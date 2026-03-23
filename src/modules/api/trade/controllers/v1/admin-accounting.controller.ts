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

    @ApiOperation({ summary: "Get aggregated trading balances per user/currency" })
    @ApiQuery({ name: "pageNumber", required: false, description: "Page number (default: 1)" })
    @ApiQuery({ name: "pageSize", required: false, description: "Page size (default: 20)" })
    @ApiQuery({ name: "currency", required: false, description: "Filter by currency" })
    @ApiQuery({ name: "search", required: false, description: "Search by user email or name" })
    @Get("trading-balances")
    async getTradingBalances(
        @Query("pageNumber", new DefaultValuePipe(1), ParseIntPipe) pageNumber: number,
        @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
        @Query("currency") currency?: string,
        @Query("search") search?: string,
    ) {
        this.logger.log(`Admin fetching trading balances (page ${pageNumber})`);

        // Build the where clause for settled trading entries
        const tradingTypes = [
            LedgerType.BUY,
            LedgerType.SELL,
            LedgerType.SWAP_IN,
            LedgerType.SWAP_OUT,
            LedgerType.SEND,
            LedgerType.RECEIVE,
            LedgerType.DEPOSIT,
            LedgerType.WITHDRAWAL,
        ];

        const where: any = {
            userId: { gt: 0 }, // Exclude platform (0) and fee (-1) accounts
            status: { in: [EntryStatus.SETTLED, EntryStatus.HOLD] },
        };

        if (currency) {
            where.currency = currency.toUpperCase();
        }

        if (search) {
            where.user = {
                OR: [
                    { email: { contains: search, mode: "insensitive" } },
                    { firstName: { contains: search, mode: "insensitive" } },
                    { lastName: { contains: search, mode: "insensitive" } },
                ],
            };
        }

        // Get distinct user-currency pairs with their latest balance
        const entries = await this.prisma.ledgerEntry.findMany({
            where,
            select: {
                userId: true,
                currency: true,
                balanceAfter: true,
                status: true,
                sequenceNumber: true,
                updatedAt: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
            orderBy: { sequenceNumber: "desc" },
            distinct: ["userId", "currency"],
            skip: (pageNumber - 1) * pageSize,
            take: pageSize,
        });

        // Get total count of distinct user-currency pairs
        const distinctPairs = await this.prisma.ledgerEntry.findMany({
            where,
            select: { userId: true, currency: true },
            distinct: ["userId", "currency"],
        });
        const total = distinctPairs.length;

        // For each entry, compute available/held from the latest settled entries
        const items = await Promise.all(
            entries.map(async (entry) => {
                // Get total held amount for this user-currency
                const holdEntries = await this.prisma.ledgerEntry.aggregate({
                    where: {
                        userId: entry.userId,
                        currency: entry.currency,
                        status: EntryStatus.HOLD,
                        type: LedgerType.HOLD,
                    },
                    _sum: { holdAmount: true },
                });

                const totalBalance = Number(entry.balanceAfter);
                const held = Number(holdEntries._sum.holdAmount ?? 0);
                const available = totalBalance - held;

                return {
                    userId: entry.userId,
                    userName: entry.user
                        ? `${entry.user.firstName ?? ""} ${entry.user.lastName ?? ""}`.trim()
                        : "Unknown",
                    email: entry.user?.email ?? "",
                    currency: entry.currency,
                    available,
                    held,
                    total: totalBalance,
                    lastActivity: entry.updatedAt,
                    status: held > 0 ? "active" : totalBalance > 0 ? "active" : "inactive",
                };
            })
        );

        return buildResponse({
            message: "Trading balances retrieved",
            data: {
                items,
                total,
                pageNumber,
                pageSize,
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
                items,
                total,
                pageNumber,
                pageSize,
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
        return buildResponse({
            message: "On-chain summary retrieved",
            data: report,
        });
    }
}
