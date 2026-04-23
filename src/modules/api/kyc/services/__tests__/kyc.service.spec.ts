import { BadRequestException } from "@nestjs/common";
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

jest.mock("@/config", () => ({
    emailTemplateConfig: {
        document_approved: "tpl-approved",
        document_rejected: "tpl-rejected",
        document_escalated: "tpl-escalated",
    },
    mailConfig: { senderMail: "noreply@test.com" },
    COMPANY_NAME: "Flipxer",
    cloudinaryConfig: { cloud_name: "cloud" },
    imagekitConfig: { url: "https://ik.imagekit.io/flipxer" },
}));

jest.mock("@/libs/ocr", () => ({
    validateAddressDocument: jest.fn(),
    validateIncomeDocument: jest.fn(),
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
    },
}));

import { KycService } from "../index";
import { PrismaService } from "@/modules/core/prisma/services";
import { TierService } from "@/modules/api/auth/services/tier.service";
import { KycStateMachineService } from "@/modules/api/auth/services/kyc-state-machine.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { EmailService } from "@/modules/core/email/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { IdentityResolutionService } from "@/modules/api/auth/services/identity-resolution.service";
import { AuditLogService } from "@/modules/api/audit-log";
import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { DocumentVerificationStatus, KycStatus, UserType } from "@prisma/client";
import { validateAddressDocument, validateIncomeDocument } from "@/libs/ocr";
import axios from "axios";

describe("KycService", () => {
    let service: KycService;
    const mockKycStateMachine = {
        transition: jest.fn().mockResolvedValue(undefined),
    };

    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };

    const mockDojahService = {
        verifyBvn: jest.fn(),
        verifyNin: jest.fn(),
        analyzeDocument: jest.fn(),
        lookupCAC: jest.fn(),
        verifyTIN: jest.fn(),
        verifyBusinessDocuments: jest.fn(),
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
        sendMailWithTemplate: jest.fn().mockResolvedValue(undefined),
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
                { provide: AuditLogService, useValue: mockAuditLogService },
                { provide: IdentityComplianceInjectionToken.DOJAH, useValue: mockDojahService },
            ],
        }).compile();

        service = module.get<KycService>(KycService);

        jest.clearAllMocks();
        mockPrismaService.kycVerification.findFirst.mockResolvedValue({
            id: 101,
            userId: 2,
            verificationType: "DOCUMENT",
            status: "PENDING",
            version: 3,
            isActive: true,
        });
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
            mockAuditLogService.log.mockResolvedValue(undefined);

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
            mockAuditLogService.log.mockResolvedValue(undefined);

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
            mockAuditLogService.log.mockResolvedValue(undefined);

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
            mockAuditLogService.log.mockResolvedValue(undefined);

            await service.processKycDecision(
                {
                    userId: 2,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                    version: 3,
                },
                99
            );

            // syncTierAndCache should have been called (tier derived from flags)
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(2);

            // Audit log should use the recalculated tier (2), not the intermediate value (1)
            expect(mockAuditLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: expect.objectContaining({
                        previousTier: 1,
                        newTier: 2,
                    }),
                })
            );
        });

        it("should clear document verification and downgrade tier on DOCUMENT reject", async () => {
            const verifiedUser = {
                ...pendingUser,
                tier: 2,
                isDocumentVerified: true,
                documentVerificationStatus: "VERIFIED",
            };

            const rejectedUser = {
                ...updatedUserAfterApproval,
                isDocumentVerified: false,
                documentVerificationStatus: "DECLINED",
                tier: 2,
            };

            mockPrismaService.user.findUnique.mockResolvedValue(verifiedUser);
            mockPrismaService.user.update.mockResolvedValue(rejectedUser);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...rejectedUser, tier: 1 });
            mockPrismaService.kycVerification.create.mockResolvedValue({});
            mockAuditLogService.log.mockResolvedValue(undefined);

            await service.processKycDecision(
                {
                    userId: 2,
                    action: "REJECT",
                    verificationType: "DOCUMENT",
                    version: 3,
                    note: "Blurry image",
                },
                99
            );

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 2 },
                    data: expect.objectContaining({
                        isDocumentVerified: false,
                        documentVerificationStatus: "DECLINED",
                    }),
                })
            );
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(2);
            expect(mockAuditLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: expect.objectContaining({
                        previousTier: 2,
                        newTier: 1,
                        verificationType: "DOCUMENT",
                    }),
                })
            );
        });

        it.each([
            {
                verificationType: "BVN",
                startingUser: {
                    ...pendingUser,
                    tier: 1,
                    isBvnVerified: true,
                },
                expectedData: {
                    isBvnVerified: false,
                },
                syncedTier: 0,
            },
            {
                verificationType: "ADDRESS",
                startingUser: {
                    ...pendingUser,
                    tier: 3,
                    isDocumentVerified: true,
                    isAddressVerified: true,
                    addressVerificationStatus: "VERIFIED",
                    addressDocumentUrl: "https://cdn.test/address.pdf",
                },
                expectedData: {
                    isAddressVerified: false,
                    addressVerificationStatus: "DECLINED",
                    addressDocumentUrl: null,
                },
                syncedTier: 2,
            },
            {
                verificationType: "INCOME",
                startingUser: {
                    ...pendingUser,
                    tier: 4,
                    isDocumentVerified: true,
                    isAddressVerified: true,
                    isIncomeVerified: true,
                    incomeVerificationStatus: "VERIFIED",
                    incomeDocumentUrl: "https://cdn.test/income.pdf",
                },
                expectedData: {
                    isIncomeVerified: false,
                    incomeVerificationStatus: "DECLINED",
                    incomeDocumentUrl: null,
                },
                syncedTier: 3,
            },
        ])("should clear dependent flags on %s reject", async ({ verificationType, startingUser, expectedData, syncedTier }) => {
            mockPrismaService.user.findUnique.mockResolvedValue(startingUser);
            mockPrismaService.user.update.mockResolvedValue({
                ...startingUser,
                ...expectedData,
            });
            mockTierService.syncTierAndCache.mockResolvedValue({ ...startingUser, ...expectedData, tier: syncedTier });

            await service.processKycDecision(
                {
                    userId: startingUser.id,
                    action: "REJECT",
                    verificationType,
                    version: 3,
                    note: "Rejected by admin",
                },
                99,
            );

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining(expectedData),
                }),
            );
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(startingUser.id);
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

        it("should send escalation email and notification on ESCALATE action", async () => {
            const escalateUser = {
                id: 5,
                email: "escalate@example.com",
                firstName: "Escalated",
                tier: 1,
                userType: UserType.INDIVIDUAL,
                isBvnVerified: true,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
                isEmailVerified: true,
                documentVerificationStatus: "PENDING",
            };

            mockPrismaService.user.findUnique.mockResolvedValue(escalateUser);
            mockPrismaService.user.update.mockResolvedValue({
                ...escalateUser,
                documentVerificationStatus: "ESCALATED",
            });
            mockTierService.syncTierAndCache.mockResolvedValue({
                ...escalateUser,
                tier: 1,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({});
            mockAuditLogService.log.mockResolvedValue(undefined);

            await service.processKycDecision(
                {
                    userId: 5,
                    action: "ESCALATE",
                    verificationType: "DOCUMENT",
                    version: 3,
                    note: "Needs senior review",
                },
                99
            );

            // Should send in-app notification with "Escalated" title
            expect(mockNotificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 5,
                    title: "KYC Verification Escalated",
                    category: "security",
                }),
            );

            // Should send escalation email via sendKycEmail
            expect(mockEmailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-escalated",
                    to: [
                        { email_address: { address: "escalate@example.com" } },
                    ],
                    merge_info: expect.objectContaining({
                        name: "Escalated",
                        document_type: "Identity Document",
                    }),
                }),
            );

            // Should log audit with ESCALATE action
            expect(mockAuditLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: "KYC_ESCALATE",
                }),
            );
        });

        it("falls back to the active verification version for legacy clients", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);
            mockPrismaService.user.update.mockResolvedValue(updatedUserAfterApproval);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...updatedUserAfterApproval, tier: 2 });

            await service.processKycDecision(
                {
                    userId: 2,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                },
                99,
            );

            expect(mockKycStateMachine.transition).toHaveBeenCalledWith(
                2,
                "DOCUMENT",
                "APPROVED",
                expect.objectContaining({
                    expectedVersion: 3,
                    reviewerId: 99,
                }),
            );
        });

        it("rejects KYC decisions that omit verificationType before side effects run", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);

            await expect(
                service.processKycDecision(
                    {
                        userId: 2,
                        action: "APPROVE",
                    } as any,
                    99,
                ),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(mockKycStateMachine.transition).not.toHaveBeenCalled();
            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
            expect(mockTierService.syncTierAndCache).not.toHaveBeenCalled();
            expect(mockAuditLogService.log).not.toHaveBeenCalled();
            expect(mockNotificationDispatcher.notify).not.toHaveBeenCalled();
            expect(mockEmailService.sendMailWithTemplate).not.toHaveBeenCalled();
        });

        it("returns a not-found response before attempting a state transition", async () => {
            const transitionSpy = jest.spyOn(service as any, "transitionKycDecision");

            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.processKycDecision(
                {
                    userId: 404,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                    version: 3,
                },
                99,
            );

            expect(result).toEqual(expect.objectContaining({ message: "User not found", success: true }));
            expect(transitionSpy).not.toHaveBeenCalled();
            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
        });

        it("returns transition feedback without mutating the user", async () => {
            const transitionResponse = {
                success: true,
                message: "DOCUMENT verification is no longer actionable.",
                data: { userId: 2, verificationType: "DOCUMENT", action: "APPROVE" },
            };
            const transitionSpy = jest
                .spyOn(service as any, "transitionKycDecision")
                .mockResolvedValueOnce(transitionResponse);

            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);

            const result = await service.processKycDecision(
                {
                    userId: 2,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                    version: 3,
                },
                99,
            );

            expect(result).toBe(transitionResponse);
            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
            expect(mockTierService.syncTierAndCache).not.toHaveBeenCalled();
            expect(mockAuditLogService.log).not.toHaveBeenCalled();
            expect(mockNotificationDispatcher.notify).not.toHaveBeenCalled();
            expect(mockWsGateway.notifyProfileUpdate).not.toHaveBeenCalled();

            transitionSpy.mockRestore();
        });

        it("logs notification dispatch failures without failing the decision", async () => {
            const errorSpy = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);
            mockPrismaService.user.update.mockResolvedValue(updatedUserAfterApproval);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...updatedUserAfterApproval, tier: 2 });
            mockPrismaService.kycVerification.create.mockResolvedValue({});
            mockAuditLogService.log.mockResolvedValue(undefined);
            mockNotificationDispatcher.notify.mockRejectedValueOnce(new Error("Push service unavailable"));

            const result = await service.processKycDecision(
                {
                    userId: 2,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                    version: 3,
                },
                99,
            );

            await Promise.resolve();

            expect(result).toEqual(expect.objectContaining({ message: "KYC approve processed successfully", success: true }));
            expect(errorSpy).toHaveBeenCalledWith("Failed to send KYC push notification to user 2: Push service unavailable");

            errorSpy.mockRestore();
        });
    });

    // ==================== sendKycEmail branch coverage ====================

    describe("sendKycEmail branch coverage", () => {
        it("returns early when user has no email", async () => {
            const noEmailUser = {
                id: 99,
                email: null,
                firstName: "NoMail",
            };
            await (service as any).sendKycEmail(
                noEmailUser,
                "ESCALATE",
                "DOCUMENT",
            );
            expect(mockEmailService.sendMailWithTemplate).not.toHaveBeenCalled();
        });

        it("uses default document type when verificationType is not provided", async () => {
            const user = {
                id: 100,
                email: "test@test.com",
                firstName: "Test",
            };
            await (service as any).sendKycEmail(user, "ESCALATE", undefined);
            expect(
                mockEmailService.sendMailWithTemplate,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        document_type: "KYC Verification",
                    }),
                }),
            );
        });

        it("handles escalation email send failure gracefully", async () => {
            const user = {
                id: 101,
                email: "fail@test.com",
                firstName: "FailTest",
            };
            mockEmailService.sendMailWithTemplate.mockRejectedValueOnce(
                new Error("SMTP timeout"),
            );
            // Should not throw
            await expect(
                (service as any).sendKycEmail(user, "ESCALATE", "BVN"),
            ).resolves.toBeUndefined();
        });

        it("returns early when the escalation template is not configured", async () => {
            const user = {
                id: 103,
                email: "escalate-missing@test.com",
                firstName: "EscalateMissing",
            };
            const configMock = jest.requireMock("@/config");
            const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
            const previousTemplate = configMock.emailTemplateConfig.document_escalated;

            try {
                configMock.emailTemplateConfig.document_escalated = "";

                await (service as any).sendKycEmail(user, "ESCALATE", "DOCUMENT");

                expect(warnSpy).toHaveBeenCalledWith("Email template not configured for KYC escalation");
                expect(mockEmailService.sendMailWithTemplate).not.toHaveBeenCalled();
            } finally {
                configMock.emailTemplateConfig.document_escalated = previousTemplate;
                warnSpy.mockRestore();
            }
        });

        it("sends approval email via APPROVE path", async () => {
            const user = {
                id: 102,
                email: "approve@test.com",
                firstName: "Approved",
            };
            await (service as any).sendKycEmail(user, "APPROVE", "ADDRESS");
            expect(mockEmailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-approved",
                    merge_info: expect.objectContaining({
                        document_type: "Address",
                        status: "Approved",
                    }),
                }),
            );
        });

        it("returns early when the approval template is not configured", async () => {
            const user = {
                id: 104,
                email: "approve-missing@test.com",
                firstName: "ApproveMissing",
            };
            const configMock = jest.requireMock("@/config");
            const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
            const previousTemplate = configMock.emailTemplateConfig.document_approved;

            try {
                configMock.emailTemplateConfig.document_approved = "";

                await (service as any).sendKycEmail(user, "APPROVE", "ADDRESS");

                expect(warnSpy).toHaveBeenCalledWith("Email template not configured for KYC approval");
                expect(mockEmailService.sendMailWithTemplate).not.toHaveBeenCalled();
            } finally {
                configMock.emailTemplateConfig.document_approved = previousTemplate;
                warnSpy.mockRestore();
            }
        });

        it("handles approval email send failure gracefully", async () => {
            const user = {
                id: 105,
                email: "approve-fail@test.com",
                firstName: "ApproveFail",
            };
            const errorSpy = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

            mockEmailService.sendMailWithTemplate.mockRejectedValueOnce(new Error("SMTP timeout"));

            await expect(
                (service as any).sendKycEmail(user, "APPROVE", "ADDRESS", "Mismatch"),
            ).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith("Failed to send KYC email to approve-fail@test.com: SMTP timeout");

            errorSpy.mockRestore();
        });
    });

    describe("getKycQueue", () => {
        it("uses default pagination when page params are omitted", async () => {
            mockPrismaService.$transaction.mockResolvedValue([[], 0]);

            await service.getKycQueue({} as any);

            expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    skip: 0,
                    take: 20,
                }),
            );
        });

        it("defaults to actionable queue view when no status is provided", async () => {
            const users = [
                {
                    id: 12,
                    identifier: "usr-12",
                    firstName: "Queue",
                    lastName: "Review",
                    email: "queue@flipxer.com",
                    phone: "08000000002",
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
                    addressDocumentUrl: null,
                    addressVerificationStatus: null,
                    incomeDocumentUrl: null,
                    incomeVerificationStatus: null,
                    userDocument: null,
                    businessDocument: null,
                    businessRecord: null,
                    kycVerifications: [
                        {
                            id: 1,
                            verificationType: "DOCUMENT",
                            status: "PENDING",
                            submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                            reviewedAt: null,
                            reviewNote: null,
                            reviewerId: null,
                            version: 3,
                        },
                    ],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({ pageNumber: 1, pageSize: 20, sortBy: "desc" } as any);

            expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        AND: expect.arrayContaining([
                            expect.objectContaining({
                                kycVerifications: expect.objectContaining({
                                    some: expect.objectContaining({ status: "PENDING", isActive: true }),
                                }),
                            }),
                        ]),
                    }),
                }),
            );
            expect(result.data.records[0].queueView).toBe("ACTIONABLE");
            expect(result.data.records[0].queueReason).toContain("Submitted identity document review for review");
                expect(new Date(result.data.records[0].oldestSubmittedAt).toISOString()).toBe("2026-04-20T10:00:00.000Z");
            expect(result.data.records[0].currentVerificationVersion).toBe(3);
        });

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
                    addressDocumentUrl: null,
                    addressVerificationStatus: null,
                    incomeDocumentUrl: null,
                    incomeVerificationStatus: null,
                    userDocument: { id: 1, type: "PASSPORT", documentNumber: "A1", documentImageUrl: "u", documentImageUrl2: null },
                    businessDocument: null,
                    businessRecord: null,
                    kycVerifications: [],
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
                expect(result.data.records[0].pendingVerifications).toContain("ADDRESS");
                expect(result.data.records[0].pendingVerifications).toContain("INCOME");
            expect(result.data.records[0].needsReview).toBe(false);
            expect(result.data.records[0].kycVerificationStatuses).toEqual({});
        });

        it("enriches users with needsReview=true when kycVerifications contain PENDING", async () => {
            const users = [
                {
                    id: 11,
                    identifier: "usr-11",
                    firstName: "Bob",
                    lastName: "Review",
                    email: "bob@flipxer.com",
                    phone: "08000000001",
                    photo: null,
                    userType: UserType.INDIVIDUAL,
                    tier: 1,
                    status: "ACTIVE",
                    bvn: "99999999999",
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
                    addressDocumentUrl: null,
                    addressVerificationStatus: null,
                    incomeDocumentUrl: null,
                    incomeVerificationStatus: null,
                    userDocument: null,
                    businessDocument: null,
                    businessRecord: null,
                    kycVerifications: [
                        { id: 1, verificationType: "BVN", status: "PENDING", submittedAt: new Date(), reviewedAt: null, reviewNote: null, reviewerId: null, version: 3 },
                        { id: 2, verificationType: "DOCUMENT", status: "APPROVED", submittedAt: new Date(), reviewedAt: new Date(), reviewNote: null, reviewerId: 99, version: 2 },
                    ],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({
                pageNumber: 1,
                pageSize: 20,
                status: "NEEDS_REVIEW",
                sortBy: "desc",
            } as any);

            expect(result.data.records[0].needsReview).toBe(true);
            expect(result.data.records[0].kycVerificationStatuses).toEqual({
                BVN: "PENDING",
                DOCUMENT: "APPROVED",
            });
        });

        it("builds awaiting-user queue metadata when submissions are missing", async () => {
            const users = [
                {
                    id: 14,
                    identifier: "usr-14",
                    firstName: "Awaiting",
                    lastName: "User",
                    email: "awaiting@flipxer.com",
                    phone: "08000000003",
                    photo: null,
                    userType: UserType.INDIVIDUAL,
                    tier: 0,
                    status: "ACTIVE",
                    bvn: null,
                    nin: null,
                    isBvnVerified: false,
                    isNinVerified: false,
                    isDocumentVerified: false,
                    isAddressVerified: false,
                    isIncomeVerified: false,
                    isEmailVerified: true,
                    isPhoneVerified: true,
                    businessDocumentsUploaded: false,
                    businessDocumentVerificationStatus: null,
                    addressDocumentUrl: null,
                    addressVerificationStatus: null,
                    incomeDocumentUrl: null,
                    incomeVerificationStatus: null,
                    userDocument: null,
                    businessDocument: null,
                    businessRecord: null,
                    kycVerifications: [],
                    createdAt: new Date("2026-04-20T10:00:00.000Z"),
                    updatedAt: new Date("2026-04-20T10:00:00.000Z"),
                },
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({
                pageNumber: 1,
                pageSize: 20,
                queueView: "AWAITING_USER",
            } as any);

            expect(result.data.records[0]).toEqual(
                expect.objectContaining({
                    queueView: "AWAITING_USER",
                    needsReview: false,
                    queueReason: "Awaiting user submission for 5 verification stages",
                }),
            );
            expect(result.data.records[0].blockingVerificationTypes).toEqual(["BVN", "NIN", "DOCUMENT", "ADDRESS", "INCOME"]);
        });

        it("builds resolved queue metadata for reviewed records", async () => {
            const users = [
                {
                    id: 15,
                    identifier: "usr-15",
                    firstName: "Resolved",
                    lastName: "User",
                    email: "resolved@flipxer.com",
                    phone: "08000000004",
                    photo: null,
                    userType: UserType.INDIVIDUAL,
                    tier: 2,
                    status: "ACTIVE",
                    bvn: "12345678901",
                    nin: "12345678902",
                    isBvnVerified: true,
                    isNinVerified: true,
                    isDocumentVerified: true,
                    isAddressVerified: true,
                    isIncomeVerified: true,
                    isEmailVerified: true,
                    isPhoneVerified: true,
                    businessDocumentsUploaded: false,
                    businessDocumentVerificationStatus: null,
                    addressDocumentUrl: "https://cdn.test/address.pdf",
                    addressVerificationStatus: "VERIFIED",
                    incomeDocumentUrl: "https://cdn.test/income.pdf",
                    incomeVerificationStatus: "VERIFIED",
                    userDocument: { id: 1, type: "PASSPORT", documentNumber: "A1", documentImageUrl: "u", documentImageUrl2: null },
                    businessDocument: null,
                    businessRecord: null,
                    kycVerifications: [
                        {
                            id: 3,
                            verificationType: "DOCUMENT",
                            status: "APPROVED",
                            submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                            reviewedAt: new Date("2026-04-21T10:00:00.000Z"),
                            reviewNote: null,
                            reviewerId: 55,
                            version: 2,
                        },
                    ],
                    createdAt: new Date("2026-04-19T10:00:00.000Z"),
                    updatedAt: new Date("2026-04-21T10:00:00.000Z"),
                },
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({
                pageNumber: 1,
                pageSize: 20,
                queueView: "RESOLVED",
                status: "APPROVED",
            } as any);

            expect(result.data.records[0]).toEqual(
                expect.objectContaining({
                    queueView: "RESOLVED",
                    latestReviewState: "APPROVED",
                    currentVerificationVersion: 2,
                    needsReview: false,
                }),
            );
        });
    });

    describe("getKycStats", () => {
        it("returns aggregate stats and tier distribution", async () => {
            mockPrismaService.user.count
                .mockResolvedValueOnce(100)  // totalUsers
                .mockResolvedValueOnce(5)    // needsReviewCount
                .mockResolvedValueOnce(18)   // awaitingUserCount
                .mockResolvedValueOnce(4)    // escalatedCount
                .mockResolvedValueOnce(7)    // rejectedCount
                .mockResolvedValueOnce(15)   // resolvedInPeriod
                .mockResolvedValueOnce(70)   // bvnVerified
                .mockResolvedValueOnce(60)   // ninVerified
                .mockResolvedValueOnce(40)   // documentVerified
                .mockResolvedValueOnce(20);  // newUsersInPeriod
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
            expect(result.data.overview.pendingKyc).toBe(18);
            expect(result.data.overview.needsReview).toBe(5);
            expect(result.data.overview.awaitingUser).toBe(18);
            expect(result.data.overview.escalated).toBe(4);
            expect(result.data.overview.rejected).toBe(7);
            expect(result.data.overview.resolvedInPeriod).toBe(15);
            expect(result.data.tierDistribution.tier2.count).toBe(30);
            expect(result.data.verificationBreakdown.bvn.verified).toBe(70);
            expect(result.data.periodMetrics.newUsers).toBe(20);
            expect(result.data.periodMetrics.kycCompleted).toBe(15);
        });
    });

    describe("getKycUserDetail", () => {
        it("returns a not-found response when the requested KYC user does not exist", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.getKycUserDetail(404);

            expect(result).toEqual(expect.objectContaining({ message: "User not found", success: true }));
        });

        it("returns stage-specific address, income, and business evidence", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 44,
                identifier: "usr-44",
                firstName: "Ada",
                lastName: "Reviewer",
                email: "ada@flipxer.com",
                phone: "08001112222",
                photo: null,
                userType: UserType.BUSINESS,
                tier: 3,
                status: "ACTIVE",
                createdAt: new Date("2026-04-01T10:00:00.000Z"),
                bvn: null,
                nin: null,
                dateOfBirth: null,
                gender: null,
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: true,
                isAddressVerified: false,
                isIncomeVerified: false,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: "PENDING",
                residentialAddress: "12 Marina, Lagos",
                addressDocumentUrl: "https://cdn.test/address.pdf",
                addressVerificationStatus: "PENDING",
                incomeDocumentUrl: "https://cdn.test/income.pdf",
                incomeVerificationStatus: "DECLINED",
                documentVerificationStatus: "VERIFIED",
                userDocument: { id: 9, type: "PASSPORT" },
                businessDocument: { cacImageUrl: "https://cdn.test/cac.pdf", tinVerified: true },
                businessRecord: { businessName: "Ada Stores", taxIdentificationNumber: "TIN-123" },
                accountLimit: { dailyLimit: 500000, monthlyLimit: 2000000 },
                kycVerifications: [
                    {
                        id: 91,
                        verificationType: "ADDRESS",
                        status: "PENDING",
                        reviewNote: "Utility bill is cropped",
                        reviewedAt: null,
                        reviewerId: null,
                        providerRef: null,
                        providerRawResponse: null,
                        documentUrl: "https://cdn.test/address.pdf",
                        submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                        version: 4,
                        isActive: true,
                    },
                    {
                        id: 92,
                        verificationType: "BUSINESS_DOCUMENT",
                        status: "PENDING",
                        reviewNote: "BUSINESS_DOCUMENT investigative lookup captured from Dojah",
                        reviewedAt: new Date("2026-04-21T11:30:00.000Z"),
                        reviewerId: 99,
                        providerRef: "lookup-92",
                        providerRawResponse: {
                            source: "ADMIN_PROVIDER_LOOKUP",
                            lookupType: "BUSINESS_DOCUMENT",
                            outcome: "SUCCESS",
                            lookedUpAt: "2026-04-21T11:30:00.000Z",
                            results: [{ key: "CAC", status: "SUCCESS" }],
                        },
                        documentUrl: "https://cdn.test/cac.pdf",
                        submittedAt: new Date("2026-04-21T11:30:00.000Z"),
                        version: 4,
                        isActive: false,
                    },
                ],
                order: [
                    {
                        id: 901,
                        orderCategory: "SELL",
                        amount: 1200,
                        currency: "USDT",
                        streamlinedStatus: "COMPLETED",
                        createdAt: new Date("2026-04-22T12:00:00.000Z"),
                    },
                ],
            });
            mockPrismaService.auditLog.findMany.mockResolvedValue([
                { action: "KYC_REJECT", details: { verificationType: "INCOME", note: "Statement unreadable" }, createdAt: new Date("2026-04-21T09:00:00.000Z") },
            ]);

            const result = await service.getKycUserDetail(44);

            expect(result.data.verificationStatus.address).toEqual(
                expect.objectContaining({
                    verified: false,
                    submitted: true,
                    status: "PENDING",
                    details: expect.objectContaining({
                        documentUrl: "https://cdn.test/address.pdf",
                        residentialAddress: "12 Marina, Lagos",
                    }),
                }),
            );
            expect(result.data.verificationStatus.income).toEqual(
                expect.objectContaining({
                    verified: false,
                    submitted: true,
                    status: "DECLINED",
                    details: expect.objectContaining({
                        documentUrl: "https://cdn.test/income.pdf",
                    }),
                }),
            );
            expect(result.data.verificationStatus.businessDocument).toEqual(
                expect.objectContaining({
                    verified: false,
                    submitted: true,
                    status: "PENDING",
                }),
            );
            expect(result.data.businessInfo).toEqual(
                expect.objectContaining({
                    submitted: true,
                    status: "PENDING",
                    record: expect.objectContaining({ businessName: "Ada Stores" }),
                }),
            );
            expect(result.data.kycVerifications).toEqual([
                expect.objectContaining({ id: 91, verificationType: "ADDRESS", isActive: true }),
            ]);
            expect(result.data.kycVerificationHistory).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: 91, isActive: true }),
                    expect.objectContaining({ id: 92, isActive: false }),
                ]),
            );
            expect(result.data.limits).toEqual(expect.objectContaining({ dailyLimit: 500000 }));
            expect(result.data.recentTransactions).toHaveLength(1);
        });
    });

    describe("runVerificationLookup", () => {
        it("returns a not-found response when the lookup user does not exist", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.runVerificationLookup({ userId: 404, verificationType: "BVN" }, 99);

            expect(result).toEqual(expect.objectContaining({ message: "User not found", success: true }));
        });

        it("persists investigative lookup history without replacing the active verification", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 12,
                firstName: "Ada",
                lastName: "Lookup",
                phone: "08001112222",
                dateOfBirth: "1991-02-03",
                bvn: "12345678901",
                nin: null,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                documentVerificationStatus: "PENDING",
                businessDocumentVerificationStatus: null,
                userDocument: null,
                businessDocument: null,
                businessRecord: null,
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 410,
                status: "PENDING",
                version: 3,
                documentUrl: null,
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 411 });
            mockDojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        reference_id: "bvn-ref-123",
                        first_name: "Ada",
                        last_name: "Lookup",
                        date_of_birth: "1991-02-03",
                        phone_number1: "+2348001112222",
                    },
                },
            });

            const result = await service.runVerificationLookup({ userId: 12, verificationType: "BVN" }, 99);

            expect(mockPrismaService.kycVerification.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        userId: 12,
                        verificationType: "BVN",
                        status: "PENDING",
                        version: 3,
                        isActive: false,
                        reviewerId: 99,
                        reviewNote: "BVN investigative lookup captured from Dojah",
                        providerRef: "bvn-ref-123",
                        providerRawResponse: expect.objectContaining({
                            source: "ADMIN_PROVIDER_LOOKUP",
                            lookupType: "BVN",
                            outcome: "SUCCESS",
                            requestedByAdminId: 99,
                            activeVerificationId: 410,
                            results: [
                                expect.objectContaining({
                                    key: "BVN",
                                    status: "SUCCESS",
                                    providerRef: "bvn-ref-123",
                                }),
                            ],
                        }),
                    }),
                }),
            );
            expect(mockAuditLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: "KYC_PROVIDER_LOOKUP",
                    details: expect.objectContaining({
                        verificationType: "BVN",
                        outcome: "SUCCESS",
                        kycVerificationHistoryId: 411,
                    }),
                }),
            );
            expect(result.data.historyRecordId).toBe(411);
            expect(result.data.results).toEqual([
                expect.objectContaining({
                    key: "BVN",
                    status: "SUCCESS",
                    providerRef: "bvn-ref-123",
                    summary: expect.objectContaining({
                        nameMatches: true,
                        dobMatches: true,
                        phoneMatches: true,
                        expectedName: "Ada Lookup",
                        providerName: "Ada Lookup",
                    }),
                }),
            ]);
        });

        it("runs NIN investigative lookups through Dojah identity verification", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 13,
                firstName: "Ada",
                lastName: "Lookup",
                phone: "08001112222",
                dateOfBirth: "1991-02-03",
                bvn: null,
                nin: "22334455667",
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                documentVerificationStatus: "PENDING",
                businessDocumentVerificationStatus: null,
                userDocument: null,
                businessDocument: null,
                businessRecord: null,
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 420,
                status: "PENDING",
                version: 6,
                documentUrl: null,
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 421 });
            mockDojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        reference_id: "nin-ref-123",
                        first_name: "Ada",
                        last_name: "Lookup",
                        date_of_birth: "1991-02-03",
                        phone_number1: "+2348001112222",
                    },
                },
            });

            const result = await service.runVerificationLookup({ userId: 13, verificationType: "NIN" }, 99);

            expect(result.data.results).toEqual([
                expect.objectContaining({
                    key: "NIN",
                    providerRef: "nin-ref-123",
                    summary: expect.objectContaining({
                        nameMatches: true,
                        dobMatches: true,
                        phoneMatches: true,
                    }),
                }),
            ]);
        });

        it("runs document investigative lookups through Dojah OCR", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 19,
                firstName: "Ada",
                lastName: "Lookup",
                phone: "08001112222",
                dateOfBirth: "1991-02-03",
                bvn: null,
                nin: null,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                documentVerificationStatus: "PENDING",
                businessDocumentVerificationStatus: null,
                userDocument: {
                    type: "PASSPORT",
                    documentNumber: "A12345",
                    documentImageUrl: "https://ik.imagekit.io/flipxer/passport-front.png",
                    documentImageUrl2: "https://ik.imagekit.io/flipxer/passport-back.png",
                },
                businessDocument: null,
                businessRecord: null,
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 710,
                status: "PENDING",
                version: 4,
                documentUrl: "https://ik.imagekit.io/flipxer/passport-front.png",
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 711 });
            mockDojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: true,
                    firstName: "Ada",
                    lastName: "Lookup",
                    dateOfBirth: "1991-02-03",
                    documentType: "PASSPORT",
                    documentNumber: "A12345",
                    expiryDate: "2030-01-01",
                },
                response: {
                    data: {
                        entity: {
                            reference_id: "doc-ref-123",
                        },
                    },
                },
            });

            const result = await service.runVerificationLookup({ userId: 19, verificationType: "DOCUMENT" }, 99);

            expect(result.data.results).toEqual([
                expect.objectContaining({
                    key: "DOCUMENT",
                    status: "SUCCESS",
                    providerRef: "doc-ref-123",
                    summary: expect.objectContaining({
                        nameMatches: true,
                        dobMatches: true,
                        documentTypeMatches: true,
                        documentNumberMatches: true,
                    }),
                }),
            ]);
        });

        it("runs address investigative lookups through the OCR validator", async () => {
            jest.spyOn(service as any, "downloadLookupDocument").mockResolvedValue({
                buffer: Buffer.from("address-doc"),
                mimeType: "application/pdf",
            });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                isValid: false,
                confidence: 88,
                extractedText: "Ada Lookup 12 Marina Lagos electricity bill April 2026",
                matchedName: true,
                matchedAddress: true,
                matchedResidentialAddress: false,
                requiresManualReview: true,
                reason: "Document flagged for review: Residential address does not match the profile address",
                documentDate: "2026-04-01T00:00:00.000Z",
                isRecent: true,
            });
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 18,
                firstName: "Ada",
                lastName: "Lookup",
                residentialAddress: "12 Marina, Lagos",
                addressDocumentUrl: "https://ik.imagekit.io/flipxer/address.pdf",
                incomeDocumentUrl: null,
                bvn: null,
                nin: null,
                userDocument: null,
                businessDocument: null,
                businessRecord: null,
                isAddressVerified: false,
                isIncomeVerified: false,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                addressVerificationStatus: "PENDING",
                incomeVerificationStatus: null,
                documentVerificationStatus: null,
                businessDocumentVerificationStatus: null,
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 510,
                status: "PENDING",
                version: 2,
                documentUrl: "https://ik.imagekit.io/flipxer/address.pdf",
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 511 });

            const result = await service.runVerificationLookup({ userId: 18, verificationType: "ADDRESS" }, 77);

            expect(validateAddressDocument).toHaveBeenCalledWith(
                expect.any(Buffer),
                "Ada",
                "Lookup",
                "12 Marina, Lagos",
                "application/pdf",
            );
            expect(result.data.results).toEqual([
                expect.objectContaining({
                    key: "ADDRESS",
                    provider: "OCR",
                    status: "FAILED",
                    summary: expect.objectContaining({
                        expectedAddress: "12 Marina, Lagos",
                        addressMatches: false,
                        nameMatches: true,
                    }),
                }),
            ]);
        });

        it("runs income investigative lookups through the OCR validator", async () => {
            jest.spyOn(service as any, "downloadLookupDocument").mockResolvedValue({
                buffer: Buffer.from("income-doc"),
                mimeType: "application/pdf",
            });
            (validateIncomeDocument as jest.Mock).mockResolvedValue({
                isValid: true,
                confidence: 91,
                extractedText: "Ada Lookup salary payslip gross net pay April 2026",
                matchedName: true,
                requiresManualReview: false,
                reason: undefined,
                documentDate: "2026-04-01T00:00:00.000Z",
                isRecent: true,
            });
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 21,
                firstName: "Ada",
                lastName: "Lookup",
                residentialAddress: null,
                incomeDocumentUrl: "https://ik.imagekit.io/flipxer/income.pdf",
                addressDocumentUrl: null,
                bvn: null,
                nin: null,
                userDocument: null,
                businessDocument: null,
                businessRecord: null,
                isAddressVerified: false,
                isIncomeVerified: false,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                addressVerificationStatus: null,
                incomeVerificationStatus: "PENDING",
                documentVerificationStatus: null,
                businessDocumentVerificationStatus: null,
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 610,
                status: "PENDING",
                version: 4,
                documentUrl: "https://ik.imagekit.io/flipxer/income.pdf",
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 611 });

            const result = await service.runVerificationLookup({ userId: 21, verificationType: "INCOME" }, 77);

            expect(validateIncomeDocument).toHaveBeenCalledWith(
                expect.any(Buffer),
                "Ada",
                "Lookup",
                "application/pdf",
            );
            expect(result.data.results).toEqual([
                expect.objectContaining({
                    key: "INCOME",
                    provider: "OCR",
                    status: "SUCCESS",
                    summary: expect.objectContaining({
                        nameMatches: true,
                        requiresManualReview: false,
                    }),
                }),
            ]);
        });

        it("runs business investigative lookups across CAC, TIN, and OCR", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 31,
                firstName: "Ada",
                lastName: "Owner",
                phone: "08001112222",
                bvn: null,
                nin: null,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                documentVerificationStatus: null,
                businessDocumentVerificationStatus: "PENDING",
                userDocument: null,
                businessRecord: {
                    businessName: "Ada Stores",
                    taxIdentificationNumber: "TIN-123",
                },
                businessDocument: {
                    cacDocumentNumber: "RC-123",
                    cacImageUrl: "https://ik.imagekit.io/flipxer/cac.pdf",
                },
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 810,
                status: "PENDING",
                version: 5,
                documentUrl: "https://ik.imagekit.io/flipxer/cac.pdf",
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 811 });
            mockDojahService.lookupCAC.mockResolvedValue({
                data: {
                    entity: {
                        reference_id: "cac-ref-123",
                        company_name: "Ada Stores Ltd",
                        company_status: "ACTIVE",
                        registration_date: "2020-01-01",
                    },
                },
            });
            mockDojahService.verifyTIN.mockResolvedValue({
                data: {
                    entity: {
                        reference_id: "tin-ref-123",
                        taxpayer_name: "Ada Stores",
                    },
                },
            });
            mockDojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: true,
                    firstName: "Ada",
                    lastName: "Stores",
                    documentNumber: "RC-123",
                },
                response: {
                    data: {
                        entity: {
                            reference_id: "ocr-ref-123",
                        },
                    },
                },
            });

            const result = await service.runVerificationLookup({ userId: 31, verificationType: "BUSINESS_DOCUMENT" }, 77);

            expect(result.data.results).toHaveLength(3);
            expect(result.data.results).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ key: "CAC", status: "SUCCESS" }),
                    expect.objectContaining({ key: "TIN", status: "SUCCESS" }),
                    expect.objectContaining({ key: "CAC_OCR", status: "SUCCESS" }),
                ]),
            );
        });

        it("reports mixed business lookup results as a partial failure", async () => {
            const businessLookupSpy = jest
                .spyOn(service as any, "runBusinessDocumentLookup")
                .mockResolvedValueOnce([
                    {
                        key: "CAC",
                        label: "CAC lookup",
                        status: "SUCCESS",
                        provider: "DOJAH",
                        providerRef: "cac-ref-1",
                        summary: { verified: true },
                        rawResponse: { ok: true },
                        lookedUpAt: "2026-04-23T12:30:00.000Z",
                    },
                    {
                        key: "TIN",
                        label: "TIN verification",
                        status: "FAILED",
                        provider: "DOJAH",
                        providerRef: null,
                        summary: { error: "TIN provider timeout" },
                        rawResponse: { error: "TIN provider timeout" },
                        lookedUpAt: "2026-04-23T12:30:00.000Z",
                    },
                ]);

            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 55,
                userDocument: null,
                businessDocument: null,
                businessRecord: null,
            });
            mockPrismaService.kycVerification.findFirst.mockResolvedValue({
                id: 910,
                status: "PENDING",
                version: 5,
                documentUrl: null,
                providerRef: null,
            });
            mockPrismaService.kycVerification.create.mockResolvedValue({ id: 911 });

            const result = await service.runVerificationLookup({ userId: 55, verificationType: "BUSINESS_DOCUMENT" }, 77);

            expect(result).toEqual(expect.objectContaining({
                message: "BUSINESS_DOCUMENT lookup completed with partial failures",
                data: expect.objectContaining({
                    historyRecordId: 911,
                }),
            }));
            expect(mockPrismaService.kycVerification.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reviewNote: "BUSINESS_DOCUMENT investigative lookup captured with 1 provider issue",
                    }),
                }),
            );

            businessLookupSpy.mockRestore();
        });

        it("rejects unsupported lookup types", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 56,
                userDocument: null,
                businessDocument: null,
                businessRecord: null,
            });

            await expect(
                service.runVerificationLookup({ userId: 56, verificationType: "ALIEN" } as any, 77),
            ).rejects.toThrow("Unsupported lookup type: ALIEN");
        });
    });

    describe("document lookup helpers", () => {
        it("downloads investigative documents from trusted origins", async () => {
            (axios.get as jest.Mock).mockResolvedValue({
                data: Uint8Array.from([1, 2, 3]).buffer,
                headers: { "content-type": "application/pdf" },
            });

            const result = await (service as any).downloadLookupDocument("https://ik.imagekit.io/flipxer/document.pdf");

            expect(axios.get).toHaveBeenCalledWith(
                "https://ik.imagekit.io/flipxer/document.pdf",
                expect.objectContaining({
                    responseType: "arraybuffer",
                    timeout: 30000,
                    maxRedirects: 0,
                }),
            );
            expect(result.mimeType).toBe("application/pdf");
            expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
        });

        it("rejects untrusted investigative document urls", async () => {
            await expect(
                (service as any).downloadLookupDocument("http://evil.example.com/document.pdf"),
            ).rejects.toThrow("Stored document URL is not trusted for investigative lookup");
        });

        it("covers lookup status fallback helpers and note variants", () => {
            const user = {
                isBvnVerified: true,
                isNinVerified: false,
                isDocumentVerified: false,
                documentVerificationStatus: DocumentVerificationStatus.DECLINED,
                isAddressVerified: false,
                addressVerificationStatus: DocumentVerificationStatus.VERIFIED,
                isIncomeVerified: false,
                incomeVerificationStatus: null,
                businessDocumentVerificationStatus: null,
            };

            expect((service as any).resolveLookupHistoryStatus(user, "BVN")).toBe(KycStatus.APPROVED);
            expect((service as any).resolveLookupHistoryStatus(user, "NIN")).toBe(KycStatus.PENDING);
            expect((service as any).resolveLookupHistoryStatus(user, "DOCUMENT")).toBe(KycStatus.REJECTED);
            expect((service as any).resolveLookupHistoryStatus(user, "ADDRESS")).toBe(KycStatus.APPROVED);
            expect((service as any).resolveLookupHistoryStatus(user, "INCOME")).toBe(KycStatus.PENDING);
            expect((service as any).resolveLookupHistoryStatus(user, "BUSINESS_DOCUMENT")).toBe(KycStatus.PENDING);
            expect((service as any).resolveLookupHistoryStatus(user, "BVN", KycStatus.ESCALATED)).toBe(KycStatus.ESCALATED);

            expect((service as any).buildLookupHistoryNote("BUSINESS_DOCUMENT", "PARTIAL_FAILURE", [
                { status: "SUCCESS" },
                { status: "FAILED" },
            ])).toBe("BUSINESS_DOCUMENT investigative lookup captured with 1 provider issue");
            expect((service as any).buildLookupHistoryNote("DOCUMENT", "FAILED", [
                { status: "FAILED" },
            ])).toBe("DOCUMENT investigative lookup failed at provider");
        });

        it("covers lookup identity, registry, and normalization error branches", async () => {
            const configMock = jest.requireMock("@/config");
            const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
            const previousImagekitUrl = configMock.imagekitConfig.url;

            try {
                await expect((service as any).runIdentityLookup({
                    user: {},
                    identifier: null,
                    missingIdentifierMessage: "Missing identity identifier",
                    request: jest.fn(),
                    key: "BVN",
                    label: "BVN lookup",
                    lookedUpAt: "2026-04-23T12:30:00.000Z",
                })).rejects.toThrow("Missing identity identifier");

                await expect((service as any).runBusinessRegistryLookup({
                    identifier: "",
                    businessName: "Ada Stores",
                    expectedName: "adastores",
                    lookedUpAt: "2026-04-23T12:30:00.000Z",
                    key: "TIN",
                    label: "TIN verification",
                    request: jest.fn(),
                    providerNameField: "taxpayer_name",
                })).rejects.toThrow("Missing TIN identifier for business lookup");

                const identityFailure = await (service as any).runIdentityLookup({
                    user: {},
                    identifier: "12345678901",
                    missingIdentifierMessage: "Missing identity identifier",
                    request: () => Promise.reject(new Error("identity provider unavailable")),
                    key: "BVN",
                    label: "BVN lookup",
                    lookedUpAt: "2026-04-23T12:30:00.000Z",
                });
                expect(identityFailure).toEqual(expect.objectContaining({
                    status: "FAILED",
                    summary: expect.objectContaining({ error: "identity provider unavailable" }),
                }));

                const registryFailure = await (service as any).runBusinessRegistryLookup({
                    identifier: "TIN-123",
                    businessName: "Ada Stores",
                    expectedName: "adastores",
                    lookedUpAt: "2026-04-23T12:30:00.000Z",
                    key: "TIN",
                    label: "TIN verification",
                    request: () => Promise.reject(new Error("TIN provider timeout")),
                    providerNameField: "taxpayer_name",
                });
                expect(registryFailure).toEqual(expect.objectContaining({
                    status: "FAILED",
                    summary: expect.objectContaining({ error: "TIN provider timeout" }),
                }));

                expect((service as any).buildLookupErrorResult(
                    "BVN",
                    "BVN lookup",
                    "2026-04-23T12:30:00.000Z",
                    "non-error failure",
                )).toEqual(expect.objectContaining({
                    provider: "DOJAH",
                    summary: expect.objectContaining({ error: "Provider lookup failed" }),
                }));

                expect((service as any).buildLookupTextExcerpt(null)).toBeNull();
                expect((service as any).buildLookupTextExcerpt("   \n\t   ")).toBeNull();
                expect((service as any).normalizeLookupDate(null)).toBe("");
                expect((service as any).normalizeLookupDate("DOB-23042026")).toBe("23042026");

                configMock.imagekitConfig.url = "::invalid-imagekit-url";

                const trustedOrigins = (service as any).getTrustedDocumentOrigins();

                expect(trustedOrigins.has("https://ik.imagekit.io")).toBe(true);
                expect(warnSpy).toHaveBeenCalledWith("Invalid IMAGEKIT_URL configured; skipping URL origin allowlist entry");
                expect((service as any).resolveTrustedDocumentUrl("not-a-valid-url")).toBeNull();
            } finally {
                configMock.imagekitConfig.url = previousImagekitUrl;
                warnSpy.mockRestore();
            }
        });

        it("covers document, address, and income lookup failure branches", async () => {
            const downloadSpy = jest.spyOn(service as any, "downloadLookupDocument");

            await expect(
                (service as any).runDocumentLookup({ userDocument: null }, "2026-04-23T12:30:00.000Z"),
            ).rejects.toThrow("This user does not have a submitted identity document to recheck");

            mockDojahService.analyzeDocument.mockRejectedValueOnce(new Error("document OCR failed"));
            const documentFailure = await (service as any).runDocumentLookup({
                firstName: "Ada",
                lastName: "Lookup",
                dateOfBirth: null,
                userDocument: {
                    type: "PASSPORT",
                    documentNumber: "A12345",
                    documentImageUrl: "https://ik.imagekit.io/flipxer/passport-front.png",
                    documentImageUrl2: null,
                },
            }, "2026-04-23T12:30:00.000Z");
            expect(documentFailure).toEqual(expect.objectContaining({
                key: "DOCUMENT",
                status: "FAILED",
                summary: expect.objectContaining({ error: "document OCR failed" }),
            }));

            await expect(
                (service as any).runAddressLookup({ addressDocumentUrl: null }, "2026-04-23T12:30:00.000Z"),
            ).rejects.toThrow("This user does not have a submitted address document to recheck");

            downloadSpy.mockRejectedValueOnce(new Error("address download failed"));
            const addressFailure = await (service as any).runAddressLookup({
                firstName: "Ada",
                lastName: "Lookup",
                residentialAddress: "12 Marina, Lagos",
                addressDocumentUrl: "https://ik.imagekit.io/flipxer/address.pdf",
            }, "2026-04-23T12:30:00.000Z");
            expect(addressFailure).toEqual(expect.objectContaining({
                key: "ADDRESS",
                provider: "OCR",
                status: "FAILED",
                summary: expect.objectContaining({ error: "address download failed" }),
            }));

            await expect(
                (service as any).runIncomeLookup({ incomeDocumentUrl: null }, "2026-04-23T12:30:00.000Z"),
            ).rejects.toThrow("This user does not have a submitted income document to recheck");

            downloadSpy.mockRejectedValueOnce(new Error("income download failed"));
            const incomeFailure = await (service as any).runIncomeLookup({
                firstName: "Ada",
                lastName: "Lookup",
                incomeDocumentUrl: "https://ik.imagekit.io/flipxer/income.pdf",
            }, "2026-04-23T12:30:00.000Z");
            expect(incomeFailure).toEqual(expect.objectContaining({
                key: "INCOME",
                provider: "OCR",
                status: "FAILED",
                summary: expect.objectContaining({ error: "income download failed" }),
            }));

            downloadSpy.mockRestore();
        });

        it("covers business lookup helper failure branches", async () => {
            await expect(
                (service as any).runBusinessDocumentLookup({ businessRecord: null, businessDocument: null }, "2026-04-23T12:30:00.000Z"),
            ).rejects.toThrow("This business user does not have stored business verification artifacts to recheck");

            mockDojahService.analyzeDocument.mockRejectedValueOnce(new Error("CAC OCR failed"));

            const ocrFailure = await (service as any).lookupBusinessOcrResult(
                "https://ik.imagekit.io/flipxer/cac.pdf",
                "RC-123",
                "2026-04-23T12:30:00.000Z",
            );

            expect(ocrFailure).toEqual(expect.objectContaining({
                key: "CAC_OCR",
                status: "FAILED",
                summary: expect.objectContaining({ error: "CAC OCR failed" }),
            }));
        });
    });

    describe("updateUserVerification", () => {
        it("updates verification flags, audits changes, and syncs tier", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 4,
                userType: UserType.INDIVIDUAL,
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
            mockAuditLogService.log.mockResolvedValue(undefined);
            mockTierService.syncTierAndCache.mockResolvedValue({ id: 4, tier: 1 });

            const result = await service.updateUserVerification(
                4,
                { isBvnVerified: true, isNinVerified: true, reason: "validated" } as any,
                9,
            );

            expect(result.message).toBe("User verification status updated successfully");
            expect(mockAuditLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: "UPDATE_USER_VERIFICATION",
                }),
            );
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(4);
        });

        it("normalizes individual status fields when admin toggles verification booleans", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 12,
                userType: UserType.INDIVIDUAL,
                bvn: "12345678901",
                nin: "10987654321",
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: true,
                isIncomeVerified: false,
                documentVerificationStatus: "DECLINED",
                addressVerificationStatus: "VERIFIED",
                incomeVerificationStatus: null,
            });
            mockPrismaService.user.update.mockResolvedValue({
                id: 12,
                email: "u@flipxer.com",
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: true,
                isAddressVerified: false,
                isIncomeVerified: true,
                documentVerificationStatus: "VERIFIED",
                addressVerificationStatus: null,
                incomeVerificationStatus: "VERIFIED",
                businessDocumentVerificationStatus: null,
            });
            mockTierService.syncTierAndCache.mockResolvedValue({ id: 12, tier: 3 });

            await service.updateUserVerification(
                12,
                {
                    isDocumentVerified: true,
                    isAddressVerified: false,
                    isIncomeVerified: true,
                    reason: "normalized",
                } as any,
                99,
            );

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 12 },
                    data: expect.objectContaining({
                        isDocumentVerified: true,
                        isAddressVerified: false,
                        isIncomeVerified: true,
                        documentVerificationStatus: "VERIFIED",
                        addressVerificationStatus: null,
                        incomeVerificationStatus: "VERIFIED",
                    }),
                }),
            );
        });

        it("normalizes business document status when admin toggles document verification", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 13,
                userType: UserType.BUSINESS,
                bvn: null,
                nin: null,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
                businessDocumentVerificationStatus: "DECLINED",
            });
            mockPrismaService.user.update.mockResolvedValue({
                id: 13,
                email: "biz@flipxer.com",
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: true,
                isAddressVerified: false,
                isIncomeVerified: false,
                documentVerificationStatus: null,
                addressVerificationStatus: null,
                incomeVerificationStatus: null,
                businessDocumentVerificationStatus: "VERIFIED",
            });
            mockTierService.syncTierAndCache.mockResolvedValue({ id: 13, tier: 1 });

            await service.updateUserVerification(
                13,
                {
                    isDocumentVerified: true,
                    reason: "normalized",
                } as any,
                99,
            );

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 13 },
                    data: expect.objectContaining({
                        isDocumentVerified: true,
                        businessDocumentVerificationStatus: "VERIFIED",
                    }),
                }),
            );
        });

        it("throws when attempting to verify NIN for users without NIN", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 10,
                userType: UserType.INDIVIDUAL,
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
                userType: UserType.INDIVIDUAL,
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

        it("returns a not-found response when the verification target user does not exist", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.updateUserVerification(
                404,
                { isBvnVerified: true, reason: "reviewed" } as any,
                99,
            );

            expect(result).toEqual(expect.objectContaining({ message: "User not found", success: true }));
            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
            expect(mockAuditLogService.log).not.toHaveBeenCalled();
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

        it("approveDocument forwards version when mapping income documents", async () => {
            const processSpy = jest
                .spyOn(service, "processKycDecision")
                .mockResolvedValue({ message: "ok", data: {} } as any);

            await service.approveDocument({ userId: 8, documentType: "income", version: 5 } as any, 99);

            expect(processSpy).toHaveBeenCalledWith(
                {
                    userId: 8,
                    action: "APPROVE",
                    verificationType: "INCOME",
                    version: 5,
                },
                99,
            );
        });

        it("maps unknown document types back to DOCUMENT", () => {
            expect((service as any).mapDocumentTypeToVerificationType("passport")).toBe("DOCUMENT");
        });
    });

    describe("helper coverage", () => {
        it("collects pending verification keys across individual and business requirements", () => {
            const pendingKeys = (service as any).getPendingVerifications({
                isEmailVerified: false,
                isPhoneVerified: false,
                isBvnVerified: false,
                bvn: "12345678901",
                isNinVerified: false,
                nin: "12345678902",
                isDocumentVerified: false,
                userDocument: { id: 1 },
                isAddressVerified: false,
                isIncomeVerified: false,
                userType: UserType.BUSINESS,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: "PENDING",
            });

            expect(pendingKeys).toEqual([
                "email",
                "phone",
                "bvn",
                "nin",
                "document",
                "address",
                "income",
                "businessDocument",
            ]);
        });

        it.each([
            ["today", true],
            ["week", true],
            ["month", true],
            ["quarter", true],
            ["year", true],
            ["all", false],
            ["unexpected", true],
        ])("resolves date ranges for %s", (period, expectCurrentMonthStart) => {
            const result = (service as any).getDateRange(period);

            expect(result.startDate).toBeInstanceOf(Date);
            expect(result.endDate).toBeInstanceOf(Date);
            expect(result.endDate.getTime()).toBeGreaterThanOrEqual(result.startDate.getTime());

            if (period === "all") {
                expect(result.startDate.getTime()).toBe(new Date(0).getTime());
            }

            if (expectCurrentMonthStart && period === "unexpected") {
                expect(result.startDate.getMonth()).toBe(new Date().getMonth());
            }
        });

        it.each([
            [{ queueView: "ACTIONABLE", status: undefined }, "ACTIONABLE"],
            [{ queueView: "AWAITING_USER", status: undefined }, "AWAITING_USER"],
            [{ queueView: "RESOLVED", status: undefined }, "RESOLVED"],
            [{ queueView: "all", status: undefined }, "ALL"],
            [{ queueView: undefined, status: "PENDING" }, "ACTIONABLE"],
            [{ queueView: undefined, status: "APPROVED" }, "RESOLVED"],
            [{ queueView: undefined, status: "SOMETHING_ELSE" }, "ALL"],
        ])("resolves queue view for %o", ({ queueView, status }, expected) => {
            expect((service as any).resolveQueueView(queueView, status)).toBe(expected);
        });

        it("builds blocking verification types for business users with missing submissions", () => {
            expect((service as any).getBlockingVerificationTypes({
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: false,
                bvn: null,
                isNinVerified: false,
                nin: null,
                isDocumentVerified: false,
                userDocument: null,
                isAddressVerified: false,
                addressDocumentUrl: null,
                isIncomeVerified: false,
                incomeDocumentUrl: null,
                userType: UserType.BUSINESS,
                businessDocumentsUploaded: false,
            })).toEqual([
                "BVN",
                "NIN",
                "DOCUMENT",
                "ADDRESS",
                "INCOME",
                "BUSINESS_DOCUMENT",
            ]);
        });

        it.each([
            [[], UserType.INDIVIDUAL, "Awaiting additional user submission"],
            [[], UserType.BUSINESS, "Awaiting additional business verification input"],
            [["BVN"], UserType.INDIVIDUAL, "Awaiting user submission for BVN verification"],
            [["BVN", "DOCUMENT"], UserType.INDIVIDUAL, "Awaiting user submission for 2 verification stages"],
        ])("builds awaiting-user reason for %j", (blockingVerificationTypes, userType, expected) => {
            expect((service as any).getAwaitingUserReason(blockingVerificationTypes, userType)).toBe(expected);
        });

        it.each([
            [[{ verificationType: "DOCUMENT" }], "Submitted identity document review for review"],
            [[{ verificationType: "DOCUMENT" }, { verificationType: "BVN" }], "Submitted 2 verifications for review"],
        ])("builds submitted-for-review reason for %j", (actionableVerifications, expected) => {
            expect((service as any).getSubmittedForReviewReason(actionableVerifications)).toBe(expected);
        });

        it.each([
            [undefined, []],
            ["all", []],
            ["BVN", [{ isBvnVerified: false, bvn: { not: null } }]],
            ["NIN", [{ isNinVerified: false, nin: { not: null } }]],
            ["DOCUMENT", [{ isDocumentVerified: false, userDocument: { isNot: null } }]],
            ["ADDRESS", [{ isAddressVerified: false }]],
            ["INCOME", [{ isIncomeVerified: false }]],
            ["BUSINESS_DOCUMENT", [{ businessDocumentsUploaded: true, businessDocumentVerificationStatus: { not: "VERIFIED" } }]],
            ["UNKNOWN", []],
        ])("builds KYC type conditions for %s", (verificationType, expected) => {
            expect((service as any).buildKycTypeConditions(verificationType)).toEqual(expected);
        });

        it.each([
            ["ACTIONABLE", undefined, () => ({ kycVerifications: { some: { status: "PENDING", isActive: true } } })],
            ["ALL", "APPROVED", () => ({ kycVerifications: { some: { status: "APPROVED", isActive: true } } })],
            ["ALL", "ESCALATED", () => ({ kycVerifications: { some: { status: "ESCALATED", isActive: true } } })],
            ["AWAITING_USER", undefined, () => (service as any).buildAwaitingUserFilter()],
            ["RESOLVED", undefined, () => ({ kycVerifications: { some: { status: { in: ["APPROVED", "REJECTED", "ESCALATED"] }, isActive: true } } })],
            ["ALL", undefined, () => ({})],
        ])("builds KYC status filter for view=%s status=%s", (queueView, status, getExpected) => {
            expect((service as any).buildKycStatusFilter(queueView, status)).toEqual(getExpected());
        });

        it("builds awaiting-user filter without active pending records", () => {
            expect((service as any).buildAwaitingUserFilter()).toEqual({
                AND: [
                    {
                        OR: [
                            { isBvnVerified: false, bvn: null },
                            { isNinVerified: false, nin: null },
                            { isDocumentVerified: false, userDocument: { is: null } },
                            { isAddressVerified: false, addressDocumentUrl: null },
                            { isIncomeVerified: false, incomeDocumentUrl: null },
                            {
                                userType: UserType.BUSINESS,
                                OR: [
                                    { businessDocumentsUploaded: false },
                                    { businessDocumentVerificationStatus: null },
                                ],
                            },
                        ],
                    },
                    {
                        NOT: {
                            kycVerifications: {
                                some: {
                                    status: "PENDING",
                                    isActive: true,
                                },
                            },
                        },
                    },
                ],
            });
        });

        it.each([
            [undefined, null],
            ["ada", {
                OR: [
                    { firstName: { contains: "ada", mode: "insensitive" } },
                    { lastName: { contains: "ada", mode: "insensitive" } },
                    { email: { contains: "ada", mode: "insensitive" } },
                    { phone: { contains: "ada", mode: "insensitive" } },
                ],
            }],
        ])("builds search condition for %s", (searchText, expected) => {
            expect((service as any).buildKycSearchCondition(searchText)).toEqual(expected);
        });

        it("builds queue where clauses for actionable search and tier filters", () => {
            expect((service as any).buildKycQueueWhere({
                resolvedQueueView: "ACTIONABLE",
                status: undefined,
                verificationType: "BVN",
                searchText: "ada",
                tier: 2,
            })).toEqual({
                userType: { not: UserType.ADMIN },
                AND: [
                    { kycVerifications: { some: { status: "PENDING", isActive: true } } },
                    { isBvnVerified: false, bvn: { not: null } },
                    { tier: 2 },
                    {
                        OR: [
                            { firstName: { contains: "ada", mode: "insensitive" } },
                            { lastName: { contains: "ada", mode: "insensitive" } },
                            { email: { contains: "ada", mode: "insensitive" } },
                            { phone: { contains: "ada", mode: "insensitive" } },
                        ],
                    },
                ],
            });
        });

        it.each([
            ["ACTIONABLE", "desc", [{ updatedAt: "desc" }, { createdAt: "desc" }]],
            ["RESOLVED", "asc", [{ createdAt: "asc" }]],
        ])("builds queue ordering for %s", (queueView, sortBy, expected) => {
            expect((service as any).getKycQueueOrderBy(queueView, sortBy)).toEqual(expected);
        });

        it.each([
            [{ version: 7 }, 4, 4],
            [{ version: 7 }, undefined, 7],
            [null, undefined, undefined],
            [{ version: null }, undefined, undefined],
        ])("resolves decision version from %j and %s", (activeVerification, version, expected) => {
            expect((service as any).resolveDecisionVersion(activeVerification, version)).toBe(expected);
        });
    });

    describe("transition decision helper coverage", () => {
        it("returns a response payload when the state machine rejects an otherwise valid transition", async () => {
            mockPrismaService.kycVerification.findFirst.mockResolvedValueOnce({
                id: 41,
                status: "PENDING",
                version: 3,
            });
            mockKycStateMachine.transition.mockRejectedValueOnce(
                new BadRequestException("Illegal KYC transition for DOCUMENT: PENDING → APPROVED"),
            );

            const result = await (service as any).transitionKycDecision({
                userId: 41,
                verificationType: "DOCUMENT",
                action: "APPROVE",
                note: "Already resolved",
                adminId: 99,
            });

            expect(result).toEqual(expect.objectContaining({
                success: true,
                message: "Illegal KYC transition for DOCUMENT: PENDING → APPROVED",
                data: expect.objectContaining({
                    userId: 41,
                    verificationType: "DOCUMENT",
                    action: "APPROVE",
                }),
            }));
        });

        it("rethrows unexpected transition errors", async () => {
            const failure = new Error("transition failed unexpectedly");

            mockPrismaService.kycVerification.findFirst.mockResolvedValueOnce({
                id: 42,
                status: "PENDING",
                version: 6,
            });
            mockKycStateMachine.transition.mockRejectedValueOnce(failure);

            await expect((service as any).transitionKycDecision({
                userId: 42,
                verificationType: "DOCUMENT",
                action: "APPROVE",
                adminId: 99,
            })).rejects.toBe(failure);
        });

        it.each([
            [
                { activeVerification: null, verificationType: "DOCUMENT", action: "APPROVE" },
                "No active DOCUMENT verification is awaiting admin action for this user.",
            ],
            [
                { activeVerification: { status: "ESCALATED" }, verificationType: "DOCUMENT", action: "ESCALATE" },
                "DOCUMENT verification can only be escalated from PENDING state.",
            ],
            [
                { activeVerification: { status: "APPROVED" }, verificationType: "DOCUMENT", action: "REJECT" },
                "DOCUMENT verification is no longer actionable. Current status: APPROVED.",
            ],
        ])("rejects invalid decision preconditions for %j", ({ activeVerification, verificationType, action }, message) => {
            expect(() => (service as any).assertDecisionPreconditions({
                activeVerification,
                verificationType,
                action,
            })).toThrow(message);
        });
    });
});
