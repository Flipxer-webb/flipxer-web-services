import { Test, TestingModule } from "@nestjs/testing";

import { PriceCacheSchedulerService } from "../coinGecko";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { WsGateway } from "@/modules/api/trade/gateway/v1";

describe("PriceCacheSchedulerService", () => {
    let service: PriceCacheSchedulerService;
    let liveCoinWatchService: {
        getBatchMarketData: jest.Mock;
        getBatchUsdtPrices: jest.Mock;
        getPriceInUSDT: jest.Mock;
    };
    let coinCapService: { getBatchMarketData: jest.Mock };
    let redisCacheService: { set: jest.Mock };
    let wsGateway: { broadcastPriceUpdate: jest.Mock };

    beforeEach(async () => {
        liveCoinWatchService = {
            getBatchMarketData: jest.fn(),
            getBatchUsdtPrices: jest.fn(),
            getPriceInUSDT: jest.fn(),
        };
        coinCapService = { getBatchMarketData: jest.fn() };
        redisCacheService = { set: jest.fn().mockResolvedValue(undefined) };
        wsGateway = { broadcastPriceUpdate: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PriceCacheSchedulerService,
                { provide: TradingInjectionToken.LIVECOINWATCH, useValue: liveCoinWatchService },
                { provide: TradingInjectionToken.COINCAP, useValue: coinCapService },
                { provide: RedisCacheService, useValue: redisCacheService },
                { provide: WsGateway, useValue: wsGateway },
            ],
        }).compile();

        service = module.get(PriceCacheSchedulerService);
    });

    afterEach(() => jest.clearAllMocks());

    it("should run both updates on module init", async () => {
        jest.spyOn(service, "updateCoinPrices").mockResolvedValue(undefined);
        jest.spyOn(service, "updateUsdtPrices").mockResolvedValue(undefined);

        await service.onModuleInit();

        expect(service.updateCoinPrices).toHaveBeenCalled();
        expect(service.updateUsdtPrices).toHaveBeenCalled();
    });

    it("should update USD prices from LiveCoinWatch and cache them", async () => {
        liveCoinWatchService.getBatchMarketData.mockResolvedValue({
            btc: { price: 100000, change24h: 3 },
            eth: { price: 5000, change24h: 2 },
        });

        await service.updateCoinPrices();

        expect(liveCoinWatchService.getBatchMarketData).toHaveBeenCalled();
        expect(redisCacheService.set).toHaveBeenCalledWith("price:btc:usd", 100000, 600);
        expect(redisCacheService.set).toHaveBeenCalledWith("price:eth:usd", 5000, 600);
    });

    it("should fall back to CoinCap when LiveCoinWatch batch fetch fails", async () => {
        liveCoinWatchService.getBatchMarketData.mockRejectedValue(new Error("lcw down"));
        coinCapService.getBatchMarketData.mockResolvedValue({
            btc: { price: 90000, change24h: -1 },
        });

        await service.updateCoinPrices();

        expect(coinCapService.getBatchMarketData).toHaveBeenCalled();
        expect(redisCacheService.set).toHaveBeenCalledWith("price:btc:usd", 90000, 600);
    });

    it("should update USDT prices using batch mode", async () => {
        liveCoinWatchService.getBatchUsdtPrices.mockResolvedValue({ btc: 0.99, eth: 1.01 });

        await service.updateUsdtPrices();

        expect(liveCoinWatchService.getBatchUsdtPrices).toHaveBeenCalled();
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "price:usdt:meta",
            expect.objectContaining({ source: "livecoinwatch", count: 2, batchMode: true }),
            90,
        );
    });

    it("should fall back to individual USDT price fetches when batch mode fails", async () => {
        liveCoinWatchService.getBatchUsdtPrices.mockRejectedValue(new Error("batch down"));
        liveCoinWatchService.getPriceInUSDT.mockImplementation(async (coin: string) => {
            if (coin === "btc") return 1.2;
            if (coin === "eth") return 1.1;
            return 0.5;
        });

        await service.updateUsdtPrices();

        expect(liveCoinWatchService.getPriceInUSDT).toHaveBeenCalled();
        expect(redisCacheService.set).toHaveBeenCalledWith("price:btc:usdt", 1.2, 90);
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "price:usdt:meta",
            expect.objectContaining({ batchMode: false }),
            90,
        );
    });
});