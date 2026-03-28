import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {},
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { RateService } from "../rate.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";

function makePrisma() {
    return {
        cryptoRate: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
    };
}

describe("RateService", () => {
    let service: RateService;
    let prisma: ReturnType<typeof makePrisma>;
    let redisCacheService: { get: jest.Mock; set: jest.Mock };
    let liveCoinWatch: { getPriceInUSDT: jest.Mock; getBatchUsdtPrices: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockRedis = {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
        };
        const mockLcw = {
            getPriceInUSDT: jest.fn(),
            getBatchUsdtPrices: jest.fn(),
        };
        const mockSlack = {
            sendSystemAlert: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RateService,
                { provide: PrismaService, useValue: prisma },
                { provide: RedisCacheService, useValue: mockRedis },
                { provide: TradingInjectionToken.LIVECOINWATCH, useValue: mockLcw },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(RateService);
        redisCacheService = module.get(RedisCacheService);
        liveCoinWatch = module.get(TradingInjectionToken.LIVECOINWATCH);
    });

    afterEach(() => jest.clearAllMocks());

    // ── isDynamicRatesEnabled ────────────────────────────────

    describe("isDynamicRatesEnabled", () => {
        it("should return true by default (flag not set)", async () => {
            redisCacheService.get.mockResolvedValue(null);

            expect(await service.isDynamicRatesEnabled()).toBe(true);
        });

        it("should return false when explicitly disabled", async () => {
            redisCacheService.get.mockResolvedValue("false");

            expect(await service.isDynamicRatesEnabled()).toBe(false);
        });

        it("should return true when explicitly enabled", async () => {
            redisCacheService.get.mockResolvedValue("true");

            expect(await service.isDynamicRatesEnabled()).toBe(true);
        });
    });

    // ── getUsdtBaseRate ──────────────────────────────────────

    describe("getUsdtBaseRate", () => {
        it("should return cached USDT rate", async () => {
            redisCacheService.get.mockResolvedValue({ buyRate: 1600, sellRate: 1650 });

            const rate = await service.getUsdtBaseRate();

            expect(rate.buyRate).toBe(1600);
            expect(rate.sellRate).toBe(1650);
        });

        it("should fetch from DB and cache when not cached", async () => {
            redisCacheService.get.mockResolvedValue(null);
            prisma.cryptoRate.findUnique.mockResolvedValue({
                currency: "USDT",
                buyRate: 1600,
                sellRate: 1650,
            });

            const rate = await service.getUsdtBaseRate();

            expect(rate.buyRate).toBe(1600);
            expect(redisCacheService.set).toHaveBeenCalled();
        });

        it("should throw when USDT rate not configured", async () => {
            redisCacheService.get.mockResolvedValue(null);
            prisma.cryptoRate.findUnique.mockResolvedValue(null);

            await expect(service.getUsdtBaseRate()).rejects.toThrow();
        });
    });

    // ── getAssetUsdtPrice ────────────────────────────────────

    describe("getAssetUsdtPrice", () => {
        it("should return 1 for USDT", async () => {
            expect(await service.getAssetUsdtPrice("USDT")).toBe(1);
        });

        it("should use cached price when available", async () => {
            redisCacheService.get.mockResolvedValue(65000);

            const price = await service.getAssetUsdtPrice("BTC");

            expect(price).toBe(65000);
        });

        it("should fetch from LiveCoinWatch when not cached", async () => {
            redisCacheService.get.mockResolvedValue(null);
            liveCoinWatch.getPriceInUSDT.mockResolvedValue(65000);

            const price = await service.getAssetUsdtPrice("BTC");

            expect(price).toBe(65000);
        });
    });

    // ── getAssetRate ─────────────────────────────────────────

    describe("getAssetRate", () => {
        it("should return dynamic rate when enabled", async () => {
            // isDynamicRatesEnabled → true (default)
            redisCacheService.get
                .mockResolvedValueOnce(null)   // feature flag → null = true
                .mockResolvedValueOnce({ buyRate: 1600, sellRate: 1650 }) // USDT base rate cached
                .mockResolvedValueOnce(65000);  // BTC price cached

            const rate = await service.getAssetRate("BTC");

            expect(rate.source).toBe("dynamic");
            expect(rate.buyRate).toBe(65000 * 1600);
            expect(rate.sellRate).toBe(65000 * 1650);
        });

        it("should return database rate when dynamic disabled", async () => {
            redisCacheService.get.mockResolvedValue("false"); // feature flag off
            prisma.cryptoRate.findUnique.mockResolvedValue({
                currency: "BTC",
                buyRate: 100000000,
                sellRate: 105000000,
                updatedAt: new Date(),
            });

            const rate = await service.getAssetRate("BTC");

            expect(rate.source).toBe("database");
            expect(rate.buyRate).toBe(100000000);
        });

        it("should return USDT rate from database directly", async () => {
            redisCacheService.get
                .mockResolvedValueOnce(null)  // feature flag → true
                .mockResolvedValueOnce({ buyRate: 1600, sellRate: 1650 }); // USDT base rate

            const rate = await service.getAssetRate("USDT");

            expect(rate.currency).toBe("USDT");
            expect(rate.source).toBe("database");
            expect(rate.buyRate).toBe(1600);
        });
    });

    // ── getAllRates ───────────────────────────────────────────

    describe("getAllRates", () => {
        it("should return all rates in legacy mode", async () => {
            redisCacheService.get.mockResolvedValue("false");
            prisma.cryptoRate.findMany.mockResolvedValue([
                { currency: "BTC", buyRate: 100000000, sellRate: 105000000, updatedAt: new Date() },
                { currency: "ETH", buyRate: 5000000, sellRate: 5200000, updatedAt: new Date() },
            ]);

            const rates = await service.getAllRates();

            expect(rates).toHaveLength(2);
            expect(rates.every(r => r.source === "database")).toBe(true);
        });

        it("should return dynamic rates with batch prices", async () => {
            redisCacheService.get
                .mockResolvedValueOnce(null)  // feature flag → true
                .mockResolvedValueOnce({ buyRate: 1600, sellRate: 1650 }); // USDT base
            prisma.cryptoRate.findMany.mockResolvedValue([
                { currency: "USDT", buyRate: 1600, sellRate: 1650, updatedAt: new Date() },
                { currency: "BTC", buyRate: 0, sellRate: 0, updatedAt: new Date() },
            ]);
            liveCoinWatch.getBatchUsdtPrices.mockResolvedValue({ btc: 65000, usdt: 1 });

            const rates = await service.getAllRates();

            expect(rates).toHaveLength(2);
            const btcRate = rates.find(r => r.currency === "BTC");
            expect(btcRate?.source).toBe("dynamic");
            expect(btcRate?.buyRate).toBe(65000 * 1600);
        });
    });
});
