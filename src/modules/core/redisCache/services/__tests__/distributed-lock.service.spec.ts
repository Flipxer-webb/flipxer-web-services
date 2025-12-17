import { Test, TestingModule } from "@nestjs/testing";
import { DistributedLockService } from "../distributed-lock.service";

// Mock Redis
jest.mock("ioredis", () => {
    const mockRedis = {
        on: jest.fn(),
        set: jest.fn(),
        get: jest.fn(),
        del: jest.fn(),
        quit: jest.fn(),
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
    });

    describe("releaseLock", () => {
        it("should release lock when token matches", async () => {
            const token = "test-token";
            mockRedis.get.mockResolvedValue(token);
            mockRedis.del.mockResolvedValue(1);
            
            const result = await service.releaseLock("test-key", token);
            
            expect(result).toBe(true);
            expect(mockRedis.del).toHaveBeenCalled();
        });

        it("should not release lock when token does not match", async () => {
            mockRedis.get.mockResolvedValue("different-token");
            
            const result = await service.releaseLock("test-key", "wrong-token");
            
            expect(result).toBe(false);
            expect(mockRedis.del).not.toHaveBeenCalled();
        });
    });

    describe("withLock", () => {
        it("should execute callback when lock is acquired", async () => {
            mockRedis.set.mockResolvedValue("OK");
            mockRedis.get.mockResolvedValue(expect.any(String));
            mockRedis.del.mockResolvedValue(1);
            
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
            mockRedis.get.mockResolvedValue(expect.any(String));
            mockRedis.del.mockResolvedValue(1);
            
            const callback = jest.fn().mockRejectedValue(new Error("Callback error"));
            
            await expect(
                service.withLock("test-key", callback)
            ).rejects.toThrow("Callback error");
            
            // Lock should still be released
            expect(mockRedis.del).toHaveBeenCalled();
        });
    });

    describe("isLocked", () => {
        it("should return true when key is locked", async () => {
            mockRedis.get.mockResolvedValue("some-token");
            
            const result = await service.isLocked("test-key");
            
            expect(result).toBe(true);
        });

        it("should return false when key is not locked", async () => {
            mockRedis.get.mockResolvedValue(null);
            
            const result = await service.isLocked("test-key");
            
            expect(result).toBe(false);
        });
    });
});
