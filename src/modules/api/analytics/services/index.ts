import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import {
    startOfDay,
    endOfDay,
    startOfWeek,
    endOfWeek,
    startOfMonth,
    endOfMonth,
    startOfQuarter,
    endOfQuarter,
    startOfYear,
    endOfYear,
    subDays,
    subMonths,
    format,
    eachDayOfInterval,
    eachWeekOfInterval,
    eachMonthOfInterval,
    eachHourOfInterval,
} from "date-fns";
import { OrderCategory, OrderStreamlinedStatus, UserType } from "@prisma/client";
import {
    GetAnalyticsDto,
    GetChartDataDto,
    GetUserGrowthDto,
    GetRevenueAnalyticsDto,
    GetAssetDistributionDto,
} from "../dtos";

@Injectable()
export class AnalyticsService {
    private readonly logger = new Logger(AnalyticsService.name);

    constructor(private readonly prisma: PrismaService) { }

    // ==================== DASHBOARD OVERVIEW ====================

    async getDashboardOverview(query: GetAnalyticsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        const [
            totalUsers,
            newUsersCount,
            activeUsersCount,
            totalTransactions,
            transactionVolume,
            revenueOrders,
            kycPendingCount,
        ] = await Promise.all([
            // Total users
            this.prisma.user.count({ where: { userType: { not: UserType.ADMIN } } }),

            // New users in period
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                },
            }),

            // Active users (users with transactions in period)
            this.prisma.order.groupBy({
                by: ["userId"],
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }).then(r => r.length),

            // Total transactions in period
            this.prisma.order.count({
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }),

            // Transaction volume in period
            this.prisma.order.aggregate({
                _sum: { amountInFiat: true },
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }),

            // Fetch orders with fee and rate to calculate revenue in fiat
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

            // KYC pending count
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    OR: [
                        { isBvnVerified: false },
                        { isNinVerified: false },
                        { isDocumentVerified: false },
                    ],
                },
            }),
        ]);

        // Calculate total revenue in fiat (fee * rateAtConversion for each order)
        const totalRevenue = revenueOrders.reduce((sum, order) => {
            const fee = order.fee || 0;
            const rate = order.rateAtConversion || 0;
            return sum + (fee * rate);
        }, 0);

        // Calculate previous period for comparison
        const periodDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const prevStartDate = subDays(startDate, periodDays);
        const prevEndDate = subDays(endDate, periodDays);

        const [prevNewUsers, prevTransactionVolume, prevRevenueOrders] = await Promise.all([
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: prevStartDate, lte: prevEndDate },
                },
            }),
            this.prisma.order.aggregate({
                _sum: { amountInFiat: true },
                where: {
                    createdAt: { gte: prevStartDate, lte: prevEndDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }),
            this.prisma.order.findMany({
                where: {
                    createdAt: { gte: prevStartDate, lte: prevEndDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    fee: { not: null },
                },
                select: {
                    fee: true,
                    rateAtConversion: true,
                },
            }),
        ]);

        // Calculate previous period revenue in fiat
        const prevRevenue = prevRevenueOrders.reduce((sum, order) => {
            const fee = order.fee || 0;
            const rate = order.rateAtConversion || 0;
            return sum + (fee * rate);
        }, 0);

        // Calculate percentage changes
        const volumeChange = this.calculatePercentageChange(
            prevTransactionVolume._sum.amountInFiat || 0,
            transactionVolume._sum.amountInFiat || 0
        );
        const revenueChange = this.calculatePercentageChange(
            prevRevenue,
            totalRevenue
        );
        const usersChange = this.calculatePercentageChange(prevNewUsers, newUsersCount);

        // Count verified users (tier >= 2 or all verifications complete)
        const verifiedUsers = await this.prisma.user.count({
            where: {
                userType: { not: UserType.ADMIN },
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
            },
        });

        return buildResponse({
            message: "Dashboard overview retrieved successfully",
            data: {
                // Flat structure expected by frontend
                totalUsers,
                activeUsers: activeUsersCount,
                totalTransactions,
                totalVolume: transactionVolume._sum.amountInFiat || 0,
                pendingKyc: kycPendingCount,
                verifiedUsers,
                growth: {
                    users: usersChange,
                    transactions: 0, // Calculated separately if needed
                    volume: volumeChange,
                },
                // Also include nested for backwards compatibility
                overview: {
                    totalUsers,
                    newUsers: {
                        count: newUsersCount,
                        change: usersChange,
                    },
                    activeUsers: activeUsersCount,
                    totalTransactions,
                    transactionVolume: {
                        amount: transactionVolume._sum.amountInFiat || 0,
                        change: volumeChange,
                        currency: "NGN",
                    },
                    revenue: {
                        amount: totalRevenue,
                        change: revenueChange,
                        currency: "NGN",
                    },
                    kycPending: kycPendingCount,
                },
                period: {
                    start: startDate,
                    end: endDate,
                },
            },
        });
    }

    // ==================== TRANSACTION ANALYTICS ====================

    async getTransactionVolume(query: GetChartDataDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");
        const granularity = query.granularity || "daily";

        const categoryFilter = query.category && query.category !== "all"
            ? { orderCategory: query.category as OrderCategory }
            : {};

        // Get transaction data grouped by date (include rateAtConversion for fee calculation)
        const transactions = await this.prisma.order.findMany({
            where: {
                createdAt: { gte: startDate, lte: endDate },
                streamlinedStatus: OrderStreamlinedStatus.completed,
                ...categoryFilter,
            },
            select: {
                createdAt: true,
                amountInFiat: true,
                fee: true,
                rateAtConversion: true,
                orderCategory: true,
            },
        });

        // Generate date intervals
        const intervals = this.generateIntervals(startDate, endDate, granularity);

        // Helper function to calculate fee in fiat
        const calculateFeeInFiat = (t: { fee: number | null; rateAtConversion: number | null }) => {
            return (t.fee || 0) * (t.rateAtConversion || 0);
        };

        // Aggregate data by interval
        const chartData = intervals.map((interval) => {
            const intervalEnd = this.getIntervalEnd(interval, granularity);
            const intervalTransactions = transactions.filter(
                (t) => t.createdAt >= interval && t.createdAt < intervalEnd
            );

            return {
                date: format(interval, this.getDateFormat(granularity)),
                timestamp: interval.toISOString(),
                volume: intervalTransactions.reduce((sum, t) => sum + (t.amountInFiat || 0), 0),
                count: intervalTransactions.length,
                fees: intervalTransactions.reduce((sum, t) => sum + calculateFeeInFiat(t), 0),
            };
        });

        // Get category breakdown
        const categoryBreakdown = await this.prisma.order.groupBy({
            by: ["orderCategory"],
            where: {
                createdAt: { gte: startDate, lte: endDate },
                streamlinedStatus: OrderStreamlinedStatus.completed,
            },
            _sum: { amountInFiat: true },
            _count: true,
        });

        return buildResponse({
            message: "Transaction volume data retrieved successfully",
            data: {
                chartData,
                categoryBreakdown: categoryBreakdown.map((c) => ({
                    category: c.orderCategory,
                    volume: c._sum.amountInFiat || 0,
                    count: c._count,
                })),
                summary: {
                    totalVolume: transactions.reduce((sum, t) => sum + (t.amountInFiat || 0), 0),
                    totalTransactions: transactions.length,
                    totalFees: transactions.reduce((sum, t) => sum + calculateFeeInFiat(t), 0),
                    averageTransactionSize: transactions.length > 0
                        ? transactions.reduce((sum, t) => sum + (t.amountInFiat || 0), 0) / transactions.length
                        : 0,
                },
            },
        });
    }

    async getTransactionsByStatus(query: GetAnalyticsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        const statusCounts = await this.prisma.order.groupBy({
            by: ["streamlinedStatus"],
            where: {
                createdAt: { gte: startDate, lte: endDate },
            },
            _count: true,
            _sum: { amountInFiat: true },
        });

        const total = statusCounts.reduce((sum, s) => sum + s._count, 0);

        return buildResponse({
            message: "Transaction status breakdown retrieved successfully",
            data: {
                breakdown: statusCounts.map((s) => ({
                    status: s.streamlinedStatus,
                    count: s._count,
                    volume: s._sum.amountInFiat || 0,
                    percentage: total > 0 ? ((s._count / total) * 100).toFixed(2) : 0,
                })),
                total,
            },
        });
    }

    // ==================== USER ANALYTICS ====================

    async getUserGrowth(query: GetUserGrowthDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");
        const granularity = "daily";

        const userTypeFilter = query.userType && query.userType !== "all"
            ? { userType: query.userType as UserType }
            : { userType: { not: UserType.ADMIN } };

        const users = await this.prisma.user.findMany({
            where: {
                createdAt: { gte: startDate, lte: endDate },
                ...userTypeFilter,
            },
            select: {
                createdAt: true,
                userType: true,
            },
        });

        const intervals = this.generateIntervals(startDate, endDate, granularity);

        // Calculate cumulative user growth
        const existingUsersCount = await this.prisma.user.count({
            where: {
                createdAt: { lt: startDate },
                ...userTypeFilter,
            },
        });

        let cumulativeCount = existingUsersCount;
        const chartData = intervals.map((interval) => {
            const intervalEnd = this.getIntervalEnd(interval, granularity);
            const newUsersInInterval = users.filter(
                (u) => u.createdAt >= interval && u.createdAt < intervalEnd
            ).length;
            cumulativeCount += newUsersInInterval;

            return {
                date: format(interval, "yyyy-MM-dd"),
                newUsers: newUsersInInterval,
                totalUsers: cumulativeCount,
            };
        });

        // User type breakdown
        const userTypeBreakdown = await this.prisma.user.groupBy({
            by: ["userType"],
            where: {
                userType: { not: UserType.ADMIN },
            },
            _count: true,
        });

        // Verification status breakdown
        const verificationBreakdown = await this.prisma.user.groupBy({
            by: ["tier"],
            where: {
                userType: { not: UserType.ADMIN },
            },
            _count: true,
        });

        return buildResponse({
            message: "User growth data retrieved successfully",
            data: {
                chartData,
                userTypeBreakdown: userTypeBreakdown.map((u) => ({
                    type: u.userType,
                    count: u._count,
                })),
                verificationBreakdown: verificationBreakdown.map((v) => ({
                    tier: v.tier,
                    count: v._count,
                })),
                summary: {
                    totalNewUsers: users.length,
                    totalUsers: cumulativeCount,
                    averageGrowthPerDay: (users.length / intervals.length).toFixed(2),
                },
            },
        });
    }

    async getUserActivity(query: GetAnalyticsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        // Users with transactions
        const activeUserIds = await this.prisma.order.groupBy({
            by: ["userId"],
            where: {
                createdAt: { gte: startDate, lte: endDate },
            },
        });

        // User login activity
        const loginActivity = await this.prisma.user.findMany({
            where: {
                userType: { not: UserType.ADMIN },
                lastLogin: { gte: startDate, lte: endDate },
            },
            select: {
                id: true,
                loginCount: true,
                lastLogin: true,
            },
        });

        // Top users by transaction volume
        const topUsersByVolume = await this.prisma.order.groupBy({
            by: ["userId"],
            where: {
                createdAt: { gte: startDate, lte: endDate },
                streamlinedStatus: OrderStreamlinedStatus.completed,
            },
            _sum: { amountInFiat: true },
            _count: true,
            orderBy: { _sum: { amountInFiat: "desc" } },
            take: 10,
        });

        // Get user details for top users
        const topUserDetails = await this.prisma.user.findMany({
            where: { id: { in: topUsersByVolume.map((u) => u.userId) } },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                userType: true,
            },
        });

        const topUsers = topUsersByVolume.map((u) => {
            const details = topUserDetails.find((d) => d.id === u.userId);
            return {
                ...details,
                transactionVolume: u._sum.amountInFiat || 0,
                transactionCount: u._count,
            };
        });

        return buildResponse({
            message: "User activity data retrieved successfully",
            data: {
                activeUsers: activeUserIds.length,
                loggedInUsers: loginActivity.length,
                topUsers,
            },
        });
    }

    // ==================== REVENUE ANALYTICS ====================

    async getRevenueAnalytics(query: GetRevenueAnalyticsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");
        const granularity = "daily";

        const transactions = await this.prisma.order.findMany({
            where: {
                createdAt: { gte: startDate, lte: endDate },
                streamlinedStatus: OrderStreamlinedStatus.completed,
                ...(query.currency && { currency: query.currency }),
            },
            select: {
                createdAt: true,
                fee: true,
                rateAtConversion: true,
                orderCategory: true,
                currency: true,
            },
        });

        // Helper function to calculate fee in fiat
        const calculateFeeInFiat = (t: { fee: number | null; rateAtConversion: number | null }) => {
            return (t.fee || 0) * (t.rateAtConversion || 0);
        };

        const intervals = this.generateIntervals(startDate, endDate, granularity);

        const chartData = intervals.map((interval) => {
            const intervalEnd = this.getIntervalEnd(interval, granularity);
            const intervalTransactions = transactions.filter(
                (t) => t.createdAt >= interval && t.createdAt < intervalEnd
            );

            return {
                date: format(interval, "yyyy-MM-dd"),
                revenue: intervalTransactions.reduce((sum, t) => sum + calculateFeeInFiat(t), 0),
                transactionCount: intervalTransactions.length,
            };
        });

        // Calculate total revenue in fiat
        const totalRevenue = transactions.reduce((sum, t) => sum + calculateFeeInFiat(t), 0);

        // Calculate revenue by category (need to fetch individual transactions for accurate conversion)
        const categoryRevenueMap = new Map<string, { revenue: number; count: number }>();
        transactions.forEach((t) => {
            const category = t.orderCategory;
            const feeInFiat = calculateFeeInFiat(t);
            if (categoryRevenueMap.has(category)) {
                const existing = categoryRevenueMap.get(category)!;
                existing.revenue += feeInFiat;
                existing.count += 1;
            } else {
                categoryRevenueMap.set(category, { revenue: feeInFiat, count: 1 });
            }
        });

        const categoryBreakdown = Array.from(categoryRevenueMap.entries()).map(([category, data]) => ({
            category,
            revenue: data.revenue,
            transactionCount: data.count,
            percentage: totalRevenue > 0
                ? ((data.revenue / totalRevenue) * 100).toFixed(2)
                : 0,
        }));

        return buildResponse({
            message: "Revenue analytics retrieved successfully",
            data: {
                chartData,
                categoryBreakdown,
                summary: {
                    totalRevenue,
                    averageFeePerTransaction: transactions.length > 0
                        ? (totalRevenue / transactions.length).toFixed(2)
                        : 0,
                    currency: "NGN",
                },
            },
        });
    }

    // ==================== ASSET ANALYTICS ====================

    async getAssetDistribution(query: GetAssetDistributionDto): Promise<ApiResponse> {
        const limit = query.limit || 10;

        // Get asset balances from LedgerEntries (virtual balance system)
        // Aggregate by currency using the latest balanceAfter for each user
        const [ledgerBalances, cryptoRates, assetVolume] = await Promise.all([
            this.prisma.$queryRaw<
                { currency: string; total_balance: number; user_count: number }[]
            >`
                WITH latest_entries AS (
                    SELECT DISTINCT ON ("userId", currency)
                        "userId",
                        currency,
                        "balanceAfter"
                    FROM "LedgerEntries"
                    WHERE status != 'FAILED'
                    ORDER BY "userId", currency, "createdAt" DESC
                )
                SELECT 
                    currency,
                    SUM("balanceAfter")::float as total_balance,
                    COUNT(DISTINCT "userId")::int as user_count
                FROM latest_entries
                WHERE "balanceAfter" > 0
                GROUP BY currency
                ORDER BY total_balance DESC
                LIMIT ${limit}
            `,
            // Fetch crypto rates for NGN conversion (using buyRate which is in NGN)
            this.prisma.cryptoRate.findMany(),
            // Get transaction volume by asset
            this.prisma.order.groupBy({
                by: ["currency"],
                where: {
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
                _sum: { amountInFiat: true },
                _count: true,
                orderBy: { _sum: { amountInFiat: "desc" } },
                take: limit,
            }),
        ]);

        // Create rate map: currency -> buyRate (NGN per 1 crypto unit)
        const rateMap = new Map<string, number>();
        for (const rate of cryptoRates) {
            rateMap.set(rate.currency.toUpperCase(), rate.buyRate || 0);
        }

        // Calculate NGN value for each currency
        const byBalanceWithNGN = ledgerBalances.map((a) => {
            const rate = rateMap.get(a.currency.toUpperCase()) || 0;
            const totalBalanceNGN = (a.total_balance || 0) * rate;
            return {
                asset: a.currency,
                totalBalance: a.total_balance || 0,
                totalBalanceNGN: totalBalanceNGN,
                walletsCount: a.user_count || 0,
            };
        });

        // Calculate total NGN value across all assets
        const totalValueNGN = byBalanceWithNGN.reduce((sum, a) => sum + a.totalBalanceNGN, 0);

        return buildResponse({
            message: "Asset distribution retrieved successfully",
            data: {
                byBalance: byBalanceWithNGN,
                totalValueNGN,
                byVolume: assetVolume.map((a) => ({
                    asset: a.currency,
                    volume: a._sum.amountInFiat || 0,
                    transactionCount: a._count,
                })),
            },
        });
    }

    // ==================== CONVERSION FUNNEL ====================

    async getConversionFunnel(query: GetAnalyticsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        // Funnel stages
        const [
            signups,
            emailVerified,
            phoneVerified,
            kycStarted,
            kycCompleted,
            firstTransaction,
        ] = await Promise.all([
            // Signups
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                },
            }),

            // Email verified
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                    isEmailVerified: true,
                },
            }),

            // Phone verified
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                    isPhoneVerified: true,
                },
            }),

            // KYC started (tier >= 1)
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                    tier: { gte: 1 },
                },
            }),

            // KYC completed (tier >= 2)
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                    tier: { gte: 2 },
                },
            }),

            // First transaction (users who signed up in period and made a transaction)
            this.prisma.order.groupBy({
                by: ["userId"],
                where: {
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    user: {
                        createdAt: { gte: startDate, lte: endDate },
                    },
                },
            }).then(r => r.length),
        ]);

        const funnel = [
            { stage: "Signups", count: signups, percentage: 100 },
            {
                stage: "Email Verified",
                count: emailVerified,
                percentage: signups > 0 ? ((emailVerified / signups) * 100).toFixed(2) : 0,
            },
            {
                stage: "Phone Verified",
                count: phoneVerified,
                percentage: signups > 0 ? ((phoneVerified / signups) * 100).toFixed(2) : 0,
            },
            {
                stage: "KYC Started",
                count: kycStarted,
                percentage: signups > 0 ? ((kycStarted / signups) * 100).toFixed(2) : 0,
            },
            {
                stage: "KYC Completed",
                count: kycCompleted,
                percentage: signups > 0 ? ((kycCompleted / signups) * 100).toFixed(2) : 0,
            },
            {
                stage: "First Transaction",
                count: firstTransaction,
                percentage: signups > 0 ? ((firstTransaction / signups) * 100).toFixed(2) : 0,
            },
        ];

        return buildResponse({
            message: "Conversion funnel data retrieved successfully",
            data: { funnel },
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
            case "all":
                return { startDate: new Date(0), endDate: now };
            default:
                return { startDate: startOfMonth(now), endDate: endOfMonth(now) };
        }
    }

    private generateIntervals(startDate: Date, endDate: Date, granularity: string): Date[] {
        switch (granularity) {
            case "hourly":
                return eachHourOfInterval({ start: startDate, end: endDate });
            case "daily":
                return eachDayOfInterval({ start: startDate, end: endDate });
            case "weekly":
                return eachWeekOfInterval({ start: startDate, end: endDate });
            case "monthly":
                return eachMonthOfInterval({ start: startDate, end: endDate });
            default:
                return eachDayOfInterval({ start: startDate, end: endDate });
        }
    }

    private getIntervalEnd(date: Date, granularity: string): Date {
        switch (granularity) {
            case "hourly":
                return new Date(date.getTime() + 60 * 60 * 1000);
            case "daily":
                return endOfDay(date);
            case "weekly":
                return endOfWeek(date);
            case "monthly":
                return endOfMonth(date);
            default:
                return endOfDay(date);
        }
    }

    private getDateFormat(granularity: string): string {
        switch (granularity) {
            case "hourly":
                return "yyyy-MM-dd HH:00";
            case "daily":
                return "yyyy-MM-dd";
            case "weekly":
                return "yyyy-'W'ww";
            case "monthly":
                return "yyyy-MM";
            default:
                return "yyyy-MM-dd";
        }
    }

    private calculatePercentageChange(previous: number, current: number): number {
        if (previous === 0) return current > 0 ? 100 : 0;
        return Number((((current - previous) / previous) * 100).toFixed(2));
    }
}
