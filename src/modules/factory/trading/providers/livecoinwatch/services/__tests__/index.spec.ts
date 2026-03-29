import { ConfigService } from "@nestjs/config";

import { LiveCoinWatchService } from "../index";

type MockRedis = {
    get: jest.Mock;
    set: jest.Mock;
};

type MockConfig = {
    get: jest.Mock;
};

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

describe("LiveCoinWatchService", () => {
    let service: LiveCoinWatchService;
    let redisCacheService: MockRedis;
    let configService: MockConfig;
    let postMock: jest.Mock;

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn(),
        };

        configService = {
            get: jest.fn().mockReturnValue("api-key"),
        };

        service = new LiveCoinWatchService(
            redisCacheService as any,
            configService as unknown as ConfigService,
        );

        postMock = jest.fn();
        (service as any).apiClient = { post: postMock };

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("getPriceInUSD should return cached value when present", async () => {
        redisCacheService.get.mockResolvedValue(42000);

        const price = await service.getPriceInUSD("BTC");

        expect(price).toBe(42000);
        expect(postMock).not.toHaveBeenCalled();
    });

    it("getPriceInUSD should return static NGN fallback", async () => {
        redisCacheService.get.mockResolvedValue(null);

        const price = await service.getPriceInUSD("ngn");

        expect(price).toBe(0.00065);
        expect(postMock).not.toHaveBeenCalled();
    });

    it("getPriceInUSD should fetch, cache, and return price", async () => {
        redisCacheService.get.mockResolvedValue(null);
        postMock.mockResolvedValue({ data: { rate: 62123.45 } });

        const price = await service.getPriceInUSD("btc", 1, 0);

        expect(price).toBe(62123.45);
        expect(postMock).toHaveBeenCalledWith("/coins/single", {
            currency: "USD",
            code: "BTC",
            meta: false,
        });
        expect(redisCacheService.set).toHaveBeenCalledWith("lcw:price:btc:usd", 62123.45, 300);
    });

    it("getPriceInUSD should throw after retries are exhausted", async () => {
        redisCacheService.get.mockResolvedValue(null);
        postMock.mockRejectedValue(new Error("upstream down"));

        await expect(service.getPriceInUSD("BTC", 2, 0)).rejects.toThrow(
            "Failed to fetch price for BTC: upstream down",
        );
    });

    it("getPriceInUSDT should return 1 for USDT", async () => {
        const price = await service.getPriceInUSDT("USDT");

        expect(price).toBe(1);
        expect(postMock).not.toHaveBeenCalled();
    });

    it("getPriceInUSDT should deduplicate in-flight requests", async () => {
        redisCacheService.get.mockResolvedValue(null);
        const deferred = createDeferred<{ data: { rate: number } }>();
        postMock.mockReturnValue(deferred.promise);

        const p1 = service.getPriceInUSDT("btc", 1, 0);
        const p2 = service.getPriceInUSDT("btc", 1, 0);

        deferred.resolve({ data: { rate: 1.11 } });

        const [v1, v2] = await Promise.all([p1, p2]);

        expect(v1).toBe(1.11);
        expect(v2).toBe(1.11);
        expect(postMock).toHaveBeenCalledTimes(1);
    });

    it("getBatchUsdtPrices should combine cache + fetched assets and include USDT", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(30000)
            .mockResolvedValueOnce(null);

        postMock.mockResolvedValue({
            data: [{ code: "ETH", rate: 1900 }],
        });

        const result = await service.getBatchUsdtPrices(["BTC", "ETH", "USDT"]);

        expect(result).toEqual({
            usdt: 1,
            btc: 30000,
            eth: 1900,
        });
        expect(redisCacheService.set).toHaveBeenCalledWith("lcw:price:eth:usdt", 1900, 90);
    });

    it("getBatchUsdtPrices should return nulls when batch call fails", async () => {
        redisCacheService.get.mockResolvedValue(null);
        postMock.mockRejectedValue(new Error("rate limit"));

        const result = await service.getBatchUsdtPrices(["BTC", "ETH"]);

        expect(result).toEqual({ btc: null, eth: null });
    });

    it("getHistoricalData should transform history and compute 24h high/low", async () => {
        const now = 1_700_000_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);

        redisCacheService.get.mockResolvedValue(null);
        postMock.mockResolvedValue({
            data: {
                history: [
                    { date: now - 5000, rate: 2, volume: 1, cap: 1 },
                    { date: now - 30_000, rate: 3, volume: 1, cap: 1 },
                    { date: now - 2 * 24 * 60 * 60 * 1000, rate: 7, volume: 1, cap: 1 },
                ],
            },
        });

        const result = await service.getHistoricalData("BTC", 7, 1, 0);

        expect(result.prices).toEqual([
            [now - 5000, 2],
            [now - 30_000, 3],
            [now - 2 * 24 * 60 * 60 * 1000, 7],
        ]);
        expect(result.high24h).toBe(3);
        expect(result.low24h).toBe(2);
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "lcw:history:btc:7d",
            result,
            7200,
        );
    });

    it("getBatchPrices should fill missing assets with null", async () => {
        postMock.mockResolvedValue({
            data: [{ code: "BTC", rate: 65000 }],
        });

        const result = await service.getBatchPrices(["BTC", "ETH"]);

        expect(result).toEqual({
            btc: 65000,
            eth: null,
        });
    });

    it("getBatchSparklines should fallback to empty sparkline on per-asset failure", async () => {
        redisCacheService.get.mockResolvedValue(null);

        const historySpy = jest.spyOn(service, "getHistoricalData");
        historySpy
            .mockResolvedValueOnce({ prices: [[1, 2], [2, 3]], high24h: 3, low24h: 2 })
            .mockRejectedValueOnce(new Error("history unavailable"));

        const result = await service.getBatchSparklines(["BTC", "ETH"]);

        expect(result).toEqual({
            btc: [2, 3],
            eth: [],
        });
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "lcw:sparklines:BTC,ETH",
            result,
            1800,
        );
    });

    it("getBatchMarketData should return cached payload when available", async () => {
        const cachedPayload = {
            btc: { price: 70000, change24h: 2.1 },
        };
        redisCacheService.get.mockResolvedValue(cachedPayload);

        const result = await service.getBatchMarketData(["BTC", "ETH"]);

        expect(result).toEqual(cachedPayload);
        expect(postMock).not.toHaveBeenCalled();
    });

    it("getBatchMarketData should map API payload and set null for missing assets", async () => {
        redisCacheService.get.mockResolvedValue(null);
        postMock.mockResolvedValue({
            data: [
                {
                    code: "BTC",
                    rate: 71000,
                    volume: 1,
                    cap: 1,
                    circulatingSupply: 1,
                    totalSupply: 1,
                    maxSupply: 1,
                    delta: { day: 1.05 },
                },
            ],
        });

        const result = await service.getBatchMarketData(["BTC", "ETH"]);

        expect(result.eth).toBeNull();
        expect(result.btc?.price).toBe(71000);
        expect(result.btc?.change24h).toBeCloseTo(5, 8);
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "lcw:batch-market:BTC,ETH",
            result,
            120,
        );
    });
});
