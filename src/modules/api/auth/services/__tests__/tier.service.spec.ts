import { UserType } from "@prisma/client";
import { TierService } from "../tier.service";

describe("TierService", () => {
    const prisma = {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
            findMany: jest.fn(),
        },
    };

    const redisCacheService = {
        del: jest.fn(),
    };

    let service: TierService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new TierService(prisma as any, redisCacheService as any);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    it("calculates individual tiers from verification status", () => {
        expect(service.calculateTier({ isEmailVerified: false })).toBe(0);
        expect(service.calculateTier({ isEmailVerified: true })).toBe(0);
        expect(service.calculateTier({ isEmailVerified: true, isBvnVerified: true })).toBe(1);
        expect(service.calculateTier({ isEmailVerified: true, isNinVerified: true, isDocumentVerified: true })).toBe(2);
        expect(service.calculateTier({ isEmailVerified: true, isBvnVerified: true, isDocumentVerified: true, isAddressVerified: true })).toBe(3);
        expect(service.calculateTier({ isEmailVerified: true, isBvnVerified: true, isDocumentVerified: true, isAddressVerified: true, isIncomeVerified: true })).toBe(4);
    });

    it("calculates business tier from document verification status", () => {
        expect(service.calculateTier({ userType: UserType.BUSINESS, businessDocumentVerificationStatus: "PENDING" } as any)).toBe(0);
        expect(service.calculateTier({ userType: UserType.BUSINESS, businessDocumentVerificationStatus: "VERIFIED" } as any)).toBe(1);
    });

    it("returns withdrawal limits and tier info", async () => {
        expect(service.getWithdrawalLimit(0)).toBe(0);

        await expect(
            service.getTierInfo({ isEmailVerified: true, isBvnVerified: true }),
        ).resolves.toEqual({
            tier: 1,
            withdrawalLimit: expect.any(Number),
            dailyLimits: { buy: 50, sell: 50, swap: 50, send: 50 },
            canTransact: true,
        });
    });

    it("updates user tier and skips update when unchanged", async () => {
        prisma.user.findUnique
            .mockResolvedValueOnce({ id: 1, tier: 0, isEmailVerified: true, isBvnVerified: true, isNinVerified: false, isDocumentVerified: false, isAddressVerified: false, isIncomeVerified: false })
            .mockResolvedValueOnce({ id: 2, tier: 1, isEmailVerified: true, isBvnVerified: true, isNinVerified: false, isDocumentVerified: false, isAddressVerified: false, isIncomeVerified: false });
        prisma.user.update.mockResolvedValue({ id: 1, tier: 1 });

        await expect(service.updateUserTier(1)).resolves.toEqual({ id: 1, tier: 1 });
        await expect(service.updateUserTier(2)).resolves.toEqual(expect.objectContaining({ id: 2, tier: 1 }));

        expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it("throws when updateUserTier cannot find user", async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(service.updateUserTier(99)).rejects.toThrow("User with ID 99 not found");
    });

    it("syncs tier and invalidates profile cache", async () => {
        const updateSpy = jest.spyOn(service, "updateUserTier").mockResolvedValue({ id: 5, tier: 1 } as any);

        await expect(service.syncTierAndCache(5)).resolves.toEqual({ id: 5, tier: 1 });

        expect(updateSpy).toHaveBeenCalledWith(5);
        expect(redisCacheService.del).toHaveBeenCalledWith("user:profile:5");
    });

    it("bulk updates tiers and tracks changed/unchanged/errors", async () => {
        prisma.user.findMany.mockResolvedValue([
            { id: 1, email: "a@test.com", userType: UserType.INDIVIDUAL, tier: 0, isEmailVerified: true, isPhoneVerified: false, isBvnVerified: true, isNinVerified: false, isDocumentVerified: false, isAddressVerified: false, isIncomeVerified: false, businessRecordCompleted: false, businessDocumentsUploaded: false },
            { id: 2, email: "b@test.com", userType: UserType.INDIVIDUAL, tier: 1, isEmailVerified: true, isPhoneVerified: false, isBvnVerified: true, isNinVerified: false, isDocumentVerified: false, isAddressVerified: false, isIncomeVerified: false, businessRecordCompleted: false, businessDocumentsUploaded: false },
            { id: 3, email: "c@test.com", userType: UserType.INDIVIDUAL, tier: 0, isEmailVerified: true, isPhoneVerified: false, isBvnVerified: true, isNinVerified: false, isDocumentVerified: false, isAddressVerified: false, isIncomeVerified: false, businessRecordCompleted: false, businessDocumentsUploaded: false },
        ]);
        prisma.user.update
            .mockResolvedValueOnce({ id: 1, tier: 1 })
            .mockRejectedValueOnce(new Error("db failure"));

        const result = await service.updateAllUserTiers();

        expect(result.total).toBe(3);
        expect(result.updated).toBe(1);
        expect(result.unchanged).toBe(1);
        expect(result.errors).toBe(1);
        expect(result.changes).toEqual([{ email: "a@test.com", from: 0, to: 1 }]);
        expect(redisCacheService.del).toHaveBeenCalledWith("user:profile:1");
    });

    it("validates withdrawals based on tier and limits", async () => {
        await expect(
            service.validateWithdrawal({ isEmailVerified: false }, 100, 0),
        ).resolves.toEqual({
            canWithdraw: false,
            reason: "Complete KYC verification to unlock withdrawals",
        });

        await expect(
            service.validateWithdrawal(
                { isEmailVerified: true, isBvnVerified: true, isDocumentVerified: true, isAddressVerified: true, isIncomeVerified: true },
                100,
                0,
            ),
        ).resolves.toEqual({ canWithdraw: true });

        await expect(
            service.validateWithdrawal({ isEmailVerified: true, isBvnVerified: true }, 100000, 0),
        ).resolves.toEqual({
            canWithdraw: false,
            reason: expect.stringContaining("Daily withdrawal limit"),
        });

        await expect(
            service.validateWithdrawal({ isEmailVerified: true, isBvnVerified: true }, 100, 0),
        ).resolves.toEqual({
            canWithdraw: false,
            reason: expect.stringContaining("Daily withdrawal limit"),
        });
    });
});
