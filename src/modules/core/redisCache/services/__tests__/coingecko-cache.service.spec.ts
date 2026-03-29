import { CoinGeckoCacheService } from "../coingecko-cache.service";

describe("CoinGeckoCacheService", () => {
    let service: CoinGeckoCacheService;
    let redisCacheService: {
        get: jest.Mock;
        set: jest.Mock;
    };
    let coinGeckoService: {
        getPriceInUSD: jest.Mock;
        getBatchPriceInUSD: jest.Mock;
        getBatchMarketData: jest.Mock;
    };

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue(undefined),
        };

        coinGeckoService = {
            getPriceInUSD: jest.fn(),
            getBatchPriceInUSD: jest.fn(),
            getBatchMarketData: jest.fn(),
        };

        service = new CoinGeckoCacheService(
            redisCacheService as any,
            coinGeckoService as any,
        );

        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("getPriceInUSD", () => {
        it("should return cached price when available", async () => {
            redisCacheService.get.mockResolvedValue(42000);

            const result = await service.getPriceInUSD("BTC");

            expect(result).toBe(42000);
            expect(coinGeckoService.getPriceInUSD).not.toHaveBeenCalled();
        });

        it("should fetch and cache price when cache misses", async () => {
            redisCacheService.get.mockResolvedValue(null);
            coinGeckoService.getPriceInUSD.mockResolvedValue(2500);

            const result = await service.getPriceInUSD("ETH");

            expect(result).toBe(2500);
            expect(coinGeckoService.getPriceInUSD).toHaveBeenCalledWith("ETH");
            expect(redisCacheService.set).toHaveBeenCalledWith(
                "coingecko:price:eth:usd",
                2500,
                300,
            );
        });

        it("should not cache null prices", async () => {
            redisCacheService.get.mockResolvedValue(null);
            coinGeckoService.getPriceInUSD.mockResolvedValue(null);

            const result = await service.getPriceInUSD("DOGE");

            expect(result).toBeNull();
            expect(redisCacheService.set).not.toHaveBeenCalled();
        });

        it("should handle provider errors and return null", async () => {
            redisCacheService.get.mockResolvedValue(null);
            coinGeckoService.getPriceInUSD.mockRejectedValue(new Error("429 too many requests"));

            const result = await service.getPriceInUSD("SOL");

            expect(result).toBeNull();
            expect((service as any).logger.error).toHaveBeenCalled();
            expect((service as any).logger.warn).toHaveBeenCalled();
        });
    });

    describe("getBatchPriceInUSD", () => {
        it("should combine cached and fetched prices", async () => {
            redisCacheService.get
                .mockResolvedValueOnce(42000)
                .mockResolvedValueOnce(null);
            coinGeckoService.getBatchPriceInUSD.mockResolvedValue({
                eth: 2600,
            });

            const result = await service.getBatchPriceInUSD(["BTC", "ETH"]);

            expect(result).toEqual({
                btc: 42000,
                eth: 2600,
            });
            expect(coinGeckoService.getBatchPriceInUSD).toHaveBeenCalledWith(["ETH"]);
            expect(redisCacheService.set).toHaveBeenCalledWith(
                "coingecko:price:eth:usd",
                2600,
                300,
            );
        });

        it("should return null for uncached assets when batch fetch fails", async () => {
            redisCacheService.get
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);
            coinGeckoService.getBatchPriceInUSD.mockRejectedValue(new Error("429 rate limit"));

            const result = await service.getBatchPriceInUSD(["BTC", "ETH"]);

            expect(result).toEqual({ btc: null, eth: null });
            expect((service as any).logger.error).toHaveBeenCalled();
            expect((service as any).logger.warn).toHaveBeenCalled();
        });
    });

    describe("getBatchMarketData", () => {
        it("should combine cached and fetched market data", async () => {
            redisCacheService.get
                .mockResolvedValueOnce({ price: 42000, change24h: 2.1 })
                .mockResolvedValueOnce(null);

            coinGeckoService.getBatchMarketData.mockResolvedValue({
                eth: { price: 2500, change24h: -1.3 },
            });

            const result = await service.getBatchMarketData(["BTC", "ETH"]);

            expect(result).toEqual({
                btc: { price: 42000, change24h: 2.1 },
                eth: { price: 2500, change24h: -1.3 },
            });
            expect(redisCacheService.set).toHaveBeenCalledWith(
                "coingecko:market_data:eth:usd",
                { price: 2500, change24h: -1.3 },
                300,
            );
        });

        it("should keep null values for uncached assets when fetch fails", async () => {
            redisCacheService.get
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);
            coinGeckoService.getBatchMarketData.mockRejectedValue(new Error("service unavailable"));

            const result = await service.getBatchMarketData(["BTC", "ETH"]);

            expect(result).toEqual({
                btc: null,
                eth: null,
            });
            expect((service as any).logger.error).toHaveBeenCalled();
        });
    });
});
