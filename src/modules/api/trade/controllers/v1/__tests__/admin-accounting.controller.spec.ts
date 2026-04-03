jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    __esModule: true,
}));

import { OrderCategory } from "@prisma/client";
import { AdminAccountingController } from "../admin-accounting.controller";

describe("AdminAccountingController", () => {
    let controller: AdminAccountingController;
    let prisma: {
        ledgerEntry: {
            findMany: jest.Mock;
            aggregate: jest.Mock;
        };
        order: {
            findMany: jest.Mock;
        };
        user: {
            findMany: jest.Mock;
        };
        assetWallet: {
            findMany: jest.Mock;
        };
        $queryRaw: jest.Mock;
    };
    let solvencyService: {
        generateReport: jest.Mock;
    };
    let rateService: {
        getAssetUsdtPrice: jest.Mock;
    };

    beforeEach(() => {
        prisma = {
            ledgerEntry: {
                findMany: jest.fn(),
                aggregate: jest.fn(),
            },
            order: {
                findMany: jest.fn(),
            },
            user: {
                findMany: jest.fn(),
            },
            assetWallet: {
                findMany: jest.fn(),
            },
            $queryRaw: jest.fn(),
        };

        solvencyService = {
            generateReport: jest.fn(),
        };

        rateService = {
            getAssetUsdtPrice: jest.fn(),
        };

        const adminSwapService = {
            getSwapQuote: jest.fn(),
            confirmSwap: jest.fn(),
        };

        controller = new AdminAccountingController(
            prisma as any,
            solvencyService as any,
            rateService as any,
            adminSwapService as any,
        );

        jest.spyOn((controller as any).logger, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("returns grouped trading balances with sorting and filters", async () => {
        prisma.ledgerEntry.findMany
            .mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }])
            .mockResolvedValueOnce([
                {
                    userId: 1,
                    currency: "BTC",
                    balanceAfter: 10,
                    updatedAt: new Date("2026-01-01"),
                    user: {
                        id: 1,
                        email: "alice@example.com",
                        firstName: "Alice",
                        lastName: "Doe",
                        userType: "INDIVIDUAL",
                    },
                },
                {
                    userId: 2,
                    currency: "USDT",
                    balanceAfter: 5,
                    updatedAt: new Date("2026-01-02"),
                    user: {
                        id: 2,
                        email: "bob@example.com",
                        firstName: "Bob",
                        lastName: "Ray",
                        userType: "BUSINESS",
                    },
                },
            ]);

        prisma.ledgerEntry.aggregate
            .mockResolvedValueOnce({ _sum: { holdAmount: 1 } })
            .mockResolvedValueOnce({ _sum: { credit: 12, debit: 2 } })
            .mockResolvedValueOnce({ _sum: { holdAmount: 0 } })
            .mockResolvedValueOnce({ _sum: { credit: 5, debit: 1 } });

        rateService.getAssetUsdtPrice
            .mockResolvedValueOnce(2)
            .mockRejectedValueOnce(new Error("missing rate"));

        const result = await controller.getTradingBalances(
            1,
            20,
            "btc",
            "ali",
            "INDIVIDUAL",
            "highest",
        );

        expect(prisma.ledgerEntry.findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    currency: "BTC",
                    user: expect.objectContaining({ userType: "INDIVIDUAL" }),
                }),
                distinct: ["userId"],
            }),
        );
        expect(result.message).toBe("Trading balances retrieved");
        expect(result.data.records).toHaveLength(2);
        expect(result.data.records[0].userId).toBe(1);
        expect(result.data.records[0].totalBalanceUsdt).toBeGreaterThan(result.data.records[1].totalBalanceUsdt);
    });

    it("returns grouped swap log by user with filters", async () => {
        prisma.order.findMany
            .mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }])
            .mockResolvedValueOnce([
                {
                    id: 101,
                    userId: 1,
                    fromCurrency: "USDT",
                    toCurrency: "BTC",
                    fromAmount: 100,
                    toAmount: 0.002,
                    executionPrice: 50000,
                    quoted_price: 50500,
                    streamlinedStatus: "COMPLETED",
                    createdAt: new Date("2026-01-03"),
                    user: { id: 1, email: "alice@example.com", firstName: "Alice", lastName: "Doe" },
                },
                {
                    id: 102,
                    userId: 1,
                    fromCurrency: "BTC",
                    toCurrency: "USDT",
                    fromAmount: 0.001,
                    toAmount: 50,
                    executionPrice: null,
                    quoted_price: 50000,
                    streamlinedStatus: "COMPLETED",
                    createdAt: new Date("2026-01-04"),
                    user: { id: 1, email: "alice@example.com", firstName: "Alice", lastName: "Doe" },
                },
                {
                    id: 103,
                    userId: 2,
                    fromCurrency: "USDT",
                    toCurrency: "ETH",
                    fromAmount: 25,
                    toAmount: 0.01,
                    executionPrice: 2500,
                    quoted_price: 2550,
                    streamlinedStatus: "COMPLETED",
                    createdAt: new Date("2026-01-05"),
                    user: { id: 2, email: "bob@example.com", firstName: "Bob", lastName: "Ray" },
                },
            ]);

        const result = await controller.getSwapLog(1, 20, "COMPLETED", "usdt");

        expect(prisma.order.findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    orderCategory: OrderCategory.SWAP,
                    streamlinedStatus: "COMPLETED",
                }),
                distinct: ["userId"],
            }),
        );
        expect(result.message).toBe("Swap log retrieved");
        expect(result.data.records).toHaveLength(2);
        expect(result.data.records.find((x: any) => x.userId === 1)?.swapCount).toBe(2);
    });

    it("returns deposit and withdrawal summary grouped by user and network", async () => {
        prisma.$queryRaw.mockResolvedValue([
            {
                userId: 1,
                currency: "BTC",
                type: "DEPOSIT",
                network: "bitcoin",
                total_credit: 1.5,
                total_debit: 0,
                entry_count: 2,
            },
            {
                userId: 1,
                currency: "BTC",
                type: "WITHDRAWAL",
                network: "bitcoin",
                total_credit: 0,
                total_debit: 0.4,
                entry_count: 1,
            },
        ]);

        prisma.user.findMany
            .mockResolvedValueOnce([{ id: 1 }])
            .mockResolvedValueOnce([
                { id: 1, firstName: "Alice", lastName: "Doe", email: "alice@example.com" },
            ]);

        const result = await controller.getDepositWithdrawalSummary(1, 20, "BTC", "alice");

        expect(result.message).toBe("Deposit/withdrawal summary retrieved");
        expect(result.data.records).toHaveLength(1);
        expect(result.data.records[0].totalDeposits).toBe(1.5);
        expect(result.data.records[0].totalWithdrawals).toBe(0.4);
        expect(result.data.records[0].currencies[0].net).toBe(1.1);
    });

    it("returns on-chain solvency summary with network mapping", async () => {
        solvencyService.generateReport.mockResolvedValue({
            currencies: [
                {
                    currency: "BTC",
                    platformReserves: 3,
                    userLiabilities: 2,
                    reserveRatio: 1.5,
                    status: "HEALTHY",
                },
                {
                    currency: "USDT",
                    platformReserves: 500,
                    userLiabilities: 450,
                    reserveRatio: 1.11,
                    status: "HEALTHY",
                },
            ],
            overallStatus: "HEALTHY",
            timestamp: "2026-03-29T08:00:00.000Z",
        });

        prisma.assetWallet.findMany.mockResolvedValue([
            { assetCurrency: "BTC", defaultNetwork: "bitcoin" },
            { assetCurrency: "USDT", defaultNetwork: "tron" },
        ]);

        const result = await controller.getOnChainSummary();

        expect(result.message).toBe("On-chain summary retrieved");
        expect(result.data.wallets).toHaveLength(2);
        expect(result.data.wallets[0]).toEqual(
            expect.objectContaining({ currency: "BTC", network: "bitcoin" }),
        );
        expect(result.data.totals.walletCount).toBe(2);
        expect(result.data.totals.totalValueUsd).toBe(503);
        expect(result.data.overallStatus).toBe("HEALTHY");
    });
});
