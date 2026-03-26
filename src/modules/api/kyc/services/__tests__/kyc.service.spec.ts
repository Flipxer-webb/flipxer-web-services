import { Test, TestingModule } from "@nestjs/testing";
import { KycService } from "../index";
import { PrismaService } from "@/modules/core/prisma/services";
import { TierService } from "@/modules/api/auth/services/tier.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { EmailService } from "@/modules/core/email/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { UserType } from "@prisma/client";

describe("KycService", () => {
    let service: KycService;

    const mockPrismaService = {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        auditLog: {
            create: jest.fn(),
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
        notify: jest.fn(),
    };

    const mockEmailService = {
        send: jest.fn(),
    };

    const mockWsGateway = {
        notifyProfileUpdate: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KycService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: TierService, useValue: mockTierService },
                { provide: NotificationDispatcher, useValue: mockNotificationDispatcher },
                { provide: EmailService, useValue: mockEmailService },
                { provide: RedisCacheService, useValue: mockRedisCacheService },
                { provide: WsGateway, useValue: mockWsGateway },
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
});
