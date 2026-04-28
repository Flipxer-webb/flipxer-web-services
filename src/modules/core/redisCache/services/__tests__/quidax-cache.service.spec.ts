import { QuidaxTooManyRequestError } from "@/libs/quidax";
import { QuidaxCacheService } from "../quidax-cache.service";

describe("QuidaxCacheService", () => {
    let service: QuidaxCacheService;
    let otherService: QuidaxCacheService;
    let redisCacheService: {
        get: jest.Mock;
        set: jest.Mock;
    };
    let distributedLockService: {
        acquireLock: jest.Mock;
        releaseLock: jest.Mock;
    };
    let quidaxService: {
        getMarketTickers: jest.Mock;
    };

    beforeEach(() => {
        redisCacheService = {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue(undefined),
        };

        distributedLockService = {
            acquireLock: jest.fn().mockResolvedValue("lock-token"),
            releaseLock: jest.fn().mockResolvedValue(true),
        };

        quidaxService = {
            getMarketTickers: jest.fn(),
        };

        service = new QuidaxCacheService(
            redisCacheService as any,
            distributedLockService as any,
            quidaxService as any,
        );
        otherService = new QuidaxCacheService(
            redisCacheService as any,
            distributedLockService as any,
            quidaxService as any,
        );

        (service as any).inFlightMarketTickersRequest = null;
        (service as any).marketTickersThrottleUntil = 0;
        (service as any).consecutiveThrottleCount = 0;
        (service as any).lastSuccessfulMarketTickers = null;
        (service as any).lastSuccessfulMarketTickersAt = 0;

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
        jest.spyOn((otherService as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((otherService as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((otherService as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((otherService as any).logger, "error").mockImplementation(() => undefined);
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
        expect(distributedLockService.acquireLock).toHaveBeenCalledWith(
            "quidax:market:tickers:refresh",
            expect.objectContaining({ ttlMs: 6000, maxWaitMs: 1000, retryIntervalMs: 100 }),
        );
        expect(distributedLockService.releaseLock).toHaveBeenCalledWith(
            "quidax:market:tickers:refresh",
            "lock-token",
        );
    });

    it("returns fresh cache when another instance populates Redis before this instance fetches", async () => {
        const refreshed = { btcngn: { buy: "1000" } };
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(refreshed);

        const result = await service.getMarketTickers();

        expect(result).toEqual(refreshed);
        expect(quidaxService.getMarketTickers).not.toHaveBeenCalled();
        expect(distributedLockService.releaseLock).toHaveBeenCalledWith(
            "quidax:market:tickers:refresh",
            "lock-token",
        );
    });

    it("uses stale cache instead of issuing a second API request when another instance holds the refresh lock", async () => {
        distributedLockService.acquireLock.mockResolvedValue(null);
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true });

        const result = await service.getMarketTickers();

        expect(result).toEqual({ stale: true });
        expect(quidaxService.getMarketTickers).not.toHaveBeenCalled();
        expect(distributedLockService.releaseLock).not.toHaveBeenCalled();
    });

    it("falls back to stale cache when API call fails", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(null)
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

    it("increases cooldown after consecutive Quidax throttles", async () => {
        let now = 1_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);

        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true });
        quidaxService.getMarketTickers.mockRejectedValue(
            new QuidaxTooManyRequestError("rate limited"),
        );

        await service.getMarketTickers();
        expect((service as any).marketTickersThrottleUntil - now).toBe(30_000);

        now = (service as any).marketTickersThrottleUntil + 1;

        await service.getMarketTickers();
        expect((service as any).marketTickersThrottleUntil - now).toBe(60_000);
    });

    it("resets throttle backoff after a successful market ticker fetch", async () => {
        let now = 2_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);

        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true });
        quidaxService.getMarketTickers
            .mockRejectedValueOnce(new QuidaxTooManyRequestError("rate limited"))
            .mockRejectedValueOnce(new QuidaxTooManyRequestError("rate limited"));

        await service.getMarketTickers();
        now = (service as any).marketTickersThrottleUntil + 1;
        await service.getMarketTickers();
        expect((service as any).marketTickersThrottleUntil - now).toBe(60_000);

        now = (service as any).marketTickersThrottleUntil + 1;

        redisCacheService.get.mockReset();
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        quidaxService.getMarketTickers.mockReset();
        quidaxService.getMarketTickers.mockResolvedValueOnce({
            data: { btcngn: { buy: "9000" } },
        });

        await service.getMarketTickers();
        expect((service as any).consecutiveThrottleCount).toBe(0);

        now += 60_000;

        redisCacheService.get.mockReset();
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ stale: true });
        quidaxService.getMarketTickers.mockReset();
        quidaxService.getMarketTickers.mockRejectedValueOnce(
            new QuidaxTooManyRequestError("rate limited"),
        );

        await service.getMarketTickers();
        expect((service as any).marketTickersThrottleUntil - now).toBe(30_000);
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

    it("uses the last successful market data when Redis stale cache expires during cooldown", async () => {
        let now = 3_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);

        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        quidaxService.getMarketTickers.mockResolvedValueOnce({
            data: { btcngn: { buy: "9000" } },
        });

        await expect(service.getMarketTickers()).resolves.toEqual({ btcngn: { buy: "9000" } });

        now += 6 * 60_000;
        (service as any).marketTickersThrottleUntil = now + 60_000;
        redisCacheService.get.mockReset();
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        quidaxService.getMarketTickers.mockReset();

        await expect(service.getMarketTickers()).resolves.toEqual({ btcngn: { buy: "9000" } });
        expect(quidaxService.getMarketTickers).not.toHaveBeenCalled();
        expect((service as any).logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("using last successful in-memory Quidax cache as fallback"),
        );
    });

    it("does not use the in-memory fallback once it is too old", async () => {
        let now = 4_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);

        (service as any).lastSuccessfulMarketTickers = { ethngn: { buy: "2500" } };
        (service as any).lastSuccessfulMarketTickersAt = now;

        now += 16 * 60_000;
        (service as any).marketTickersThrottleUntil = now + 60_000;
        redisCacheService.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await expect(service.getMarketTickers()).resolves.toEqual({});
    });

    it("returns empty object when API and stale cache are unavailable", async () => {
        redisCacheService.get
            .mockResolvedValueOnce(null)
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

    it("shares in-flight market ticker requests across service instances", async () => {
        redisCacheService.get.mockResolvedValue(null);

        let resolveApi!: (v: any) => void;
        quidaxService.getMarketTickers.mockReturnValue(
            new Promise((res) => { resolveApi = res; }),
        );

        const first = service.getMarketTickers();
        const second = otherService.getMarketTickers();

        resolveApi({ data: { ethngn: { buy: "2500" } } });

        const [r1, r2] = await Promise.all([first, second]);
        expect(r1).toEqual({ ethngn: { buy: "2500" } });
        expect(r2).toEqual({ ethngn: { buy: "2500" } });
        expect(quidaxService.getMarketTickers).toHaveBeenCalledTimes(1);
    });
});
