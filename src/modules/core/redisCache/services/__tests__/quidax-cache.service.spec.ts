import { QuidaxTooManyRequestError } from "@/libs/quidax";
import { QuidaxCacheService } from "../quidax-cache.service";

describe("QuidaxCacheService", () => {
    let service: QuidaxCacheService;
    let redisCacheService: {
        get: jest.Mock;
        set: jest.Mock;
    };
    let quidaxService: {
        getMarketTickers: jest.Mock;
    };

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue(undefined),
        };

        quidaxService = {
            getMarketTickers: jest.fn(),
        };

        service = new QuidaxCacheService(redisCacheService as any, quidaxService as any);

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns fresh cached market data on cache hit", async () => {
        const cached = { btcngn: { buy: "1000" } };
        redisCacheService.get.mockResolvedValue(cached);

        const result = await service.getMarketTickers();

        expect(redisCacheService.get).toHaveBeenCalledWith("quidax:market:tickers");
        expect(quidaxService.getMarketTickers).not.toHaveBeenCalled();
        expect(result).toEqual(cached);
    });

    it("fetches from API and stores fresh + stale caches on miss", async () => {
        redisCacheService.get.mockResolvedValueOnce(null);
        quidaxService.getMarketTickers.mockResolvedValue({
            data: { ethngn: { buy: "2500" } },
        });

        const result = await service.getMarketTickers();

        expect(result).toEqual({ ethngn: { buy: "2500" } });
        expect(quidaxService.getMarketTickers).toHaveBeenCalledTimes(1);
        expect(redisCacheService.set).toHaveBeenNthCalledWith(
            1,
            "quidax:market:tickers",
            { ethngn: { buy: "2500" } },
            60,
        );
        expect(redisCacheService.set).toHaveBeenNthCalledWith(
            2,
            "quidax:market:tickers:stale",
            { ethngn: { buy: "2500" } },
            300,
        );
    });

    it("falls back to stale cache when API call fails", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true });
        quidaxService.getMarketTickers.mockRejectedValue(new Error("provider down"));

        const result = await service.getMarketTickers();

        expect(result).toEqual({ stale: true });
        expect((service as any).logger.warn).toHaveBeenCalled();
        expect((service as any).logger.error).toHaveBeenCalled();
    });

    it("enters cooldown after Quidax throttles and serves stale cache without re-hitting the API", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true });
        quidaxService.getMarketTickers.mockRejectedValue(
            new QuidaxTooManyRequestError("rate limited"),
        );

        const first = await service.getMarketTickers();
        const second = await service.getMarketTickers();

        expect(first).toEqual({ stale: true });
        expect(second).toEqual({ stale: true });
        expect((service as any).marketTickersThrottleUntil).toBeGreaterThan(Date.now());
        expect(quidaxService.getMarketTickers).toHaveBeenCalledTimes(1);
    });

    it("returns empty object during cooldown when stale cache is unavailable", async () => {
        (service as any).marketTickersThrottleUntil = Date.now() + 30_000;
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        const result = await service.getMarketTickers();

        expect(result).toEqual({});
        expect(quidaxService.getMarketTickers).not.toHaveBeenCalled();
    });

    it("returns empty object when API and stale cache are unavailable", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        quidaxService.getMarketTickers.mockRejectedValue(new Error("timeout"));

        const result = await service.getMarketTickers();

        expect(result).toEqual({});
    });

    it("handles API response without data payload", async () => {
        redisCacheService.get.mockResolvedValueOnce(null);
        quidaxService.getMarketTickers.mockResolvedValue({});

        const result = await service.getMarketTickers();

        expect(result).toEqual({});
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "quidax:market:tickers",
            {},
            60,
        );
        expect(redisCacheService.set).toHaveBeenCalledWith(
            "quidax:market:tickers:stale",
            {},
            300,
        );
    });

    it("rejects when fetcher exceeds timeout", async () => {
        const promise = (service as any).fetchWithTimeout(
            () => new Promise(() => undefined),
            1,
        );

        await expect(promise).rejects.toThrow("Quidax API timeout after 1ms");
    });

    it("deduplicates concurrent requests via in-flight promise", async () => {
        redisCacheService.get.mockResolvedValue(null);

        let resolveApi!: (v: any) => void;
        quidaxService.getMarketTickers.mockReturnValue(
            new Promise((res) => { resolveApi = res; }),
        );

        const first = service.getMarketTickers();
        const second = service.getMarketTickers();

        resolveApi({ data: { btcngn: { buy: "9000" } } });

        const [r1, r2] = await Promise.all([first, second]);
        expect(r1).toEqual({ btcngn: { buy: "9000" } });
        expect(r2).toEqual({ btcngn: { buy: "9000" } });
        expect(quidaxService.getMarketTickers).toHaveBeenCalledTimes(1);
    });
});
