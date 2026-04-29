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
});