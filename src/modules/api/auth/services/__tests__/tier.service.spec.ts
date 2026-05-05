import { UserType } from "@prisma/client";
import { TierService } from "../tier.service";

const createStageAttempt = (
    stage: string,
    status: string,
    overrides: Record<string, unknown> = {},
) => ({
    stage,
    status,
    isCurrent: true,
    ...overrides,
});

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
        jest.spyOn((service as any).logger, "log").mockImplementation(
            () => undefined,
        );
        jest.spyOn((service as any).logger, "error").mockImplementation(
            () => undefined,
        );
    });

    it("calculates individual tiers from verification status", () => {
        expect(service.calculateTier({ isEmailVerified: false })).toBe(0);
        expect(service.calculateTier({ isEmailVerified: true })).toBe(0);
        expect(
            service.calculateTier({
                isEmailVerified: true,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            }),
        ).toBe(1);
        expect(
            service.calculateTier({
                isEmailVerified: true,
                isDocumentVerified: true,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "NIN",
                    }),
                ],
            }),
        ).toBe(2);
        expect(
            service.calculateTier({
                isEmailVerified: true,
                isDocumentVerified: false,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "NIN",
                    }),
                    createStageAttempt("IDENTITY_DOCUMENT", "APPROVED"),
                ],
            }),
        ).toBe(2);
        expect(
            service.calculateTier({
                isEmailVerified: true,
                isDocumentVerified: true,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                    createStageAttempt("ADDRESS", "APPROVED"),
                ],
            }),
        ).toBe(3);
        expect(
            service.calculateTier({
                isEmailVerified: true,
                isDocumentVerified: true,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                    createStageAttempt("ADDRESS", "APPROVED"),
                    createStageAttempt("INCOME", "APPROVED"),
                ],
            }),
        ).toBe(4);
    });

    it("calculates business tier from document verification status", () => {
        expect(
            service.calculateTier({
                userType: UserType.BUSINESS,
                businessDocumentVerificationStatus: "PENDING",
            } as any),
        ).toBe(0);
        expect(
            service.calculateTier({
                userType: UserType.BUSINESS,
                businessDocumentVerificationStatus: "VERIFIED",
            } as any),
        ).toBe(1);
    });

    it("returns withdrawal limits and tier info", async () => {
        expect(service.getWithdrawalLimit(0)).toBe(0);

        await expect(
            service.getTierInfo({
                isEmailVerified: true,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            }),
        ).resolves.toEqual({
            tier: 1,
            withdrawalLimit: expect.any(Number),
            dailyLimits: { buy: 50, sell: 50, swap: 50, send: 50 },
            canTransact: true,
        });
    });

    it("updates user tier and skips update when unchanged", async () => {
        prisma.user.findUnique
            .mockResolvedValueOnce({
                id: 1,
                tier: 0,
                userType: UserType.INDIVIDUAL,
                bvn: "12345678901",
                nin: null,
                isEmailVerified: true,
                isDocumentVerified: false,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            })
            .mockResolvedValueOnce({
                id: 2,
                tier: 1,
                userType: UserType.INDIVIDUAL,
                bvn: "12345678901",
                nin: null,
                isEmailVerified: true,
                isDocumentVerified: false,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            });
        prisma.user.update.mockResolvedValue({ id: 1, tier: 1 });

        await expect(service.updateUserTier(1)).resolves.toEqual({
            id: 1,
            tier: 1,
        });
        await expect(service.updateUserTier(2)).resolves.toEqual(
            expect.objectContaining({ id: 2, tier: 1 }),
        );

        expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it("updates tier from approved staged identity document attempts", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 7,
            tier: 1,
            userType: UserType.INDIVIDUAL,
            bvn: null,
            nin: "12345678901",
            isEmailVerified: true,
            isDocumentVerified: false,
            businessDocumentVerificationStatus: null,
            kycStageAttempts: [
                createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                    method: "NIN",
                }),
                createStageAttempt("IDENTITY_DOCUMENT", "APPROVED"),
            ],
        });
        prisma.user.update.mockResolvedValue({ id: 7, tier: 2 });

        await expect(service.updateUserTier(7)).resolves.toEqual({
            id: 7,
            tier: 2,
        });

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 7 },
            data: { tier: 2 },
        });
    });

    it("throws when updateUserTier cannot find user", async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(service.updateUserTier(99)).rejects.toThrow(
            "User with ID 99 not found",
        );
    });

    it("syncs tier and invalidates profile cache", async () => {
        const updateSpy = jest
            .spyOn(service, "updateUserTier")
            .mockResolvedValue({ id: 5, tier: 1 } as any);

        await expect(service.syncTierAndCache(5)).resolves.toEqual({
            id: 5,
            tier: 1,
        });

        expect(updateSpy).toHaveBeenCalledWith(5);
        expect(redisCacheService.del).toHaveBeenCalledWith("user:profile:5");
    });

    it("bulk updates tiers and tracks changed/unchanged/errors", async () => {
        prisma.user.findMany.mockResolvedValue([
            {
                id: 1,
                email: "a@test.com",
                userType: UserType.INDIVIDUAL,
                tier: 0,
                bvn: "12345678901",
                nin: null,
                isEmailVerified: true,
                isPhoneVerified: false,
                isDocumentVerified: false,
                businessRecordCompleted: false,
                businessDocumentsUploaded: false,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            },
            {
                id: 2,
                email: "b@test.com",
                userType: UserType.INDIVIDUAL,
                tier: 1,
                bvn: "12345678902",
                nin: null,
                isEmailVerified: true,
                isPhoneVerified: false,
                isDocumentVerified: false,
                businessRecordCompleted: false,
                businessDocumentsUploaded: false,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            },
            {
                id: 3,
                email: "c@test.com",
                userType: UserType.INDIVIDUAL,
                tier: 0,
                bvn: "12345678903",
                nin: null,
                isEmailVerified: true,
                isPhoneVerified: false,
                isDocumentVerified: false,
                businessRecordCompleted: false,
                businessDocumentsUploaded: false,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                        method: "BVN",
                    }),
                ],
            },
        ]);
        prisma.user.update
            .mockResolvedValueOnce({ id: 1, tier: 1 })
            .mockRejectedValueOnce(new Error("db failure"));

        const result = await service.updateAllUserTiers();

        expect(result.total).toBe(3);
        expect(result.updated).toBe(1);
        expect(result.unchanged).toBe(1);
        expect(result.errors).toBe(1);
        expect(result.changes).toEqual([
            { email: "a@test.com", from: 0, to: 1 },
        ]);
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
                {
                    isEmailVerified: true,
                    isDocumentVerified: true,
                    kycStageAttempts: [
                        createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                            method: "BVN",
                        }),
                        createStageAttempt("ADDRESS", "APPROVED"),
                        createStageAttempt("INCOME", "APPROVED"),
                    ],
                },
                100,
                0,
            ),
        ).resolves.toEqual({ canWithdraw: true });

        await expect(
            service.validateWithdrawal(
                {
                    isEmailVerified: true,
                    kycStageAttempts: [
                        createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                            method: "BVN",
                        }),
                    ],
                },
                100000,
                0,
            ),
        ).resolves.toEqual({
            canWithdraw: false,
            reason: expect.stringContaining("Daily withdrawal limit"),
        });

        await expect(
            service.validateWithdrawal(
                {
                    isEmailVerified: true,
                    kycStageAttempts: [
                        createStageAttempt("GOVERNMENT_ID", "APPROVED", {
                            method: "BVN",
                        }),
                    ],
                },
                100,
                0,
            ),
        ).resolves.toEqual({
            canWithdraw: false,
            reason: expect.stringContaining("Daily withdrawal limit"),
        });
    });
});
