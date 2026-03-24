import {
    Controller,
    Get,
    Query,
    UseGuards,
    Logger,
    ParseIntPipe,
    DefaultValuePipe,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from "@nestjs/swagger";
import {
    AuthGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType, LedgerType, EntryStatus, OrderCategory } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PrismaService } from "@/modules/core/prisma/services";
import { SolvencyService } from "../../services/ledger/solvency.service";
import { buildResponse } from "@/utils/api-response-util";
import { buildPaginationMeta } from "@/utils";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN])
@ApiTags("admin-accounting")
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/accounting",
})
export class AdminAccountingController {
    private readonly logger = new Logger(AdminAccountingController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly solvencyService: SolvencyService,
    ) {}

    // =========================================================================
    // TRADING BALANCE ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get aggregated trading balances grouped by user" })
    @ApiQuery({ name: "pageNumber", required: false, description: "Page number (default: 1)" })
    @ApiQuery({ name: "pageSize", required: false, description: "Page size (default: 20)" })
    @ApiQuery({ name: "currency", required: false, description: "Filter by currency" })
    @ApiQuery({ name: "search", required: false, description: "Search by user email or name" })
    @ApiQuery({ name: "accountType", required: false, description: "Filter by account type (INDIVIDUAL/BUSINESS)" })
    @ApiQuery({ name: "sortBalance", required: false, description: "Sort by total balance: highest or lowest" })
    @Get("trading-balances")
    async getTradingBalances(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
        @Query("currency") currency?: string,
        @Query("search") search?: string,
        @Query("accountType") accountType?: string,
        @Query("sortBalance") sortBalance?: string,
    ) {
        this.logger.log(`Admin fetching trading balances (page ${pageNumber})`);

        const where: any = {
            userId: { gt: 0 }, // Exclude platform (0) and fee (-1) accounts
            status: { in: [EntryStatus.SETTLED, EntryStatus.HOLD] },
        };

        if (currency) {
            where.currency = currency.toUpperCase();
        }

        const userFilter: any = {};
        if (search) {
            userFilter.OR = [
                { email: { contains: search, mode: "insensitive" } },
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
            ];
        }
        if (accountType) {
            userFilter.userType = accountType;
        }
        if (Object.keys(userFilter).length > 0) {
            where.user = userFilter;
        }

        // Get distinct users that have ledger entries
        const distinctUsers = await this.prisma.ledgerEntry.findMany({
            where,
            select: { userId: true },
            distinct: ["userId"],
        });
        const totalUsers = distinctUsers.length;

        // Get all distinct user-currency entries for building grouped data
        const allEntries = await this.prisma.ledgerEntry.findMany({
            where,
            select: {
                userId: true,
                currency: true,
                balanceAfter: true,
                updatedAt: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        userType: true,
                    },
                },
            },
            orderBy: { sequenceNumber: "desc" },
            distinct: ["userId", "currency"],
        });

        // Group entries by user
        const userMap = new Map<number, typeof allEntries>();
        for (const entry of allEntries) {
            const list = userMap.get(entry.userId) || [];
            list.push(entry);
            userMap.set(entry.userId, list);
        }

        // Build grouped records with totalCredit/totalDebit per user-currency
        const groupedUsers = await Promise.all(
            Array.from(userMap.entries()).map(async ([userId, entries]) => {
                const firstEntry = entries[0];
                const userName = firstEntry.user
                    ? `${firstEntry.user.firstName ?? ""} ${firstEntry.user.lastName ?? ""}`.trim()
                    : "Unknown";

                const balances = await Promise.all(
                    entries.map(async (entry) => {
                        // Get held amount
                        const holdEntries = await this.prisma.ledgerEntry.aggregate({
                            where: {
                                userId: entry.userId,
                                currency: entry.currency,
                                status: EntryStatus.HOLD,
                                type: LedgerType.HOLD,
                            },
                            _sum: { holdAmount: true },
                        });

                        // Get total credit and debit for this user-currency
                        const creditDebit = await this.prisma.ledgerEntry.aggregate({
                            where: {
                                userId: entry.userId,
                                currency: entry.currency,
                                status: EntryStatus.SETTLED,
                            },
                            _sum: { credit: true, debit: true },
                        });

                        const totalBalance = Number(entry.balanceAfter);
                        const held = Number(holdEntries._sum.holdAmount ?? 0);
                        const available = totalBalance - held;
                        const totalCredit = Number(creditDebit._sum.credit ?? 0);
                        const totalDebit = Number(creditDebit._sum.debit ?? 0);

                        return {
                            currency: entry.currency,
                            available,
                            held,
                            total: totalBalance,
                            totalCredit,
                            totalDebit,
                            lastActivity: entry.updatedAt,
                        };
                    })
                );

                const totalBalanceUsdt = balances.reduce((sum, b) => sum + b.total, 0);

                return {
                    userId,
                    userName,
                    email: firstEntry.user?.email ?? "",
                    accountType: firstEntry.user?.userType ?? "",
                    totalBalanceUsdt,
                    balances,
                    status: balances.some(b => b.held > 0 || b.total > 0) ? "active" : "inactive",
                };
            })
        );

        // Sort by balance if requested
        if (sortBalance === "highest") {
            groupedUsers.sort((a, b) => b.totalBalanceUsdt - a.totalBalanceUsdt);
        } else if (sortBalance === "lowest") {
            groupedUsers.sort((a, b) => a.totalBalanceUsdt - b.totalBalanceUsdt);
        }

        // Paginate the grouped results
        const paginatedUsers = groupedUsers.slice(
            (pageNumber - 1) * pageSize,
            pageNumber * pageSize
        );

        return buildResponse({
            message: "Trading balances retrieved",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, totalUsers, paginatedUsers.length),
                records: paginatedUsers,
            },
        });
    }

    // =========================================================================
    // SWAP LOG ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get swap transaction log" })
    @ApiQuery({ name: "pageNumber", required: false, description: "Page number (default: 1)" })
    @ApiQuery({ name: "pageSize", required: false, description: "Page size (default: 20)" })
    @ApiQuery({ name: "status", required: false, description: "Filter by status" })
    @ApiQuery({ name: "currency", required: false, description: "Filter by from/to currency" })
    @Get("swap-log")
    async getSwapLog(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
        @Query("status") status?: string,
        @Query("currency") currency?: string,
    ) {
        this.logger.log(`Admin fetching swap log (page ${pageNumber})`);

        const where: any = {
            orderCategory: OrderCategory.SWAP,
        };

        if (status) {
            where.streamlinedStatus = status;
        }

        if (currency) {
            const upperCurrency = currency.toUpperCase();
            where.OR = [
                { fromCurrency: upperCurrency },
                { toCurrency: upperCurrency },
            ];
        }

        const [orders, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true,
                        },
                    },
                },
                orderBy: { createdAt: "desc" },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.order.count({ where }),
        ]);

        const items = orders.map((order) => ({
            id: order.id,
            userId: order.userId,
            userName: order.user
                ? `${order.user.firstName ?? ""} ${order.user.lastName ?? ""}`.trim()
                : "Unknown",
            fromCurrency: order.fromCurrency,
            toCurrency: order.toCurrency,
            fromAmount: order.fromAmount,
            toAmount: order.toAmount,
            rate: order.executionPrice ?? order.quoted_price,
            status: order.streamlinedStatus,
            createdAt: order.createdAt,
        }));

        return buildResponse({
            message: "Swap log retrieved",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, total, items.length),
                records: items,
            },
        });
    }

    // =========================================================================
    // DEPOSIT / WITHDRAWAL SUMMARY ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get per-user deposit and withdrawal summaries grouped by currency" })
    @ApiQuery({ name: "page", required: false, type: Number })
    @ApiQuery({ name: "limit", required: false, type: Number })
    @ApiQuery({ name: "currency", required: false, type: String })
    @ApiQuery({ name: "search", required: false, type: String })
    @Get("deposit-withdrawal-summary")
    async getDepositWithdrawalSummary(
        @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
        @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
        @Query("currency") currency?: string,
        @Query("search") search?: string,
    ) {
        this.logger.log("Admin fetching deposit/withdrawal summary");

        // Build where clause for ledger entries
        const where: any = {
            type: { in: [LedgerType.DEPOSIT, LedgerType.WITHDRAWAL] },
            status: EntryStatus.SETTLED,
        };
        if (currency) {
            where.currency = currency.toUpperCase();
        }

        // Get aggregated data grouped by userId, currency, and type
        const aggregations = await this.prisma.ledgerEntry.groupBy({
            by: ["userId", "currency", "type"],
            where,
            _sum: { credit: true, debit: true },
            _count: true,
        });

        // Build a map: userId -> { currencies: { currency -> { deposits, withdrawals } } }
        const userMap = new Map<number, {
            userId: number;
            currencies: Map<string, { totalDeposits: number; depositCount: number; totalWithdrawals: number; withdrawalCount: number }>;
        }>();

        for (const agg of aggregations) {
            if (!userMap.has(agg.userId)) {
                userMap.set(agg.userId, { userId: agg.userId, currencies: new Map() });
            }
            const user = userMap.get(agg.userId)!;
            if (!user.currencies.has(agg.currency)) {
                user.currencies.set(agg.currency, { totalDeposits: 0, depositCount: 0, totalWithdrawals: 0, withdrawalCount: 0 });
            }
            const curr = user.currencies.get(agg.currency)!;
            if (agg.type === LedgerType.DEPOSIT) {
                curr.totalDeposits = Number(agg._sum.credit ?? 0);
                curr.depositCount = agg._count;
            } else if (agg.type === LedgerType.WITHDRAWAL) {
                curr.totalWithdrawals = Number(agg._sum.debit ?? 0);
                curr.withdrawalCount = agg._count;
            }
        }

        // Fetch user details for all relevant users
        const userIds = Array.from(userMap.keys());

        // Apply search filter if provided
        let filteredUserIds = userIds;
        if (search) {
            const users = await this.prisma.user.findMany({
                where: {
                    id: { in: userIds },
                    OR: [
                        { firstName: { contains: search, mode: "insensitive" } },
                        { lastName: { contains: search, mode: "insensitive" } },
                        { email: { contains: search, mode: "insensitive" } },
                    ],
                },
                select: { id: true },
            });
            filteredUserIds = users.map((u) => u.id);
        }

        const total = filteredUserIds.length;
        const pageSize = Math.min(limit, 100);
        const pageNumber = Math.max(page, 1);
        const paginatedIds = filteredUserIds.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);

        const userDetails = await this.prisma.user.findMany({
            where: { id: { in: paginatedIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
        });
        const userDetailMap = new Map(userDetails.map((u) => [u.id, u]));

        const records = paginatedIds.map((uid) => {
            const entry = userMap.get(uid)!;
            const user = userDetailMap.get(uid);
            const currencies = Array.from(entry.currencies.entries()).map(([curr, data]) => ({
                currency: curr,
                totalDeposits: data.totalDeposits,
                depositCount: data.depositCount,
                totalWithdrawals: data.totalWithdrawals,
                withdrawalCount: data.withdrawalCount,
                net: data.totalDeposits - data.totalWithdrawals,
            }));
            return {
                userId: uid,
                userName: user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "Unknown",
                email: user?.email ?? "",
                currencies,
                totalDeposits: currencies.reduce((s, c) => s + c.totalDeposits, 0),
                totalWithdrawals: currencies.reduce((s, c) => s + c.totalWithdrawals, 0),
            };
        });

        return buildResponse({
            message: "Deposit/withdrawal summary retrieved",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, total, records.length),
                records,
            },
        });
    }

    // =========================================================================
    // ON-CHAIN SUMMARY ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get on-chain solvency summary (wallet balances vs ledger)" })
    @Get("on-chain-summary")
    async getOnChainSummary() {
        this.logger.log("Admin fetching on-chain summary");
        const report = await this.solvencyService.generateReport();

        // Transform solvency report into the frontend-expected format
        const wallets = (report.currencies ?? []).map((c: any) => ({
            currency: c.currency,
            network: null,
            onChainBalance: Number(c.platformReserves ?? 0),
            ledgerBalance: Number(c.userLiabilities ?? 0),
            walletAddress: null,
            reserveRatio: c.reserveRatio,
            status: c.status,
        }));

        const totalOnChain = wallets.reduce((sum: number, w: any) => sum + w.onChainBalance, 0);

        return buildResponse({
            message: "On-chain summary retrieved",
            data: {
                wallets,
                totals: {
                    walletCount: wallets.length,
                    totalValueUsd: totalOnChain,
                },
                overallStatus: report.overallStatus,
                timestamp: report.timestamp,
            },
        });
    }
}
