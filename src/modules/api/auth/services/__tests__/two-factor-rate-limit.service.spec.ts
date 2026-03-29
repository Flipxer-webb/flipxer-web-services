import { TwoFactorRateLimitService } from "../two-factor-rate-limit.service";

describe("TwoFactorRateLimitService", () => {
    const redis = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    let service: TwoFactorRateLimitService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new TwoFactorRateLimitService(redis as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("allows first attempt when no record exists", async () => {
        redis.get.mockResolvedValueOnce(null); // lockout
        redis.get.mockResolvedValueOnce(null); // attempt record

        const result = await service.checkAttempt("user-1", "login");

        expect(result).toEqual({ allowed: true, remainingAttempts: 4 });
    });

    it("blocks attempts while lockout is active", async () => {
        const now = 1_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);
        redis.get.mockResolvedValueOnce(now + 30_000); // active lockout

        const result = await service.checkAttempt("user-2", "transaction");

        expect(result.allowed).toBe(false);
        expect(result.remainingAttempts).toBe(0);
        expect(result.lockoutDuration).toBe(30);
    });

    it("resets stale attempts after TTL", async () => {
        const now = 2_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);

        redis.get
            .mockResolvedValueOnce(null) // lockout
            .mockResolvedValueOnce({ count: 2, lastAttemptAt: now - (25 * 60 * 60 * 1000) }); // stale record

        const resetSpy = jest.spyOn(service, "resetAttempts").mockResolvedValue();

        const result = await service.checkAttempt("user-3", "login");

        expect(resetSpy).toHaveBeenCalledWith("user-3", "login");
        expect(result).toEqual({ allowed: true, remainingAttempts: 4 });
    });

    it("returns remaining attempts for active non-stale records", async () => {
        const now = 2_500_000;
        jest.spyOn(Date, "now").mockReturnValue(now);

        redis.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ count: 3, lastAttemptAt: now - 1000 });

        const result = await service.checkAttempt("user-3b", "transaction");

        expect(result).toEqual({ allowed: true, remainingAttempts: 2 });
    });

    it("records first failed attempt without lockout", async () => {
        jest.spyOn(Date, "now").mockReturnValue(3_000_000);
        redis.get.mockResolvedValue(null);

        const result = await service.recordFailedAttempt("user-4", "login");

        expect(result).toEqual({ allowed: true, remainingAttempts: 4, lockoutEndsAt: undefined, lockoutDuration: undefined });
        expect(redis.set).toHaveBeenCalledTimes(1);
        expect(redis.set).toHaveBeenCalledWith(
            "2fa:attempts:login:user-4",
            expect.objectContaining({ count: 1 }),
            86400,
        );
    });

    it("applies exponential lockout on subsequent failed attempts", async () => {
        jest.spyOn(Date, "now").mockReturnValue(4_000_000);
        redis.get.mockResolvedValue({ count: 1, lastAttemptAt: 3_999_000 });

        const result = await service.recordFailedAttempt("user-5", "login");

        expect(result.allowed).toBe(false);
        expect(result.remainingAttempts).toBe(3);
        expect(result.lockoutDuration).toBe(30);
        expect(redis.set).toHaveBeenCalledWith("2fa:lockout:login:user-5", 4_030_000, 30);
    });

    it("resets all tracking after successful attempt", async () => {
        await service.recordSuccessfulAttempt("user-6", "transaction");

        expect(redis.del).toHaveBeenCalledWith("2fa:attempts:transaction:user-6");
        expect(redis.del).toHaveBeenCalledWith("2fa:lockout:transaction:user-6");
    });

    it("resets both login and transaction contexts when context is omitted", async () => {
        await service.resetAttempts("user-6b");

        expect(redis.del).toHaveBeenCalledWith("2fa:attempts:login:user-6b");
        expect(redis.del).toHaveBeenCalledWith("2fa:lockout:login:user-6b");
        expect(redis.del).toHaveBeenCalledWith("2fa:attempts:transaction:user-6b");
        expect(redis.del).toHaveBeenCalledWith("2fa:lockout:transaction:user-6b");
    });

    it("returns null status when no history exists", async () => {
        redis.get.mockResolvedValue(null);

        const result = await service.getAttemptStatus("user-7", "login");

        expect(result).toBeNull();
    });

    it("returns active lockout status in dashboard view", async () => {
        const now = 5_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);

        redis.get
            .mockResolvedValueOnce({ count: 3, lastAttemptAt: now - 1000 })
            .mockResolvedValueOnce(now + 60_000);

        const result = await service.getAttemptStatus("user-8", "login");

        expect(result).toEqual({
            allowed: false,
            remainingAttempts: 0,
            lockoutEndsAt: now + 60_000,
            lockoutDuration: 60,
        });
    });

    it("returns remaining attempts when not currently locked", async () => {
        const now = 6_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);

        redis.get
            .mockResolvedValueOnce({ count: 2, lastAttemptAt: now - 1000 })
            .mockResolvedValueOnce(now - 10_000);

        const result = await service.getAttemptStatus("user-9", "transaction");

        expect(result).toEqual({ allowed: true, remainingAttempts: 3 });
    });
});
