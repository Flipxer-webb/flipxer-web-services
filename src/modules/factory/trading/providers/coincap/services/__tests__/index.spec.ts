import axios from "axios";

import { CoinCapService } from "../index";

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn(),
    },
}));

type MockRedis = {
    get: jest.Mock;
    set: jest.Mock;
};

describe("CoinCapService", () => {
    let service: CoinCapService;
    let redisCacheService: MockRedis;
    let getMock: jest.Mock;

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn(),
        };

        getMock = jest.fn();
        (axios as any).create.mockReturnValue({ get: getMock });

        service = new CoinCapService(redisCacheService as any);

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("getPriceInUSD should return cached value", async () => {
        redisCacheService.get.mockResolvedValue(40200);

        const result = await service.getPriceInUSD("BTC");

        expect(result).toBe(40200);
        expect(getMock).not.toHaveBeenCalled();
    });

    it("getPriceInUSD should reject invalid symbols", async () => {
        redisCacheService.get.mockResolvedValue(null);

        await expect(service.getPriceInUSD("BTC/USDT", 1, 0)).rejects.toThrow(
            "Invalid asset symbol: BTC/USDT",
        );
    });

    it("getPriceInUSD should fetch and cache rate", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockResolvedValue({ data: { data: { priceUsd: "61888.45" } } });

        const result = await service.getPriceInUSD("BTC", 1, 0);

        expect(result).toBe(61888.45);
        expect(getMock).toHaveBeenCalledWith("/assets/bitcoin");
        expect(redisCacheService.set).toHaveBeenCalledWith("coincap:price:btc:usd", 61888.45, 300);
    });

    it("getPriceInUSD should throw after retry exhaustion", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockRejectedValue(new Error("upstream unavailable"));

        await expect(service.getPriceInUSD("ETH", 2, 0)).rejects.toThrow(
            "Failed to fetch price for ETH: upstream unavailable",
        );
    });

    it("getBatchMarketData should map payload and keep missing assets null", async () => {
        getMock.mockResolvedValue({
            data: {
                data: [
                    {
                        id: "bitcoin",
                        priceUsd: "70000",
                        changePercent24Hr: "1.5",
                    },
                ],
            },
        });

        const result = await service.getBatchMarketData(["BTC", "ETH"]);

        expect(result.btc?.price).toBe(70000);
        expect(result.btc?.change24h).toBe(1.5);
        expect(result.eth).toBeNull();
    });

    it("getBatchMarketData should return null map when API fails", async () => {
        getMock.mockRejectedValue(new Error("bad gateway"));

        const result = await service.getBatchMarketData(["BTC", "ETH"]);

        expect(result).toEqual({ btc: null, eth: null });
    });

    it("getHistoricalData should return cached chart payload", async () => {
        const cached = { prices: [[1, 2] as [number, number]], high24h: 2, low24h: 2 };
        redisCacheService.get.mockResolvedValue(cached);

        const result = await service.getHistoricalData("BTC", 7);

        expect(result).toEqual(cached);
        expect(getMock).not.toHaveBeenCalled();
    });

    it("getHistoricalData should compute prices and 24h high/low", async () => {
        const now = 1_710_000_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockResolvedValue({
            data: {
                data: [
                    { time: now - 1000, priceUsd: "2", date: "x" },
                    { time: now - 2000, priceUsd: "5", date: "y" },
                    { time: now - 2 * 24 * 60 * 60 * 1000, priceUsd: "8", date: "z" },
                ],
            },
        });

        const result = await service.getHistoricalData("BTC", 7, 1, 0);

        expect(result.prices).toEqual([
            [now - 1000, 2],
            [now - 2000, 5],
            [now - 2 * 24 * 60 * 60 * 1000, 8],
        ]);
        expect(result.high24h).toBe(5);
        expect(result.low24h).toBe(2);
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coincap:history:btc:7d",
            result,
            7200,
        );
    });

    it("getBatchSparklines should return cache immediately", async () => {
        redisCacheService.get.mockResolvedValue({ btc: [1, 2] });

        const result = await service.getBatchSparklines(["BTC", "ETH"]);

        expect(result).toEqual({ btc: [1, 2] });
    });

    it("getBatchSparklines should fallback to empty arrays for failing assets", async () => {
        redisCacheService.get.mockResolvedValue(null);

        const historySpy = jest.spyOn(service, "getHistoricalData");
        historySpy
            .mockResolvedValueOnce({ prices: [[1, 10], [2, 11]], high24h: 11, low24h: 10 })
            .mockRejectedValueOnce(new Error("asset unavailable"));

        const result = await service.getBatchSparklines(["BTC", "ETH"]);

        expect(result).toEqual({
            btc: [10, 11],
            eth: [],
        });
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coincap:sparklines:BTC,ETH",
            result,
            1800,
        );
    });
});