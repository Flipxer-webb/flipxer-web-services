import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { 
    ReportFilters, 
    ReportConfig, 
    ReportResult,
    TransactionReportRow,
    UserReportRow,
    RevenueReportRow,
    TaxReportRow,
} from "../types";
import { KycStage, OrderCategory, OrderStreamlinedStatus, Prisma } from "@prisma/client";
import { buildIndividualVerificationSnapshot } from "@/modules/api/auth/utils/individual-kyc-stage-state.util";

@Injectable()
export class ReportsService {
    private readonly logger = new Logger(ReportsService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Generate a report based on configuration
     */
    async generateReport(config: ReportConfig): Promise<ReportResult> {
        this.logger.log(`Generating ${config.type} report in ${config.format} format`);

        let data: any[];
        let filename: string;

        switch (config.type) {
            case "transactions":
                data = await this.getTransactionData(config.filters);
                filename = `transactions_${this.formatDateForFilename(new Date())}`;
                break;
            case "users":
                data = await this.getUserData(config.filters);
                filename = `users_${this.formatDateForFilename(new Date())}`;
                break;
            case "revenue":
                data = await this.getRevenueData(config.filters);
                filename = `revenue_${this.formatDateForFilename(new Date())}`;
                break;
            case "tax":
                data = await this.getTaxData(config.filters);
                filename = `tax_${this.formatDateForFilename(new Date())}`;
                break;
            default:
                throw new Error(`Unknown report type: ${config.type}`);
        }

        const content = config.format === "csv" 
            ? this.convertToCSV(data, config.includeHeaders !== false)
            : JSON.stringify(data, null, 2);

        return {
            filename: `${filename}.${config.format}`,
            contentType: config.format === "csv" ? "text/csv" : "application/json",
            data: content,
            rowCount: data.length,
            generatedAt: new Date(),
        };
    }

    /**
     * Get transaction data for report
     */
    private async getTransactionData(filters: ReportFilters): Promise<TransactionReportRow[]> {
        const where: Prisma.OrderWhereInput = this.buildOrderFilters(filters);

        const orders = await this.prisma.order.findMany({
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
            take: 10000, // Limit for performance
        });

        return orders.map((order) => ({
            id: order.id,
            date: order.createdAt.toISOString(),
            userId: order.userId,
            userEmail: order.user.email,
            userName: `${order.user.firstName || ""} ${order.user.lastName || ""}`.trim(),
            orderCategory: order.orderCategory,
            fromCurrency: order.fromCurrency || order.currency || "",
            toCurrency: order.toCurrency || "",
            amount: order.amount || order.fromAmount || 0,
            fee: order.fee || 0,
            total: order.total || 0,
            status: order.streamlinedStatus,
            paymentMethod: "QUIDAX",
            reference: order.orderReference || order.providerOrderId || "",
        }));
    }

    /**
     * Get user data for report
     */
    private async getUserData(filters: ReportFilters): Promise<UserReportRow[]> {
        const where: Prisma.UserWhereInput = {
            isDeleted: false,
            userType: { not: "ADMIN" },
        };

        if (filters.userType) {
            where.userType = filters.userType as any;
        }

        if (filters.country) {
            where.country = filters.country as any;
        }

        if (filters.startDate || filters.endDate) {
            where.createdAt = {};
            if (filters.startDate) where.createdAt.gte = filters.startDate;
            if (filters.endDate) where.createdAt.lte = filters.endDate;
        }

        const users = await this.prisma.user.findMany({
            where,
            select: {
                id: true,
                identifier: true,
                email: true,
                firstName: true,
                lastName: true,
                phone: true,
                userType: true,
                tier: true,
                country: true,
                status: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isDocumentVerified: true,
                createdAt: true,
                lastLogin: true,
                loginCount: true,
                bvn: true,
                nin: true,
                kycStageAttempts: {
                    where: {
                        journeyType: "INDIVIDUAL",
                        stage: KycStage.GOVERNMENT_ID,
                        isCurrent: true,
                    },
                    orderBy: [{ updatedAt: Prisma.SortOrder.desc }, { id: Prisma.SortOrder.desc }],
                    select: {
                        stage: true,
                        method: true,
                        status: true,
                        isCurrent: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
            take: 10000,
        });

        return users.map((user) => {
            const verificationSnapshot = buildIndividualVerificationSnapshot({
                bvn: user.bvn,
                nin: user.nin,
                kycStageAttempts: user.kycStageAttempts ?? [],
            });

            return {
                id: user.id,
                identifier: user.identifier,
                email: user.email,
                firstName: user.firstName || "",
                lastName: user.lastName || "",
                phone: user.phone || "",
                userType: user.userType,
                tier: user.tier,
                country: user.country,
                status: user.status,
                emailVerified: user.isEmailVerified,
                phoneVerified: user.isPhoneVerified,
                governmentIdVerified:
                    verificationSnapshot.bvnVerified
                    || verificationSnapshot.ninVerified
                    || Boolean(user.bvn)
                    || Boolean(user.nin),
                documentVerified: user.isDocumentVerified,
                createdAt: user.createdAt.toISOString(),
                lastLogin: user.lastLogin?.toISOString() || "",
                loginCount: user.loginCount,
            };
        });
    }

    /**
     * Get revenue data for report (aggregated)
     */
    private async getRevenueData(filters: ReportFilters): Promise<RevenueReportRow[]> {
        const where: Prisma.OrderWhereInput = this.buildOrderFilters(filters);
        where.streamlinedStatus = "completed";

        // Get raw orders for aggregation
        const orders = await this.prisma.order.findMany({
            where,
            select: {
                createdAt: true,
                orderCategory: true,
                currency: true,
                fromCurrency: true,
                amount: true,
                fromAmount: true,
                fee: true,
            },
            orderBy: { createdAt: "asc" },
        });

        // Group by date, category, and currency
        const grouped = new Map<string, RevenueReportRow>();

        for (const order of orders) {
            const date = order.createdAt.toISOString().split("T")[0];
            const currency = order.currency || order.fromCurrency || "NGN";
            const key = `${date}|${order.orderCategory}|${currency}`;

            if (!grouped.has(key)) {
                grouped.set(key, {
                    date,
                    orderCategory: order.orderCategory,
                    currency,
                    transactionCount: 0,
                    totalVolume: 0,
                    totalFees: 0,
                    avgTransactionValue: 0,
                });
            }

            const row = grouped.get(key);
            if (!row) {
                continue;
            }
            row.transactionCount++;
            row.totalVolume += order.amount || order.fromAmount || 0;
            row.totalFees += order.fee || 0;
        }

        // Calculate averages
        const result = Array.from(grouped.values());
        for (const row of result) {
            row.avgTransactionValue = row.transactionCount > 0 
                ? row.totalVolume / row.transactionCount 
                : 0;
        }

        return result.sort((a, b) => a.date.localeCompare(b.date));
    }

    /**
     * Get tax report data (per-user aggregation)
     */
    private async getTaxData(filters: ReportFilters): Promise<TaxReportRow[]> {
        const where: Prisma.OrderWhereInput = this.buildOrderFilters(filters);
        where.streamlinedStatus = "completed";

        // Get orders grouped by user
        const orders = await this.prisma.order.findMany({
            where,
            include: {
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
        });

        // Group by user
        const grouped = new Map<number, TaxReportRow>();

        for (const order of orders) {
            if (!grouped.has(order.userId)) {
                grouped.set(order.userId, {
                    userId: order.userId,
                    userEmail: order.user.email,
                    userName: `${order.user.firstName || ""} ${order.user.lastName || ""}`.trim(),
                    userType: order.user.userType,
                    totalTransactions: 0,
                    totalVolume: 0,
                    totalFees: 0,
                    totalBuyVolume: 0,
                    totalSellVolume: 0,
                    totalSwapVolume: 0,
                    period: this.formatPeriod(filters.startDate, filters.endDate),
                });
            }

            const row = grouped.get(order.userId);
            if (!row) {
                continue;
            }
            const amount = order.amount || order.fromAmount || 0;
            
            row.totalTransactions++;
            row.totalVolume += amount;
            row.totalFees += order.fee || 0;

            switch (order.orderCategory) {
                case "BUY":
                    row.totalBuyVolume += amount;
                    break;
                case "SELL":
                    row.totalSellVolume += amount;
                    break;
                case "SWAP":
                    row.totalSwapVolume += amount;
                    break;
            }
        }

        return Array.from(grouped.values())
            .sort((a, b) => b.totalVolume - a.totalVolume);
    }

    /**
     * Build Prisma filters for orders
     */
    private buildOrderFilters(filters: ReportFilters): Prisma.OrderWhereInput {
        const where: Prisma.OrderWhereInput = {};

        if (filters.startDate || filters.endDate) {
            where.createdAt = {};
            if (filters.startDate) where.createdAt.gte = filters.startDate;
            if (filters.endDate) where.createdAt.lte = filters.endDate;
        }

        if (filters.currency) {
            where.OR = [
                { currency: filters.currency },
                { fromCurrency: filters.currency },
                { toCurrency: filters.currency },
            ];
        }

        if (filters.status) {
            where.streamlinedStatus = filters.status as OrderStreamlinedStatus;
        }

        if (filters.orderCategory) {
            where.orderCategory = filters.orderCategory as OrderCategory;
        }

        return where;
    }

    /**
     * Convert data array to CSV string
     */
    private convertToCSV(data: any[], includeHeaders: boolean = true): string {
        if (data.length === 0) {
            return "";
        }

        const headers = Object.keys(data[0]);
        const rows: string[] = [];

        if (includeHeaders) {
            rows.push(headers.join(","));
        }

        for (const row of data) {
            const values = headers.map((header) => {
                const value = row[header];
                if (value === null || value === undefined) return "";
                if (typeof value === "string" && (value.includes(",") || value.includes('"'))) {
                    return `"${value.replaceAll('"', '""')}"`;
                }
                return String(value);
            });
            rows.push(values.join(","));
        }

        return rows.join("\n");
    }

    /**
     * Format date for filename
     */
    private formatDateForFilename(date: Date): string {
        return date.toISOString().split("T")[0].replaceAll("-", "");
    }

    /**
     * Format period string
     */
    private formatPeriod(startDate?: Date, endDate?: Date): string {
        const start = startDate?.toISOString().split("T")[0] || "beginning";
        const end = endDate?.toISOString().split("T")[0] || "now";
        return `${start} to ${end}`;
    }

    /**
     * Preview a report (returns summary and sample data)
     */
    async previewReport(config: ReportConfig): Promise<{
        totalRecords: number;
        estimatedSize: string;
        sampleData: any[];
        columns: string[];
    }> {
        this.logger.log(`Generating preview for ${config.type} report`);

        let data: any[];
        let columns: string[];

        switch (config.type) {
            case "transactions":
                data = await this.getTransactionData(config.filters || {});
                columns = ["id", "date", "userEmail", "userName", "orderCategory", "fromCurrency", "toCurrency", "amount", "fee", "total", "status"];
                break;
            case "users":
                data = await this.getUserData(config.filters || {});
                columns = ["id", "email", "firstName", "lastName", "createdAt", "verificationTier", "country", "status"];
                break;
            case "revenue":
                data = await this.getRevenueData(config.filters || {});
                columns = ["date", "category", "currency", "transactionCount", "totalVolume", "totalFees"];
                break;
            case "tax":
                data = await this.getTaxData(config.filters || {});
                columns = ["userId", "userEmail", "userName", "totalTransactions", "totalVolume", "totalFees"];
                break;
            default:
                throw new Error(`Unknown report type: ${config.type}`);
        }

        // Estimate size (rough calculation)
        const sampleSize = Math.min(10, data.length);
        const sampleData = data.slice(0, sampleSize);
        const sampleJson = JSON.stringify(sampleData);
        const avgRowSize = sampleSize > 0 ? sampleJson.length / sampleSize : 100;
        const estimatedBytes = avgRowSize * data.length;
        
        let estimatedSize: string;
        if (estimatedBytes < 1024) {
            estimatedSize = `${estimatedBytes.toFixed(0)} B`;
        } else if (estimatedBytes < 1024 * 1024) {
            estimatedSize = `${(estimatedBytes / 1024).toFixed(1)} KB`;
        } else {
            estimatedSize = `${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
        }

        return {
            totalRecords: data.length,
            estimatedSize,
            sampleData,
            columns,
        };
    }

    /**
     * Get available report types
     */
    getAvailableReports() {
        return [
            {
                type: "transactions",
                name: "Transaction Report",
                description: "All transactions with user details, amounts, fees, and status",
                filters: ["startDate", "endDate", "currency", "status", "orderCategory"],
            },
            {
                type: "users",
                name: "User Report",
                description: "All registered users with verification status and activity",
                filters: ["startDate", "endDate", "userType", "country"],
            },
            {
                type: "revenue",
                name: "Revenue Report",
                description: "Aggregated revenue by date, category, and currency",
                filters: ["startDate", "endDate", "currency", "orderCategory"],
            },
            {
                type: "tax",
                name: "Tax Report",
                description: "Per-user transaction totals for tax purposes",
                filters: ["startDate", "endDate"],
            },
        ];
    }
}
