jest.mock("@/config", () => ({
    quidaxConfig: {
        api_public: "pk_test",
        api_secret: "sk_test",
        baseUrl: "https://quidax.test",
        rampBaseUrl: "https://quidax-ramp.test",
    },
}));

jest.mock("@/libs/quidax", () => ({
    QuidaxLib: jest.fn(),
}));

import { QuidaxLib } from "@/libs/quidax";
import { WalletManagementService } from "../wallet-management.service";

describe("WalletManagementService", () => {
    let service: WalletManagementService;

    const mockGetUserWalletList = jest.fn();
    const mockGetSingleMarketTicker = jest.fn();

    const prisma = {
        systemSetting: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        user: {
            count: jest.fn(),
        },
        $queryRaw: jest.fn(),
        cryptoRate: {
            findMany: jest.fn(),
        },
    };

    const cacheService = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    const coinGeckoCache = {
        getPriceInUSD: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();

        (QuidaxLib as unknown as jest.Mock).mockImplementation(() => ({
            getUserWalletList: mockGetUserWalletList,
            getSingleMarketTicker: mockGetSingleMarketTicker,
        }));

        service = new WalletManagementService(
            prisma as any,
            cacheService as any,
            coinGeckoCache as any
        );
    });

    it("returns cached wallet balances when available", async () => {
        const cached = {
            totalNgnValue: 1200,
            totalUsdValue: 0.75,
            wallets: [],
            lastUpdated: new Date().toISOString(),
        };
        cacheService.get.mockResolvedValueOnce(cached);

        const result = await service.getWalletBalances();

        expect(result).toEqual(cached);
        expect(mockGetUserWalletList).not.toHaveBeenCalled();
    });

    it("fetches fresh wallet balances and caches result", async () => {
        cacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        coinGeckoCache.getPriceInUSD.mockResolvedValue(1);
        mockGetSingleMarketTicker.mockResolvedValue({
            data: { ticker: { last: "1600" } },
        });
        mockGetUserWalletList.mockResolvedValue({
            data: [
                {
                    currency: "btc",
                    name: "Bitcoin",
                    balance: "1.5",
                    locked: "0.2",
                    staked: "0.1",
                    converted_balance: "4000000",
                    default_network: "BTC",
                    is_crypto: true,
                },
            ],
        });

        const result = await service.getWalletBalances();

        expect(result.wallets).toHaveLength(1);
        expect(result.wallets[0].availableBalance).toBe("1.2");
        expect(result.totalNgnValue).toBe(4000000);
        expect(result.totalUsdValue).toBeCloseTo(2500, 8);
        expect(cacheService.set).toHaveBeenCalledWith(
            "exchange:ngn:usd",
            expect.any(Number),
            300
        );
        expect(cacheService.set).toHaveBeenCalledWith(
            "admin:quidax:wallets",
            expect.objectContaining({ wallets: expect.any(Array) }),
            45
        );
    });

    it("returns stale cache when Quidax fetch fails", async () => {
        const stale = {
            totalNgnValue: 2000,
            totalUsdValue: 1,
            wallets: [{ currency: "usdt" }],
            lastUpdated: new Date().toISOString(),
        };

        cacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(stale);
        mockGetUserWalletList.mockRejectedValue(new Error("quidax down"));

        const result = await service.getWalletBalances();

        expect(result).toEqual(stale);
    });

    it("returns empty wallet response when fetch fails and no cache exists", async () => {
        cacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockGetUserWalletList.mockRejectedValue(new Error("timeout"));

        const result = await service.getWalletBalances();

        expect(result.totalNgnValue).toBe(0);
        expect(result.totalUsdValue).toBe(0);
        expect(result.wallets).toEqual([]);
        expect(result.error).toMatch(/Failed to fetch wallet data/);
    });

    it("invalidates wallet cache", async () => {
        await service.invalidateWalletCache();

        expect(cacheService.del).toHaveBeenCalledWith("admin:quidax:wallets");
    });

    it("gets single wallet balance case-insensitively", async () => {
        jest.spyOn(service, "getWalletBalances").mockResolvedValue({
            totalNgnValue: 1,
            totalUsdValue: 1,
            wallets: [
                {
                    currency: "btc",
                    name: "Bitcoin",
                    balance: "1",
                    availableBalance: "1",
                    lockedBalance: "0",
                },
            ],
            lastUpdated: new Date().toISOString(),
        });

        const wallet = await service.getWalletBalance("BTC");

        expect(wallet?.currency).toBe("btc");
    });

    it("returns default liquidity thresholds when setting is missing", async () => {
        prisma.systemSetting.findUnique.mockResolvedValue(null);

        const thresholds = await service.getLiquidityThresholds();

        expect(thresholds).toHaveLength(4);
        expect(thresholds[0]).toEqual(expect.objectContaining({ currency: "btc" }));
    });

    it("detects low and high liquidity threshold breaches", async () => {
        jest.spyOn(service, "getLiquidityThresholds").mockResolvedValue([
            { currency: "btc", minBalance: 1, maxBalance: 5, alertEnabled: true },
            { currency: "eth", minBalance: 1, maxBalance: 2, alertEnabled: true },
        ] as any);
        jest.spyOn(service, "getWalletBalances").mockResolvedValue({
            totalNgnValue: 0,
            totalUsdValue: 0,
            wallets: [
                {
                    currency: "btc",
                    name: "Bitcoin",
                    balance: "0.5",
                    availableBalance: "0.5",
                    lockedBalance: "0",
                },
                {
                    currency: "eth",
                    name: "Ethereum",
                    balance: "3",
                    availableBalance: "3",
                    lockedBalance: "0",
                },
            ],
            lastUpdated: new Date().toISOString(),
        });

        const result = await service.checkLiquidityThresholds();

        expect(result.breaches).toHaveLength(2);
        expect(result.breaches[0].breachType).toBe("low");
        expect(result.breaches[1].breachType).toBe("high");
    });

    it("updates liquidity thresholds", async () => {
        prisma.systemSetting.upsert.mockResolvedValue({});

        const thresholds = [
            { currency: "usdt", minBalance: 100, maxBalance: 500, alertEnabled: true },
        ] as any;

        const result = await service.updateLiquidityThresholds(thresholds, 91);

        expect(prisma.systemSetting.upsert).toHaveBeenCalled();
        expect(result).toEqual(thresholds);
    });

    it("aggregates wallet statistics from ledger and crypto rates", async () => {
        prisma.user.count.mockResolvedValue(8);
        prisma.$queryRaw.mockResolvedValue([
            { currency: "btc", total_balance: 1.2, user_count: 2 },
            { currency: "eth", total_balance: 5, user_count: 4 },
        ]);
        prisma.cryptoRate.findMany.mockResolvedValue([
            { currency: "BTC", buyRate: 95000000 },
            { currency: "ETH", buyRate: 4200000 },
        ]);

        const result = await service.getWalletStatistics();

        expect(result.totalUsers).toBe(8);
        expect(result.totalWallets).toBe(2);
        expect(result.topCurrencies).toHaveLength(2);
        expect(result.totalValueNGN).toBeGreaterThan(0);
    });
});