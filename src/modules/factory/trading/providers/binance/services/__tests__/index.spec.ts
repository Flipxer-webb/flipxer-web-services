import axios from "axios";

import { BinanceService } from "../index";

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

describe("BinanceService", () => {
    let service: BinanceService;
    let redisCacheService: MockRedis;
    let getMock: jest.Mock;

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn(),
        };

        getMock = jest.fn();
        (axios as any).create.mockReturnValue({ get: getMock });

        service = new BinanceService(redisCacheService as any);
        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("getPriceInUSDT should return 1 for USDT", async () => {
        const result = await service.getPriceInUSDT("USDT");

        expect(result).toBe(1);
        expect(getMock).not.toHaveBeenCalled();
    });

    it("getPriceInUSDT should return cached value", async () => {
        redisCacheService.get.mockResolvedValue(123.45);

        const result = await service.getPriceInUSDT("SOL");

        expect(result).toBe(123.45);
        expect(getMock).not.toHaveBeenCalled();
    });

    it("getPriceInUSDT should map symbols and cache successful responses", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockResolvedValue({ data: { symbol: "POLUSDT", price: "0.95" } });

        const result = await service.getPriceInUSDT("MATIC", 1, 0);

        expect(result).toBe(0.95);
        expect(getMock).toHaveBeenCalledWith("/api/v3/ticker/price", {
            params: { symbol: "POLUSDT" },
        });
        expect(redisCacheService.set).toHaveBeenCalledWith("binance:price:matic:usdt", 0.95, 60);
    });

    it("getPriceInUSDT should throw BAD_REQUEST when symbol does not exist", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockRejectedValue({ response: { status: 400 }, message: "invalid symbol" });

        await expect(service.getPriceInUSDT("UNKNOWN", 1, 0)).rejects.toThrow(
            "Asset UNKNOWN not available on Binance",
        );
    });

    it("getPriceInUSDT should throw after retries for non-400 failures", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockRejectedValue(new Error("gateway timeout"));

        await expect(service.getPriceInUSDT("BTC", 2, 0)).rejects.toThrow(
            "Failed to fetch USDT price for BTC: gateway timeout",
        );
    });

    it("getBatchPricesInUSDT should combine cache hits and API results", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(68000)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        getMock.mockResolvedValue({
            data: [
                { symbol: "ETHUSDT", price: "3000" },
                { symbol: "BTCUSDT", price: "69000" },
            ],
        });

        const result = await service.getBatchPricesInUSDT(["BTC", "ETH", "USDT"]);

        expect(result.get("BTC")).toBe(68000);
        expect(result.get("ETH")).toBe(3000);
        expect(result.get("USDT")).toBe(1);
        expect(redisCacheService.set).toHaveBeenCalledWith("binance:price:eth:usdt", 3000, 60);
    });

    it("getBatchPricesInUSDT should fallback to individual fetches when batch fails", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockRejectedValue(new Error("batch failed"));

        const singleSpy = jest
            .spyOn(service, "getPriceInUSDT")
            .mockResolvedValueOnce(1.5)
            .mockResolvedValueOnce(2.5);

        const result = await service.getBatchPricesInUSDT(["AAVE", "LINK"]);

        expect(result.get("AAVE")).toBe(1.5);
        expect(result.get("LINK")).toBe(2.5);
        expect(singleSpy).toHaveBeenCalledTimes(2);
    });

    it("getAvailableUSDTPairs should return cache when present", async () => {
        redisCacheService.get.mockResolvedValue(["BTC", "ETH"]);

        const result = await service.getAvailableUSDTPairs();

        expect(result).toEqual(["BTC", "ETH"]);
        expect(getMock).not.toHaveBeenCalled();
    });

    it("getAvailableUSDTPairs should fetch and cache pairs", async () => {
        redisCacheService.get.mockResolvedValue(null);
        getMock.mockResolvedValue({
            data: [
                { symbol: "BTCUSDT", price: "69000" },
                { symbol: "ETHUSDT", price: "3000" },
                { symbol: "BNBBTC", price: "0.01" },
            ],
        });

        const result = await service.getAvailableUSDTPairs();

        expect(result).toEqual(["BTC", "ETH"]);
        expect(redisCacheService.set).toHaveBeenCalledWith("binance:usdt_pairs", ["BTC", "ETH"], 3600);
    });

    it("hasUSDTPair and getCachedPrice should rely on helper methods", async () => {
        jest.spyOn(service, "getAvailableUSDTPairs").mockResolvedValue(["POL", "BTC"]);
        redisCacheService.get.mockResolvedValue(0.88);

        const hasPair = await service.hasUSDTPair("matic");
        const cached = await service.getCachedPrice("MATIC");

        expect(hasPair).toBe(true);
        expect(cached).toBe(0.88);
        expect(redisCacheService.get).toHaveBeenCalledWith("binance:price:matic:usdt");
    });
});