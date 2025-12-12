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

    constructor(private readonly prisma: PrismaService) {}

    // ==================== DASHBOARD OVERVIEW ====================

    async getDashboardOverview(query: GetAnalyticsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        const [
            totalUsers,
            newUsersCount,
            activeUsersCount,
            totalTransactions,
            transactionVolume,
            totalRevenue,
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
            
            // Total fees collected (revenue)
            this.prisma.order.aggregate({
                _sum: { fee: true },
                where: {
                    createdAt: { gte: startDate, lte: endDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
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

        // Calculate previous period for comparison
        const periodDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const prevStartDate = subDays(startDate, periodDays);
        const prevEndDate = subDays(endDate, periodDays);

        const [prevNewUsers, prevTransactionVolume, prevRevenue] = await Promise.all([
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
            this.prisma.order.aggregate({
                _sum: { fee: true },
                where: {
                    createdAt: { gte: prevStartDate, lte: prevEndDate },
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                },
            }),
        ]);

        // Calculate percentage changes
        const volumeChange = this.calculatePercentageChange(
            prevTransactionVolume._sum.amountInFiat || 0,
            transactionVolume._sum.amountInFiat || 0
        );
        const revenueChange = this.calculatePercentageChange(
            prevRevenue._sum.fee || 0,
            totalRevenue._sum.fee || 0
        );
        const usersChange = this.calculatePercentageChange(prevNewUsers, newUsersCount);

        return buildResponse({
            message: "Dashboard overview retrieved successfully",
            data: {
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
                        amount: totalRevenue._sum.fee || 0,
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

        // Get transaction data grouped by date
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
                orderCategory: true,
            },
        });

        // Generate date intervals
        const intervals = this.generateIntervals(startDate, endDate, granularity);

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
                fees: intervalTransactions.reduce((sum, t) => sum + (t.fee || 0), 0),
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
                    totalFees: transactions.reduce((sum, t) => sum + (t.fee || 0), 0),
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
                orderCategory: true,
                currency: true,
            },
        });

        const intervals = this.generateIntervals(startDate, endDate, granularity);

        const chartData = intervals.map((interval) => {
            const intervalEnd = this.getIntervalEnd(interval, granularity);
            const intervalTransactions = transactions.filter(
                (t) => t.createdAt >= interval && t.createdAt < intervalEnd
            );

            return {
                date: format(interval, "yyyy-MM-dd"),
                revenue: intervalTransactions.reduce((sum, t) => sum + (t.fee || 0), 0),
                transactionCount: intervalTransactions.length,
            };
        });

        // Revenue by category
        const revenueByCategory = await this.prisma.order.groupBy({
            by: ["orderCategory"],
            where: {
                createdAt: { gte: startDate, lte: endDate },
                streamlinedStatus: OrderStreamlinedStatus.completed,
            },
            _sum: { fee: true },
            _count: true,
        });

        const totalRevenue = transactions.reduce((sum, t) => sum + (t.fee || 0), 0);

        return buildResponse({
            message: "Revenue analytics retrieved successfully",
            data: {
                chartData,
                categoryBreakdown: revenueByCategory.map((c) => ({
                    category: c.orderCategory,
                    revenue: c._sum.fee || 0,
                    transactionCount: c._count,
                    percentage: totalRevenue > 0
                        ? (((c._sum.fee || 0) / totalRevenue) * 100).toFixed(2)
                        : 0,
                })),
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

        // Get asset wallet balances
        const assetBalances = await this.prisma.assetWallet.groupBy({
            by: ["assetCurrency"],
            _sum: { convertedBalance: true },
            _count: true,
            orderBy: { _sum: { convertedBalance: "desc" } },
            take: limit,
        });

        // Get transaction volume by asset
        const assetVolume = await this.prisma.order.groupBy({
            by: ["currency"],
            where: {
                streamlinedStatus: OrderStreamlinedStatus.completed,
            },
            _sum: { amountInFiat: true },
            _count: true,
            orderBy: { _sum: { amountInFiat: "desc" } },
            take: limit,
        });

        return buildResponse({
            message: "Asset distribution retrieved successfully",
            data: {
                byBalance: assetBalances.map((a) => ({
                    asset: a.assetCurrency,
                    totalBalance: a._sum.convertedBalance,
                    walletsCount: a._count,
                })),
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
