import { Test, TestingModule } from "@nestjs/testing";
import { RateLimiterService } from "../rate-limiter.service";

describe("RateLimiterService (in-memory fallback)", () => {
    let service: RateLimiterService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RateLimiterService,
                {
                    provide: "RATE_LIMIT_OPTIONS",
                    useValue: {
                        limit: 5,
                        windowSeconds: 60,
                        useRedis: false,
                        keyPrefix: "test:",
                    },
                },
            ],
        }).compile();

        service = module.get(RateLimiterService);
        await service.onModuleInit();
    });

    afterEach(async () => {
        await service.onModuleDestroy();
    });

    it("allows requests within the limit", async () => {
        const result = await service.checkLimit("user-1");
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4);
    });

    it("tracks remaining requests correctly", async () => {
        for (let i = 0; i < 3; i++) {
            await service.checkLimit("user-2");
        }
        const result = await service.checkLimit("user-2");
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(1);
    });

    it("blocks requests exceeding the limit", async () => {
        for (let i = 0; i < 5; i++) {
            await service.checkLimit("user-3");
        }
        const result = await service.checkLimit("user-3");
        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
        expect(result.retryAfter).toBeDefined();
    });

    it("uses separate counters for different keys", async () => {
        for (let i = 0; i < 5; i++) {
            await service.checkLimit("user-a");
        }
        const resultA = await service.checkLimit("user-a");
        const resultB = await service.checkLimit("user-b");

        expect(resultA.allowed).toBe(false);
        expect(resultB.allowed).toBe(true);
    });

    it("respects config overrides", async () => {
        const result = await service.checkLimit("user-4", { limit: 1 });
        expect(result.allowed).toBe(true);

        const result2 = await service.checkLimit("user-4", { limit: 1 });
        expect(result2.allowed).toBe(false);
    });

    it("resets limit for a key", async () => {
        for (let i = 0; i < 5; i++) {
            await service.checkLimit("user-5");
        }
        const blocked = await service.checkLimit("user-5");
        expect(blocked.allowed).toBe(false);

        await service.resetLimit("user-5");

        const afterReset = await service.checkLimit("user-5");
        expect(afterReset.allowed).toBe(true);
    });

    it("returns retryAfter when blocked", async () => {
        for (let i = 0; i < 6; i++) {
            await service.checkLimit("user-6");
        }
        const result = await service.checkLimit("user-6");
        expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("returns in-memory status", async () => {
        await service.checkLimit("status-user");
        const status = await service.getStatus("status-user");

        expect(status).not.toBeNull();
        expect(status?.remaining).toBe(4);
        expect(status?.allowed).toBe(true);
    });

    it("returns null in-memory status when key is unknown", async () => {
        await expect(service.getStatus("missing")).resolves.toBeNull();
    });

    it("fails closed by default when check path throws", async () => {
        (service as any).checkInMemoryLimit = jest.fn(() => {
            throw new Error("boom");
        });

        const result = await service.checkLimit("error-user");
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBe(60);
    });

    it("fails open when configured to do so", async () => {
        (service as any).checkInMemoryLimit = jest.fn(() => {
            throw new Error("boom");
        });

        const result = await service.checkLimit("error-user-open", {
            failOpen: true,
            limit: 3,
            windowSeconds: 10,
        });

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(3);
    });
});

describe("RateLimiterService (redis mode)", () => {
    let service: RateLimiterService;

    beforeEach(() => {
        service = new RateLimiterService({
            limit: 3,
            windowSeconds: 60,
            useRedis: true,
            keyPrefix: "redis:",
        } as any);
    });

    it("uses redis multi pipeline for checks", async () => {
        const execMock = jest.fn().mockResolvedValue([
            [null, 1],
            [null, 1],
            [null, 2],
            [null, 1],
        ]);

        const multiMock = {
            zremrangebyscore: jest.fn().mockReturnThis(),
            zadd: jest.fn().mockReturnThis(),
            zcard: jest.fn().mockReturnThis(),
            expire: jest.fn().mockReturnThis(),
            exec: execMock,
        };

        const client = {
            multi: jest.fn().mockReturnValue(multiMock),
        };

        (service as any).client = client;
        (service as any).isRedisConnected = true;

        const result = await service.checkLimit("k1");
        expect(client.multi).toHaveBeenCalled();
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(1);
    });

    it("throws when redis multi returns null", async () => {
        const multiMock = {
            zremrangebyscore: jest.fn().mockReturnThis(),
            zadd: jest.fn().mockReturnThis(),
            zcard: jest.fn().mockReturnThis(),
            expire: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue(null),
        };

        (service as any).client = {
            multi: jest.fn().mockReturnValue(multiMock),
        };
        (service as any).isRedisConnected = true;

        const result = await service.checkLimit("k2", { failOpen: false });
        expect(result.allowed).toBe(false);
    });

    it("resets redis keys with DEL", async () => {
        const delMock = jest.fn().mockResolvedValue(1);

        (service as any).client = {
            del: delMock,
        };
        (service as any).isRedisConnected = true;

        await service.resetLimit("abc");
        expect(delMock).toHaveBeenCalledWith("redis:abc");
    });

    it("returns redis status and null when no records", async () => {
        const zcardMock = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2);
        const ttlMock = jest.fn().mockResolvedValue(30);

        (service as any).client = {
            zcard: zcardMock,
            ttl: ttlMock,
        };
        (service as any).isRedisConnected = true;

        await expect(service.getStatus("none")).resolves.toBeNull();

        const status = await service.getStatus("exists");
        expect(status).toMatchObject({
            allowed: true,
            remaining: 1,
        });
    });

    it("quits redis client on destroy", async () => {
        const quitMock = jest.fn().mockResolvedValue("OK");
        const disconnectMock = jest.fn();
        (service as any).client = {
            status: "ready",
            quit: quitMock,
            disconnect: disconnectMock,
        };

        await service.onModuleDestroy();
        expect(quitMock).toHaveBeenCalled();
    });

    it("disconnects closed redis client on destroy", async () => {
        const quitMock = jest.fn();
        const disconnectMock = jest.fn();
        (service as any).client = {
            status: "end",
            quit: quitMock,
            disconnect: disconnectMock,
        };

        await service.onModuleDestroy();

        expect(disconnectMock).toHaveBeenCalledWith(false);
        expect(quitMock).not.toHaveBeenCalled();
    });
});
