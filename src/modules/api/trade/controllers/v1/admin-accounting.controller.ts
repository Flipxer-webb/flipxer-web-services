import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    UseGuards,
    Logger,
    ParseIntPipe,
    DefaultValuePipe,
    Inject,
    NotFoundException,
    BadRequestException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from "@nestjs/swagger";
import {
    AuthGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { User as UserEntity, LedgerType, EntryStatus, OrderCategory, Prisma, PaymentMethod } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PrismaService } from "@/modules/core/prisma/services";
import { SolvencyService } from "../../services/ledger/solvency.service";
import { LedgerService } from "../../services/ledger/ledger.service";
import { RateService } from "../../services/rate.service";
import { AdminSwapService } from "../../services/admin-swap.service";
import { AdminSwapQuoteDto, AdminSwapConfirmDto, AdminAdjustmentDto } from "../../dtos";
import { User } from "@/modules/api/user/decorators";
import { buildResponse } from "@/utils/api-response-util";
import { buildPaginationMeta } from "@/utils";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
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
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService,
        private readonly adminSwapService: AdminSwapService,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
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

                        // Get USDT price for this currency
                        let usdtPrice = 1;
                        try {
                            usdtPrice = await this.rateService.getAssetUsdtPrice(entry.currency);
                        } catch {
                            usdtPrice = entry.currency === "USDT" ? 1 : 0;
                        }

                        return {
                            currency: entry.currency,
                            available,
                            held,
                            total: totalBalance,
                            totalCredit,
                            totalDebit,
                            availableInUsdt: available * usdtPrice,
                            totalInUsdt: totalBalance * usdtPrice,
                            lastActivity: entry.updatedAt,
                        };
                    })
                );

                const totalBalanceUsdt = balances.reduce((sum, b) => sum + (b.availableInUsdt ?? 0), 0);

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
    @ApiQuery({ name: "source", required: false, description: "Filter by swap source (admin | user | all)" })
    @Get("swap-log")
    async getSwapLog(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
        @Query("status") status?: string,
        @Query("currency") currency?: string,
        @Query("source") source?: string,
    ) {
        this.logger.log(`Admin fetching swap log (page ${pageNumber})`);

        const where: any = {
            orderCategory: OrderCategory.SWAP,
        };

        const adminSwapMatcher = {
            OR: [
                { orderReference: { startsWith: "admin-swap-", mode: "insensitive" } },
                { transactionId: { startsWith: "admin-swap-", mode: "insensitive" } },
            ],
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

        const normalizedSource = (source ?? "").toLowerCase();
        if (normalizedSource === "admin") {
            where.AND = [adminSwapMatcher];
        } else if (normalizedSource === "user") {
            where.AND = [{ NOT: adminSwapMatcher }];
        }

        // Get distinct users with matching swap orders (paginate by user, not by entry)
        const distinctUsers = await this.prisma.order.findMany({
            where,
            select: { userId: true },
            distinct: ["userId"],
            orderBy: { createdAt: "desc" },
        });
        const totalUsers = distinctUsers.length;

        // Paginate user IDs
        const paginatedUserIds = distinctUsers
            .slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
            .map((u) => u.userId);

        // Fetch all swap orders for paginated users
        const orders = await this.prisma.order.findMany({
            where: {
                ...where,
                userId: { in: paginatedUserIds },
            },
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
        });

        // Group orders by user
        const userMap = new Map<number, { userName: string; entries: any[] }>();
        for (const order of orders) {
            const isAdminSwap =
                (typeof order.orderReference === "string" && order.orderReference.toLowerCase().startsWith("admin-swap-")) ||
                (typeof order.transactionId === "string" && order.transactionId.toLowerCase().startsWith("admin-swap-"));

            const entry = {
                id: order.id,
                userId: order.userId,
                userName: order.user
                    ? `${order.user.firstName ?? ""} ${order.user.lastName ?? ""}`.trim()
                    : "Unknown",
                source: isAdminSwap ? "ADMIN_SWAP" : "USER_SWAP",
                fromCurrency: order.fromCurrency,
                toCurrency: order.toCurrency,
                fromAmount: order.fromAmount,
                toAmount: order.toAmount,
                rate: order.executionPrice ?? order.quoted_price,
                status: order.streamlinedStatus,
                createdAt: order.createdAt,
            };

            const existing = userMap.get(order.userId);
            if (existing) {
                existing.entries.push(entry);
            } else {
                userMap.set(order.userId, {
                    userName: entry.userName,
                    entries: [entry],
                });
            }
        }

        const records = Array.from(userMap.entries()).map(([userId, group]) => ({
            userId,
            userName: group.userName,
            swapCount: group.entries.length,
            entries: group.entries,
        }));

        return buildResponse({
            message: "Swap log retrieved",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, totalUsers, records.length),
                records,
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

        // Get aggregated data grouped by userId, currency, type, and network (from metadata)
        const aggregations: Array<{
            userId: number;
            currency: string;
            type: string;
            network: string | null;
            total_credit: number;
            total_debit: number;
            entry_count: number;
        }> = await this.prisma.$queryRaw`
            SELECT
                "userId",
                "currency",
                "type"::text,
                "metadata"->>'network' AS "network",
                COALESCE(SUM("credit"), 0)::float AS "total_credit",
                COALESCE(SUM("debit"), 0)::float AS "total_debit",
                COUNT(*)::int AS "entry_count"
            FROM "LedgerEntries"
            WHERE "type" IN ('DEPOSIT', 'WITHDRAWAL')
              AND "status" = 'SETTLED'
              ${currency ? Prisma.sql`AND "currency" = ${currency.toUpperCase()}` : Prisma.empty}
            GROUP BY "userId", "currency", "type", "metadata"->>'network'
        `;

        // Build a map: userId -> { currencies: { "currency|network" -> { deposits, withdrawals } } }
        const userMap = new Map<number, {
            userId: number;
            currencies: Map<string, { currency: string; network: string | null; totalDeposits: number; depositCount: number; totalWithdrawals: number; withdrawalCount: number }>;
        }>();

        for (const agg of aggregations) {
            let user = userMap.get(agg.userId);
            if (!user) {
                user = { userId: agg.userId, currencies: new Map() };
                userMap.set(agg.userId, user);
            }
            const key = `${agg.currency}|${agg.network ?? "unknown"}`;
            let curr = user.currencies.get(key);
            if (!curr) {
                curr = { currency: agg.currency, network: agg.network ?? null, totalDeposits: 0, depositCount: 0, totalWithdrawals: 0, withdrawalCount: 0 };
                user.currencies.set(key, curr);
            }
            if (agg.type === "DEPOSIT") {
                curr.totalDeposits = Number(agg.total_credit);
                curr.depositCount = Number(agg.entry_count);
            } else if (agg.type === "WITHDRAWAL") {
                curr.totalWithdrawals = Number(agg.total_debit);
                curr.withdrawalCount = Number(agg.entry_count);
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
            const entry = userMap.get(uid);
            if (!entry) return null;
            const user = userDetailMap.get(uid);
            const currencies = Array.from(entry.currencies.entries()).map(([_key, data]) => ({
                currency: data.currency,
                network: data.network,
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
        }).filter(Boolean);

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

        // Fetch default networks for each currency from AssetWallet
        const assetWallets = await this.prisma.assetWallet.findMany({
            select: { assetCurrency: true, defaultNetwork: true },
            distinct: ["assetCurrency"],
        });
        const networkMap = new Map(
            assetWallets.map((w) => [w.assetCurrency.toUpperCase(), w.defaultNetwork]),
        );

        // Transform solvency report into the frontend-expected format
        const wallets = (report.currencies ?? []).map((c: any) => ({
            currency: c.currency,
            network: networkMap.get(c.currency?.toUpperCase()) ?? null,
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

    // =========================================================================
    // ADMIN SWAP ENDPOINTS (Main Wallet Rebalancing via Quidax)
    // =========================================================================

    @ApiOperation({ summary: "Get a swap quote for the platform main wallet via Quidax" })
    @Post("swap-quote")
    async getSwapQuote(@Body() dto: AdminSwapQuoteDto) {
        return this.adminSwapService.getSwapQuote(dto);
    }

    @ApiOperation({ summary: "Confirm and execute a swap on the platform main wallet via Quidax" })
    @Post("swap-confirm")
    async confirmSwap(
        @Body() dto: AdminSwapConfirmDto,
        @User() admin: UserEntity,
    ) {
        return this.adminSwapService.confirmSwap(dto, admin.id);
    }

    // =========================================================================
    // FIAT GATEWAY ENDPOINTS
    // =========================================================================

    @ApiOperation({ summary: "Get fiat gateway balances from all configured providers (Fincra, Nomba)" })
    @Get("fiat-gateway-summary")
    async getFiatGatewaySummary() {
        this.logger.log("Admin fetching fiat gateway summary");

        const gateways: Array<{
            provider: string;
            status: "connected" | "error";
            currency: string;
            availableBalance: number;
            lockedBalance: number;
            ledgerBalance: number;
            error?: string;
        }> = [];

        // Fetch Fincra wallets
        try {
            const fincraWallets = await this.fincraService.getWallets();
            if (fincraWallets?.data?.length) {
                for (const wallet of fincraWallets.data) {
                    gateways.push({
                        provider: "Fincra",
                        status: "connected",
                        currency: wallet.currency || "NGN",
                        availableBalance: Number(wallet.availableBalance ?? 0),
                        lockedBalance: Number(wallet.lockedBalance ?? 0),
                        ledgerBalance: Number(wallet.ledgerBalance ?? 0),
                    });
                }
            }
        } catch (error) {
            this.logger.error(`Failed to fetch Fincra wallets: ${(error as Error).message}`);
            gateways.push({
                provider: "Fincra",
                status: "error",
                currency: "NGN",
                availableBalance: 0,
                lockedBalance: 0,
                ledgerBalance: 0,
                error: "Unable to connect to Fincra",
            });
        }

        // Fetch Nomba balance
        try {
            const nombaBalance = await this.nombaService.getAccountBalance();
            if (nombaBalance?.data) {
                gateways.push({
                    provider: "Nomba",
                    status: "connected",
                    currency: nombaBalance.data.currency || "NGN",
                    availableBalance: Number(nombaBalance.data.availableBalance ?? nombaBalance.data.balance ?? 0),
                    lockedBalance: Number(nombaBalance.data.lockedBalance ?? 0),
                    ledgerBalance: Number(nombaBalance.data.balance ?? 0),
                });
            }
        } catch (error) {
            this.logger.error(`Failed to fetch Nomba balance: ${(error as Error).message}`);
            gateways.push({
                provider: "Nomba",
                status: "error",
                currency: "NGN",
                availableBalance: 0,
                lockedBalance: 0,
                ledgerBalance: 0,
                error: "Unable to connect to Nomba",
            });
        }

        const totalAvailable = gateways
            .filter((g) => g.status === "connected")
            .reduce((sum, g) => sum + g.availableBalance, 0);
        const totalLocked = gateways
            .filter((g) => g.status === "connected")
            .reduce((sum, g) => sum + g.lockedBalance, 0);
        const connectedCount = gateways.filter((g) => g.status === "connected").length;

        return buildResponse({
            message: "Fiat gateway summary retrieved",
            data: {
                gateways,
                totals: {
                    totalAvailable,
                    totalLocked,
                    totalLedger: totalAvailable + totalLocked,
                    connectedGateways: connectedCount,
                    totalGateways: gateways.length,
                },
                timestamp: new Date().toISOString(),
            },
        });
    }

    @ApiOperation({ summary: "Get recent fiat gateway activity (buy/sell orders involving NGN)" })
    @ApiQuery({ name: "page", required: false, type: Number })
    @ApiQuery({ name: "limit", required: false, type: Number })
    @ApiQuery({ name: "provider", required: false, description: "Filter by gateway provider: fincra, nomba, or all" })
    @ApiQuery({ name: "type", required: false, description: "Filter by type: collection, payout, or all" })
    @Get("fiat-gateway-activity")
    async getFiatGatewayActivity(
        @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
        @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
        @Query("provider") provider?: string,
        @Query("type") type?: string,
    ) {
        this.logger.log(`Admin fetching fiat gateway activity (page ${page})`);

        const pageSize = Math.min(limit, 100);
        const skip = (Math.max(page, 1) - 1) * pageSize;

        const where: any = {};

        // Filter by payment method (maps to provider)
        if (provider === "fincra") {
            where.paymentMethod = PaymentMethod.FINCRA;
        } else if (provider === "nomba") {
            where.paymentMethod = PaymentMethod.NOMBA;
        } else {
            where.paymentMethod = { in: [PaymentMethod.FINCRA, PaymentMethod.NOMBA] };
        }

        // Filter by flow type
        if (type === "collection") {
            where.flow = "IN";
        } else if (type === "payout") {
            where.flow = "OUT";
        }

        const [payments, total] = await Promise.all([
            this.prisma.payment.findMany({
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
                skip,
                take: pageSize,
            }),
            this.prisma.payment.count({ where }),
        ]);

        const records = payments.map((p) => ({
            id: p.id,
            reference: p.reference,
            transactionId: p.transactionId,
            provider: p.paymentMethod === PaymentMethod.FINCRA ? "Fincra" : "Nomba",
            type: p.flow === "IN" ? "collection" : "payout",
            amount: Number(p.amount),
            currency: p.expectedCurrency || "NGN",
            status: p.status,
            userId: p.userId,
            userName: p.user
                ? `${p.user.firstName ?? ""} ${p.user.lastName ?? ""}`.trim()
                : "Unknown",
            email: p.user?.email ?? "",
            narration: p.narration,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
        }));

        return buildResponse({
            message: "Fiat gateway activity retrieved",
            data: {
                meta: buildPaginationMeta(page, pageSize, total, records.length),
                records,
            },
        });
    }

    // =========================================================================
    // ADMIN LEDGER ADJUSTMENT
    // =========================================================================

    @ApiOperation({ summary: "Credit or debit a user's ledger balance (admin adjustment)" })
    @Post("adjustment")
    async createAdjustment(
        @Body() dto: AdminAdjustmentDto,
        @User() admin: UserEntity,
    ) {
        const { userId, currency, amount, reason, orderId } = dto;

        // Verify user exists
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        const reference = `admin-adj:${admin.id}:${Date.now()}`;

        this.logger.warn(
            `[ADMIN ADJUSTMENT] Admin ${admin.id} (${admin.email}) crediting ${amount} ${currency} to user ${userId} (${user.email}) | Reason: ${reason} | OrderId: ${orderId ?? "none"}`,
        );

        const result = await this.ledgerService.pairedCredit({
            userId,
            currency: currency.toUpperCase(),
            type: LedgerType.ADJUSTMENT,
            amount,
            reference,
            description: `Admin adjustment: ${reason}`,
            metadata: {
                adminId: admin.id,
                adminEmail: admin.email,
                reason,
                ...(orderId ? { orderId } : {}),
            },
            sweepStatus: undefined,
            createPlatformEntry: true,
        });

        if (!result.success) {
            this.logger.error(`[ADMIN ADJUSTMENT] Failed: ${result.error}`);
            throw new BadRequestException(`Adjustment failed: ${result.error}`);
        }

        // If an orderId was provided, link the ledger entry to the order
        if (orderId && result.userEntry) {
            await this.prisma.order.update({
                where: { id: orderId },
                data: { ledgerEntryId: result.userEntry.id, fulfilled: true },
            }).catch((err) => {
                this.logger.warn(`[ADMIN ADJUSTMENT] Could not link ledger entry to order ${orderId}: ${err.message}`);
            });
        }

        this.logger.log(
            `[ADMIN ADJUSTMENT] Success | LedgerEntry: ${result.userEntry?.id} | BalanceAfter: ${result.userBalanceAfter}`,
        );

        return buildResponse({
            message: "Adjustment applied successfully",
            data: {
                ledgerEntryId: result.userEntry?.id,
                balanceAfter: result.userBalanceAfter?.toString(),
                reference,
            },
        });
    }
}
