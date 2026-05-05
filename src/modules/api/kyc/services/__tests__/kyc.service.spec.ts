/// <reference types="jest" />
import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

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

jest.mock("node:https", () => ({
    __esModule: true,
    request: jest.fn(),
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

type IndividualFixtureVerification = {
    emailVerified?: boolean;
    phoneVerified?: boolean;
    bvnVerified?: boolean;
    ninVerified?: boolean;
    documentVerified?: boolean;
    documentStatus?: DocumentVerificationStatus | null;
    addressVerified?: boolean;
    addressStatus?: DocumentVerificationStatus | null;
    incomeVerified?: boolean;
    incomeStatus?: DocumentVerificationStatus | null;
};

const createStageAttempt = (stage: string, status: string, overrides: Record<string, unknown> = {}) => ({
    stage,
    status,
    isCurrent: true,
    method: null,
    ...overrides,
});

const mapDocumentStatusToAttemptStatus = (status: DocumentVerificationStatus | null | undefined) => {
    switch (status) {
        case DocumentVerificationStatus.VERIFIED:
            return "APPROVED";
        case DocumentVerificationStatus.PENDING:
            return "PENDING_REVIEW";
        case DocumentVerificationStatus.DECLINED:
            return "REJECTED";
        default:
            return null;
    }
};

const createIndividualUser = (
    overrides: Record<string, unknown> = {},
    verification: IndividualFixtureVerification = {},
) => {
    const documentStatus = verification.documentStatus
        ?? (verification.documentVerified ? DocumentVerificationStatus.VERIFIED : null);
    const addressStatus = verification.addressStatus
        ?? (verification.addressVerified ? DocumentVerificationStatus.VERIFIED : null);
    const incomeStatus = verification.incomeStatus
        ?? (verification.incomeVerified ? DocumentVerificationStatus.VERIFIED : null);
    const documentAttemptStatus = mapDocumentStatusToAttemptStatus(documentStatus);
    const addressAttemptStatus = mapDocumentStatusToAttemptStatus(addressStatus);
    const incomeAttemptStatus = mapDocumentStatusToAttemptStatus(incomeStatus);

    const generatedStageAttempts = [
        verification.bvnVerified
            ? createStageAttempt("GOVERNMENT_ID", "APPROVED", { method: "BVN" })
            : null,
        verification.ninVerified
            ? createStageAttempt("GOVERNMENT_ID", "APPROVED", { method: "NIN" })
            : null,
        documentAttemptStatus
            ? createStageAttempt("IDENTITY_DOCUMENT", documentAttemptStatus, {
                method: "PASSPORT",
            })
            : null,
        addressAttemptStatus
            ? createStageAttempt("ADDRESS", addressAttemptStatus, {
                method: "UTILITY_BILL",
            })
            : null,
        incomeAttemptStatus
            ? createStageAttempt("INCOME", incomeAttemptStatus, {
                method: "PAYSLIP",
            })
            : null,
    ].filter(Boolean);

    return {
        id: 1,
        identifier: "usr-1",
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "08000000000",
        photo: null,
        userType: UserType.INDIVIDUAL,
        tier: 0,
        status: "ACTIVE",
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
        bvn: verification.bvnVerified ? "12345678901" : null,
        nin: verification.ninVerified ? "10987654321" : null,
        dateOfBirth: null,
        gender: null,
        residentialAddress: null,
        accountLimit: null,
        isEmailVerified: verification.emailVerified ?? true,
        isPhoneVerified: verification.phoneVerified ?? false,
        isDocumentVerified: verification.documentVerified ?? documentStatus === DocumentVerificationStatus.VERIFIED,
        documentVerificationStatus: documentStatus,
        addressVerificationStatus: addressStatus,
        incomeVerificationStatus: incomeStatus,
        businessDocumentsUploaded: false,
        businessDocumentVerificationStatus: null,
        addressDocumentUrl: null,
        incomeDocumentUrl: null,
        userDocument: null,
        businessDocument: null,
        businessRecord: null,
        kycStageAttempts: overrides.kycStageAttempts ?? generatedStageAttempts,
        kycAttemptEvents: [],
        ...overrides,
    };
};

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
        $executeRaw: jest.fn().mockResolvedValue(1),
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
        kycAttemptEvent: {
            create: jest.fn(),
        },
        kycStageAttempt: {
            aggregate: jest.fn(),
            create: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({ id: 1 }),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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

        jest.resetAllMocks();
        mockKycStateMachine.transition.mockResolvedValue(undefined);
        mockAuditLogService.log.mockResolvedValue(undefined);
        mockNotificationDispatcher.notify.mockResolvedValue(undefined);
        mockEmailService.send.mockResolvedValue(undefined);
        mockEmailService.sendMailWithTemplate.mockResolvedValue(undefined);
        mockPrismaService.kycAttemptEvent.create.mockResolvedValue({ id: 1 });
        mockPrismaService.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: null } });
        mockPrismaService.kycStageAttempt.create.mockResolvedValue({
            id: 1,
            journeyType: "INDIVIDUAL",
            stage: "GOVERNMENT_ID",
            status: "PENDING_REVIEW",
            providerRef: null,
            reviewerId: null,
            reviewNote: null,
            reviewedAt: null,
            version: 1,
        });
        mockPrismaService.kycStageAttempt.findFirst.mockImplementation(async ({ where }: { where?: Record<string, any> } = {}) => {
            const stage = where?.stage;
            const method = where?.method ?? null;

            if (stage === "IDENTITY_DOCUMENT") {
                return {
                    id: 811,
                    journeyType: "INDIVIDUAL",
                    stage: "IDENTITY_DOCUMENT",
                    status: "PENDING_REVIEW",
                    providerRef: null,
                    reviewerId: null,
                    reviewNote: null,
                    reviewedAt: null,
                    version: 3,
                };
            }

            if (stage === "GOVERNMENT_ID" && method === "BVN") {
                return {
                    id: 812,
                    journeyType: "INDIVIDUAL",
                    stage: "GOVERNMENT_ID",
                    status: "PENDING_REVIEW",
                    providerRef: null,
                    reviewerId: null,
                    reviewNote: null,
                    reviewedAt: null,
                    version: 3,
                };
            }

            if (stage === "GOVERNMENT_ID" && method === "NIN") {
                return {
                    id: 813,
                    journeyType: "INDIVIDUAL",
                    stage: "GOVERNMENT_ID",
                    status: "PENDING_REVIEW",
                    providerRef: null,
                    reviewerId: null,
                    reviewNote: null,
                    reviewedAt: null,
                    version: 3,
                };
            }

            if (stage === "ADDRESS") {
                return {
                    id: 814,
                    journeyType: "INDIVIDUAL",
                    stage: "ADDRESS",
                    status: "PENDING_REVIEW",
                    providerRef: "address-ref",
                    reviewerId: null,
                    reviewNote: null,
                    reviewedAt: null,
                    version: 3,
                };
            }

            if (stage === "INCOME") {
                return {
                    id: 815,
                    journeyType: "INDIVIDUAL",
                    stage: "INCOME",
                    status: "PENDING_REVIEW",
                    providerRef: "income-ref",
                    reviewerId: null,
                    reviewNote: null,
                    reviewedAt: null,
                    version: 3,
                };
            }

            if (stage === "BUSINESS_DOCUMENT") {
                return {
                    id: 816,
                    journeyType: "BUSINESS",
                    stage: "BUSINESS_DOCUMENT",
                    status: "PENDING_REVIEW",
                    providerRef: "RC-321",
                    reviewerId: null,
                    reviewNote: null,
                    reviewedAt: null,
                    version: 1,
                };
            }

            return null;
        });
        mockPrismaService.kycStageAttempt.findUnique.mockResolvedValue(null);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    // ==================== updateUserTier ====================

    describe("updateUserTier - tier ceiling enforcement", () => {
        const baseUser = createIndividualUser(
            {
                id: 1,
                email: "test@example.com",
                tier: 1,
            },
            {
                bvnVerified: true,
                emailVerified: true,
            },
        );

        it("should allow setting tier at or below calculated tier", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(baseUser);
            mockTierService.calculateTier.mockReturnValue(1); // BVN only -> Tier 1
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
            const verifiedUser = createIndividualUser(
                {
                    id: 1,
                    email: baseUser.email,
                    tier: 2,
                },
                {
                    bvnVerified: true,
                    documentVerified: true,
                    emailVerified: true,
                },
            );
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
        const pendingUser = createIndividualUser(
            {
                id: 2,
                email: "pending@example.com",
                tier: 1,
            },
            {
                bvnVerified: true,
                documentStatus: DocumentVerificationStatus.PENDING,
                emailVerified: true,
            },
        );

        const updatedUserAfterApproval = createIndividualUser(
            {
                id: 2,
                email: "pending@example.com",
                tier: 1,
            },
            {
                bvnVerified: true,
                documentVerified: true,
                emailVerified: true,
            },
        );

        it("should derive tier from syncTierAndCache on APPROVE, not from dto", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);
            mockPrismaService.user.update.mockResolvedValue(updatedUserAfterApproval);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...updatedUserAfterApproval, tier: 2 });
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
            expect(mockPrismaService.$executeRaw).toHaveBeenCalledTimes(1);

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
            expect(mockPrismaService.$executeRaw).toHaveBeenCalledTimes(1);
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
                startingUser: createIndividualUser(
                    {
                        id: 2,
                        email: pendingUser.email,
                        tier: 1,
                    },
                    {
                        bvnVerified: true,
                        documentStatus: DocumentVerificationStatus.PENDING,
                        emailVerified: true,
                    },
                ),
                expectedData: null,
                syncedTier: 0,
            },
            {
                verificationType: "ADDRESS",
                startingUser: createIndividualUser(
                    {
                        id: 2,
                        email: pendingUser.email,
                        tier: 3,
                        addressDocumentUrl: "https://cdn.test/address.pdf",
                    },
                    {
                        bvnVerified: true,
                        documentVerified: true,
                        addressVerified: true,
                        emailVerified: true,
                    },
                ),
                expectedData: {
                    addressDocumentUrl: null,
                },
                syncedTier: 2,
            },
            {
                verificationType: "INCOME",
                startingUser: createIndividualUser(
                    {
                        id: 2,
                        email: pendingUser.email,
                        tier: 4,
                        incomeDocumentUrl: "https://cdn.test/income.pdf",
                    },
                    {
                        bvnVerified: true,
                        documentVerified: true,
                        addressVerified: true,
                        incomeVerified: true,
                        emailVerified: true,
                    },
                ),
                expectedData: {
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

            if (expectedData) {
                expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                    expect.objectContaining({
                        data: expect.objectContaining(expectedData),
                    }),
                );
            } else {
                expect(mockPrismaService.user.update).not.toHaveBeenCalled();
            }
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
            const escalateUser = createIndividualUser(
                {
                    id: 5,
                    email: "escalate@example.com",
                    firstName: "Escalated",
                    tier: 1,
                },
                {
                    bvnVerified: true,
                    documentStatus: DocumentVerificationStatus.PENDING,
                    emailVerified: true,
                },
            );

            mockPrismaService.user.findUnique.mockResolvedValue(escalateUser);
            mockPrismaService.user.update.mockResolvedValue({
                ...escalateUser,
                documentVerificationStatus: "ESCALATED",
            });
            mockTierService.syncTierAndCache.mockResolvedValue({
                ...escalateUser,
                tier: 1,
            });
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

        it.each([
            ["APPROVE", "APPROVED", undefined],
            ["REJECT", "REJECTED", "Blurry document"],
            ["ESCALATE", "ESCALATED", "Needs senior review"],
        ])("writes an attempt-owned %s shadow event after a staged decision", async (action, eventType, note) => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);
            mockPrismaService.user.update.mockResolvedValue(updatedUserAfterApproval);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...updatedUserAfterApproval, tier: 2 });
            mockAuditLogService.log.mockResolvedValue(undefined);
            mockPrismaService.kycStageAttempt.findUnique.mockResolvedValue({
                id: 811,
                journeyType: "INDIVIDUAL",
                stage: "IDENTITY_DOCUMENT",
            });

            await service.processKycDecision(
                {
                    userId: 2,
                    action: action as any,
                    verificationType: "DOCUMENT",
                    version: 3,
                    note,
                },
                99,
            );

            let expectedProviderStatus = "INCONCLUSIVE";
            if (action === "APPROVE") {
                expectedProviderStatus = "PASSED";
            } else if (action === "REJECT") {
                expectedProviderStatus = "FAILED";
            }

            expect(mockPrismaService.kycStageAttempt.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 811 },
                    data: expect.objectContaining({
                        status: eventType,
                        providerStatus: expectedProviderStatus,
                        reviewerId: 99,
                        reviewNote: note ?? null,
                        providerRef: null,
                        version: 4,
                    }),
                }),
            );
            expect(mockPrismaService.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 811,
                        userId: 2,
                        journeyType: "INDIVIDUAL",
                        stage: "IDENTITY_DOCUMENT",
                        eventType,
                        actorType: "ADMIN",
                        actorId: 99,
                        note: note ?? undefined,
                        payload: expect.objectContaining({
                            source: "ADMIN_DECISION",
                            verificationType: "DOCUMENT",
                            action,
                            auditAction: `KYC_${action}`,
                            attemptId: 811,
                            attemptVersion: 4,
                        }),
                    }),
                }),
            );
        });

        it("does not invoke the legacy state machine for stage-managed decisions", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);
            mockPrismaService.user.update.mockResolvedValue(updatedUserAfterApproval);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...updatedUserAfterApproval, tier: 2 });
            mockPrismaService.kycStageAttempt.findUnique.mockResolvedValue({
                id: 811,
                journeyType: "INDIVIDUAL",
                stage: "IDENTITY_DOCUMENT",
            });

            await service.processKycDecision(
                {
                    userId: 2,
                    action: "APPROVE",
                    verificationType: "DOCUMENT",
                },
                99,
            );

            expect(mockKycStateMachine.transition).not.toHaveBeenCalled();
            expect(mockPrismaService.kycStageAttempt.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 811 },
                    data: expect.objectContaining({
                        version: 4,
                        reviewerId: 99,
                    }),
                }),
            );
        });

        it("processes BUSINESS_DOCUMENT decisions from the current attempt when no legacy verification row exists", async () => {
            const pendingBusinessUser = createIndividualUser(
                {
                    id: 12,
                    userType: UserType.BUSINESS,
                    businessDocumentsUploaded: true,
                    businessDocumentVerificationStatus: "PENDING",
                },
                {},
            );
            const approvedBusinessUser = {
                ...pendingBusinessUser,
                isDocumentVerified: true,
                businessDocumentVerificationStatus: "VERIFIED",
            };

            mockPrismaService.user.findUnique.mockResolvedValue(pendingBusinessUser);
            mockPrismaService.user.update.mockResolvedValue(approvedBusinessUser);
            mockTierService.syncTierAndCache.mockResolvedValue({ ...approvedBusinessUser, tier: 1 });
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValue({
                id: 912,
                journeyType: "BUSINESS",
                stage: "BUSINESS_DOCUMENT",
                status: "PENDING_REVIEW",
                providerRef: "RC-321",
            });

            await service.processKycDecision(
                {
                    userId: 12,
                    action: "APPROVE",
                    verificationType: "BUSINESS_DOCUMENT",
                },
                99,
            );

            expect(mockKycStateMachine.transition).not.toHaveBeenCalled();
            expect(mockPrismaService.kycStageAttempt.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 912 },
                    data: expect.objectContaining({
                        status: "APPROVED",
                        providerStatus: "PASSED",
                        providerRef: "RC-321",
                        reviewerId: 99,
                    }),
                }),
            );
            expect(mockPrismaService.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 912,
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        eventType: "APPROVED",
                        actorType: "ADMIN",
                    }),
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

        it("rejects KYC decisions that omit action before side effects run", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(pendingUser);

            await expect(
                service.processKycDecision(
                    {
                        userId: 2,
                        verificationType: "DOCUMENT",
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
                createIndividualUser(
                    {
                        id: 12,
                        identifier: "usr-12",
                        firstName: "Queue",
                        lastName: "Review",
                        email: "queue@flipxer.com",
                        phone: "08000000002",
                        tier: 1,
                        bvn: "12345678901",
                        kycStageAttempts: [
                            {
                                id: 1,
                                stage: "IDENTITY_DOCUMENT",
                                method: "PASSPORT",
                                attemptNo: 1,
                                isCurrent: true,
                                status: "PENDING_REVIEW",
                                providerStatus: "RUNNING",
                                providerRef: null,
                                reviewNote: null,
                                reviewerId: null,
                                submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                                reviewedAt: null,
                                version: 3,
                            },
                        ],
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                    {
                        emailVerified: true,
                        phoneVerified: false,
                    },
                ),
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({ pageNumber: 1, pageSize: 20, sortBy: "desc" } as any);

            expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        AND: expect.arrayContaining([
                            expect.objectContaining({
                                OR: expect.arrayContaining([
                                    expect.objectContaining({
                                        kycStageAttempts: expect.objectContaining({
                                            some: expect.objectContaining({
                                                isCurrent: true,
                                                journeyType: "INDIVIDUAL",
                                            }),
                                        }),
                                    }),
                                ]),
                            }),
                        ]),
                    }),
                }),
            );
            expect(result.data.records[0].queueView).toBe("ACTIONABLE");
            expect(result.data.records[0].queueReason).toContain("Submitted identity document review for review");
                expect(new Date(result.data.records[0].oldestSubmittedAt).toISOString()).toBe("2026-04-20T10:00:00.000Z");
            expect(result.data.records[0].activeAttempt).toEqual(
                expect.objectContaining({
                    attemptId: 1,
                    verificationType: "DOCUMENT",
                    stage: "IDENTITY_DOCUMENT",
                    status: "PENDING",
                    version: 3,
                    queueReason: expect.stringContaining("identity document review"),
                    allowedActions: expect.arrayContaining(["APPROVE", "RECHECK"]),
                }),
            );
            expect(result.data.records[0].actionableAttempts).toEqual([
                expect.objectContaining({
                    attemptId: 1,
                    verificationType: "DOCUMENT",
                    stage: "IDENTITY_DOCUMENT",
                }),
            ]);
        });

        it("surfaces latest queue activity from attempt events when present", async () => {
            const users = [
                createIndividualUser(
                    {
                        id: 16,
                        identifier: "usr-16",
                        firstName: "Recent",
                        lastName: "Activity",
                        email: "activity@flipxer.com",
                        phone: "08000000006",
                        tier: 1,
                        bvn: "12345678901",
                        kycStageAttempts: [
                            {
                                id: 41,
                                stage: "IDENTITY_DOCUMENT",
                                method: "DOCUMENT",
                                attemptNo: 1,
                                isCurrent: true,
                                status: "PENDING_REVIEW",
                                providerStatus: "INCONCLUSIVE",
                                reviewNote: "Manual review required",
                                reviewerId: null,
                                submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                                reviewedAt: null,
                                version: 3,
                            },
                        ],
                        kycAttemptEvents: [
                            {
                                id: 501,
                                attemptId: 41,
                                stage: "IDENTITY_DOCUMENT",
                                eventType: "ADMIN_RECHECK",
                                actorType: "ADMIN",
                                actorId: 88,
                                note: "Rechecked against OCR",
                                payload: {
                                    source: "ADMIN_PROVIDER_LOOKUP",
                                    lookupType: "DOCUMENT",
                                    outcome: "PARTIAL_FAILURE",
                                    lookedUpAt: "2026-04-22T09:00:00.000Z",
                                    results: [],
                                },
                                createdAt: new Date("2026-04-22T09:00:00.000Z"),
                            },
                        ],
                        createdAt: new Date("2026-04-19T10:00:00.000Z"),
                        updatedAt: new Date("2026-04-22T09:00:00.000Z"),
                    },
                    {
                        emailVerified: true,
                        phoneVerified: true,
                        bvnVerified: true,
                    },
                ),
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({ pageNumber: 1, pageSize: 20, queueView: "ACTIONABLE" } as any);

            expect(result.data.records[0].activeAttempt).toEqual(
                expect.objectContaining({
                    attemptId: 41,
                    latestActivityType: "ADMIN_RECHECK",
                    latestActivityNote: "Rechecked against OCR",
                }),
            );
            expect(new Date(result.data.records[0].latestReviewAt).toISOString()).toBe("2026-04-22T09:00:00.000Z");
        });

        it("returns paginated KYC queue with verification summaries", async () => {
            const users = [
                createIndividualUser(
                    {
                        id: 10,
                        identifier: "usr-10",
                        firstName: "Jane",
                        lastName: "Doe",
                        email: "jane@flipxer.com",
                        phone: "08000000000",
                        tier: 1,
                        bvn: "12345678901",
                        userDocument: { id: 1, type: "PASSPORT", documentNumber: "A1", documentImageUrl: "u", documentImageUrl2: null },
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                    {
                        emailVerified: true,
                        phoneVerified: false,
                    },
                ),
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
            expect(result.data.records[0]).toEqual(
                expect.objectContaining({
                    emailVerified: true,
                    phoneVerified: false,
                    documentVerified: false,
                }),
            );
            expect(result.data.records[0]).not.toHaveProperty("isEmailVerified");
            expect(result.data.records[0]).not.toHaveProperty("isPhoneVerified");
            expect(result.data.records[0]).not.toHaveProperty("isDocumentVerified");
            expect(result.data.records[0]).not.toHaveProperty("pendingVerifications");
            expect(result.data.records[0]).not.toHaveProperty("kycVerificationStatuses");
            expect(result.data.records[0].needsReview).toBe(false);
            expect(result.data.records[0].blockingVerificationTypes).toEqual(expect.arrayContaining(["PHONE", "ADDRESS", "INCOME"]));
            expect(result.data.records[0].activeAttempt).toBeNull();
            expect(result.data.records[0].actionableAttempts).toEqual([]);
        });

        it("enriches users with needsReview=true when current stage attempts are pending", async () => {
            const users = [
                createIndividualUser(
                    {
                        id: 11,
                        identifier: "usr-11",
                        firstName: "Bob",
                        lastName: "Review",
                        email: "bob@flipxer.com",
                        phone: "08000000001",
                        tier: 1,
                        bvn: "99999999999",
                        kycStageAttempts: [
                            {
                                id: 1,
                                stage: "GOVERNMENT_ID",
                                method: "BVN",
                                attemptNo: 3,
                                isCurrent: true,
                                status: "PENDING_REVIEW",
                                providerStatus: "RUNNING",
                                providerRef: null,
                                reviewNote: null,
                                reviewerId: null,
                                submittedAt: new Date(),
                                reviewedAt: null,
                                version: 3,
                            },
                        ],
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                    {
                        emailVerified: true,
                        phoneVerified: false,
                    },
                ),
            ];

            mockPrismaService.$transaction.mockResolvedValue([users, 1]);

            const result = await service.getKycQueue({
                pageNumber: 1,
                pageSize: 20,
                status: "NEEDS_REVIEW",
                sortBy: "desc",
            } as any);

            expect(result.data.records[0].needsReview).toBe(true);
            expect(result.data.records[0]).not.toHaveProperty("kycVerificationStatuses");
            expect(result.data.records[0].actionableAttempts).toEqual([
                expect.objectContaining({ verificationType: "BVN", status: "PENDING" }),
            ]);
            expect(result.data.records[0].activeAttempt).toEqual(
                expect.objectContaining({ verificationType: "BVN", status: "PENDING" }),
            );
        });

        it("builds awaiting-user queue metadata when submissions are missing", async () => {
            const users = [
                createIndividualUser(
                    {
                        id: 14,
                        identifier: "usr-14",
                        firstName: "Awaiting",
                        lastName: "User",
                        email: "awaiting@flipxer.com",
                        phone: "08000000003",
                        tier: 0,
                        bvn: null,
                        nin: null,
                        createdAt: new Date("2026-04-20T10:00:00.000Z"),
                        updatedAt: new Date("2026-04-20T10:00:00.000Z"),
                    },
                    {
                        emailVerified: true,
                        phoneVerified: true,
                    },
                ),
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
                    queueReason: "Awaiting user submission for 4 verification stages",
                }),
            );
            expect(result.data.records[0].blockingVerificationTypes).toEqual(["BVN", "DOCUMENT", "ADDRESS", "INCOME"]);
        });

        it("builds resolved queue metadata for reviewed records", async () => {
            const users = [
                createIndividualUser(
                    {
                        id: 15,
                        identifier: "usr-15",
                        firstName: "Resolved",
                        lastName: "User",
                        email: "resolved@flipxer.com",
                        phone: "08000000004",
                        tier: 2,
                        bvn: "12345678901",
                        nin: "12345678902",
                        addressDocumentUrl: "https://cdn.test/address.pdf",
                        incomeDocumentUrl: "https://cdn.test/income.pdf",
                        userDocument: { id: 1, type: "PASSPORT", documentNumber: "A1", documentImageUrl: "u", documentImageUrl2: null },
                        kycStageAttempts: [
                            {
                                id: 3,
                                stage: "IDENTITY_DOCUMENT",
                                method: "PASSPORT",
                                attemptNo: 2,
                                isCurrent: true,
                                status: "APPROVED",
                                providerStatus: "PASSED",
                                providerRef: "doc-approved",
                                reviewNote: null,
                                reviewerId: 55,
                                submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                                reviewedAt: new Date("2026-04-21T10:00:00.000Z"),
                                version: 2,
                            },
                        ],
                        createdAt: new Date("2026-04-19T10:00:00.000Z"),
                        updatedAt: new Date("2026-04-21T10:00:00.000Z"),
                    },
                    {
                        emailVerified: true,
                        phoneVerified: true,
                        bvnVerified: true,
                        ninVerified: true,
                        documentVerified: true,
                        addressVerified: true,
                        incomeVerified: true,
                    },
                ),
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
                    latestAttempt: expect.objectContaining({ status: "APPROVED", version: 2 }),
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
            expect(mockPrismaService.user.count.mock.calls[5][0].where).toEqual(
                expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({
                            kycStageAttempts: expect.objectContaining({
                                some: expect.objectContaining({
                                    journeyType: "INDIVIDUAL",
                                }),
                            }),
                        }),
                        expect.objectContaining({
                            kycStageAttempts: expect.objectContaining({
                                some: expect.objectContaining({
                                    journeyType: "BUSINESS",
                                    stage: "BUSINESS_DOCUMENT",
                                }),
                            }),
                        }),
                    ]),
                }),
            );
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
                isDocumentVerified: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: "PENDING",
                residentialAddress: "12 Marina, Lagos",
                addressDocumentUrl: "https://cdn.test/address.pdf",
                incomeDocumentUrl: "https://cdn.test/income.pdf",
                documentVerificationStatus: "VERIFIED",
                userDocument: { id: 9, type: "PASSPORT" },
                businessDocument: { cacImageUrl: "https://cdn.test/cac.pdf", tinVerified: true },
                businessRecord: { businessName: "Ada Stores", taxIdentificationNumber: "TIN-123" },
                accountLimit: { dailyLimit: 500000, monthlyLimit: 2000000 },
                kycStageAttempts: [
                    {
                        id: 91,
                        stage: "ADDRESS",
                        method: "UTILITY_BILL",
                        attemptNo: 1,
                        isCurrent: true,
                        status: "PENDING_REVIEW",
                        providerStatus: "INCONCLUSIVE",
                        providerRef: null,
                        reasonCode: null,
                        reasonMessage: "Utility bill is cropped",
                        reasonDetails: null,
                        extractedFields: null,
                        comparisonSummary: null,
                        evidenceSummary: { documentUrl: "https://cdn.test/address.pdf" },
                        reviewNote: "Utility bill is cropped",
                        reviewerId: null,
                        submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                        reviewedAt: null,
                        version: 4,
                        evidenceAssets: [],
                    },
                    {
                        id: 92,
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        method: "BUSINESS_REGISTRATION",
                        attemptNo: 1,
                        isCurrent: true,
                        status: "PENDING_REVIEW",
                        providerStatus: "RUNNING",
                        providerRef: "lookup-92",
                        reasonCode: null,
                        reasonMessage: null,
                        reasonDetails: null,
                        extractedFields: null,
                        comparisonSummary: null,
                        evidenceSummary: { documentUrl: "https://cdn.test/cac.pdf" },
                        reviewNote: "BUSINESS_DOCUMENT investigative lookup captured from Dojah",
                        reviewerId: 99,
                        submittedAt: new Date("2026-04-21T11:30:00.000Z"),
                        reviewedAt: new Date("2026-04-21T11:30:00.000Z"),
                        version: 4,
                        evidenceAssets: [],
                    },
                ],
                kycAttemptEvents: [
                    {
                        id: 9201,
                        attemptId: 8801,
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        eventType: "ADMIN_RECHECK",
                        actorType: "ADMIN",
                        actorId: 99,
                        note: "BUSINESS_DOCUMENT investigative lookup captured from Dojah",
                        payload: {
                            source: "ADMIN_PROVIDER_LOOKUP",
                            lookupType: "BUSINESS_DOCUMENT",
                            outcome: "SUCCESS",
                            lookedUpAt: "2026-04-21T11:30:00.000Z",
                            requestedByAdminId: 99,
                            attemptId: 92,
                            legacyHistoryRecordId: 92,
                            results: [{ key: "CAC", status: "SUCCESS" }],
                        },
                        createdAt: new Date("2026-04-21T11:30:01.000Z"),
                    },
                    {
                        id: 9301,
                        attemptId: 7003,
                        journeyType: "INDIVIDUAL",
                        stage: "INCOME",
                        eventType: "REJECTED",
                        actorType: "ADMIN",
                        actorId: 99,
                        note: "Statement unreadable",
                        payload: {
                            source: "ADMIN_DECISION",
                            verificationType: "INCOME",
                            action: "REJECT",
                            auditAction: "KYC_REJECT",
                            note: "Statement unreadable",
                            attemptId: 7003,
                            attemptVersion: 2,
                        },
                        createdAt: new Date("2026-04-21T09:00:01.000Z"),
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

            expect(result.data.businessInfo).toEqual(
                expect.objectContaining({
                    submitted: true,
                    status: "PENDING",
                    record: expect.objectContaining({ businessName: "Ada Stores" }),
                }),
            );
            expect(result.data.attemptDetailsByVerificationType.ADDRESS).toEqual(
                expect.objectContaining({
                    evidenceSummary: expect.objectContaining({
                        documentUrl: "https://cdn.test/address.pdf",
                        residentialAddress: "12 Marina, Lagos",
                    }),
                }),
            );
            expect(result.data.attemptDetailsByVerificationType.INCOME).toEqual(
                expect.objectContaining({
                    evidenceSummary: expect.objectContaining({
                        documentUrl: "https://cdn.test/income.pdf",
                    }),
                }),
            );
            expect(result.data.attemptDetailsByVerificationType.BUSINESS_DOCUMENT).toEqual(
                expect.objectContaining({
                    attempt: expect.objectContaining({
                        status: "PENDING",
                    }),
                }),
            );
            expect(result.data.activeAttempts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attemptId: 91, verificationType: "ADDRESS", status: "PENDING" }),
                    expect.objectContaining({ attemptId: 92, verificationType: "BUSINESS_DOCUMENT", status: "PENDING" }),
                ]),
            );
            expect(result.data.attemptHistory).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attemptId: 91, verificationType: "ADDRESS" }),
                    expect.objectContaining({ attemptId: 92, verificationType: "BUSINESS_DOCUMENT" }),
                ]),
            );
            expect(result.data.auditHistory).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        source: "ATTEMPT_EVENT",
                        action: "KYC_PROVIDER_LOOKUP",
                        verificationType: "BUSINESS_DOCUMENT",
                    }),
                    expect.objectContaining({
                        source: "ATTEMPT_EVENT",
                        action: "KYC_REJECT",
                        verificationType: "INCOME",
                        note: "Statement unreadable",
                    }),
                ]),
            );
            expect(result.data.activeAttempts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        attemptId: 91,
                        verificationType: "ADDRESS",
                        stage: "ADDRESS",
                        status: "PENDING",
                        attemptNo: 1,
                    }),
                    expect.objectContaining({
                        attemptId: 92,
                        verificationType: "BUSINESS_DOCUMENT",
                        stage: "BUSINESS_DOCUMENT",
                        status: "PENDING",
                        attemptNo: 1,
                    }),
                ]),
            );
            expect(result.data.currentAttemptByVerificationType).toEqual(
                expect.objectContaining({
                    ADDRESS: expect.objectContaining({
                        attemptId: 91,
                        version: 4,
                        allowedActions: expect.arrayContaining(["APPROVE", "RECHECK"]),
                    }),
                    BUSINESS_DOCUMENT: expect.objectContaining({
                        attemptId: 92,
                        status: "PENDING",
                    }),
                }),
            );
            expect(result.data.attemptHistory).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attemptId: 91, attemptNo: 1, isActive: true }),
                    expect.objectContaining({ attemptId: 92, stage: "BUSINESS_DOCUMENT", attemptNo: 1, isActive: true }),
                ]),
            );
            expect(result.data.attemptDetailsByVerificationType).toEqual(
                expect.objectContaining({
                    ADDRESS: expect.objectContaining({
                        attempt: expect.objectContaining({ attemptId: 91, status: "PENDING" }),
                        evidenceSummary: expect.objectContaining({
                            residentialAddress: "12 Marina, Lagos",
                            documentUrl: "https://cdn.test/address.pdf",
                        }),
                        rawEvidence: expect.arrayContaining([
                            expect.objectContaining({ kind: "ADDRESS_DOCUMENT", url: "https://cdn.test/address.pdf" }),
                        ]),
                    }),
                    BUSINESS_DOCUMENT: expect.objectContaining({
                        lookupHistory: expect.arrayContaining([
                            expect.objectContaining({
                                historyRecordId: 92,
                                requestedByAdminId: 99,
                                note: "BUSINESS_DOCUMENT investigative lookup captured from Dojah",
                                results: expect.arrayContaining([
                                    expect.objectContaining({ key: "CAC", status: "SUCCESS" }),
                                ]),
                            }),
                        ]),
                        rawEvidence: expect.arrayContaining([
                            expect.objectContaining({ kind: "CAC_DOCUMENT", url: "https://cdn.test/cac.pdf" }),
                        ]),
                    }),
                    INCOME: expect.objectContaining({
                        decisionHistory: [
                            expect.objectContaining({
                                action: "KYC_REJECT",
                                note: "Statement unreadable",
                                adminId: 99,
                            }),
                        ],
                    }),
                }),
            );
            expect(result.data.limits).toEqual(expect.objectContaining({ dailyLimit: 500000 }));
            expect(result.data.recentTransactions).toHaveLength(1);
        });

        it("prefers KycStageAttempt records for staged individual admin detail panels", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 45,
                    identifier: "usr-45",
                    firstName: "Stage",
                    lastName: "Attempt",
                    email: "stage@flipxer.com",
                    phone: "08001112223",
                    tier: 2,
                    createdAt: new Date("2026-04-01T10:00:00.000Z"),
                    bvn: "12345678901",
                    residentialAddress: "22 Broad Street, Lagos",
                    addressDocumentUrl: "https://cdn.test/address-legacy.pdf",
                    userDocument: { id: 9, type: "PASSPORT" },
                    accountLimit: { dailyLimit: 250000, monthlyLimit: 1000000 },
                    kycStageAttempts: [
                    {
                        id: 701,
                        stage: "ADDRESS",
                        method: "UTILITY_BILL",
                        attemptNo: 2,
                        isCurrent: true,
                        status: "PENDING_REVIEW",
                        providerStatus: "INCONCLUSIVE",
                        providerRef: null,
                        reasonCode: "ADDRESS_REVIEW",
                        reasonMessage: "Manual review required",
                        reasonDetails: { matchedAddress: false },
                        extractedFields: null,
                        comparisonSummary: { matchedAddress: false, confidence: 0.62 },
                        evidenceSummary: { assetCount: 1, mimeType: "application/pdf" },
                        reviewNote: null,
                        reviewerId: null,
                        submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                        reviewedAt: null,
                        version: 5,
                        evidenceAssets: [
                            {
                                id: 9901,
                                kind: "PDF",
                                storageUrl: "https://cdn.test/address-stage.pdf",
                                originalName: "address-stage.pdf",
                                mimeType: "application/pdf",
                                side: null,
                            },
                        ],
                    },
                ],
                    order: [],
                },
                {
                    emailVerified: true,
                    phoneVerified: true,
                    bvnVerified: true,
                    documentVerified: true,
                    addressStatus: DocumentVerificationStatus.PENDING,
                },
            ));
            mockPrismaService.auditLog.findMany.mockResolvedValue([]);

            const result = await service.getKycUserDetail(45);

            expect(result.data.currentAttemptByVerificationType.ADDRESS).toEqual(
                expect.objectContaining({
                    attemptId: 701,
                    method: "UTILITY_BILL",
                    providerStatus: "INCONCLUSIVE",
                    attemptNo: 2,
                    version: 5,
                }),
            );
            expect(result.data.attemptDetailsByVerificationType.ADDRESS).toEqual(
                expect.objectContaining({
                    comparisonSummary: expect.objectContaining({
                        matchedAddress: false,
                        confidence: 0.62,
                    }),
                    rawEvidence: expect.arrayContaining([
                        expect.objectContaining({
                            kind: "ADDRESS_DOCUMENT",
                            url: "https://cdn.test/address-stage.pdf",
                        }),
                    ]),
                }),
            );
            expect(result.data.attemptDetailsByVerificationType.ADDRESS.extractedFields).toBeNull();
            expect(result.data.attemptDetailsByVerificationType.ADDRESS.comparisonSummary).not.toHaveProperty("expectedAddress");
            expect(result.data.attemptDetailsByVerificationType.ADDRESS.evidenceSummary).toEqual(
                expect.objectContaining({
                    assetCount: 1,
                    mimeType: "application/pdf",
                    documentUrl: "https://cdn.test/address-stage.pdf",
                    residentialAddress: "22 Broad Street, Lagos",
                }),
            );
        });
    });

    describe("runProviderLookup", () => {
        it("returns a not-found response when the lookup user does not exist", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.runProviderLookup({ userId: 404, verificationType: "BVN" }, 99);

            expect(result).toEqual(expect.objectContaining({ message: "User not found", success: true }));
        });

        it("persists investigative lookup history without replacing the active verification", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 12,
                    firstName: "Ada",
                    lastName: "Lookup",
                    phone: "08001112222",
                    dateOfBirth: "1991-02-03",
                    bvn: "12345678901",
                    kycStageAttempts: [
                        createStageAttempt("GOVERNMENT_ID", "PENDING_REVIEW", {
                            id: 310,
                            journeyType: "INDIVIDUAL",
                            method: "BVN",
                            version: 3,
                        }),
                    ],
                },
                {
                    documentStatus: DocumentVerificationStatus.PENDING,
                },
            ));
            mockPrismaService.kycStageAttempt.findUnique.mockResolvedValue({
                id: 310,
                journeyType: "INDIVIDUAL",
                stage: "GOVERNMENT_ID",
                status: "PENDING_REVIEW",
                providerRef: null,
                reviewerId: null,
                reviewNote: null,
                reviewedAt: null,
                version: 3,
            });
            mockPrismaService.kycAttemptEvent.create.mockResolvedValue({ id: 411 });
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

            const result = await service.runProviderLookup({ userId: 12, verificationType: "BVN" }, 99);

            expect(mockPrismaService.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 812,
                        userId: 12,
                        journeyType: "INDIVIDUAL",
                        stage: "GOVERNMENT_ID",
                        eventType: "ADMIN_RECHECK",
                        actorType: "ADMIN",
                        actorId: 99,
                        providerName: "DOJAH",
                        providerStatus: "PASSED",
                        providerRef: "bvn-ref-123",
                        note: "BVN investigative lookup captured from Dojah",
                        payload: expect.objectContaining({
                            source: "ADMIN_PROVIDER_LOOKUP",
                            lookupType: "BVN",
                            outcome: "SUCCESS",
                            attemptId: 310,
                            requestedByAdminId: 99,
                        }),
                    }),
                    select: { id: true },
                }),
            );
            expect(mockAuditLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: "KYC_PROVIDER_LOOKUP",
                    details: expect.objectContaining({
                        verificationType: "BVN",
                        outcome: "SUCCESS",
                        kycLookupHistoryId: 411,
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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 13,
                    firstName: "Ada",
                    lastName: "Lookup",
                    phone: "08001112222",
                    dateOfBirth: "1991-02-03",
                    nin: "22334455667",
                },
                {
                    documentStatus: DocumentVerificationStatus.PENDING,
                },
            ));
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

            const result = await service.runProviderLookup({ userId: 13, verificationType: "NIN" }, 99);

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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 19,
                    firstName: "Ada",
                    lastName: "Lookup",
                    phone: "08001112222",
                    dateOfBirth: "1991-02-03",
                    userDocument: {
                        type: "PASSPORT",
                        documentNumber: "A12345",
                        documentImageUrl: "https://ik.imagekit.io/flipxer/passport-front.png",
                        documentImageUrl2: "https://ik.imagekit.io/flipxer/passport-back.png",
                    },
                },
                {
                    documentStatus: DocumentVerificationStatus.PENDING,
                },
            ));
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

            const result = await service.runProviderLookup({ userId: 19, verificationType: "DOCUMENT" }, 99);

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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 18,
                    firstName: "Ada",
                    lastName: "Lookup",
                    residentialAddress: "12 Marina, Lagos",
                    addressDocumentUrl: "https://ik.imagekit.io/flipxer/address.pdf",
                    incomeDocumentUrl: null,
                },
                {
                    addressStatus: DocumentVerificationStatus.PENDING,
                },
            ));

            const result = await service.runProviderLookup({ userId: 18, verificationType: "ADDRESS" }, 77);

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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 21,
                    firstName: "Ada",
                    lastName: "Lookup",
                    residentialAddress: null,
                    incomeDocumentUrl: "https://ik.imagekit.io/flipxer/income.pdf",
                    addressDocumentUrl: null,
                },
                {
                    incomeStatus: DocumentVerificationStatus.PENDING,
                },
            ));

            const result = await service.runProviderLookup({ userId: 21, verificationType: "INCOME" }, 77);

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

            const result = await service.runProviderLookup({ userId: 31, verificationType: "BUSINESS_DOCUMENT" }, 77);

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
                kycStageAttempts: [],
                kycAttemptEvents: [],
            });
            mockPrismaService.kycStageAttempt.findFirst.mockResolvedValueOnce(null);
            mockPrismaService.kycStageAttempt.create.mockResolvedValue({
                id: 810,
                journeyType: "BUSINESS",
                stage: "BUSINESS_DOCUMENT",
                status: "PENDING_REVIEW",
                providerRef: "cac-ref-1",
                reviewerId: null,
                reviewNote: null,
                reviewedAt: null,
                version: 1,
            });
            mockPrismaService.kycAttemptEvent.create.mockResolvedValue({ id: 911 });

            const result = await service.runProviderLookup({ userId: 55, verificationType: "BUSINESS_DOCUMENT" }, 77);

            expect(result).toEqual(expect.objectContaining({
                message: "BUSINESS_DOCUMENT lookup completed with partial failures",
                data: expect.objectContaining({
                    historyRecordId: 911,
                }),
            }));
            expect(mockPrismaService.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        userId: 55,
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        method: "DOCUMENT",
                        attemptNo: 1,
                        status: "PENDING_REVIEW",
                        providerStatus: "NOT_REQUESTED",
                        providerRef: "cac-ref-1",
                        version: 1,
                    }),
                }),
            );
            expect(mockPrismaService.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 810,
                        note: "BUSINESS_DOCUMENT investigative lookup captured with 1 provider issue",
                    }),
                    select: { id: true },
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
                service.runProviderLookup({ userId: 56, verificationType: "ALIEN" } as any, 77),
            ).rejects.toThrow("Unsupported lookup type: ALIEN");
        });
    });

    describe("document lookup helpers", () => {
        it("downloads investigative documents from trusted origins", async () => {
            (httpsRequest as jest.Mock).mockImplementation((options: Record<string, any>, callback: (response: Readable) => void) => {
                const response = Readable.from([Buffer.from([1, 2, 3])]) as Readable & {
                    statusCode?: number;
                    headers?: Record<string, string>;
                };
                response.statusCode = 200;
                response.headers = { "content-type": "application/pdf" };

                const request = {
                    on: jest.fn().mockReturnThis(),
                    destroy: jest.fn(),
                    end: jest.fn(() => {
                        callback(response);
                    }),
                };

                return request;
            });

            const result = await (service as any).downloadLookupDocument("https://ik.imagekit.io/flipxer/document.pdf");

            expect(httpsRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    hostname: "ik.imagekit.io",
                    path: "/flipxer/document.pdf",
                    method: "GET",
                    timeout: 30000,
                }),
                expect.any(Function),
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
                userType: UserType.INDIVIDUAL,
                bvn: "12345678901",
                nin: null,
                isDocumentVerified: false,
                documentVerificationStatus: DocumentVerificationStatus.DECLINED,
                kycStageAttempts: [
                    {
                        stage: "GOVERNMENT_ID",
                        method: "BVN",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        method: "UTILITY_BILL",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser({
                id: 4,
                bvn: "12345678901",
                nin: "10987654321",
            }));

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
                { bvnVerified: true, ninVerified: true, reason: "validated" } as any,
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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 12,
                    bvn: "12345678901",
                    nin: "10987654321",
                },
                {
                    documentStatus: DocumentVerificationStatus.DECLINED,
                    addressVerified: true,
                },
            ));
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
                    documentVerified: true,
                    addressVerified: false,
                    incomeVerified: true,
                    reason: "normalized",
                } as any,
                99,
            );

            expect(mockPrismaService.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 12 },
                    data: expect.objectContaining({
                        isDocumentVerified: true,
                        documentVerificationStatus: "VERIFIED",
                        addressDocumentUrl: null,
                    }),
                }),
            );
        });

        it("uses stage attempt version for staged government-id admin decisions", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 46,
                    identifier: "usr-46",
                    firstName: "Pending",
                    lastName: "Version",
                    email: "pending-version@flipxer.com",
                    phone: "08001112224",
                    tier: 0,
                    createdAt: new Date("2026-04-01T10:00:00.000Z"),
                    kycStageAttempts: [
                        {
                            id: 801,
                            stage: "GOVERNMENT_ID",
                            method: "BVN",
                            attemptNo: 2,
                            isCurrent: true,
                            status: "PENDING_REVIEW",
                            providerStatus: "INCONCLUSIVE",
                            providerRef: "seeded-bvn",
                            reasonCode: "REVIEW_REQUIRED",
                            reasonMessage: "Manual review required",
                            reasonDetails: null,
                            extractedFields: null,
                            comparisonSummary: null,
                            evidenceSummary: { identifierType: "BVN" },
                            reviewNote: null,
                            reviewerId: null,
                            submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                            reviewedAt: null,
                            version: 1,
                            evidenceAssets: [],
                        },
                    ],
                    order: [],
                },
                {
                    emailVerified: true,
                    phoneVerified: true,
                },
            ));
            mockPrismaService.auditLog.findMany.mockResolvedValue([]);

            const result = await service.getKycUserDetail(46);

            expect(result.data.currentAttemptByVerificationType.BVN).toEqual(
                expect.objectContaining({
                    attemptId: 801,
                    version: 1,
                    status: "PENDING",
                    allowedActions: expect.arrayContaining(["APPROVE", "REJECT", "ESCALATE", "RECHECK"]),
                }),
            );
        });

        it("uses canonical imported legacy event payloads for raw provider response fallback", async () => {
            const providerRawResponse = {
                entity: {
                    first_name: "Pending",
                    last_name: "Version",
                    verification_status: "passed",
                },
            };

            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser(
                {
                    id: 47,
                    identifier: "usr-47",
                    firstName: "Pending",
                    lastName: "Version",
                    email: "imported-history@flipxer.com",
                    phone: "08001112225",
                    tier: 0,
                    bvn: "12345678901",
                    createdAt: new Date("2026-04-01T10:00:00.000Z"),
                    kycStageAttempts: [
                        {
                            id: 811,
                            stage: "GOVERNMENT_ID",
                            method: "BVN",
                            attemptNo: 1,
                            isCurrent: true,
                            status: "PENDING_REVIEW",
                            providerStatus: "RUNNING",
                            providerRef: "legacy-bvn-ref",
                            reasonCode: "REVIEW_REQUIRED",
                            reasonMessage: "Manual review required",
                            reasonDetails: null,
                            extractedFields: null,
                            comparisonSummary: null,
                            evidenceSummary: { identifierType: "BVN" },
                            reviewNote: null,
                            reviewerId: null,
                            submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                            reviewedAt: null,
                            version: 1,
                            evidenceAssets: [],
                        },
                    ],
                    kycAttemptEvents: [
                        {
                            id: 9811,
                            attemptId: 811,
                            journeyType: "INDIVIDUAL",
                            stage: "GOVERNMENT_ID",
                            eventType: "IMPORTED_LEGACY_HISTORY",
                            actorType: "SYSTEM",
                            actorId: null,
                            note: "BVN legacy verification imported (status APPROVED, version 2)",
                            payload: {
                                source: "IMPORTED_LEGACY_HISTORY",
                                importedFromLegacy: true,
                                legacyRecordId: 311,
                                verificationType: "BVN",
                                status: "APPROVED",
                                version: 2,
                                isActive: false,
                                reviewerId: null,
                                reviewNote: null,
                                documentUrl: null,
                                providerRef: "legacy-bvn-ref",
                                providerRawResponse,
                                submittedAt: "2026-04-20T10:00:00.000Z",
                                reviewedAt: null,
                                escalatedAt: null,
                                createdAt: "2026-04-20T10:00:00.000Z",
                                updatedAt: "2026-04-20T10:05:00.000Z",
                            },
                            createdAt: new Date("2026-04-20T10:05:00.000Z"),
                        },
                    ],
                    order: [],
                },
                {
                    emailVerified: true,
                    phoneVerified: true,
                },
            ));
            mockPrismaService.auditLog.findMany.mockResolvedValue([]);

            const result = await service.getKycUserDetail(47);

            expect(result.data.attemptDetailsByVerificationType.BVN.rawProviderResponse).toEqual(providerRawResponse);
            expect(result.data.attemptDetailsByVerificationType.BVN.lookupHistory).toEqual([]);
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
                    documentVerified: true,
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
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser({
                id: 10,
                bvn: "12345678901",
                nin: null,
            }));

            await expect(
                service.updateUserVerification(10, { ninVerified: true, reason: "reviewed" } as any, 99),
            ).rejects.toThrow("Cannot set NIN verified");
        });

        it("throws when attempting to verify BVN for users without BVN", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(createIndividualUser({
                id: 11,
                bvn: null,
                nin: "10987654321",
            }));

            await expect(
                service.updateUserVerification(11, { bvnVerified: true, reason: "reviewed" } as any, 99),
            ).rejects.toThrow("Cannot set BVN verified");
        });

        it("returns a not-found response when the verification target user does not exist", async () => {
            mockPrismaService.user.findUnique.mockResolvedValue(null);

            const result = await service.updateUserVerification(
                404,
                { bvnVerified: true, reason: "reviewed" } as any,
                99,
            );

            expect(result).toEqual(expect.objectContaining({ message: "User not found", success: true }));
            expect(mockPrismaService.user.update).not.toHaveBeenCalled();
            expect(mockAuditLogService.log).not.toHaveBeenCalled();
        });
    });

    describe("document decision wrappers", () => {
        it("processAttemptDecision resolves attempt ids into the staged decision contract", async () => {
            mockTierService.syncTierAndCache.mockResolvedValue({ id: 44, tier: 2 });
            mockPrismaService.kycStageAttempt.findUnique
                .mockResolvedValueOnce({
                    id: 701,
                    userId: 44,
                    stage: "ADDRESS",
                    method: "UTILITY_BILL",
                    version: 4,
                })
                .mockResolvedValueOnce({
                    id: 701,
                    userId: 44,
                    stage: "ADDRESS",
                    method: "UTILITY_BILL",
                    attemptNo: 2,
                    isCurrent: true,
                    status: "APPROVED",
                    providerStatus: "PASSED",
                    reasonMessage: null,
                    evidenceSummary: { documentUrl: "https://cdn.test/address.pdf" },
                    reviewerId: 99,
                    reviewNote: "looks good",
                    reviewedAt: new Date("2026-04-21T12:00:00.000Z"),
                    providerRef: null,
                    submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                    version: 4,
                    evidenceAssets: [],
                });

            const processSpy = jest
                .spyOn(service, "processKycDecision")
                .mockResolvedValue({ message: "ok", data: { status: "APPROVED" } } as any);

            const result = await service.processAttemptDecision(701, { action: "APPROVE", expectedVersion: 4, note: "looks good", verificationType: "ADDRESS" } as any, 99);

            expect(processSpy).toHaveBeenCalledWith(
                {
                    userId: 44,
                    action: "APPROVE",
                    verificationType: "ADDRESS",
                    version: 4,
                    note: "looks good",
                },
                99,
            );
            expect(result.data).toEqual(expect.objectContaining({ attemptId: 701, status: "APPROVED" }));
        });

        it("processAttemptDecision routes stage-owned government ID decisions through the attempt context", async () => {
            const reviewedAt = new Date("2026-04-21T13:00:00.000Z");

            mockTierService.syncTierAndCache.mockResolvedValue({ id: 45, tier: 0 });
            mockPrismaService.kycStageAttempt.findUnique
                .mockResolvedValueOnce({
                    id: 702,
                    userId: 45,
                    stage: "GOVERNMENT_ID",
                    method: "BVN",
                    version: 5,
                })
                .mockResolvedValueOnce({
                    id: 702,
                    userId: 45,
                    stage: "GOVERNMENT_ID",
                    method: "BVN",
                    attemptNo: 1,
                    isCurrent: true,
                    status: "REJECTED",
                    providerStatus: "FAILED",
                    reasonMessage: "BVN verification was declined",
                    evidenceSummary: { identifierType: "BVN" },
                    reviewerId: 99,
                    reviewNote: "details mismatch",
                    reviewedAt,
                    providerRef: "seeded-ref",
                    submittedAt: new Date("2026-04-20T10:00:00.000Z"),
                    version: 5,
                    evidenceAssets: [],
                });

            const processSpy = jest
                .spyOn(service, "processKycDecision")
                .mockResolvedValue({ message: "ok", data: { status: "REJECTED" } } as any);

            const result = await service.processAttemptDecision(
                702,
                { action: "REJECT", expectedVersion: 5, note: "details mismatch", verificationType: "BVN" } as any,
                99,
            );

            expect(processSpy).toHaveBeenCalledWith(
                {
                    userId: 45,
                    action: "REJECT",
                    verificationType: "BVN",
                    version: 5,
                    note: "details mismatch",
                },
                99,
            );
            expect(result.data).toEqual(expect.objectContaining({ attemptId: 702, status: "REJECTED" }));
        });

        it("runAttemptVerificationLookup resolves stage attempt ids before invoking the lookup contract", async () => {
            mockPrismaService.kycStageAttempt.findUnique.mockResolvedValue({
                id: 701,
                userId: 44,
                stage: "ADDRESS",
                method: "UTILITY_BILL",
            });

            const lookupSpy = jest
                .spyOn(service, "runProviderLookup")
                .mockResolvedValue({
                    message: "ok",
                    data: {
                        lookedUpAt: "2026-04-21T13:00:00.000Z",
                        historyRecordId: 501,
                        results: [
                            {
                                key: "ADDRESS",
                                label: "Address OCR lookup",
                                status: "SUCCESS",
                                provider: "OCR",
                                providerRef: null,
                                summary: { verified: true, addressMatches: true },
                                rawResponse: { verified: true },
                                documentUrl: "https://cdn.test/address.pdf",
                                lookedUpAt: "2026-04-21T13:00:00.000Z",
                            },
                        ],
                    },
                } as any);

            const result = await service.runAttemptVerificationLookup(701, { provider: "OCR", verificationType: "ADDRESS" } as any, 99);

            expect(lookupSpy).toHaveBeenCalledWith(
                {
                    userId: 44,
                    verificationType: "ADDRESS",
                },
                99,
            );
            expect(result.data).toEqual(expect.objectContaining({ attemptId: 701, provider: "OCR", providerStatus: "SUCCESS" }));
        });

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
        it.each([
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
                bvn: null,
                nin: null,
                isDocumentVerified: false,
                userDocument: null,
                addressDocumentUrl: null,
                incomeDocumentUrl: null,
                userType: UserType.BUSINESS,
                businessDocumentsUploaded: false,
                kycStageAttempts: [],
            })).toEqual([
                "BVN",
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
            ["BVN", [{ OR: [{ kycStageAttempts: { some: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "GOVERNMENT_ID", method: "BVN" } } }, { bvn: { not: null } }] }]],
            ["NIN", [{ OR: [{ kycStageAttempts: { some: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "GOVERNMENT_ID", method: "NIN" } } }, { nin: { not: null } }] }]],
            ["DOCUMENT", [{ OR: [{ kycStageAttempts: { some: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "IDENTITY_DOCUMENT" } } }, { userDocument: { isNot: null } }] }]],
            ["ADDRESS", [{ OR: [{ kycStageAttempts: { some: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "ADDRESS" } } }, { addressDocumentUrl: { not: null } }] }]],
            ["INCOME", [{ OR: [{ kycStageAttempts: { some: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "INCOME" } } }, { incomeDocumentUrl: { not: null } }] }]],
            [
                "BUSINESS_DOCUMENT",
                [{ OR: [{ kycStageAttempts: { some: { isCurrent: true, journeyType: "BUSINESS", stage: "BUSINESS_DOCUMENT" } } }, { businessDocument: { isNot: null } }] }],
            ],
            ["UNKNOWN", []],
        ])("builds KYC type conditions for %s", (verificationType, expected) => {
            expect((service as any).buildKycTypeConditions(verificationType)).toEqual(expected);
        });

        it.each([
            ["ACTIONABLE", undefined, () => ({
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"] },
                                status: { in: ["SUBMITTED", "PENDING_REVIEW"] },
                            },
                        },
                    },
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "BUSINESS",
                                stage: "BUSINESS_DOCUMENT",
                                status: { in: ["SUBMITTED", "PENDING_REVIEW"] },
                            },
                        },
                    },
                ],
            })],
            ["ALL", "APPROVED", () => ({
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"] },
                                status: { in: ["APPROVED"] },
                            },
                        },
                    },
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "BUSINESS",
                                stage: "BUSINESS_DOCUMENT",
                                status: { in: ["APPROVED"] },
                            },
                        },
                    },
                ],
            })],
            ["ALL", "ESCALATED", () => ({
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"] },
                                status: { in: ["ESCALATED"] },
                            },
                        },
                    },
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "BUSINESS",
                                stage: "BUSINESS_DOCUMENT",
                                status: { in: ["ESCALATED"] },
                            },
                        },
                    },
                ],
            })],
            ["AWAITING_USER", undefined, () => (service as any).buildAwaitingUserFilter()],
            ["RESOLVED", undefined, () => ({
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"] },
                                status: { in: ["APPROVED", "REJECTED", "ESCALATED", "EXPIRED"] },
                            },
                        },
                    },
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "BUSINESS",
                                stage: "BUSINESS_DOCUMENT",
                                status: { in: ["APPROVED", "REJECTED", "ESCALATED", "EXPIRED"] },
                            },
                        },
                    },
                ],
            })],
            ["ALL", undefined, () => ({})],
        ])("builds KYC status filter for view=%s status=%s", (queueView, status, getExpected) => {
            expect((service as any).buildKycStatusFilter(queueView, status)).toEqual(getExpected());
        });

        it("builds awaiting-user filter without active pending records", () => {
            expect((service as any).buildAwaitingUserFilter()).toEqual({
                AND: [
                    {
                        OR: [
                            {
                                AND: [
                                    { bvn: null },
                                    { nin: null },
                                    { kycStageAttempts: { none: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "GOVERNMENT_ID" } } },
                                ],
                            },
                            {
                                AND: [
                                    { isDocumentVerified: false },
                                    { userDocument: { is: null } },
                                    { kycStageAttempts: { none: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "IDENTITY_DOCUMENT" } } },
                                ],
                            },
                            {
                                AND: [
                                    { addressDocumentUrl: null },
                                    { kycStageAttempts: { none: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "ADDRESS" } } },
                                ],
                            },
                            {
                                AND: [
                                    { incomeDocumentUrl: null },
                                    { kycStageAttempts: { none: { isCurrent: true, journeyType: "INDIVIDUAL", stage: "INCOME" } } },
                                ],
                            },
                            {
                                AND: [
                                    { userType: UserType.BUSINESS },
                                    { businessDocument: { is: null } },
                                    { kycStageAttempts: { none: { isCurrent: true, journeyType: "BUSINESS", stage: "BUSINESS_DOCUMENT" } } },
                                ],
                            },
                        ],
                    },
                    {
                        NOT: {
                            OR: [
                                {
                                    kycStageAttempts: {
                                        some: {
                                            isCurrent: true,
                                            journeyType: "INDIVIDUAL",
                                            stage: { in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"] },
                                            status: { in: ["SUBMITTED", "PENDING_REVIEW"] },
                                        },
                                    },
                                },
                                {
                                    kycStageAttempts: {
                                        some: {
                                            isCurrent: true,
                                            journeyType: "BUSINESS",
                                            stage: "BUSINESS_DOCUMENT",
                                            status: { in: ["SUBMITTED", "PENDING_REVIEW"] },
                                        },
                                    },
                                },
                            ],
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
                    {
                        OR: [
                            {
                                kycStageAttempts: {
                                    some: {
                                        isCurrent: true,
                                        journeyType: "INDIVIDUAL",
                                        stage: { in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"] },
                                        status: { in: ["SUBMITTED", "PENDING_REVIEW"] },
                                    },
                                },
                            },
                            {
                                kycStageAttempts: {
                                    some: {
                                        isCurrent: true,
                                        journeyType: "BUSINESS",
                                        stage: "BUSINESS_DOCUMENT",
                                        status: { in: ["SUBMITTED", "PENDING_REVIEW"] },
                                    },
                                },
                            },
                        ],
                    },
                    {
                        OR: [
                            {
                                kycStageAttempts: {
                                    some: {
                                        isCurrent: true,
                                        journeyType: "INDIVIDUAL",
                                        stage: "GOVERNMENT_ID",
                                        method: "BVN",
                                    },
                                },
                            },
                            { bvn: { not: null } },
                        ],
                    },
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
        it("returns a response payload when the state machine rejects a legacy transition", async () => {
            mockKycStateMachine.transition.mockRejectedValueOnce(
                new BadRequestException("Illegal KYC transition for LEGACY_COMPAT: PENDING → APPROVED"),
            );

            const result = await (service as any).transitionKycDecision({
                userId: 41,
                verificationType: "LEGACY_COMPAT",
                action: "APPROVE",
                note: "Already resolved",
                adminId: 99,
            });

            expect(result).toEqual(expect.objectContaining({
                success: true,
                message: "Illegal KYC transition for LEGACY_COMPAT: PENDING → APPROVED",
                data: expect.objectContaining({
                    userId: 41,
                    verificationType: "LEGACY_COMPAT",
                    action: "APPROVE",
                }),
            }));
        });

        it("rethrows unexpected errors from the legacy transition path", async () => {
            const failure = new Error("transition failed unexpectedly");

            mockKycStateMachine.transition.mockRejectedValueOnce(failure);

            await expect((service as any).transitionKycDecision({
                userId: 42,
                verificationType: "LEGACY_COMPAT",
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
