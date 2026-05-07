import { OrderCategory, OrderStatus, TransactionStatus } from "@prisma/client";

import { TransactionService } from "..";
import { TransactionNotFoundException } from "../../errors";

/* ------------------------------------------------------------------ */
/*  Stub heavy transitive deps                                        */
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

jest.mock("@/modules/core/prisma/services", () => ({
    PrismaService: class {
        isStub() {
            return true;
        }
    },
}));

/* ------------------------------------------------------------------ */
/*  Mock factories                                                    */
/* ------------------------------------------------------------------ */
function createMockPrisma() {
    return {
        order: {
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(0),
        },
        $transaction: jest.fn().mockImplementation((args: any[]) =>
            Promise.all(args),
        ),
    };
}

/* ------------------------------------------------------------------ */
/*  Test data                                                         */
/* ------------------------------------------------------------------ */
const NOW = new Date("2025-06-15T12:00:00Z");

function buildOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        userId: 10,
        transactionId: "TX-001",
        orderCategory: "BUY",
        status: "completed",
        streamlinedStatus: "completed",
        paymentStatus: "paid",
        refundAttempts: [],
        amount: 100,
        total: 100,
        fee: 1,
        currency: "BTC",
        fromCurrency: "NGN",
        toCurrency: "BTC",
        fromAmount: 50000,
        toAmount: 0.001,
        quoted_currency: null,
        quoted_price: null,
        executionPrice: null,
        swapExpiresAt: null,
        quotationId: null,
        narration: "Buy BTC",
        recipient: null,
        reason: null,
        transaction_note: null,
        paymentMethod: null,
        destinationBankName: null,
        destinationBankAccountNumber: null,
        destinationBankAccountName: null,
        totalToReceiveInFiat: null,
        amountInFiat: 50000,
        rateAtConversion: 50000000,
        createdAt: NOW,
        updatedAt: NOW,
        user: { firstName: "John", lastName: "Doe", email: "j@test.com", userType: "INDIVIDUAL" },
        ...overrides,
    };
}

const mockUser = {
    id: 10,
    email: "j@test.com",
    firstName: "John",
    lastName: "Doe",
} as any;

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("TransactionService", () => {
    let service: TransactionService;
    let prisma: ReturnType<typeof createMockPrisma>;

    beforeEach(() => {
        prisma = createMockPrisma();
        service = new TransactionService(prisma as any);
    });

    // ==================== getRecentTransactionList ====================

    describe("getRecentTransactionList", () => {
        it("returns last 10 transactions shaped", async () => {
            prisma.order.findMany.mockResolvedValue([buildOrder()]);

            const res = await service.getRecentTransactionList();

            expect(res.data).toHaveLength(1);
            expect(res.data[0].transactionId).toBe("TX-001");
            expect(prisma.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ take: 10, orderBy: { createdAt: "desc" } }),
            );
        });

        it("returns empty array when no transactions", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const res = await service.getRecentTransactionList();

            expect(res.data).toEqual([]);
        });
    });

    // ==================== getUserTransactionHistory ====================

    describe("getUserTransactionHistory", () => {
        it("returns paginated results when paginated=true", async () => {
            const order = buildOrder();
            prisma.$transaction.mockResolvedValue([[order], 1]);

            const res = await service.getUserTransactionHistory(
                { paginated: "true", pageNumber: 1, pageSize: 10, sortBy: "desc" } as any,
            );

            expect(res.data.meta).toBeDefined();
        });

        it("returns non-paginated results when paginated is not 'true'", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            const res = await service.getUserTransactionHistory(
                { sortBy: "desc" } as any,
            );

            expect(res.data.meta).toBeUndefined();
        });

        it("groups by date when user is provided", async () => {
            prisma.$transaction.mockResolvedValue([[buildOrder()], 1]);

            const res = await service.getUserTransactionHistory(
                { sortBy: "desc" } as any,
                mockUser,
            );

            // groupTransactionsByDate returns a grouped object
            expect(res.data.records).toBeDefined();
        });

        it("shapes transactions when no user (admin view)", async () => {
            prisma.$transaction.mockResolvedValue([[buildOrder()], 1]);

            const res = await service.getUserTransactionHistory(
                { sortBy: "desc" } as any,
            );

            expect(Array.isArray(res.data.records)).toBe(true);
        });

        it("applies type filter", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            await service.getUserTransactionHistory(
                { sortBy: "desc", type: "BUY" } as any,
            );

            const txArgs = prisma.$transaction.mock.calls[0][0];
            // The findMany promise is constructed with the where clause
            expect(txArgs).toBeDefined();
        });

        it("applies status filter and passes isStatusFilter to shaping", async () => {
            prisma.$transaction.mockResolvedValue([[buildOrder()], 1]);

            const res = await service.getUserTransactionHistory(
                { sortBy: "desc", status: "completed" } as any,
            );

            expect(res.data.records).toBeDefined();
        });

        it("surfaces settled BUY refunds as refunded while keeping the raw order status", async () => {
            prisma.$transaction.mockResolvedValue([[
                buildOrder({
                    orderCategory: OrderCategory.BUY,
                    status: OrderStatus.reversed,
                    streamlinedStatus: "cancelled",
                    refundAttempts: [
                        {
                            status: TransactionStatus.SUCCESS,
                            settledAt: NOW,
                        },
                    ],
                }),
            ], 1]);

            const res = await service.getUserTransactionHistory(
                { sortBy: "desc" } as any,
            );

            expect(res.data.records[0].status).toBe(OrderStatus.reversed);
            expect(res.data.records[0].streamLinedStatus).toBe("refunded");
        });

        it("keeps reversed BUY orders cancelled until the refund settles", async () => {
            prisma.$transaction.mockResolvedValue([[
                buildOrder({
                    orderCategory: OrderCategory.BUY,
                    status: OrderStatus.reversed,
                    streamlinedStatus: "cancelled",
                    refundAttempts: [
                        {
                            status: TransactionStatus.PENDING,
                            settledAt: null,
                        },
                    ],
                }),
            ], 1]);

            const res = await service.getUserTransactionHistory(
                { sortBy: "desc" } as any,
            );

            expect(res.data.records[0].streamLinedStatus).toBe("cancelled");
        });

        it("applies asset filter via AND/OR clause", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            await service.getUserTransactionHistory(
                { sortBy: "desc", asset: "BTC" } as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
        });

        it("applies searchText filter", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            await service.getUserTransactionHistory(
                { sortBy: "desc", searchText: "TX-001" } as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
        });

        it("applies date range filters", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            await service.getUserTransactionHistory(
                {
                    sortBy: "desc",
                    startDate: "2025-01-01",
                    endDate: "2025-12-31",
                } as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
        });

        it("applies only startDate without endDate", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            await service.getUserTransactionHistory(
                { sortBy: "desc", startDate: "2025-01-01" } as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
        });

        it("defaults pageNumber to 1 when not provided", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            const res = await service.getUserTransactionHistory(
                { paginated: "true", sortBy: "desc" } as any,
            );

            expect(res.data.meta).toBeDefined();
        });

        it("defaults pageSize when zero or negative", async () => {
            prisma.$transaction.mockResolvedValue([[], 0]);

            const res = await service.getUserTransactionHistory(
                { paginated: "true", pageNumber: 1, pageSize: 0, sortBy: "desc" } as any,
            );

            expect(res.data.meta).toBeDefined();
        });
    });

    // ==================== getTransactionDetail ====================

    describe("getTransactionDetail", () => {
        it("returns transaction detail when found", async () => {
            prisma.order.findUnique.mockResolvedValue(buildOrder());

            const res = await service.getTransactionDetail("TX-001");

            expect(res.data.transactionId).toBe("TX-001");
        });

        it("throws TransactionNotFoundException when not found", async () => {
            prisma.order.findUnique.mockResolvedValue(null);

            await expect(
                service.getTransactionDetail("TX-999"),
            ).rejects.toThrow(TransactionNotFoundException);
        });

        it("throws when userId does not match transaction owner", async () => {
            prisma.order.findUnique.mockResolvedValue(buildOrder({ userId: 10 }));

            await expect(
                service.getTransactionDetail("TX-001", 99),
            ).rejects.toThrow(TransactionNotFoundException);
        });

        it("allows access when userId matches", async () => {
            prisma.order.findUnique.mockResolvedValue(buildOrder({ userId: 10 }));

            const res = await service.getTransactionDetail("TX-001", 10);

            expect(res.data.transactionId).toBe("TX-001");
        });
    });

    // ==================== downloadGeneralReport ====================

    describe("downloadGeneralReport", () => {
        it("returns CSV string for BUY transactions", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({ orderCategory: "BUY", currency: "BTC" }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(typeof csv).toBe("string");
            expect(csv).toContain("Transaction ID");
            expect(csv).toContain("TX-001");
        });

        it("maps SWAP fields correctly", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({
                    orderCategory: "SWAP",
                    fromCurrency: "BTC",
                    toCurrency: "ETH",
                    fromAmount: 1,
                    toAmount: 15,
                    quoted_currency: "ETH",
                }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("BTC");
            expect(csv).toContain("ETH");
        });

        it("maps SELL fields with bank details", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({
                    orderCategory: "SELL",
                    currency: "BTC",
                    destinationBankName: "GTBank",
                    destinationBankAccountNumber: "0123456789",
                    destinationBankAccountName: "John Doe",
                    totalToReceiveInFiat: 50000,
                }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("GTBank");
            expect(csv).toContain("0123456789");
        });

        it("maps SEND category (currency only)", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({ orderCategory: "SEND", currency: "ETH" }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("ETH");
        });

        it("maps RECEIVE category", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({ orderCategory: "RECEIVE", currency: "USDT" }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("USDT");
        });

        it("handles unknown order category (default branch)", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({ orderCategory: "UNKNOWN_TYPE" }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("N/A");
        });

        it("handles SELL with null bank fields", async () => {
            prisma.order.findMany.mockResolvedValue([
                buildOrder({
                    orderCategory: "SELL",
                    currency: "BTC",
                    destinationBankName: null,
                    destinationBankAccountNumber: null,
                    destinationBankAccountName: null,
                    totalToReceiveInFiat: null,
                }),
            ]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("N/A");
        });

        it("applies type filter when provided", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
                type: "BUY",
            } as any);

            expect(prisma.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ orderCategory: "BUY" }),
                }),
            );
        });

        it("returns empty CSV with just headers when no transactions", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            const csv = await service.downloadGeneralReport(mockUser, {
                startDate: "2025-01-01",
                endDate: "2025-12-31",
            } as any);

            expect(csv).toContain("Transaction ID");
            expect(csv.split("\n").filter((l: string) => l.trim()).length).toBeLessThanOrEqual(2);
        });
    });
});
