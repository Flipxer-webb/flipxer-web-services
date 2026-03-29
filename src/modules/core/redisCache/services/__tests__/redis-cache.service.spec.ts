jest.mock("@/config", () => ({
    redisConfig: {
        host: "localhost",
        port: 6379,
        user: "",
        password: "",
        redisOptions: { tls: undefined },
    },
}));

jest.mock("ioredis", () => {
    return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        exists: jest.fn(),
        ping: jest.fn(),
        disconnect: jest.fn(),
        multi: jest.fn(),
        incrbyfloat: jest.fn(),
        ttl: jest.fn(),
    }));
});

import { RedisCacheService } from "../redis-cache.service";

describe("RedisCacheService", () => {
    let service: RedisCacheService;

    beforeEach(() => {
        process.env.REDIS_DISABLED = "true";
        service = new RedisCacheService();
        service.onModuleInit();
    });

    afterEach(() => {
        service.onModuleDestroy();
        delete process.env.REDIS_DISABLED;
    });

    describe("fallback cache operations (Redis disabled)", () => {
        it("should set and get from fallback cache", async () => {
            await service.set("key1", { data: "hello" }, 60);
            const result = await service.get<{ data: string }>("key1");
            expect(result).toEqual({ data: "hello" });
        });

        it("should return null for missing keys", async () => {
            const result = await service.get("nonexistent");
            expect(result).toBeNull();
        });

        it("should delete keys from fallback cache", async () => {
            await service.set("key1", "value", 60);
            await service.del("key1");
            const result = await service.get("key1");
            expect(result).toBeNull();
        });

        it("should check existence in fallback cache", async () => {
            await service.set("key1", "value", 60);
            expect(await service.exists("key1")).toBe(true);
            expect(await service.exists("nonexistent")).toBe(false);
        });

        it("should handle getDel - get and delete atomically", async () => {
            await service.set("key1", "value", 60);
            const result = await service.getDel("key1");
            expect(result).toBe("value");
            // Should be deleted after getDel
            const after = await service.get("key1");
            expect(after).toBeNull();
        });

        it("should return null from getDel for missing keys", async () => {
            const result = await service.getDel("nonexistent");
            expect(result).toBeNull();
        });

        it("should expire fallback entries", async () => {
            // Set with very short TTL
            await service.set("expired", "data", 0);
            // TTL 0 = expires immediately
            const result = await service.get("expired");
            expect(result).toBeNull();
        });

        it("should evict when exceeding max fallback size", async () => {
            // Fill cache to max
            for (let i = 0; i < 1001; i++) {
                await service.set(`key${i}`, `value${i}`, 3600);
            }
            // Should have evicted some entries but still work
            const result = await service.get("key1000");
            expect(result).toBe("value1000");
        });

        it("should return null when fallback cache is disabled", () => {
            (service as any).FALLBACK_ENABLED = false;

            (service as any).setFallback("disabled-key", "value", 60);

            expect((service as any).fallbackCache.has("disabled-key")).toBe(false);
            expect((service as any).getFallback("disabled-key")).toBeNull();
        });
    });

    describe("incrbyfloat (Redis disabled)", () => {
        it("should return null when Redis is disabled", async () => {
            const result = await service.incrbyfloat("counter", 1);
            expect(result).toBeNull();
        });
    });

    describe("health check", () => {
        it("should report healthy with fallback when Redis disabled", async () => {
            const health = await service.isHealthy();
            expect(health.healthy).toBe(true);
            expect(health.usingFallback).toBe(true);
        });
    });

    describe("getStats", () => {
        it("should return cache statistics", () => {
            const stats = service.getStats();
            expect(stats).toHaveProperty("fallbackSize");
            expect(stats).toHaveProperty("isConnected");
            expect(stats.isConnected).toBe(false);
        });

        it("should track fallback size", async () => {
            await service.set("a", 1, 60);
            await service.set("b", 2, 60);
            const stats = service.getStats();
            expect(stats.fallbackSize).toBe(2);
        });
    });
});

describe("RedisCacheService - with Redis enabled but not connected", () => {
    let service: RedisCacheService;

    beforeEach(() => {
        delete process.env.REDIS_DISABLED;
        service = new RedisCacheService();
        // Don't call onModuleInit to avoid actual Redis connection
        // Instead, manually set the state
        (service as any).isConnected = false;
        (service as any).REDIS_DISABLED = false;
        (service as any).client = {
            get: jest.fn().mockRejectedValue(new Error("Connection refused")),
            set: jest.fn().mockRejectedValue(new Error("Connection refused")),
            del: jest.fn().mockRejectedValue(new Error("Connection refused")),
            exists: jest.fn().mockRejectedValue(new Error("Connection refused")),
            ping: jest.fn().mockRejectedValue(new Error("Connection refused")),
            disconnect: jest.fn(),
            multi: jest.fn().mockReturnValue({
                get: jest.fn().mockReturnThis(),
                del: jest.fn().mockReturnThis(),
                exec: jest.fn().mockRejectedValue(new Error("Connection refused")),
            }),
            incrbyfloat: jest.fn().mockRejectedValue(new Error("Connection refused")),
            ttl: jest.fn(),
        };
        // Start the fallback cleanup
        (service as any).fallbackCleanupInterval = setInterval(() => {}, 60000);
    });

    afterEach(() => {
        service.onModuleDestroy();
    });

    it("should fall back to in-memory on get when not connected", async () => {
        // Set a value via fallback
        (service as any).setFallback("testkey", "testval", 60);

        const result = await service.get("testkey");
        expect(result).toBe("testval");
    });

    it("should fall back on set when not connected", async () => {
        await service.set("key1", "val1", 60);
        // Should be in fallback
        const val = (service as any).getFallback("key1");
        expect(val).toBe("val1");
    });

    it("should fall back on getDel when not connected", async () => {
        (service as any).setFallback("key1", "val1", 60);
        const result = await service.getDel("key1");
        expect(result).toBe("val1");
    });

    it("should fall back on exists when not connected", async () => {
        (service as any).setFallback("key1", "val1", 60);
        const result = await service.exists("key1");
        expect(result).toBe(true);
    });

    it("should return null from incrbyfloat when not connected", async () => {
        const result = await service.incrbyfloat("counter", 5);
        expect(result).toBeNull();
    });

    it("should report unhealthy when not connected and ping fails", async () => {
        (service as any).isConnected = true;
        const health = await service.isHealthy();
        // Ping will fail, so it will report using fallback
        expect(health.usingFallback).toBe(true);
    });
});

describe("RedisCacheService - circuit breaker", () => {
    let service: RedisCacheService;
    let mockClient: any;

    beforeEach(() => {
        delete process.env.REDIS_DISABLED;
        service = new RedisCacheService();
        (service as any).REDIS_DISABLED = false;
        (service as any).isConnected = true;
        mockClient = {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            exists: jest.fn(),
            ping: jest.fn(),
            disconnect: jest.fn(),
            multi: jest.fn(),
            incrbyfloat: jest.fn(),
            ttl: jest.fn(),
        };
        (service as any).client = mockClient;
        (service as any).fallbackCleanupInterval = setInterval(() => {}, 60000);
    });

    afterEach(() => {
        service.onModuleDestroy();
    });

    it("should open circuit breaker after consecutive failures", async () => {
        mockClient.get.mockRejectedValue(new Error("fail"));

        // Trigger 3 failures
        await service.get("k1");
        await service.get("k2");
        await service.get("k3");

        // Circuit should be open - next call should skip Redis
        (service as any).setFallback("k4", "cached", 60);
        const result = await service.get("k4");
        expect(result).toBe("cached");
    });

    it("should recover after circuit breaker timeout", async () => {
        // Open the circuit
        (service as any).consecutiveFailures = 3;
        (service as any).lastFailureTime = Date.now() - 31000; // 31s ago, past the 30s window

        mockClient.get.mockResolvedValue(JSON.stringify("success"));
        mockClient.ttl.mockResolvedValue(60);

        const result = await service.get("key");
        expect(result).toBe("success");
    });

    it("should record success and close circuit breaker", async () => {
        (service as any).consecutiveFailures = 2;
        mockClient.get.mockResolvedValue(JSON.stringify("ok"));
        mockClient.ttl.mockResolvedValue(60);

        await service.get("key");
        expect((service as any).consecutiveFailures).toBe(0);
    });

    it("should handle successful set operation", async () => {
        mockClient.set.mockResolvedValue("OK");

        await service.set("key", "val", 60);
        expect(mockClient.set).toHaveBeenCalledWith("key", '"val"', "EX", 60);
    });

    it("should handle successful exists operation", async () => {
        mockClient.exists.mockResolvedValue(1);

        const result = await service.exists("key");
        expect(result).toBe(true);
    });

    it("should handle successful del operation", async () => {
        mockClient.del.mockResolvedValue(1);
        await service.del("key");
        expect(mockClient.del).toHaveBeenCalledWith("key");
    });

    it("should handle incrbyfloat success", async () => {
        mockClient.incrbyfloat.mockResolvedValue("15.5");

        const result = await service.incrbyfloat("counter", 5.5, 3600);
        expect(result).toBe(15.5);
    });

    it("should handle incrbyfloat with TTL on new key", async () => {
        mockClient.incrbyfloat.mockResolvedValue("5");
        mockClient.ttl.mockResolvedValue(-1);
        // Mock expire - we need to add it
        mockClient.expire = jest.fn().mockResolvedValue(1);

        const result = await service.incrbyfloat("counter", 5, 3600);
        expect(result).toBe(5);
    });

    it("should skip Redis set when circuit breaker is open", async () => {
        (service as any).consecutiveFailures = 3;
        (service as any).lastFailureTime = Date.now();

        await service.set("cb-key", "value", 60);

        expect(mockClient.set).not.toHaveBeenCalled();
        expect((service as any).getFallback("cb-key")).toBe("value");
    });

    it("should delete fallback entry via getDel when circuit breaker is open", async () => {
        (service as any).setFallback("cb-gd", "cached", 60);
        (service as any).consecutiveFailures = 3;
        (service as any).lastFailureTime = Date.now();

        await expect(service.getDel("cb-gd")).resolves.toBe("cached");
        expect((service as any).getFallback("cb-gd")).toBeNull();
    });

    it("should use fallback when getDel multi returns get error", async () => {
        (service as any).setFallback("gd-key", "cached", 60);
        mockClient.multi.mockReturnValue({
            get: jest.fn().mockReturnThis(),
            del: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue([[new Error("boom"), null], [null, 1]]),
        });

        const result = await service.getDel("gd-key");

        expect(result).toBe("cached");
        expect((service as any).getFallback("gd-key")).toBeNull();
    });

    it("should return parsed value on successful getDel multi execution", async () => {
        (service as any).setFallback("gd-success", "stale", 60);
        mockClient.multi.mockReturnValue({
            get: jest.fn().mockReturnThis(),
            del: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue([[null, "{\"ok\":true}"], [null, 1]]),
        });

        await expect(service.getDel<{ ok: boolean }>("gd-success")).resolves.toEqual({ ok: true });
        expect((service as any).getFallback("gd-success")).toBeNull();
    });

    it("should handle del and exists errors without throwing", async () => {
        (service as any).setFallback("exists-key", "cached", 60);
        mockClient.del.mockRejectedValue(new Error("del-failed"));
        mockClient.exists.mockRejectedValue(new Error("exists-failed"));

        await expect(service.del("some-key")).resolves.toBeUndefined();
        await expect(service.exists("exists-key")).resolves.toBe(true);
    });

    it("should handle health success and counter branches", async () => {
        mockClient.ping.mockResolvedValue("PONG");
        mockClient.get
            .mockResolvedValueOnce("12.5")
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error("counter-fail"));

        await expect(service.isHealthy()).resolves.toEqual(
            expect.objectContaining({ healthy: true, usingFallback: false })
        );
        await expect(service.getCounter("counter")).resolves.toBe(12.5);
        await expect(service.getCounter("counter")).resolves.toBe(0);
        await expect(service.getCounter("counter")).resolves.toBeNull();

        (service as any).consecutiveFailures = 3;
        (service as any).lastFailureTime = Date.now();
        await expect(service.getCounter("counter")).resolves.toBeNull();
    });

    it("should cover incrbyfloat fallback branches and decr wrapper", async () => {
        (service as any).consecutiveFailures = 3;
        (service as any).lastFailureTime = Date.now();
        await expect(service.incrbyfloat("counter", 1)).resolves.toBeNull();

        (service as any).consecutiveFailures = 0;
        (service as any).isConnected = false;
        await expect(service.incrbyfloat("counter", 1)).resolves.toBeNull();

        (service as any).isConnected = true;
        mockClient.incrbyfloat.mockRejectedValue(new Error("incr-fail"));
        await expect(service.incrbyfloat("counter", 1)).resolves.toBeNull();

        const spy = jest
            .spyOn(service, "incrbyfloat")
            .mockResolvedValueOnce(8);
        await expect(service.decrbyfloat("counter", 8)).resolves.toBe(8);
        expect(spy).toHaveBeenCalledWith("counter", -8);
        spy.mockRestore();
    });

    it("should keep fallback value when Redis set throws while connected", async () => {
        mockClient.set.mockRejectedValue(new Error("set-failed"));

        await expect(service.set("set-fail", "value", 60)).resolves.toBeUndefined();
        expect((service as any).getFallback("set-fail")).toBe("value");
    });

    it("should return early for del and getCounter when not connected", async () => {
        (service as any).setFallback("del-key", "value", 60);
        (service as any).isConnected = false;

        await expect(service.del("del-key")).resolves.toBeUndefined();
        await expect(service.getCounter("counter")).resolves.toBeNull();
        expect(mockClient.del).not.toHaveBeenCalled();
    });
});

describe("RedisCacheService - module init with Redis enabled", () => {
    let service: RedisCacheService;
    let mockClient: any;
    let redisCtor: jest.Mock;

    beforeEach(() => {
        delete process.env.REDIS_DISABLED;
        redisCtor = require("ioredis");
        redisCtor.mockClear();

        mockClient = {
            on: jest.fn(),
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            exists: jest.fn(),
            ping: jest.fn(),
            disconnect: jest.fn(),
            multi: jest.fn(),
            incrbyfloat: jest.fn(),
            ttl: jest.fn(),
            expire: jest.fn(),
        };

        redisCtor.mockImplementation(() => mockClient);

        service = new RedisCacheService();
        service.onModuleInit();
    });

    afterEach(() => {
        service.onModuleDestroy();
    });

    it("should configure Redis constructor options and retry hooks", () => {
        expect(redisCtor).toHaveBeenCalledTimes(1);

        const options = redisCtor.mock.calls[0][0];

        expect(options.retryStrategy(2)).toBe(400);
        expect(options.retryStrategy(6)).toBeNull();
        expect(options.reconnectOnError(new Error("Too many requests"))).toBe(true);
        expect(options.reconnectOnError(new Error("READONLY"))).toBe(true);
        expect(options.reconnectOnError(new Error("other"))).toBe(false);
    });

    it("should register connection listeners and toggle connection state", () => {
        const listeners = new Map<string, Function>();
        for (const [eventName, callback] of mockClient.on.mock.calls) {
            listeners.set(eventName, callback);
        }

        expect(listeners.has("error")).toBe(true);
        expect(listeners.has("connect")).toBe(true);
        expect(listeners.has("close")).toBe(true);
        expect(listeners.has("reconnecting")).toBe(true);

        listeners.get("connect")?.();
        expect(service.getStats().isConnected).toBe(true);

        listeners.get("close")?.();
        expect(service.getStats().isConnected).toBe(false);

        listeners.get("reconnecting")?.();

        listeners.get("error")?.(new Error("redis-down"));
        expect(service.getStats().isConnected).toBe(false);
    });

    it("should clean up expired fallback entries", async () => {
        await service.set("fresh", "ok", 60);
        await service.set("expired", "gone", 0);

        (service as any).cleanupFallbackCache();

        expect(await service.get("fresh")).toBe("ok");
        expect(await service.get("expired")).toBeNull();
    });
});

describe("RedisCacheService - cleanup interval callbacks", () => {
    afterEach(() => {
        delete process.env.REDIS_DISABLED;
        jest.restoreAllMocks();
    });

    it("runs cleanup callback in Redis-disabled mode", () => {
        process.env.REDIS_DISABLED = "true";

        const intervalSpy = jest.spyOn(globalThis, "setInterval").mockImplementation(((cb: any) => {
            cb();
            return 1 as any;
        }) as any);

        const service = new RedisCacheService();
        const cleanupSpy = jest.spyOn(service as any, "cleanupFallbackCache");

        service.onModuleInit();

        expect(intervalSpy).toHaveBeenCalled();
        expect(cleanupSpy).toHaveBeenCalled();

        service.onModuleDestroy();
    });

    it("runs cleanup callback in Redis-enabled mode", () => {
        delete process.env.REDIS_DISABLED;

        const intervalSpy = jest.spyOn(globalThis, "setInterval").mockImplementation(((cb: any) => {
            cb();
            return 1 as any;
        }) as any);

        const service = new RedisCacheService();
        const cleanupSpy = jest.spyOn(service as any, "cleanupFallbackCache");

        service.onModuleInit();

        expect(intervalSpy).toHaveBeenCalled();
        expect(cleanupSpy).toHaveBeenCalled();

        service.onModuleDestroy();
    });
});
