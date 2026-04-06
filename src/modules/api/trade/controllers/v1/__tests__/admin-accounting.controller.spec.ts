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
        payment: {
            findMany: jest.Mock;
            count: jest.Mock;
        };
        $queryRaw: jest.Mock;
    };
    let solvencyService: {
        generateReport: jest.Mock;
    };
    let rateService: {
        getAssetUsdtPrice: jest.Mock;
    };
    let fincraService: {
        getWallets: jest.Mock;
    };
    let nombaService: {
        getAccountBalance: jest.Mock;
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
            payment: {
                findMany: jest.fn(),
                count: jest.fn(),
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

        fincraService = {
            getWallets: jest.fn(),
        };

        nombaService = {
            getAccountBalance: jest.fn(),
        };

        controller = new AdminAccountingController(
            prisma as any,
            solvencyService as any,
            { pairedCredit: jest.fn() } as any,
            rateService as any,
            adminSwapService as any,
            fincraService as any,
            nombaService as any,
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

    it("returns fiat gateway summary with balances from both providers", async () => {
        fincraService.getWallets.mockResolvedValue({
            data: [
                {
                    currency: "NGN",
                    availableBalance: 500000,
                    lockedBalance: 20000,
                    ledgerBalance: 520000,
                },
                {
                    currency: "USD",
                    availableBalance: 1000,
                    lockedBalance: 0,
                    ledgerBalance: 1000,
                },
            ],
        });

        nombaService.getAccountBalance.mockResolvedValue({
            data: {
                currency: "NGN",
                availableBalance: 300000,
                lockedBalance: 10000,
                balance: 310000,
            },
        });

        const result = await controller.getFiatGatewaySummary();

        expect(result.message).toBe("Fiat gateway summary retrieved");
        expect(result.data.gateways).toHaveLength(3);
        expect(result.data.gateways[0]).toEqual(
            expect.objectContaining({ provider: "Fincra", status: "connected", currency: "NGN" }),
        );
        expect(result.data.gateways[2]).toEqual(
            expect.objectContaining({ provider: "Nomba", status: "connected", currency: "NGN" }),
        );
        expect(result.data.totals.totalAvailable).toBe(801000);
        expect(result.data.totals.connectedGateways).toBe(3);
    });

    it("returns fiat gateway summary with error status when providers fail", async () => {
        fincraService.getWallets.mockRejectedValue(new Error("Fincra timeout"));
        nombaService.getAccountBalance.mockRejectedValue(new Error("Nomba auth failed"));

        jest.spyOn((controller as any).logger, "error").mockImplementation(() => undefined);

        const result = await controller.getFiatGatewaySummary();

        expect(result.message).toBe("Fiat gateway summary retrieved");
        expect(result.data.gateways).toHaveLength(2);
        expect(result.data.gateways[0]).toEqual(
            expect.objectContaining({ provider: "Fincra", status: "error", error: "Unable to connect to Fincra" }),
        );
        expect(result.data.gateways[1]).toEqual(
            expect.objectContaining({ provider: "Nomba", status: "error", error: "Unable to connect to Nomba" }),
        );
        expect(result.data.totals.totalAvailable).toBe(0);
        expect(result.data.totals.connectedGateways).toBe(0);
    });

    it("returns paginated fiat gateway activity with filters", async () => {
        prisma.payment.findMany.mockResolvedValue([
            {
                id: 1,
                reference: "ref-001",
                transactionId: "txn-001",
                paymentMethod: "FINCRA",
                flow: "IN",
                amount: 50000,
                expectedCurrency: "NGN",
                status: "COMPLETED",
                userId: 1,
                narration: "Deposit",
                createdAt: new Date("2026-01-10"),
                updatedAt: new Date("2026-01-10"),
                user: { id: 1, email: "alice@example.com", firstName: "Alice", lastName: "Doe" },
            },
        ]);
        prisma.payment.count.mockResolvedValue(1);

        const result = await controller.getFiatGatewayActivity(1, 20, "fincra", "collection");

        expect(result.message).toBe("Fiat gateway activity retrieved");
        expect(result.data.records).toHaveLength(1);
        expect(result.data.records[0]).toEqual(
            expect.objectContaining({
                provider: "Fincra",
                type: "collection",
                amount: 50000,
                currency: "NGN",
            }),
        );
        expect(result.data.meta.totalCount).toBe(1);
    });

    it("returns fiat gateway activity for all providers when no filter specified", async () => {
        prisma.payment.findMany.mockResolvedValue([]);
        prisma.payment.count.mockResolvedValue(0);

        const result = await controller.getFiatGatewayActivity(1, 20);

        expect(result.message).toBe("Fiat gateway activity retrieved");
        expect(result.data.records).toHaveLength(0);
        expect(result.data.meta.totalCount).toBe(0);
    });
});
