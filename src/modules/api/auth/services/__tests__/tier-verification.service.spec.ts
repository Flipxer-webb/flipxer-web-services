import { Test, TestingModule } from "@nestjs/testing";
import { HttpException } from "@nestjs/common";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    DuplicateUserException: class extends Error {},
    __esModule: true,
}));

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: class { server = { to: jest.fn() } },
}));

jest.mock("@/config", () => ({
    storageDirConfig: {
        document: "/var/lib/flipxer/test-docs",
        documentDir: "/var/lib/flipxer/test-docs",
    },
    emailTemplateConfig: {
        document_pending_review: "tpl-pending-review",
        document_approved: "tpl-approved",
        document_rejected: "tpl-rejected",
    },
    COMPANY_NAME: "Flipxer",
    mailConfig: { senderMail: "noreply@test.com" },
    cloudinaryConfig: {},
    imagekitConfig: {},
    jwtSecret: "test",
}));

jest.mock("@/core/validators/file-validator", () => ({
    isPdfFile: jest.fn((mimetype?: string) => mimetype === "application/pdf"),
    validateDocumentFile: jest.fn(),
}));

jest.mock("@/libs/ocr", () => ({
    OcrDocumentPreparationError: class OcrDocumentPreparationError extends Error {
        constructor(message: string) {
            super(message);
            this.name = "OcrDocumentPreparationError";
        }
    },
    validateAddressDocument: jest.fn(),
    validateIncomeDocument: jest.fn(),
}));

jest.mock("bcryptjs", () => ({
    hash: jest.fn().mockResolvedValue("hashed"),
    compare: jest.fn(),
}));

import { TierVerificationService } from "../tier-verification.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { UploadFactory } from "@/modules/core/upload/services";
import { EmailService } from "@/modules/core/email/services";
import { TierService } from "../tier.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { validateDocumentFile } from "@/core/validators/file-validator";
import {
    OcrDocumentPreparationError,
    validateAddressDocument,
    validateIncomeDocument,
} from "@/libs/ocr";
import {
    KycAttemptStatus,
    KycDecisionMode,
    KycMethod,
    KycProviderName,
    KycProviderStatus,
    KycStage,
} from "@prisma/client";

function makePrisma() {
    return {
        user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
        kycStageAttempt: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            aggregate: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
    };
}

let testSecretCounter = 0;
function createTestSecret(): string {
    testSecretCounter += 1;
    return `test-secret-${testSecretCounter}`;
}

describe("TierVerificationService", () => {
    let service: TierVerificationService;
    let prisma: ReturnType<typeof makePrisma>;
    let mockTierService: any;
    let mockNotificationDispatcher: any;
    let mockUploadService: any;
    let mockWsGateway: any;
    let mockAuthService: {
        analyzeAddressDocumentSignals: jest.Mock;
        analyzeIncomeDocumentSignals: jest.Mock;
    };
    let mockEmailService: {
        sendEmail: jest.Mock;
        sendMailWithTemplate: jest.Mock;
    };

    const mockFile = {
        buffer: Buffer.from("test"),
        mimetype: "image/png",
        size: 1000,
        originalname: "doc.png",
    } as Express.Multer.File;

    const mockUser = {
        id: 1,
        email: "test@test.com",
        firstName: "John",
        lastName: "Doe",
        tier: 1,
        residentialAddress: "10 Main Street Lagos",
        addressDocumentUrl: null,
        incomeDocumentUrl: null,
        isDocumentVerified: true,
    } as any;

    beforeEach(async () => {
        prisma = makePrisma();
        mockTierService = { syncTierAndCache: jest.fn() };
        mockNotificationDispatcher = {
            notify: jest.fn().mockResolvedValue(undefined),
        };
        mockEmailService = {
            sendEmail: jest.fn(),
            sendMailWithTemplate: jest.fn().mockResolvedValue(undefined),
        };
        mockWsGateway = { server: { to: jest.fn() }, notifyProfileUpdate: jest.fn() };
        mockAuthService = {
            analyzeAddressDocumentSignals: jest.fn().mockResolvedValue(null),
            analyzeIncomeDocumentSignals: jest.fn().mockResolvedValue(null),
        };
        prisma.user.findFirst.mockResolvedValue(null);
        prisma.user.findUnique.mockResolvedValue({
            kycStageAttempts: [
                {
                    stage: "IDENTITY_DOCUMENT",
                    status: "APPROVED",
                    isCurrent: true,
                },
            ],
        });
        prisma.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: 0 } });
        prisma.kycStageAttempt.findMany.mockResolvedValue([]);
        prisma.kycStageAttempt.updateMany.mockResolvedValue({ count: 0 });
        prisma.kycStageAttempt.create.mockResolvedValue({ id: 1 });
        prisma.kycStageAttempt.findFirst.mockResolvedValue({ id: 1 });
        prisma.kycStageAttempt.update.mockResolvedValue({ id: 1 });
        mockUploadService = {
            upload: jest.fn().mockResolvedValue({ url: "https://cdn.test.com/doc.png" }),
            uploadImage: jest
                .fn()
                .mockResolvedValue({ url: "https://cdn.test.com/doc.pdf" }),
            uploadCompressedImage: jest
                .fn()
                .mockResolvedValue({ url: "https://cdn.test.com/doc.png" }),
        };

        const mockUploadFactory = {
            build: jest.fn().mockReturnValue(mockUploadService),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TierVerificationService,
                { provide: PrismaService, useValue: prisma },
                { provide: UploadFactory, useValue: mockUploadFactory },
                { provide: TierService, useValue: mockTierService },
                { provide: EmailService, useValue: mockEmailService },
                { provide: NotificationDispatcher, useValue: mockNotificationDispatcher },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: "AUTH_SERVICE", useValue: mockAuthService },
            ],
        }).compile();

        service = module.get<TierVerificationService>(TierVerificationService);
    });

    // ==================== Address Verification (File Upload) ====================

    describe("verifyAddress", () => {
        it("should return early if address is already verified", async () => {
            const verifiedUser = {
                ...mockUser,
                tier: 2,
                addressDocumentUrl: "https://cdn.test.com/address-proof.png",
            };
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.verifyAddress(verifiedUser, mockFile);
            expect(result.message).toBe("Address is already verified");
        });

        it("should throw if file validation fails", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({
                isValid: false,
                error: "File too large",
            });

            await expect(
                service.verifyAddress(mockUser, mockFile),
            ).rejects.toThrow(HttpException);
        });

        it("returns a pending response when address verification is already pending", async () => {
            (validateDocumentFile as jest.Mock).mockClear();
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "PENDING_REVIEW",
                        isCurrent: true,
                    },
                ],
            });

            await expect(
                service.verifyAddress(
                    {
                        ...mockUser,
                        addressDocumentUrl: "https://cdn.test.com/address-pending.png",
                    },
                    mockFile,
                ),
            ).resolves.toEqual(
                expect.objectContaining({
                    message: "Address verification is pending review",
                    data: expect.objectContaining({
                        status: "PENDING",
                        reason: null,
                    }),
                }),
            );

            expect(validateDocumentFile).not.toHaveBeenCalled();
            expect(prisma.kycStageAttempt.create).not.toHaveBeenCalled();
        });

        it("should reject address verification until document verification is complete", async () => {
            (validateDocumentFile as jest.Mock).mockClear();
            prisma.user.findUnique.mockResolvedValue({
                tier: mockUser.tier,
                addressDocumentUrl: null,
                incomeDocumentUrl: null,
                kycStageAttempts: [],
            });

            await expect(
                service.verifyAddress(
                    {
                        ...mockUser,
                    },
                    mockFile,
                ),
            ).rejects.toThrow(
                "Complete identity document verification before submitting address verification.",
            );

            expect(validateDocumentFile).not.toHaveBeenCalled();
        });

        it("should flag for manual review when OCR requires it", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0.4,
                matchedName: false,
                matchedAddress: true,
                matchedResidentialAddress: false,
                requiresManualReview: true,
                decision: "REVIEW",
                reason: "Low confidence",
            });

            const result = await service.verifyAddress(mockUser, mockFile);
            expect(result.message).toBe("Address verification is pending review");
            expect(result.data.status).toBe("PENDING");
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(mockUser.id);
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        stage: KycStage.ADDRESS,
                        status: KycAttemptStatus.PENDING_REVIEW,
                        providerName: KycProviderName.OCR,
                    }),
                }),
            );
            expect(mockEmailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-pending-review",
                    merge_info: expect.objectContaining({
                        name: "John",
                        document_type: "Address Document",
                    }),
                }),
            );
        });

        it("routes clean address verification passes to manual review", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0.95,
                matchedName: true,
                matchedAddress: true,
                matchedResidentialAddress: true,
                countryConfirmed: true,
                requiresManualReview: false,
                decision: "APPROVE",
            });

            const result = await service.verifyAddress(mockUser, mockFile);
            expect(result.message).toBe("Address verification is pending review");
            expect(result.data.status).toBe("PENDING");
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        stage: KycStage.ADDRESS,
                        status: KycAttemptStatus.PENDING_REVIEW,
                        providerStatus: KycProviderStatus.PASSED,
                        decisionMode: KycDecisionMode.MANUAL,
                    }),
                }),
            );
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(mockUser.id);
            expect(mockNotificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "Document Submitted",
                    body: "Your address document has been submitted for review. We'll notify you once it's processed.",
                }),
            );
            expect(mockEmailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-pending-review",
                    merge_info: expect.objectContaining({
                        name: "John",
                        document_type: "Address Document",
                    }),
                }),
            );
            expect(mockWsGateway.notifyProfileUpdate).not.toHaveBeenCalled();
        });

        it("passes Dojah provider signals into address submit validation", async () => {
            const providerSignals = {
                documentType: "Utility Bill",
                nameMatches: true,
                documentDate: "2026-04-20",
            };
            mockAuthService.analyzeAddressDocumentSignals.mockResolvedValue(providerSignals);
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0.95,
                matchedName: true,
                matchedAddress: true,
                matchedResidentialAddress: true,
                requiresManualReview: false,
                decision: "APPROVE",
            });

            await service.verifyAddress(mockUser, mockFile);

            expect(mockAuthService.analyzeAddressDocumentSignals).toHaveBeenCalledWith(mockUser, mockFile);
            expect(validateAddressDocument).toHaveBeenCalledWith(
                mockFile.buffer,
                "John",
                "Doe",
                "10 Main Street Lagos",
                "image/png",
                providerSignals,
            );
        });

        it("keeps the persisted Dojah preview payload on address submit-from-preview", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });

            await service.verifyAddressFromPreview(
                mockUser,
                mockFile,
                KycMethod.UTILITY_BILL,
                {
                    outcome: "REVIEW_LIKELY",
                    providerStatus: KycProviderStatus.INCONCLUSIVE,
                    comparisonSummary: {
                        decision: "REVIEW",
                        matchedName: true,
                        matchedAddress: true,
                        matchedResidentialAddress: true,
                    },
                    providerInteraction: {
                        provider: "DOJAH",
                        request: {
                            inputType: "base64",
                            imageFrontSide: "address-preview-base64",
                        },
                        response: {
                            parsed: {
                                documentType: "utility bill",
                            },
                        },
                    },
                },
            );

            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reasonDetails: expect.objectContaining({
                            providerInteraction: expect.objectContaining({
                                provider: "DOJAH",
                                request: expect.objectContaining({
                                    imageFrontSide: "address-preview-base64",
                                }),
                            }),
                        }),
                    }),
                }),
            );
        });

        it("should auto-reject a clear high-confidence address mismatch", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0.93,
                matchedName: false,
                matchedAddress: true,
                matchedResidentialAddress: false,
                requiresManualReview: false,
                decision: "REJECT",
                reason: "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
            });

            const result = await service.verifyAddress(mockUser, mockFile);

            expect(result.message).toBe("The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.");
            expect(result.data.status).toBe("REJECTED");
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        stage: KycStage.ADDRESS,
                        status: KycAttemptStatus.REJECTED,
                        providerStatus: KycProviderStatus.FAILED,
                        decisionMode: KycDecisionMode.AUTO,
                        reasonMessage: "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
                    }),
                }),
            );
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(mockUser.id);
            expect(mockNotificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "Address Verification Rejected",
                    body: "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
                    enablePush: true,
                }),
            );
            expect(mockWsGateway.notifyProfileUpdate).toHaveBeenCalledWith(mockUser.id);
            expect(mockEmailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-rejected",
                    merge_info: expect.objectContaining({
                        first_name: "John",
                        document_type: "Address",
                        rejection_reason: "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
                        status: "Rejected",
                    }),
                }),
            );
        });

        it("uploads PDF address documents without image compression", async () => {
            const pdfFile = {
                ...mockFile,
                mimetype: "application/pdf",
                originalname: "utility-bill.pdf",
            } as Express.Multer.File;

            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0,
                matchedName: false,
                matchedAddress: false,
                matchedResidentialAddress: null,
                requiresManualReview: true,
                decision: "REVIEW",
                reason: "Could not extract text from document. Please upload a clearer image.",
            });

            const result = await service.verifyAddress(mockUser, pdfFile);

            expect(result.data.status).toBe("PENDING");
            expect(mockUploadService.uploadImage).toHaveBeenCalledWith(
                expect.objectContaining({
                    dir: "/var/lib/flipxer/test-docs/address",
                    name: expect.stringMatching(/^address-doc-\d+-\d+\.pdf$/),
                }),
            );
            expect(
                mockUploadService.uploadCompressedImage,
            ).not.toHaveBeenCalled();
        });

        it("maps compression failures to a bad-request error", async () => {
            const compressionError = Object.assign(
                new Error("unsupported image format"),
                {
                    name: "ImageCompressionError",
                },
            );

            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            mockUploadService.uploadCompressedImage.mockRejectedValue(
                compressionError,
            );

            await expect(
                service.verifyAddress(mockUser, mockFile),
            ).rejects.toThrow(
                "Unsupported document format. Please upload a JPEG, PNG, or PDF file.",
            );

            expect(prisma.user.update).not.toHaveBeenCalled();
            expect(prisma.kycStageAttempt.create).not.toHaveBeenCalled();
        });

        it("maps unreadable PDF OCR failures to a bad-request error", async () => {
            const pdfFile = {
                ...mockFile,
                mimetype: "application/pdf",
                originalname: "utility-bill.pdf",
            } as Express.Multer.File;

            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockRejectedValue(
                new OcrDocumentPreparationError(
                    "Unsupported or unreadable PDF document. Please upload a valid PDF or image file.",
                ),
            );

            await expect(
                service.verifyAddress(mockUser, pdfFile),
            ).rejects.toThrow(
                "Unsupported or unreadable PDF document. Please upload a valid PDF or image file.",
            );

            expect(prisma.user.update).not.toHaveBeenCalled();
            expect(prisma.kycStageAttempt.create).not.toHaveBeenCalled();
        });
    });

    // ==================== Income Verification (File Upload) ====================

    describe("verifyIncome", () => {
        const eligibleIncomeUser = {
            ...mockUser,
            tier: 2,
            addressDocumentUrl: "https://cdn.test.com/address-proof.png",
        };

        it("should return early if income is already verified", async () => {
            const verifiedUser = {
                ...eligibleIncomeUser,
                tier: 3,
                incomeDocumentUrl: "https://cdn.test.com/income-proof.png",
            };
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "INCOME",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.verifyIncome(verifiedUser, mockFile);
            expect(result.message).toBe("Income is already verified");
        });

        it("should throw if file validation fails", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({
                isValid: false,
                error: "Invalid mime type",
            });

            await expect(
                service.verifyIncome(eligibleIncomeUser, mockFile),
            ).rejects.toThrow(HttpException);
        });

        it("should reject income verification until address verification is complete", async () => {
            (validateDocumentFile as jest.Mock).mockClear();

            await expect(
                service.verifyIncome(
                    {
                        ...mockUser,
                        addressDocumentUrl: null,
                    },
                    mockFile,
                ),
            ).rejects.toThrow(
                "Complete address verification before submitting income verification.",
            );

            expect(validateDocumentFile).not.toHaveBeenCalled();
        });

        it("should queue manual review for a valid Nigerian bank statement", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateIncomeDocument as jest.Mock).mockResolvedValue({
                confidence: 0.93,
                matchedName: true,
                incomeDocumentType: "BANK_STATEMENT",
                isAllowedDocumentType: true,
                countryConfirmed: true,
                isRecent: true,
                requiresManualReview: true,
                decision: "REVIEW",
                reason: "Your bank statement passed automated checks and will be reviewed by our team.",
            });
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.verifyIncome(
                eligibleIncomeUser,
                mockFile,
            );
            expect(result.data.status).toBe("PENDING");
            expect(result.message).toBe("Your bank statement passed automated checks and is pending manual review.");
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        stage: KycStage.INCOME,
                        status: KycAttemptStatus.PENDING_REVIEW,
                    }),
                }),
            );
            expect(mockEmailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-pending-review",
                    merge_info: expect.objectContaining({
                        name: "John",
                        document_type: "Bank Statement",
                    }),
                }),
            );
        });

        it("passes Dojah provider signals into income submit validation and records provider rejections", async () => {
            const providerSignals = {
                isValid: false,
                reason: "Printed photocopy detected",
                documentType: "Bank Statement",
                nameMatches: true,
                documentDate: "2026-04-20",
                country: "Nigeria",
                countryCode: "NG",
            };
            mockAuthService.analyzeIncomeDocumentSignals.mockResolvedValue(providerSignals);
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateIncomeDocument as jest.Mock).mockResolvedValue({
                confidence: 0.93,
                matchedName: true,
                incomeDocumentType: "BANK_STATEMENT",
                isAllowedDocumentType: true,
                countryConfirmed: true,
                isRecent: true,
                providerVerified: false,
                providerReason: "Printed photocopy detected",
                providerDocumentType: "Bank Statement",
                providerNameMatches: true,
                requiresManualReview: false,
                decision: "REJECT",
                reason: "This bank statement could not be verified as an original document. Please upload an original Nigerian bank statement that shows your full name.",
            });
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.verifyIncome(
                eligibleIncomeUser,
                mockFile,
            );

            expect(mockAuthService.analyzeIncomeDocumentSignals).toHaveBeenCalledWith(eligibleIncomeUser, mockFile);
            expect(validateIncomeDocument).toHaveBeenCalledWith(
                mockFile.buffer,
                "John",
                "Doe",
                "image/png",
                providerSignals,
            );
            expect(result.message).toBe(
                "This bank statement could not be verified as an original document. Please upload an original Nigerian bank statement that shows your full name.",
            );
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        stage: KycStage.INCOME,
                        status: KycAttemptStatus.REJECTED,
                        comparisonSummary: expect.objectContaining({
                            providerVerified: false,
                            providerReason: "Printed photocopy detected",
                            providerDocumentType: "Bank Statement",
                            providerNameMatches: true,
                        }),
                        reasonDetails: expect.objectContaining({
                            providerVerified: false,
                            providerReason: "Printed photocopy detected",
                        }),
                    }),
                }),
            );
        });

        it("keeps the persisted Dojah preview payload on income submit-from-preview", async () => {
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
            });
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });

            await service.verifyIncomeFromPreview(
                eligibleIncomeUser,
                mockFile,
                KycMethod.BANK_STATEMENT,
                {
                    outcome: "REVIEW_LIKELY",
                    providerStatus: KycProviderStatus.INCONCLUSIVE,
                    comparisonSummary: {
                        decision: "REVIEW",
                        matchedName: true,
                        isAllowedDocumentType: true,
                    },
                    providerInteraction: {
                        provider: "DOJAH",
                        request: {
                            inputType: "base64",
                            imageFrontSide: "income-preview-base64",
                        },
                        response: {
                            parsed: {
                                documentType: "bank statement",
                            },
                        },
                    },
                },
            );

            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reasonDetails: expect.objectContaining({
                            providerInteraction: expect.objectContaining({
                                provider: "DOJAH",
                                request: expect.objectContaining({
                                    imageFrontSide: "income-preview-base64",
                                }),
                            }),
                        }),
                    }),
                }),
            );
        });

        it("should auto-reject when the bank statement fails the automated rules", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateIncomeDocument as jest.Mock).mockResolvedValue({
                confidence: 0.9,
                matchedName: false,
                incomeDocumentType: "BANK_STATEMENT",
                isAllowedDocumentType: true,
                countryConfirmed: true,
                isRecent: true,
                requiresManualReview: false,
                decision: "REJECT",
                reason: "The submitted bank statement does not match the name on your profile. Please upload your own recent bank statement.",
            });
            prisma.user.findUnique.mockResolvedValue({
                kycStageAttempts: [
                    {
                        stage: "IDENTITY_DOCUMENT",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                    {
                        stage: "ADDRESS",
                        status: "APPROVED",
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.verifyIncome(
                eligibleIncomeUser,
                mockFile,
            );
            expect(result.message).toBe("The submitted bank statement does not match the name on your profile. Please upload your own recent bank statement.");
            expect(result.data.status).toBe("REJECTED");
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        stage: KycStage.INCOME,
                        status: KycAttemptStatus.REJECTED,
                        decisionMode: KycDecisionMode.AUTO,
                    }),
                }),
            );
            expect(mockNotificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "Income Verification Rejected",
                    body: "The submitted bank statement does not match the name on your profile. Please upload your own recent bank statement.",
                }),
            );
        });
    });

    // ==================== Trading Password ====================

    describe("createTradingPassword", () => {
        it("should throw when trading password confirmation does not match", async () => {
            const tradingPassword = createTestSecret();
            const confirmTradingPassword = createTestSecret();
            const accountPassword = createTestSecret();

            await expect(
                service.createTradingPassword(mockUser, {
                    tradingPassword,
                    confirmTradingPassword,
                    accountPassword,
                } as any),
            ).rejects.toThrow("Passwords do not match");
        });

        it("should throw if account password is wrong", async () => {
            const bcrypt = require("bcryptjs");
            bcrypt.compare.mockResolvedValue(false);
            prisma.user.findUnique.mockResolvedValue({ password: createTestSecret() });
            const tradingPassword = createTestSecret();
            const accountPassword = createTestSecret();

            await expect(
                service.createTradingPassword(mockUser, {
                    tradingPassword,
                    accountPassword,
                } as any)
            ).rejects.toThrow();
        });
    });

    describe("status and notification helpers", () => {
        it("hasTradingPassword returns false when password is missing", async () => {
            prisma.user.findUnique.mockResolvedValue({ tradingPassword: null });

            const result = await service.hasTradingPassword(mockUser);
            expect(result.data.hasTradingPassword).toBe(false);
        });

        it("hasTradingPassword returns true when password exists", async () => {
            prisma.user.findUnique.mockResolvedValue({ tradingPassword: createTestSecret() });

            const result = await service.hasTradingPassword(mockUser);
            expect(result.data.hasTradingPassword).toBe(true);
        });

        it("getVerificationStatus throws when user is not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(service.getVerificationStatus(mockUser)).rejects.toThrow("User not found");
        });

        it("sendReviewNotification returns early when user has no email", async () => {
            prisma.user.findUnique.mockResolvedValue({ email: null, firstName: "NoMail" });

            await expect(service.sendReviewNotification(1, "address", true)).resolves.toBeUndefined();
        });

        it("approveDocument handles business documents flow", async () => {
            prisma.user.update.mockResolvedValue({});

            const result = await service.approveDocument(1, "business");

            expect(result.message).toContain("approved successfully");
            expect(prisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        businessDocumentVerificationStatus: expect.any(String),
                        isDocumentVerified: true,
                    }),
                })
            );
            expect(mockNotificationDispatcher.notify).toHaveBeenCalled();
            expect(mockWsGateway.notifyProfileUpdate).toHaveBeenCalledWith(1);
        });

        it("rejectDocument handles business documents flow", async () => {
            prisma.user.update.mockResolvedValue({});

            const result = await service.rejectDocument(1, "business", "invalid docs");

            expect(result.message).toContain("rejected");
            expect(prisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        businessDocumentVerificationStatus: expect.any(String),
                        businessDocumentsUploaded: false,
                    }),
                })
            );
            expect(mockNotificationDispatcher.notify).toHaveBeenCalled();
            expect(mockWsGateway.notifyProfileUpdate).toHaveBeenCalledWith(1);
        });
    });
});
