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
});
