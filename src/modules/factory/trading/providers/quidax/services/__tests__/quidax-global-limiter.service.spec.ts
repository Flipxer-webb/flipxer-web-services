import { QuidaxTooManyRequestError } from "@/libs/quidax";
import { QuidaxGlobalLimiterService } from "../quidax-global-limiter.service";

describe("QuidaxGlobalLimiterService", () => {
    let service: QuidaxGlobalLimiterService;
    let rateLimiterService: { checkLimit: jest.Mock };
    let redisCacheService: { get: jest.Mock; set: jest.Mock };

    beforeEach(() => {
        rateLimiterService = {
            checkLimit: jest.fn().mockResolvedValue({
                allowed: true,
                remaining: 1,
                resetTime: Date.now() + 60_000,
            }),
        };

        redisCacheService = {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
        };

        service = new QuidaxGlobalLimiterService(
            rateLimiterService as any,
            redisCacheService as any,
        );
    });

    it("throws when a cooldown is already active", async () => {
        jest.spyOn(Date, "now").mockReturnValue(1_000);
        redisCacheService.get.mockResolvedValueOnce({
            consecutiveThrottleCount: 2,
            cooldownUntil: 6_000,
        });

        await expect(service.assertAllowed("main")).rejects.toBeInstanceOf(QuidaxTooManyRequestError);
        expect(rateLimiterService.checkLimit).not.toHaveBeenCalled();

        jest.restoreAllMocks();
    });

    it("uses the stricter wallet-address bucket settings", async () => {
        await service.assertAllowed("wallet-address");

        expect(rateLimiterService.checkLimit).toHaveBeenCalledWith(
            "shared",
            expect.objectContaining({
                limit: 15,
                windowSeconds: 1,
                keyPrefix: "quidax:budget:wallet-address:",
            }),
        );
    });

    it("ignores expired cooldowns and checks the shared main bucket", async () => {
        jest.spyOn(Date, "now").mockReturnValue(10_000);
        redisCacheService.get.mockResolvedValueOnce({
            consecutiveThrottleCount: 1,
            cooldownUntil: 9_000,
        });

        await expect(service.assertAllowed("main")).resolves.toBeUndefined();

        expect(rateLimiterService.checkLimit).toHaveBeenCalledWith(
            "shared",
            expect.objectContaining({
                limit: 240,
                windowSeconds: 60,
                keyPrefix: "quidax:budget:main:",
            }),
        );

        jest.restoreAllMocks();
    });

    it("sets a shared cooldown and throws when the main bucket is exhausted", async () => {
        jest.spyOn(Date, "now").mockReturnValue(10_000);
        rateLimiterService.checkLimit.mockResolvedValueOnce({
            allowed: false,
            remaining: 0,
            resetTime: 14_000,
        });

        await expect(service.assertAllowed("main")).rejects.toBeInstanceOf(QuidaxTooManyRequestError);

        expect(redisCacheService.set).toHaveBeenCalledWith(
            "quidax:cooldown:main",
            expect.objectContaining({
                consecutiveThrottleCount: 0,
                cooldownUntil: 14_000,
            }),
            4,
        );

        jest.restoreAllMocks();
    });

    it("sets a cooldown when Quidax returns a throttle/block response", async () => {
        jest.spyOn(Date, "now").mockReturnValue(10_000);

        await service.noteThrottle("main");

        expect(redisCacheService.set).toHaveBeenCalledWith(
            "quidax:cooldown:main",
            expect.objectContaining({
                consecutiveThrottleCount: 1,
                cooldownUntil: 130_000,
            }),
            120,
        );

        jest.restoreAllMocks();
    });

    it("keeps the longer existing cooldown when a new throttle arrives", async () => {
        jest.spyOn(Date, "now").mockReturnValue(10_000);
        redisCacheService.get.mockResolvedValueOnce({
            consecutiveThrottleCount: 1,
            cooldownUntil: 400_000,
        });

        await service.noteThrottle("wallet-address");

        expect(redisCacheService.set).toHaveBeenCalledWith(
            "quidax:cooldown:wallet-address",
            expect.objectContaining({
                consecutiveThrottleCount: 2,
                cooldownUntil: 400_000,
            }),
            390,
        );

        jest.restoreAllMocks();
    });
});