import axios from "axios";

import { CoinGeckoService } from "../index";

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
    },
}));

type MockRedis = {
    get: jest.Mock;
    set: jest.Mock;
};

describe("CoinGeckoService", () => {
    let service: CoinGeckoService;
    let redisCacheService: MockRedis;
    let axiosGet: jest.Mock;

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn(),
        };

        service = new CoinGeckoService(redisCacheService as any);
        axiosGet = (axios as any).get as jest.Mock;

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("getPriceInUSD should return cached value", async () => {
        redisCacheService.get.mockResolvedValue(42000);

        const result = await service.getPriceInUSD("BTC");

        expect(result).toBe(42000);
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it("getPriceInUSD should throw when asset has no mapping", async () => {
        redisCacheService.get.mockResolvedValue(null);

        await expect(service.getPriceInUSD("UNKNOWN")).rejects.toThrow(
            "No CoinGecko ID mapping for UNKNOWN",
        );
    });

    it("getPriceInUSD should fetch and cache data", async () => {
        redisCacheService.get.mockResolvedValue(null);
        axiosGet.mockResolvedValue({ data: { bitcoin: { usd: 63123.45 } } });

        const result = await service.getPriceInUSD("BTC", 1, 0);

        expect(result).toBe(63123.45);
        expect(axiosGet).toHaveBeenCalledWith(
            "https://api.coingecko.com/api/v3/simple/price",
            {
                params: { ids: "bitcoin", vs_currencies: "usd" },
            },
        );
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:price:btc:usd",
            63123.45,
            300,
        );
    });

    it("getPriceInUSD should throw after retry exhaustion", async () => {
        redisCacheService.get.mockResolvedValue(null);
        axiosGet.mockRejectedValue(new Error("upstream down"));

        await expect(service.getPriceInUSD("BTC", 2, 0)).rejects.toThrow(
            "Failed to fetch USD rate for BTC after 2 attempts: upstream down",
        );
    });

    it("getBatchPriceInUSD should throw when no valid ids are provided", async () => {
        await expect(service.getBatchPriceInUSD(["UNKNOWN"], 1, 0)).rejects.toThrow(
            "No valid CoinGecko IDs provided",
        );
    });

    it("getBatchPriceInUSD should map data and keep missing asset as null", async () => {
        axiosGet.mockResolvedValue({
            data: {
                bitcoin: { usd: 70000 },
            },
        });

        const result = await service.getBatchPriceInUSD(["BTC", "ETH"], 1, 0);

        expect(result).toEqual({ btc: 70000, eth: null });
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:price:btc:usd",
            70000,
            300,
        );
    });

    it("getBatchMarketData should return null map when no valid ids exist", async () => {
        const result = await service.getBatchMarketData(["UNKNOWN"], 1, 0);

        expect(result).toEqual({ unknown: null });
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it("getBatchMarketData should map market payload and keep unknown entries null", async () => {
        axiosGet.mockResolvedValue({
            data: {
                bitcoin: { usd: 71000, usd_24h_change: 1.5 },
            },
        });

        const result = await service.getBatchMarketData(["BTC", "ETH"], 1, 0);

        expect(result.eth).toBeNull();
        expect(result.btc?.price).toBe(71000);
        expect(result.btc?.change24h).toBe(1.5);
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:price:btc:usd",
            71000,
            300,
        );
    });

    it("getMarketChart should return cached chart data", async () => {
        const cached = { prices: [[1, 2] as [number, number]] };
        redisCacheService.get.mockResolvedValue(cached);

        const result = await service.getMarketChart("BTC", 7, 1, 0);

        expect(result).toEqual(cached);
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it("getMarketChart should fallback market data when market endpoint fails", async () => {
        redisCacheService.get.mockResolvedValue(null);
        axiosGet
            .mockResolvedValueOnce({
                data: {
                    prices: [
                        [1000, 100],
                        [2000, 120],
                    ],
                },
            })
            .mockRejectedValueOnce(new Error("market endpoint unavailable"));

        const result = await service.getMarketChart("BTC", 1, 1, 0);

        expect(result.prices).toEqual([
            [1000, 100],
            [2000, 120],
        ]);
        expect(result.market_data.current_price).toBe(120);
        expect(result.market_data.price_change_percentage_24h).toBe(20);
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:chart:btc:1d",
            result,
            600,
        );
    });

    it("getBatchSparklines should fetch uncached data and cache matched coins", async () => {
        redisCacheService.get
            .mockResolvedValueOnce([10, 20])
            .mockResolvedValueOnce(null);

        axiosGet.mockResolvedValue({
            data: [
                {
                    id: "ethereum",
                    sparkline_in_7d: { price: [30, 40, 50] },
                },
            ],
        });

        const result = await service.getBatchSparklines(["BTC", "ETH"], 1, 0);

        expect(result).toEqual({
            btc: [10, 20],
            eth: [30, 40, 50],
        });
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:sparkline:eth",
            [30, 40, 50],
            1800,
        );
    });

    it("getAthAtl should return cached data when available", async () => {
        const cached = {
            ath: 69000,
            ath_date: "2021-11-10T00:00:00.000Z",
            atl: 65,
            atl_date: "2013-07-06T00:00:00.000Z",
        };
        redisCacheService.get.mockResolvedValue(cached);

        const result = await service.getAthAtl("BTC", 1, 0);

        expect(result).toEqual(cached);
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it("getAthAtl should return stale cache when rate-limited", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                ath: 70000,
                ath_date: "x",
                atl: 70,
                atl_date: "y",
            });

        axiosGet.mockRejectedValue({ response: { status: 429 } });

        const result = await service.getAthAtl("BTC", 2, 0);

        expect(result).toEqual({
            ath: 70000,
            ath_date: "x",
            atl: 70,
            atl_date: "y",
        });
    });

    it("getAthAtl should fetch and cache fresh data", async () => {
        redisCacheService.get.mockResolvedValue(null);
        axiosGet.mockResolvedValue({
            data: {
                market_data: {
                    ath: { usd: 73000 },
                    ath_date: { usd: "2024-03-14T00:00:00.000Z" },
                    atl: { usd: 67 },
                    atl_date: { usd: "2013-07-06T00:00:00.000Z" },
                },
            },
        });

        const result = await service.getAthAtl("BTC", 1, 0);

        expect(result).toEqual({
            ath: 73000,
            ath_date: "2024-03-14T00:00:00.000Z",
            atl: 67,
            atl_date: "2013-07-06T00:00:00.000Z",
        });
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:ath_atl:btc",
            result,
            604800,
        );
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "coingecko:ath_atl:stale:btc",
            result,
            2592000,
        );
    });
});
