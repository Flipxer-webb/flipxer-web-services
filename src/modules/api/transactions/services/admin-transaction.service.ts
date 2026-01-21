import { Injectable, Logger, BadRequestException, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { Order, OrderStreamlinedStatus, Prisma, LedgerType, SweepStatus, User, OrderStatus, OrderCategory, TransactionStatus } from "@prisma/client";
import { LedgerService, LedgerOperationResult } from "@/modules/api/trade/services/ledger/ledger.service";
import { SettingService } from "@/modules/api/settings/services";
import {
    startOfMonth,
    endOfMonth,
    startOfWeek,
    endOfWeek,
    startOfDay,
    endOfDay,
    startOfQuarter,
    endOfQuarter,
    startOfYear,
    endOfYear,
} from "date-fns";
import { createObjectCsvStringifier } from "csv-writer";
import {
    GetUserTransactionListDto,
    UpdateTransactionStatusDto,
    ManualApproveTransactionDto,
    RefundTransactionDto,
    BulkTransactionActionDto,
} from "../dtos";
import { shapeTransaction, TransactionIncludeOptions } from "../types";
import { BuyOrderService } from "@/modules/api/trade/services/buy-order.service";
import { SwapService } from "@/modules/api/trade/services/swap.service";
import { WithdrawalWebhookHandler } from "@/modules/api/trade/services/webhook-handlers/withdrawal-webhook.handler";

@Injectable()
export class AdminTransactionService {
    private readonly logger = new Logger(AdminTransactionService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly ledgerService: LedgerService,
        private readonly settingService: SettingService,
        private readonly buyOrderService: BuyOrderService,
        private readonly swapService: SwapService,
        private readonly withdrawalWebhookHandler: WithdrawalWebhookHandler,
    ) { }

    // ==================== PENDING/FAILED TRANSACTIONS ====================

    async getPendingTransactions(query: GetUserTransactionListDto): Promise<ApiResponse> {
        const { pageNumber = 1, pageSize = 20 } = query;

        const where: Prisma.OrderWhereInput = {
            streamlinedStatus: OrderStreamlinedStatus.pending,
            ...(query.type && { orderCategory: query.type }),
            ...(query.startDate && {
                createdAt: { gte: new Date(query.startDate) },
            }),
            ...(query.endDate && {
                createdAt: { lte: new Date(query.endDate) },
            }),
        };

        const [transactions, count] = await this.prisma.$transaction([
            this.prisma.order.findMany({
                where,
                include: {
                    user: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
                orderBy: { createdAt: "desc" },
            }),
            this.prisma.order.count({ where }),
        ]);

        return buildResponse({
            message: "Pending transactions retrieved",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, count, transactions.length),
                records: transactions.map((t) => shapeTransaction(t)),
            },
        });
    }

    async getFailedTransactions(query: GetUserTransactionListDto): Promise<ApiResponse> {
        const { pageNumber = 1, pageSize = 20 } = query;

        const where: Prisma.OrderWhereInput = {
            streamlinedStatus: OrderStreamlinedStatus.failed,
            ...(query.type && { orderCategory: query.type }),
            ...(query.startDate && {
                createdAt: { gte: new Date(query.startDate) },
            }),
            ...(query.endDate && {
                createdAt: { lte: new Date(query.endDate) },
            }),
        };

        const [transactions, count] = await this.prisma.$transaction([
            this.prisma.order.findMany({
                where,
                include: {
                    user: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
                orderBy: { createdAt: "desc" },
            }),
            this.prisma.order.count({ where }),
        ]);

        return buildResponse({
            message: "Failed transactions retrieved",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, count, transactions.length),
                records: transactions.map((t) => shapeTransaction(t)),
            },
        });
    }

    // ==================== TRANSACTION STATS ====================

    async getTransactionStats(period: string = "month"): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(period);

        const [
            totalCount,
            completedCount,
            pendingCount,
            failedCount,
            totalVolume,
            completedOrdersForFees,
            volumeByCategory,
        ] = await Promise.all([
            this.prisma.order.count({
                where: { createdAt: { gte: startDate, lte: endDate } },
            }),
            this.prisma.order.count({
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }),
            this.prisma.order.count({
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.pending,
                },
            }),
            this.prisma.order.count({
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                },
            }),
            this.prisma.order.aggregate({
                _sum: { amountInFiat: true },
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }),
            // Fetch completed orders with fee and rate to calculate fees in fiat
            this.prisma.order.findMany({
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    fee: { not: null },
                },
                select: {
                    fee: true,
                    rateAtConversion: true,
                },
            }),
            this.prisma.order.groupBy({
                by: ["orderCategory"],
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
                _sum: { amountInFiat: true },
                _count: true,
            }),
        ]);

        // Calculate total fees in fiat (fee * rateAtConversion for each order)
        const totalFeesInFiat = completedOrdersForFees.reduce((sum, order) => {
            const fee = order.fee || 0;
            const rate = order.rateAtConversion || 0;
            return sum + (fee * rate);
        }, 0);

        return buildResponse({
            message: "Transaction stats retrieved",
            data: {
                overview: {
                    total: totalCount,
                    completed: completedCount,
                    pending: pendingCount,
                    failed: failedCount,
                    successRate: totalCount > 0
                        ? ((completedCount / totalCount) * 100).toFixed(2)
                        : 0,
                },
                volume: {
                    total: totalVolume._sum.amountInFiat || 0,
                    fees: totalFeesInFiat,
                    currency: "NGN",
                },
                byCategory: volumeByCategory.map((c) => ({
                    category: c.orderCategory,
                    count: c._count,
                    volume: c._sum.amountInFiat || 0,
                })),
                period: { start: startDate, end: endDate },
            },
        });
    }

    // ==================== TRANSACTION STATUS UPDATES ====================

    async updateTransactionStatus(
        transactionId: string,
        dto: UpdateTransactionStatusDto,
        adminId?: number
    ): Promise<ApiResponse> {
        const transaction = await this.prisma.order.findUnique({
            where: { transactionId },
        });

        if (!transaction) {
            return buildResponse({ message: "Transaction not found", data: null });
        }

        const previousStatus = transaction.streamlinedStatus;

        const updatedTransaction = await this.prisma.order.update({
            where: { transactionId },
            data: {
                streamlinedStatus: dto.status,
                reason: dto.reason || transaction.reason,
            },
            include: { user: { select: { firstName: true, lastName: true } } },
        });

        // Create audit log
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "UPDATE_TRANSACTION_STATUS",
                resource: "transaction",
                resourceId: transactionId,
                details: {
                    previousStatus,
                    newStatus: dto.status,
                    reason: dto.reason,
                    note: dto.note,
                },
            },
        });

        return buildResponse({
            message: "Transaction status updated successfully",
            data: shapeTransaction(updatedTransaction),
        });
    }

    /**
     * Manually approve a pending transaction.
     * Requires 2FA verification from admin.
     * For BUY orders, credits the user's ledger.
     */
    async manualApproveTransaction(
        transactionId: string,
        dto: ManualApproveTransactionDto,
        admin: User
    ): Promise<ApiResponse> {
        // Verify admin 2FA first
        const is2FAValid = await this.settingService.verify2FACode(admin.id, dto.twoFactorCode);
        if (!is2FAValid) {
            throw new UnauthorizedException('Invalid 2FA code');
        }

        const transaction = await this.prisma.order.findUnique({
            where: { transactionId },
        });

        if (!transaction) {
            return buildResponse({ message: "Transaction not found", data: null });
        }

        if (!dto.confirmed) {
            return buildResponse({
                message: "Manual approval requires confirmation",
                data: null
            });
        }

        // Prevent double-approval
        if (transaction.fulfilled || transaction.streamlinedStatus === OrderStreamlinedStatus.completed) {
            return buildResponse({ message: "Transaction already completed", data: null });
        }

        // For BUY orders, credit the user's ledger
        let creditResult: LedgerOperationResult | null = null;
        if (transaction.orderCategory === 'BUY') {
            creditResult = await this.ledgerService.credit({
                userId: transaction.userId,
                currency: transaction.currency.toUpperCase(),
                amount: transaction.amount,
                type: LedgerType.BUY,
                reference: `manual-approve:${transactionId}`,
                description: `Admin manual approval`,
                metadata: {
                    adminId: admin.id,
                    approveType: 'manual',
                    verificationNote: dto.verificationNote,
                },
                sweepStatus: SweepStatus.NOT_APPLICABLE,
            });

            if (!creditResult.success) {
                this.logger.error(`Manual approve ledger credit failed for ${transactionId}: ${creditResult.error}`);
                throw new InternalServerErrorException(`Failed to credit ledger: ${creditResult.error}`);
            }
        }

        const updatedTransaction = await this.prisma.order.update({
            where: { transactionId },
            data: {
                streamlinedStatus: OrderStreamlinedStatus.completed,
                status: "confirmed",
                fulfilled: true,
                ...(dto.overrideAmount && {
                    amountInFiat: parseFloat(dto.overrideAmount)
                }),
            },
            include: { user: { select: { firstName: true, lastName: true } } },
        });

        // Create audit log
        await this.prisma.auditLog.create({
            data: {
                adminId: admin.id,
                action: "MANUAL_APPROVE_TRANSACTION",
                resource: "transaction",
                resourceId: transactionId,
                details: {
                    verificationNote: dto.verificationNote,
                    overrideAmount: dto.overrideAmount,
                    originalAmount: transaction.amountInFiat,
                    ledgerEntryId: creditResult?.entryId,
                    orderCategory: transaction.orderCategory,
                },
            },
        });

        this.logger.log(
            `Manual approve completed | ${JSON.stringify({
                transactionId,
                userId: transaction.userId,
                adminId: admin.id,
                orderCategory: transaction.orderCategory,
                ledgerCredited: !!creditResult,
            })}`
        );

        return buildResponse({
            message: "Transaction manually approved",
            data: shapeTransaction(updatedTransaction),
        });
    }

    /**
     * Refund a failed transaction by crediting funds back to user's ledger.
     * Only failed transactions can be refunded. Refunds are always FULL amount.
     * 
     * IMPORTANT: Completed orders with successful bank payouts require manual reversal.
     */
    async refundTransaction(
        transactionId: string,
        dto: RefundTransactionDto,
        adminId?: number
    ): Promise<ApiResponse> {
        const transaction = await this.prisma.order.findUnique({
            where: { transactionId },
        });

        if (!transaction) {
            return buildResponse({ message: "Transaction not found", data: null });
        }

        // Only allow refund for failed orders
        // Completed orders with bank payouts require manual bank reversal
        if (transaction.streamlinedStatus !== OrderStreamlinedStatus.failed) {
            throw new BadRequestException(
                'Only failed transactions can be refunded. Completed transactions with bank payouts require manual reversal.'
            );
        }

        // Check for existing refund to prevent double-refund
        const existingRefund = await this.prisma.ledgerEntry.findFirst({
            where: {
                reference: { startsWith: `refund:${transaction.orderReference}` },
            },
        });
        if (existingRefund) {
            throw new BadRequestException('Transaction has already been refunded');
        }

        // Full refund - for SELL/SEND use total (includes fees), otherwise use amount
        const refundAmount = (transaction.orderCategory === 'SELL' || transaction.orderCategory === 'SEND')
            ? (transaction.total || transaction.amount)
            : transaction.amount;

        if (!refundAmount || refundAmount <= 0) {
            throw new BadRequestException('Cannot refund: transaction amount is zero or invalid');
        }

        // Credit user's ledger using distributed lock for atomicity
        const creditResult = await this.ledgerService.runWithLock(
            transaction.userId,
            transaction.currency.toUpperCase(),
            async () => {
                // Double-check for existing refund inside the lock
                const recheck = await this.prisma.ledgerEntry.findFirst({
                    where: { reference: { startsWith: `refund:${transaction.orderReference}` } },
                });
                if (recheck) {
                    throw new BadRequestException('Transaction has already been refunded');
                }

                return this.ledgerService.credit({
                    userId: transaction.userId,
                    currency: transaction.currency.toUpperCase(),
                    amount: refundAmount,
                    type: LedgerType.ADJUSTMENT, // Using ADJUSTMENT for refunds
                    reference: `refund:${transaction.orderReference}:admin`,
                    description: `Admin refund: ${dto.reason}`,
                    metadata: {
                        originalOrderId: transaction.id,
                        originalTransactionId: transactionId,
                        adminId,
                        reason: dto.reason,
                        refundType: 'full',
                    },
                    sweepStatus: SweepStatus.NOT_APPLICABLE,
                });
            }
        );

        if (!creditResult.success) {
            this.logger.error(`Refund credit failed for ${transactionId}: ${creditResult.error}`);
            throw new InternalServerErrorException(`Refund failed: ${creditResult.error}`);
        }

        // Update order status to reversed
        const updatedTransaction = await this.prisma.order.update({
            where: { transactionId },
            data: {
                status: "reversed",
                reason: `REFUND: ${dto.reason}`,
            },
            include: { user: { select: { firstName: true, lastName: true } } },
        });

        // Create audit log
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "REFUND_TRANSACTION",
                resource: "transaction",
                resourceId: transactionId,
                details: {
                    reason: dto.reason,
                    refundAmount: refundAmount,
                    currency: transaction.currency,
                    ledgerEntryId: creditResult.entryId,
                    originalAmount: transaction.amount,
                },
            },
        });

        this.logger.log(
            `Refund processed | ${JSON.stringify({
                transactionId,
                userId: transaction.userId,
                amount: refundAmount,
                currency: transaction.currency,
                adminId,
            })}`
        );

        return buildResponse({
            message: "Refund processed successfully",
            data: {
                transaction: shapeTransaction(updatedTransaction),
                refund: {
                    amount: refundAmount,
                    currency: transaction.currency,
                    ledgerEntryId: creditResult.entryId,
                    reason: dto.reason,
                },
            },
        });
    }

    async retryTransaction(
        transactionId: string,
        adminId?: number
    ): Promise<ApiResponse> {
        const transaction = await this.prisma.order.findUnique({
            where: { transactionId },
        });

        if (!transaction) {
            return buildResponse({ message: "Transaction not found", data: null });
        }

        if (
            transaction.streamlinedStatus !== OrderStreamlinedStatus.failed &&
            transaction.streamlinedStatus !== OrderStreamlinedStatus.pending
        ) {
            return buildResponse({
                message: "Only failed or pending transactions can be retried",
                data: null
            });
        }

        if (transaction.status === OrderStatus.done || transaction.status === OrderStatus.completed) {
            return buildResponse({ message: "Cannot retry completed transaction", data: null });
        }

        // Reset to pending for retry - this updates the UI status
        const updatedTransaction = await this.prisma.order.update({
            where: { transactionId },
            data: {
                streamlinedStatus: OrderStreamlinedStatus.pending,
                status: "pending",
            },
            include: { user: { select: { firstName: true, lastName: true } } },
        });

        // Create audit log - before execution to capture intent
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "RETRY_TRANSACTION",
                resource: "transaction",
                resourceId: transactionId,
                details: {
                    previousStatus: transaction.streamlinedStatus,
                    previousReason: transaction.reason
                },
            },
        });

        try {
            switch (transaction.orderCategory) {
                case OrderCategory.BUY:
                    if (!transaction.orderReference) {
                        throw new Error("Missing order reference required for payment lookup");
                    }

                    // Reset Payment status to PENDING so fulfillBuyOrder can pick it up
                    // (fulfillBuyOrder uses atomic update on PENDING status)
                    await this.prisma.payment.updateMany({
                        where: { reference: transaction.orderReference },
                        data: {
                            status: TransactionStatus.PENDING,
                            paymentStatus: TransactionStatus.PENDING
                        }
                    });

                    await this.buyOrderService.fulfillBuyOrder(transaction.orderReference);
                    break;

                case OrderCategory.SELL:
                    await this.withdrawalWebhookHandler.retryFiatPayout(transaction.id);
                    break;

                case OrderCategory.SWAP:
                    await this.swapService.retryPendingSwap(transaction.id);
                    break;

                case OrderCategory.SEND:
                    throw new BadRequestException("Retry not supported for SEND transactions. Use manual reversal/refund if needed.");

                default:
                    throw new BadRequestException(`Retry not implemented for category ${transaction.orderCategory}`);
            }

            // Re-fetch to get final status after service execution (since they might have updated it to completed)
            const finalTransaction = await this.prisma.order.findUnique({
                where: { transactionId },
                include: { user: { select: { firstName: true, lastName: true } } },
            });

            return buildResponse({
                message: "Transaction retry initiated/completed successfully",
                data: shapeTransaction(finalTransaction),
            });

        } catch (error) {
            this.logger.error(`Retry failed for ${transactionId}: ${error.message}`);

            // Revert status to failed if retry logic blew up, so it doesn't get stuck in Pending
            await this.prisma.order.update({
                where: { transactionId },
                data: {
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                    status: "failed",
                    reason: `Retry Error: ${error.message}`
                }
            });

            throw new InternalServerErrorException(`Retry failed: ${error.message}`);
        }
    }

    async bulkUpdateStatus(
        dto: BulkTransactionActionDto,
        adminId?: number
    ): Promise<ApiResponse> {
        const results = await Promise.allSettled(
            dto.transactionIds.map((transactionId) =>
                this.updateTransactionStatus(
                    transactionId,
                    { status: dto.status, reason: dto.reason },
                    adminId
                )
            )
        );

        const successful = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected").length;

        return buildResponse({
            message: "Bulk status update completed",
            data: {
                total: dto.transactionIds.length,
                successful,
                failed,
            },
        });
    }

    // ==================== AUDIT LOGS ====================

    async getTransactionAuditLogs(transactionId: string): Promise<ApiResponse> {
        const logs = await this.prisma.auditLog.findMany({
            where: {
                resource: "transaction",
                resourceId: transactionId,
            },
            include: {
                admin: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        return buildResponse({
            message: "Transaction audit logs retrieved",
            data: logs,
        });
    }

    // ==================== EXPORT ====================

    async exportTransactions(
        query: GetUserTransactionListDto,
        format: "csv" | "json" = "csv"
    ): Promise<ApiResponse> {
        const where: Prisma.OrderWhereInput = {
            ...(query.type && { orderCategory: query.type }),
            ...(query.status && { streamlinedStatus: query.status }),
            ...(query.startDate && {
                createdAt: { gte: new Date(query.startDate) },
            }),
            ...(query.endDate && {
                createdAt: { lte: new Date(query.endDate) },
            }),
        };

        const transactions = await this.prisma.order.findMany({
            where,
            include: {
                user: { select: { firstName: true, lastName: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 10000, // Limit export size
        });

        if (format === "csv") {
            const csvStringifier = createObjectCsvStringifier({
                header: [
                    { id: "transactionId", title: "Transaction ID" },
                    { id: "type", title: "Type" },
                    { id: "status", title: "Status" },
                    { id: "amount", title: "Amount" },
                    { id: "currency", title: "Currency" },
                    { id: "fee", title: "Fee" },
                    { id: "userName", title: "User Name" },
                    { id: "userEmail", title: "User Email" },
                    { id: "createdAt", title: "Date" },
                ],
            });

            const records = transactions.map((t) => ({
                transactionId: t.transactionId,
                type: t.orderCategory,
                status: t.streamlinedStatus,
                amount: t.amountInFiat,
                currency: t.currency || "NGN",
                fee: t.fee,
                userName: `${t.user?.firstName || ""} ${t.user?.lastName || ""}`.trim(),
                userEmail: t.user?.email,
                createdAt: t.createdAt.toISOString(),
            }));

            const csvContent = csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(records);

            return buildResponse({
                message: "Export generated successfully",
                data: {
                    format: "csv",
                    content: csvContent,
                    recordCount: transactions.length,
                },
            });
        }

        return buildResponse({
            message: "Export generated successfully",
            data: {
                format: "json",
                records: transactions.map((t) => shapeTransaction(t)),
                recordCount: transactions.length,
            },
        });
    }

    // ==================== HELPERS ====================

    private getDateRange(period: string): { startDate: Date; endDate: Date } {
        const now = new Date();
        switch (period) {
            case "today":
                return { startDate: startOfDay(now), endDate: endOfDay(now) };
            case "week":
                return { startDate: startOfWeek(now), endDate: endOfWeek(now) };
            case "month":
                return { startDate: startOfMonth(now), endDate: endOfMonth(now) };
            case "quarter":
                return { startDate: startOfQuarter(now), endDate: endOfQuarter(now) };
            case "year":
                return { startDate: startOfYear(now), endDate: endOfYear(now) };
            default:
                return { startDate: startOfMonth(now), endDate: endOfMonth(now) };
        }
    }
}
