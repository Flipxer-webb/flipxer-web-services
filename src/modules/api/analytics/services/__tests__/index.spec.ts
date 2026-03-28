import { AnalyticsService } from "..";

/* ------------------------------------------------------------------ */
/*  Mock heavy transitive deps that Prisma / NestJS would pull in     */
/* ------------------------------------------------------------------ */
jest.mock("@nestjs/common", () => {
    const actual = jest.requireActual("@nestjs/common");
    return {
        ...actual,
        Logger: class {
            log = jest.fn();
            error = jest.fn();
            warn = jest.fn();
            debug = jest.fn();
        },
    };
});

/* ------------------------------------------------------------------ */
/*  Prisma mock factory                                               */
/* ------------------------------------------------------------------ */
function createMockPrisma() {
    return {
        user: {
            count: jest.fn().mockResolvedValue(0),
            findMany: jest.fn().mockResolvedValue([]),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        order: {
            count: jest.fn().mockResolvedValue(0),
            findMany: jest.fn().mockResolvedValue([]),
            aggregate: jest.fn().mockResolvedValue({ _sum: { amountInFiat: 0 } }),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        cryptoRate: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
    };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
const FIXED_START = "2025-01-01";
const FIXED_END = "2025-01-02";

function customDateQuery(extra: Record<string, unknown> = {}) {
    return { startDate: FIXED_START, endDate: FIXED_END, ...extra };
}

function periodQuery(period = "month") {
    return { period } as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("AnalyticsService", () => {
    let service: AnalyticsService;
    let prisma: ReturnType<typeof createMockPrisma>;

    beforeEach(() => {
        prisma = createMockPrisma();
        service = new AnalyticsService(prisma as any);
    });

    // ==================== getDashboardOverview ====================

    describe("getDashboardOverview", () => {
        it("returns overview with custom date range", async () => {
            prisma.user.count.mockResolvedValue(100);
            prisma.order.groupBy.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
            prisma.order.count.mockResolvedValue(50);
            prisma.order.aggregate.mockResolvedValue({ _sum: { amountInFiat: 500_000 } });
            prisma.order.findMany.mockResolvedValue([
                { fee: 0.001, rateAtConversion: 1_000_000 },
            ]);

            const res = await service.getDashboardOverview(customDateQuery());

            expect(res.data.totalUsers).toBe(100);
            expect(res.data.activeUsers).toBe(2);
            expect(res.data.totalTransactions).toBe(50);
            expect(res.data.totalVolume).toBe(500_000);
            expect(res.data.overview.revenue.amount).toBe(1_000);
        });

        it("uses period fallback when no custom dates", async () => {
            prisma.user.count.mockResolvedValue(0);
            prisma.order.groupBy.mockResolvedValue([]);
            prisma.order.count.mockResolvedValue(0);
            prisma.order.aggregate.mockResolvedValue({ _sum: { amountInFiat: null } });
            prisma.order.findMany.mockResolvedValue([]);

            const res = await service.getDashboardOverview(periodQuery("week"));

            expect(res.data.totalVolume).toBe(0);
            expect(res.data.overview.revenue.amount).toBe(0);
        });

        it("handles percentage change when previous period is zero", async () => {
            // First batch (current period)
            prisma.user.count
                .mockResolvedValueOnce(10)   // totalUsers
                .mockResolvedValueOnce(5)    // newUsersCount
                .mockResolvedValueOnce(0)    // kycPendingCount
                .mockResolvedValueOnce(0)    // prevNewUsers
                .mockResolvedValueOnce(3);   // verifiedUsers

            prisma.order.groupBy.mockResolvedValue([{ userId: 1 }]);
            prisma.order.count.mockResolvedValue(10);
            prisma.order.aggregate
                .mockResolvedValueOnce({ _sum: { amountInFiat: 1000 } })   // current
                .mockResolvedValueOnce({ _sum: { amountInFiat: 0 } });     // previous
            prisma.order.findMany
                .mockResolvedValueOnce([{ fee: 0.01, rateAtConversion: 100 }])  // current revenue
                .mockResolvedValueOnce([]);                                       // previous revenue

            const res = await service.getDashboardOverview(customDateQuery());

            expect(res.data.growth.users).toBe(100);
            expect(res.data.growth.volume).toBe(100);
        });

        it("computes negative percentage change correctly", async () => {
            prisma.user.count
                .mockResolvedValueOnce(10)   // totalUsers
                .mockResolvedValueOnce(2)    // newUsersCount (current)
                .mockResolvedValueOnce(0)    // kycPendingCount
                .mockResolvedValueOnce(10)   // prevNewUsers (higher)
                .mockResolvedValueOnce(5);   // verifiedUsers

            prisma.order.groupBy.mockResolvedValue([]);
            prisma.order.count.mockResolvedValue(0);
            prisma.order.aggregate.mockResolvedValue({ _sum: { amountInFiat: 0 } });
            prisma.order.findMany.mockResolvedValue([]);

            const res = await service.getDashboardOverview(customDateQuery());

            expect(res.data.growth.users).toBe(-80);
        });
    });

    // ==================== getTransactionVolume ====================

    describe("getTransactionVolume", () => {
        it("returns chart data with daily granularity", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    createdAt: new Date("2025-01-01T10:00:00Z"),
                    amountInFiat: 1000,
                    fee: 0.01,
                    rateAtConversion: 100,
                    orderCategory: "BUY",
                },
            ]);
            prisma.order.groupBy.mockResolvedValue([
                { orderCategory: "BUY", _sum: { amountInFiat: 1000 }, _count: 1 },
            ]);

            const res = await service.getTransactionVolume(
                customDateQuery({ granularity: "daily" }) as any,
            );

            expect(res.data.chartData).toBeDefined();
            expect(res.data.categoryBreakdown.length).toBe(1);
            expect(res.data.summary.totalTransactions).toBe(1);
        });

        it("filters by category when provided", async () => {
            prisma.order.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            await service.getTransactionVolume(
                customDateQuery({ category: "BUY", granularity: "daily" }) as any,
            );

            expect(prisma.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ orderCategory: "BUY" }),
                }),
            );
        });

        it("does not filter category when 'all'", async () => {
            prisma.order.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            await service.getTransactionVolume(
                customDateQuery({ category: "all", granularity: "daily" }) as any,
            );

            const callArg = prisma.order.findMany.mock.calls[0][0];
            expect(callArg.where.orderCategory).toBeUndefined();
        });

        it("uses period fallback when no dates", async () => {
            prisma.order.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionVolume(
                periodQuery("today") as any,
            );

            expect(res.data.summary.averageTransactionSize).toBe(0);
        });

        it("computes averageTransactionSize with transactions", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    createdAt: new Date("2025-01-01T05:00:00Z"),
                    amountInFiat: 2000,
                    fee: 0,
                    rateAtConversion: 0,
                    orderCategory: "SELL",
                },
                {
                    createdAt: new Date("2025-01-01T06:00:00Z"),
                    amountInFiat: 4000,
                    fee: 0,
                    rateAtConversion: 0,
                    orderCategory: "SELL",
                },
            ]);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionVolume(
                customDateQuery({ granularity: "daily" }) as any,
            );

            expect(res.data.summary.averageTransactionSize).toBe(3000);
        });

        it("supports hourly granularity", async () => {
            prisma.order.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionVolume(
                customDateQuery({ granularity: "hourly" }) as any,
            );

            expect(res.data.chartData.length).toBeGreaterThan(1);
        });

        it("supports weekly granularity", async () => {
            prisma.order.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionVolume({
                startDate: "2025-01-01",
                endDate: "2025-01-31",
                granularity: "weekly",
            } as any);

            expect(res.data.chartData.length).toBeGreaterThanOrEqual(1);
        });

        it("supports monthly granularity", async () => {
            prisma.order.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionVolume({
                startDate: "2025-01-01",
                endDate: "2025-03-31",
                granularity: "monthly",
            } as any);

            expect(res.data.chartData.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ==================== getTransactionsByStatus ====================

    describe("getTransactionsByStatus", () => {
        it("returns status breakdown with percentages", async () => {
            prisma.order.groupBy.mockResolvedValue([
                { streamlinedStatus: "completed", _count: 80, _sum: { amountInFiat: 8000 } },
                { streamlinedStatus: "failed", _count: 20, _sum: { amountInFiat: 2000 } },
            ]);

            const res = await service.getTransactionsByStatus(customDateQuery());

            expect(res.data.total).toBe(100);
            expect(res.data.breakdown[0].percentage).toBe("80.00");
        });

        it("handles zero total gracefully", async () => {
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionsByStatus(customDateQuery());

            expect(res.data.total).toBe(0);
            expect(res.data.breakdown).toEqual([]);
        });

        it("uses period fallback", async () => {
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getTransactionsByStatus(periodQuery("quarter"));

            expect(res.data.total).toBe(0);
        });
    });

    // ==================== getUserGrowth ====================

    describe("getUserGrowth", () => {
        it("returns cumulative growth chart with custom dates", async () => {
            prisma.user.findMany.mockResolvedValue([
                { createdAt: new Date("2025-01-01T10:00:00Z"), userType: "INDIVIDUAL" },
            ]);
            prisma.user.count.mockResolvedValue(50); // existingUsersCount
            prisma.user.groupBy.mockResolvedValue([
                { userType: "INDIVIDUAL", _count: 40 },
                { userType: "BUSINESS", _count: 10 },
            ]);

            const res = await service.getUserGrowth(customDateQuery() as any);

            expect(res.data.summary.totalNewUsers).toBe(1);
            expect(res.data.summary.totalUsers).toBeGreaterThanOrEqual(50);
            expect(res.data.userTypeBreakdown.length).toBe(2);
        });

        it("filters specific userType", async () => {
            prisma.user.findMany.mockResolvedValue([]);
            prisma.user.count.mockResolvedValue(0);
            prisma.user.groupBy.mockResolvedValue([]);

            await service.getUserGrowth(
                customDateQuery({ userType: "BUSINESS" }) as any,
            );

            expect(prisma.user.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ userType: "BUSINESS" }),
                }),
            );
        });

        it("excludes ADMIN when userType is 'all'", async () => {
            prisma.user.findMany.mockResolvedValue([]);
            prisma.user.count.mockResolvedValue(0);
            prisma.user.groupBy.mockResolvedValue([]);

            await service.getUserGrowth(
                customDateQuery({ userType: "all" }) as any,
            );

            const callArg = prisma.user.findMany.mock.calls[0][0];
            expect(callArg.where.userType).toEqual({ not: "ADMIN" });
        });

        it("uses period fallback and default ADMIN exclusion", async () => {
            prisma.user.findMany.mockResolvedValue([]);
            prisma.user.count.mockResolvedValue(0);
            prisma.user.groupBy.mockResolvedValue([]);

            const res = await service.getUserGrowth(periodQuery("year") as any);

            expect(res.data.summary.totalNewUsers).toBe(0);
        });
    });

    // ==================== getUserActivity ====================

    describe("getUserActivity", () => {
        it("returns active users, logins and top users", async () => {
            prisma.order.groupBy.mockResolvedValue([
                { userId: 1 },
                { userId: 2 },
            ]);
            prisma.user.findMany
                .mockResolvedValueOnce([
                    { id: 1, loginCount: 5, lastLogin: new Date() },
                ])
                .mockResolvedValueOnce([
                    { id: 1, firstName: "John", lastName: "Doe", email: "j@test.com", userType: "INDIVIDUAL" },
                ]);

            const topVolume = [
                { userId: 1, _sum: { amountInFiat: 50000 }, _count: 10 },
            ];
            // order.groupBy is called twice: first for activeUserIds, then for topUsersByVolume
            prisma.order.groupBy
                .mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }])
                .mockResolvedValueOnce(topVolume);

            const res = await service.getUserActivity(customDateQuery());

            expect(res.data.activeUsers).toBe(2);
            expect(res.data.loggedInUsers).toBe(1);
        });

        it("handles no activity gracefully", async () => {
            prisma.order.groupBy.mockResolvedValue([]);
            prisma.user.findMany.mockResolvedValue([]);

            const res = await service.getUserActivity(customDateQuery());

            expect(res.data.activeUsers).toBe(0);
            expect(res.data.loggedInUsers).toBe(0);
            expect(res.data.topUsers).toEqual([]);
        });
    });

    // ==================== getRevenueAnalytics ====================

    describe("getRevenueAnalytics", () => {
        it("returns revenue chart and category breakdown", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    createdAt: new Date("2025-01-01T12:00:00Z"),
                    fee: 0.01,
                    rateAtConversion: 1_000_000,
                    orderCategory: "BUY",
                    currency: "BTC",
                },
                {
                    createdAt: new Date("2025-01-01T14:00:00Z"),
                    fee: 0.02,
                    rateAtConversion: 500_000,
                    orderCategory: "SELL",
                    currency: "ETH",
                },
            ]);

            const res = await service.getRevenueAnalytics(customDateQuery() as any);

            expect(res.data.summary.totalRevenue).toBe(20_000);
            expect(res.data.categoryBreakdown.length).toBe(2);
            // BUY revenue = 10000 => 50%, SELL = 10000 => 50%
            const buyCategory = res.data.categoryBreakdown.find(
                (c: any) => c.category === "BUY",
            );
            expect(buyCategory.percentage).toBe("50.00");
        });

        it("handles zero revenue percentage gracefully", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const res = await service.getRevenueAnalytics(customDateQuery() as any);

            expect(res.data.summary.totalRevenue).toBe(0);
            expect(res.data.summary.averageFeePerTransaction).toBe(0);
        });

        it("applies currency filter", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            await service.getRevenueAnalytics(
                customDateQuery({ currency: "BTC" }) as any,
            );

            expect(prisma.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ currency: "BTC" }),
                }),
            );
        });

        it("uses period fallback", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const res = await service.getRevenueAnalytics(periodQuery() as any);

            expect(res.data.summary.currency).toBe("NGN");
        });

        it("accumulates same-category revenues in the Map", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    createdAt: new Date("2025-01-01T10:00:00Z"),
                    fee: 0.01,
                    rateAtConversion: 100,
                    orderCategory: "BUY",
                    currency: "BTC",
                },
                {
                    createdAt: new Date("2025-01-01T11:00:00Z"),
                    fee: 0.02,
                    rateAtConversion: 100,
                    orderCategory: "BUY",
                    currency: "BTC",
                },
            ]);

            const res = await service.getRevenueAnalytics(customDateQuery() as any);

            expect(res.data.categoryBreakdown.length).toBe(1);
            expect(res.data.categoryBreakdown[0].transactionCount).toBe(2);
            expect(res.data.categoryBreakdown[0].revenue).toBe(3); // (0.01+0.02)*100
        });
    });

    // ==================== getAssetDistribution ====================

    describe("getAssetDistribution", () => {
        it("returns balance distribution with NGN conversion", async () => {
            prisma.$queryRaw.mockResolvedValue([
                { currency: "BTC", total_balance: 2.5, user_count: 100 },
                { currency: "ETH", total_balance: 50, user_count: 80 },
            ]);
            prisma.cryptoRate.findMany.mockResolvedValue([
                { currency: "btc", buyRate: 100_000_000 },
                { currency: "eth", buyRate: 5_000_000 },
            ]);
            prisma.order.groupBy.mockResolvedValue([
                { currency: "BTC", _sum: { amountInFiat: 5_000_000 }, _count: 50 },
            ]);

            const res = await service.getAssetDistribution({ limit: 5 });

            expect(res.data.byBalance.length).toBe(2);
            expect(res.data.byBalance[0].totalBalanceNGN).toBe(250_000_000);
            expect(res.data.totalValueNGN).toBe(500_000_000);
            expect(res.data.byVolume.length).toBe(1);
        });

        it("defaults limit to 10", async () => {
            prisma.$queryRaw.mockResolvedValue([]);
            prisma.cryptoRate.findMany.mockResolvedValue([]);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getAssetDistribution({});

            expect(res.data.byBalance).toEqual([]);
            expect(res.data.totalValueNGN).toBe(0);
        });

        it("handles unknown currency (rate = 0)", async () => {
            prisma.$queryRaw.mockResolvedValue([
                { currency: "DOGE", total_balance: 1000, user_count: 5 },
            ]);
            prisma.cryptoRate.findMany.mockResolvedValue([]); // no rate
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getAssetDistribution({});

            expect(res.data.byBalance[0].totalBalanceNGN).toBe(0);
        });
    });

    // ==================== getConversionFunnel ====================

    describe("getConversionFunnel", () => {
        it("returns funnel with percentages", async () => {
            prisma.user.count
                .mockResolvedValueOnce(100)  // signups
                .mockResolvedValueOnce(90)   // emailVerified
                .mockResolvedValueOnce(80)   // phoneVerified
                .mockResolvedValueOnce(60)   // kycStarted
                .mockResolvedValueOnce(40);  // kycCompleted
            prisma.order.groupBy.mockResolvedValue(
                Array.from({ length: 30 }, (_, i) => ({ userId: i + 1 })),
            );

            const res = await service.getConversionFunnel(customDateQuery());

            const funnel = res.data.funnel;
            expect(funnel).toHaveLength(6);
            expect(funnel[0].stage).toBe("Signups");
            expect(funnel[0].count).toBe(100);
            expect(funnel[0].percentage).toBe(100);
            expect(funnel[5].stage).toBe("First Transaction");
            expect(funnel[5].count).toBe(30);
            expect(funnel[5].percentage).toBe("30.00");
        });

        it("handles zero signups gracefully", async () => {
            prisma.user.count.mockResolvedValue(0);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getConversionFunnel(customDateQuery());

            const funnel = res.data.funnel;
            expect(funnel[1].percentage).toBe(0);
            expect(funnel[5].percentage).toBe(0);
        });

        it("uses period fallback", async () => {
            prisma.user.count.mockResolvedValue(0);
            prisma.order.groupBy.mockResolvedValue([]);

            const res = await service.getConversionFunnel(periodQuery("all"));

            expect(res.data.funnel).toHaveLength(6);
        });
    });

    // ==================== getDateRange (via public methods) ====================

    describe("getDateRange coverage via period variants", () => {
        beforeEach(() => {
            prisma.order.groupBy.mockResolvedValue([]);
        });

        it.each(["today", "week", "month", "quarter", "year", "all", "unknown"])(
            "period '%s' produces a valid response",
            async (period) => {
                prisma.user.count.mockResolvedValue(0);
                prisma.order.groupBy.mockResolvedValue([]);

                const res = await service.getConversionFunnel({ period });

                expect(res.data.funnel).toHaveLength(6);
            },
        );
    });
});
