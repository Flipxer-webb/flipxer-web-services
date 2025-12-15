import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { Order, OrderStreamlinedStatus, Prisma } from "@prisma/client";
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

@Injectable()
export class AdminTransactionService {
    private readonly logger = new Logger(AdminTransactionService.name);

    constructor(private readonly prisma: PrismaService) {}

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

    async manualApproveTransaction(
        transactionId: string,
        dto: ManualApproveTransactionDto,
        adminId?: number
    ): Promise<ApiResponse> {
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

        const updatedTransaction = await this.prisma.order.update({
            where: { transactionId },
            data: {
                streamlinedStatus: OrderStreamlinedStatus.completed,
                status: "confirmed",
                ...(dto.overrideAmount && { 
                    amountInFiat: parseFloat(dto.overrideAmount) 
                }),
            },
            include: { user: { select: { firstName: true, lastName: true } } },
        });

        // Create audit log
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "MANUAL_APPROVE_TRANSACTION",
                resource: "transaction",
                resourceId: transactionId,
                details: {
                    verificationNote: dto.verificationNote,
                    overrideAmount: dto.overrideAmount,
                    originalAmount: transaction.amountInFiat,
                },
            },
        });

        // TODO: Trigger notification to user

        return buildResponse({
            message: "Transaction manually approved",
            data: shapeTransaction(updatedTransaction),
        });
    }

    async refundTransaction(
        transactionId: string,
        dto: RefundTransactionDto,
        adminId?: number
    ): Promise<ApiResponse> {
        const transaction = await this.prisma.order.findUnique({
            where: { transactionId },
            include: { user: true },
        });

        if (!transaction) {
            return buildResponse({ message: "Transaction not found", data: null });
        }

        // For now, we mark the transaction as refunded and log it
        // In production, this would trigger actual refund logic
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
                    type: dto.type || "full",
                    refundAmount: dto.amount || transaction.amountInFiat,
                    originalAmount: transaction.amountInFiat,
                },
            },
        });

        // TODO: Actually process refund through payment provider

        return buildResponse({
            message: "Refund initiated successfully",
            data: {
                transaction: shapeTransaction(updatedTransaction),
                refund: {
                    amount: dto.amount || transaction.amountInFiat,
                    type: dto.type || "full",
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

        if (transaction.streamlinedStatus !== OrderStreamlinedStatus.failed) {
            return buildResponse({ 
                message: "Only failed transactions can be retried", 
                data: null 
            });
        }

        // Reset to pending for retry
        const updatedTransaction = await this.prisma.order.update({
            where: { transactionId },
            data: {
                streamlinedStatus: OrderStreamlinedStatus.pending,
                status: "pending",
            },
            include: { user: { select: { firstName: true, lastName: true } } },
        });

        // Create audit log
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "RETRY_TRANSACTION",
                resource: "transaction",
                resourceId: transactionId,
                details: {
                    previousStatus: transaction.streamlinedStatus,
                },
            },
        });

        // TODO: Actually trigger retry logic through appropriate service

        return buildResponse({
            message: "Transaction queued for retry",
            data: shapeTransaction(updatedTransaction),
        });
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
