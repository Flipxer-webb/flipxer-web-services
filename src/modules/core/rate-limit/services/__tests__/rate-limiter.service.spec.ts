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
});
