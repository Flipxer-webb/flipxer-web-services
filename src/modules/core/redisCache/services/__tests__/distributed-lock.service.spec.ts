import { Test, TestingModule } from "@nestjs/testing";
import { DistributedLockService } from "../distributed-lock.service";

// Mock Redis
jest.mock("ioredis", () => {
    const mockRedis = {
        on: jest.fn(),
        set: jest.fn(),
        get: jest.fn(),
        del: jest.fn(),
        eval: jest.fn(),
        exists: jest.fn(),
        pttl: jest.fn(),
        quit: jest.fn(),
        disconnect: jest.fn(),
        status: "ready",
    };
    return jest.fn(() => mockRedis);
});

describe("DistributedLockService", () => {
    let service: DistributedLockService;
    let mockRedis: any;

    beforeEach(async () => {
        jest.clearAllMocks();
        
        const module: TestingModule = await Test.createTestingModule({
            providers: [DistributedLockService],
        }).compile();

        service = module.get<DistributedLockService>(DistributedLockService);
        
        // Get the mock Redis instance
        const Redis = require("ioredis");
        mockRedis = new Redis();
        
        // Simulate connected state
        const connectHandler = mockRedis.on.mock.calls.find(
            (call: any[]) => call[0] === "connect"
        );
        if (connectHandler) {
            connectHandler[1]();
        }
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("acquireLock", () => {
        it("should acquire lock successfully when key is available", async () => {
            mockRedis.set.mockResolvedValue("OK");
            
            const token = await service.acquireLock("test-key");
            
            expect(token).toBeTruthy();
            expect(mockRedis.set).toHaveBeenCalled();
        });

        it("should return null when lock cannot be acquired", async () => {
            mockRedis.set.mockResolvedValue(null);
            
            const token = await service.acquireLock("test-key", { maxWaitMs: 100 });
            
            expect(token).toBeNull();
        });

        it("should use custom TTL", async () => {
            mockRedis.set.mockResolvedValue("OK");
            
            await service.acquireLock("test-key", { ttlMs: 60000 });
            
            const setCall = mockRedis.set.mock.calls[0];
            expect(setCall).toContain("PX");
            expect(setCall).toContain(60000);
        });

        it("should throw in strict mode when lock service is unavailable", async () => {
            const closeHandler = mockRedis.on.mock.calls.find(
                (call: any[]) => call[0] === "close"
            );
            closeHandler?.[1]();

            await expect(
                service.acquireLock("strict-key", { strict: true, maxWaitMs: 0 })
            ).rejects.toThrow("Redis lock service unavailable");
        });

        it("should throw strict lock error when redis set fails while connected", async () => {
            mockRedis.set.mockRejectedValue(new Error("redis set down"));

            await expect(
                service.acquireLock("strict-error", { strict: true, maxWaitMs: 0 })
            ).rejects.toThrow("Redis lock error for strict-error: redis set down");
        });
    });

    describe("releaseLock", () => {
        it("should release lock when token matches", async () => {
            const token = "test-token";
            mockRedis.eval.mockResolvedValue(1);
            
            const result = await service.releaseLock("test-key", token);
            
            expect(result).toBe(true);
            expect(mockRedis.eval).toHaveBeenCalled();
        });

        it("should not release lock when token does not match", async () => {
            mockRedis.eval.mockResolvedValue(0);
            
            const result = await service.releaseLock("test-key", "wrong-token");
            
            expect(result).toBe(false);
        });

        it("should return true when redis is disconnected during release", async () => {
            const closeHandler = mockRedis.on.mock.calls.find(
                (call: any[]) => call[0] === "close"
            );
            closeHandler?.[1]();

            await expect(service.releaseLock("test-key", "token")).resolves.toBe(true);
            expect(mockRedis.eval).not.toHaveBeenCalled();
        });

        it("should return false when release throws", async () => {
            mockRedis.eval.mockRejectedValue(new Error("eval failed"));

            await expect(service.releaseLock("test-key", "token")).resolves.toBe(false);
        });
    });

    describe("withLock", () => {
        it("should execute callback when lock is acquired", async () => {
            mockRedis.set.mockResolvedValue("OK");
            mockRedis.eval.mockResolvedValue(1);
            
            const callback = jest.fn().mockResolvedValue("result");
            
            const result = await service.withLock("test-key", callback);
            
            expect(callback).toHaveBeenCalled();
            expect(result).toBe("result");
        });

        it("should throw error when lock cannot be acquired", async () => {
            mockRedis.set.mockResolvedValue(null);
            
            const callback = jest.fn();
            
            await expect(
                service.withLock("test-key", callback, { maxWaitMs: 100 })
            ).rejects.toThrow("Failed to acquire lock");
            
            expect(callback).not.toHaveBeenCalled();
        });

        it("should release lock even if callback throws", async () => {
            mockRedis.set.mockResolvedValue("OK");
            mockRedis.eval.mockResolvedValue(1);
            
            const callback = jest.fn().mockRejectedValue(new Error("Callback error"));
            
            await expect(
                service.withLock("test-key", callback)
            ).rejects.toThrow("Callback error");
            
            // Lock should still be released
            expect(mockRedis.eval).toHaveBeenCalled();
        });
    });

    describe("isLocked", () => {
        it("should return true when key is locked", async () => {
            mockRedis.exists.mockResolvedValue(1);
            
            const result = await service.isLocked("test-key");
            
            expect(result).toBe(true);
        });

        it("should return false when key is not locked", async () => {
            mockRedis.exists.mockResolvedValue(0);
            
            const result = await service.isLocked("test-key");
            
            expect(result).toBe(false);
        });

        it("should return false when disconnected", async () => {
            const closeHandler = mockRedis.on.mock.calls.find(
                (call: any[]) => call[0] === "close"
            );
            closeHandler?.[1]();

            await expect(service.isLocked("test-key")).resolves.toBe(false);
            expect(mockRedis.exists).not.toHaveBeenCalled();
        });

        it("should return false when redis exists throws", async () => {
            mockRedis.exists.mockRejectedValue(new Error("exists failed"));

            await expect(service.isLocked("test-key")).resolves.toBe(false);
        });
    });

    describe("getLockTTL", () => {
        it("should return pttl value when connected", async () => {
            mockRedis.pttl.mockResolvedValue(1234);

            await expect(service.getLockTTL("ttl-key")).resolves.toBe(1234);
            expect(mockRedis.pttl).toHaveBeenCalledWith("lock:ttl-key");
        });

        it("should return -1 when disconnected", async () => {
            const closeHandler = mockRedis.on.mock.calls.find(
                (call: any[]) => call[0] === "close"
            );
            closeHandler?.[1]();

            await expect(service.getLockTTL("ttl-key")).resolves.toBe(-1);
        });

        it("should return -1 when redis pttl throws", async () => {
            mockRedis.pttl.mockRejectedValue(new Error("pttl failed"));

            await expect(service.getLockTTL("ttl-key")).resolves.toBe(-1);
        });
    });

    describe("redis initialization handlers", () => {
        it("should expose retry strategy behavior from constructor options", () => {
            const Redis = require("ioredis");
            const options = Redis.mock.calls[0][0];

            expect(options.retryStrategy(2)).toBe(400);
            expect(options.retryStrategy(6)).toBeNull();
        });

        it("should handle error and close listeners", () => {
            const errorHandler = mockRedis.on.mock.calls.find(
                (call: any[]) => call[0] === "error"
            );
            const closeHandler = mockRedis.on.mock.calls.find(
                (call: any[]) => call[0] === "close"
            );

            errorHandler?.[1](new Error("boom"));
            closeHandler?.[1]();

            expect(service).toBeDefined();
        });

        it("should quit redis client on module destroy", async () => {
            mockRedis.status = "ready";

            await service.onModuleDestroy();
            expect(mockRedis.quit).toHaveBeenCalled();
        });

        it("should disconnect redis client when it is already closed", async () => {
            mockRedis.status = "end";

            await service.onModuleDestroy();

            expect(mockRedis.disconnect).toHaveBeenCalledWith(false);
            expect(mockRedis.quit).not.toHaveBeenCalled();
        });
    });
});
