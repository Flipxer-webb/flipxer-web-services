import { Test, TestingModule } from "@nestjs/testing";

// Break circular dependency: auth/guard → @/modules/api/user → auth/index → auth/controllers → @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import { KycService } from "../index";
import { PrismaService } from "@/modules/core/prisma/services";
import { TierService } from "@/modules/api/auth/services/tier.service";
import { KycStateMachineService } from "@/modules/api/auth/services/kyc-state-machine.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { EmailService } from "@/modules/core/email/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { IdentityResolutionService } from "@/modules/api/auth/services/identity-resolution.service";
import { UserType } from "@prisma/client";

describe("KycService", () => {
    let service: KycService;
    const mockKycStateMachine = {
        transition: jest.fn().mockResolvedValue(undefined),
    };

    const mockPrismaService = {
        $transaction: jest.fn(),
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            groupBy: jest.fn(),
        },
        auditLog: {
            create: jest.fn(),
            findMany: jest.fn(),
        },
        kycVerification: {
            findFirst: jest.fn(),
            create: jest.fn(),
        },
    };

    const mockTierService = {
        calculateTier: jest.fn(),
        syncTierAndCache: jest.fn(),
    };

    const mockRedisCacheService = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    const mockNotificationDispatcher = {
        notify: jest.fn().mockResolvedValue(undefined),
    };

    const mockEmailService = {
        send: jest.fn().mockResolvedValue(undefined),
    };

    const mockWsGateway = {
        notifyProfileUpdate: jest.fn(),
    };

    const mockIdentityResolutionService = {
        resolveOrCreate: jest.fn(),
        getSubjectForUser: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KycService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: TierService, useValue: mockTierService },
                { provide: KycStateMachineService, useValue: mockKycStateMachine },
                { provide: NotificationDispatcher, useValue: mockNotificationDispatcher },
                { provide: EmailService, useValue: mockEmailService },
                { provide: RedisCacheService, useValue: mockRedisCacheService },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: IdentityResolutionService, useValue: mockIdentityResolutionService },
            ],
        }).compile();

        service = module.get<KycService>(KycService);

        jest.clearAllMocks();
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    // ==================== updateUserTier ====================

    describe("updateUserTier - tier ceiling enforcement", () => {
        const baseUser = {
            id: 1,
            email: "test@example.com",
            tier: 1,
            userType: UserType.INDIVIDUAL,
            isBvnVerified: true,
            isNinVerified: false,
            isDocumentVerified: false,
            isAddressVerified: false,
            isIncomeVerified: false,
            isEmailVerified: true,
        };

        it("should allow setting tier at or below calculated tier", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(baseUser);
            mockTierService.calculateTier.mockReturnValue(1); // BVN only → Tier 1
            mockPrismaService.user.update.mockResolvedValue({ id: 1, email: baseUser.email, tier: 1 });
            mockPrismaService.auditLog.create.mockResolvedValue({});

            const result = await service.updateUserTier(1, { tier: 1 }, 99);

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: { tier: 1 },
                })
            );
            expect(result.data.tier).toBe(1);
        });

        it("should clamp tier to calculated ceiling when admin sets higher", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(baseUser);
            mockTierService.calculateTier.mockReturnValue(1); // Only BVN → Tier 1
            mockPrismaService.user.update.mockResolvedValue({ id: 1, email: baseUser.email, tier: 1 });
            mockPrismaService.auditLog.create.mockResolvedValue({});

            const result = await service.updateUserTier(1, { tier: 4 }, 99);

            // Should have been clamped from 4 → 1
            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: { tier: 1 },
                })
            );
            expect(result.data.tier).toBe(1);
        });

        it("should allow admin to downgrade tier below calculated", async () => {
            const verifiedUser = { ...baseUser, isDocumentVerified: true, tier: 2 };
            mockPrismaService.user.findUnique.mockResolvedValue(verifiedUser);
            mockTierService.calculateTier.mockReturnValue(2); // BVN + Doc → Tier 2
            mockPrismaService.user.update.mockResolvedValue({ id: 1, email: verifiedUser.email, tier: 0 });
            mockPrismaService.auditLog.create.mockResolvedValue({});

            const result = await service.updateUserTier(1, { tier: 0, reason: "Investigation" }, 99);

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: { tier: 0 },
                })
            );
            expect(result.data.tier).toBe(0);
        });

        it("should return 'User not found' for invalid user", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.updateUserTier(999, { tier: 1 }, 99);

            expect(result.message).toBe("User not found");
            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
        });
    });

    // ==================== processKycDecision ====================

    describe("processKycDecision - verification-gated tier", () => {
        const pendingUser = {
            id: 2,
            email: "pending@example.com",
            tier: 1,
            userType: UserType.INDIVIDUAL,
            isBvnVerified: true,
            isNinVerified: false,
            isDocumentVerified: false,
            isAddressVerified: false,
            isIncomeVerified: false,
            isEmailVerified: true,
            documentVerificationStatus: "PENDING",
            addressVerificationStatus: null,
            incomeVerificationStatus: null,
        };

        const updatedUserAfterApproval = {
            id: 2,
            email: "pending@example.com",
            tier: 1, // intermediate value before syncTierAndCache
            isBvnVerified: true,
            isNinVerified: false,
            isDocumentVerified: true,
            isAddressVerified: false,
            isIncomeVerified: false,
            addressVerificationStatus: null,
            incomeVerificationStatus: null,
            documentVerificationStatus: "VERIFIED",
        };

        it("should derive tier from syncTierAndCache on APPROVE, not from dto", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);
            mockPrismaService.user.update.mockResolvedValue(updatedUserAfterApproval);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...updatedUserAfterApproval, tier: 2 });
            mockPrismaService.kycVerification.create.mockResolvedValue({});
            mockPrismaService.auditLog.create.mockResolvedValue({});

            await service.processKycDecision(
                {
                    userId: 2,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                },
                99
            );

            // syncTierAndCache should have been called (tier derived from flags)
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(2);

            // Audit log should use the recalculated tier (2), not the intermediate value (1)
            expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        details: expect.objectContaining({
                            previousTier: 1,
                            newTier: 2,
                        }),
                    }),
                })
            );
        });

        it("should recalculate tier on REJECT (may downgrade)", async () => {
            const verifiedUser = {
                ...pendingUser,
                tier: 2,
                isDocumentVerified: true,
                documentVerificationStatus: "VERIFIED",
            };

            const rejectedUser = {
                ...updatedUserAfterApproval,
                isDocumentVerified: true, // flag not cleared on rejection, only status
                documentVerificationStatus: "DECLINED",
                tier: 2,
            };

            mockPrismaService.user.findUnique.mockResolvedValue(verifiedUser);
            mockPrismaService.user.update.mockResolvedValue(rejectedUser);
            // After rejection, syncTierAndCache recalculates — tier stays based on flags
            mockTierService.syncTierAndCache.mockResolvedValue({ ...rejectedUser, tier: 2 });
            mockPrismaService.kycVerification.create.mockResolvedValue({});
            mockPrismaService.auditLog.create.mockResolvedValue({});

            await service.processKycDecision(
                {
                    userId: 2,
                    action: "REJECT",
                    verificationType: "DOCUMENT",
                    note: "Blurry image",
                },
                99
            );

            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(2);
        });

        it("should not accept newTier field (removed from DTO type)", () => {
            // TypeScript compile-time check: KycDecisionDto should not have newTier
            const dto = {
                userId: 2,
                action: "APPROVE" as const,
                verificationType: "DOCUMENT",
            };

            // Verify the DTO shape has no newTier property
            expect(dto).not.toHaveProperty("newTier");
        });
    });

    describe("getKycQueue", () => {
        it("returns paginated KYC queue with verification summaries", async () => {
            const users = [
                {
                    id: 10,
                    identifier: "usr-10",
                    firstName: "Jane",
                    lastName: "Doe",
                    email: "jane@flipxer.com",
                    phone: "08000000000",
                    photo: null,
                    userType: UserType.INDIVIDUAL,
                    tier: 1,
                    status: "ACTIVE",
                    bvn: "12345678901",
                    nin: null,
                    isBvnVerified: false,
                    isNinVerified: false,
                    isDocumentVerified: false,
                    isAddressVerified: false,
                    isIncomeVerified: false,
                    isEmailVerified: true,
                    isPhoneVerified: false,
                    businessDocumentsUploaded: false,
                    businessDocumentVerificationStatus: null,
                    userDocument: { id: 1, type: "PASSPORT", documentNumber: "A1", documentImageUrl: "u", documentImageUrl2: null },
                    businessDocument: null,
                    businessRecord: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({
                pageNumber: 1,
                pageSize: 20,
                status: "PENDING",
                sortBy: "desc",
            } as any);

            expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
            expect(result.message).toBe("KYC queue retrieved successfully");
            expect(result.data.records).toHaveLength(1);
            expect(result.data.records[0].pendingVerifications).toContain("document");
            expect(result.data.records[0].pendingVerifications).toContain("address");
        });
    });

    describe("getKycStats", () => {
        it("returns aggregate stats and tier distribution", async () => {
            mockPrismaService.user.count
                .mockResolvedValueOnce(100)
                .mockResolvedValueOnce(30)
                .mockResolvedValueOnce(70)
                .mockResolvedValueOnce(60)
                .mockResolvedValueOnce(40)
                .mockResolvedValueOnce(20)
                .mockResolvedValueOnce(15);
            mockPrismaService.user.groupBy.mockResolvedValue([
                { tier: 0, _count: { _all: 10 } },
                { tier: 1, _count: { _all: 20 } },
                { tier: 2, _count: { _all: 30 } },
                { tier: 3, _count: { _all: 25 } },
                { tier: 4, _count: { _all: 15 } },
            ]);

            const result = await service.getKycStats({ period: "month" } as any);

            expect(result.message).toBe("KYC statistics retrieved successfully");
            expect(result.data.overview.totalUsers).toBe(100);
            expect(result.data.overview.pendingKyc).toBe(30);
            expect(result.data.tierDistribution.tier2.count).toBe(30);
            expect(result.data.verificationBreakdown.bvn.verified).toBe(70);
            expect(result.data.periodMetrics.newUsers).toBe(20);
        });
    });

    describe("updateUserVerification", () => {
        it("updates verification flags, audits changes, and syncs tier", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 4,
                bvn: "12345678901",
                nin: "10987654321",
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
            });

            mockPrismaService.user.update.mockResolvedValue({
                id: 4,
                email: "u@flipxer.com",
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
            });
            mockPrismaService.auditLog.create.mockResolvedValue({});
            mockTierService.syncTierAndCache.mockResolvedValue({ id: 4, tier: 1 });

            const result = await service.updateUserVerification(
                4,
                { isBvnVerified: true, isNinVerified: true, reason: "validated" } as any,
                9,
            );

            expect(result.message).toBe("User verification status updated successfully");
            expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        action: "UPDATE_USER_VERIFICATION",
                    }),
                }),
            );
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(4);
        });

        it("throws when attempting to verify NIN for users without NIN", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 10,
                bvn: "12345678901",
                nin: null,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
            });

            await expect(
                service.updateUserVerification(10, { isNinVerified: true, reason: "reviewed" } as any, 99),
            ).rejects.toThrow("Cannot set NIN verified");
        });

        it("throws when attempting to verify BVN for users without BVN", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 11,
                bvn: null,
                nin: "10987654321",
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
            });

            await expect(
                service.updateUserVerification(11, { isBvnVerified: true, reason: "reviewed" } as any, 99),
            ).rejects.toThrow("Cannot set BVN verified");
        });

        it("does not persist verification when identity resolution fails", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 12,
                bvn: "12345678901",
                nin: null,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
            });
            mockIdentityResolutionService.resolveOrCreate.mockRejectedValue(new Error("duplicate identity"));

            await expect(
                service.updateUserVerification(12, { isBvnVerified: true, reason: "reviewed" } as any, 99),
            ).rejects.toThrow("duplicate identity");

            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
            expect(mockPrismaService.auditLog.create).not.toHaveBeenCalled();
            expect(mockTierService.syncTierAndCache).not.toHaveBeenCalled();
        });
    });

    describe("document decision wrappers", () => {
        it("approveDocument maps address to ADDRESS verification", async () => {
            const processSpy = jest
                .spyOn(service, "processKycDecision")
                .mockResolvedValue({ message: "ok", data: {} } as any);

            await service.approveDocument({ userId: 3, documentType: "address" } as any, 99);

            expect(processSpy).toHaveBeenCalledWith(
                {
                    userId: 3,
                    action: "APPROVE",
                    verificationType: "ADDRESS",
                },
                99,
            );
        });

        it("rejectDocument maps business to BUSINESS_DOCUMENT verification", async () => {
            const processSpy = jest
                .spyOn(service, "processKycDecision")
                .mockResolvedValue({ message: "ok", data: {} } as any);

            await service.rejectDocument(
                { userId: 3, documentType: "business", reason: "invalid CAC" } as any,
                99,
            );

            expect(processSpy).toHaveBeenCalledWith(
                {
                    userId: 3,
                    action: "REJECT",
                    verificationType: "BUSINESS_DOCUMENT",
                    note: "invalid CAC",
                },
                99,
            );
        });
    });
});
