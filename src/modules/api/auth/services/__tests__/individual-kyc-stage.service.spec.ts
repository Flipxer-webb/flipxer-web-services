import { HttpException, HttpStatus } from "@nestjs/common";

jest.mock("../index", () => ({
    AuthService: class AuthService {
        readonly __stub = true;
    },
}));

jest.mock("../tier-verification.service", () => ({
    TierVerificationService: class TierVerificationService {
        readonly __stub = true;
    },
}));

jest.mock("@/core/validators/file-validator", () => ({
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

import {
    DocumentType,
    DocumentVerificationStatus,
    KycAttemptStatus,
    KycDecisionMode,
    KycMethod,
    KycProviderName,
    KycProviderStatus,
    KycStage,
} from "@prisma/client";
import { validateDocumentFile } from "@/core/validators/file-validator";
import {
    OcrDocumentPreparationError,
    validateAddressDocument,
    validateIncomeDocument,
} from "@/libs/ocr";
import { IndividualKycStageService } from "../individual-kyc-stage.service";

function createPrismaMock() {
    return {
        user: { findUnique: jest.fn() },
        kycStageAttempt: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
        userDocument: { findUnique: jest.fn() },
        $transaction: jest.fn(),
    };
}

function createTransactionMock() {
    return {
        kycStageAttempt: {
            findUnique: jest.fn(),
            aggregate: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        kycEvidenceAsset: {
            deleteMany: jest.fn(),
            createMany: jest.fn(),
        },
    };
}

describe("IndividualKycStageService", () => {
    let prisma: ReturnType<typeof createPrismaMock>;
    let tx: ReturnType<typeof createTransactionMock>;
    let authService: {
        bvnVerification: jest.Mock;
        ninVerification: jest.Mock;
        previewDocument: jest.Mock;
        previewDocumentWithProviderLog: jest.Mock;
        documentVerificationBase64: jest.Mock;
        documentVerificationBase64FromPreview: jest.Mock;
        analyzeAddressDocumentSignals: jest.Mock;
        analyzeIncomeDocumentSignals: jest.Mock;
    };
    let tierVerificationService: {
        verifyAddress: jest.Mock;
        verifyIncome: jest.Mock;
        verifyAddressFromPreview: jest.Mock;
        verifyIncomeFromPreview: jest.Mock;
    };
    let service: IndividualKycStageService;

    const baseUser = {
        id: 7,
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: new Date("1815-12-10T00:00:00.000Z"),
        residentialAddress: "22 Broad Street, Lagos",
        incomeVerificationStatus: DocumentVerificationStatus.PENDING,
    } as any;

    const pdfFile = {
        buffer: Buffer.from("address-proof"),
        mimetype: "application/pdf",
        size: 1024,
        originalname: "address-proof.pdf",
    } as Express.Multer.File;

    beforeEach(() => {
        prisma = createPrismaMock();
        tx = createTransactionMock();
        authService = {
            bvnVerification: jest.fn(),
            ninVerification: jest.fn(),
            previewDocument: jest.fn(),
            previewDocumentWithProviderLog: jest.fn(),
            documentVerificationBase64: jest.fn(),
            documentVerificationBase64FromPreview: jest.fn(),
            analyzeAddressDocumentSignals: jest.fn().mockResolvedValue(null),
            analyzeIncomeDocumentSignals: jest.fn().mockResolvedValue(null),
        };
        tierVerificationService = {
            verifyAddress: jest.fn(),
            verifyIncome: jest.fn(),
            verifyAddressFromPreview: jest.fn(),
            verifyIncomeFromPreview: jest.fn(),
        };

        prisma.$transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
        (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });

        service = new IndividualKycStageService(
            prisma as any,
            authService as any,
            tierVerificationService as any,
        );
    });

    it("maps identity preview responses into staged preview payloads", async () => {
        authService.previewDocumentWithProviderLog.mockResolvedValue({
            message: "Document can be submitted for review",
            data: {
                isValid: false,
                hasExtractedText: true,
                documentType: "PASSPORT",
                country: "NG",
                firstName: "Ada",
                lastName: "Lovelace",
                documentNumber: "A1234567",
                dateOfBirth: "1815-12-10",
                hasPortrait: true,
                hasFrontSide: true,
                hasBackSide: false,
            },
            providerInteraction: {
                provider: "DOJAH",
                request: {
                    inputType: "base64",
                    imageFrontSide: "ZmFrZQ==",
                },
                response: {
                    parsed: {
                        documentNumber: "A1234567",
                    },
                },
            },
        });

        const result = await service.previewIdentityDocument(baseUser, {
            imageFrontBase64: "data:image/jpeg;base64,ZmFrZQ==",
        } as any);

        expect(authService.previewDocumentWithProviderLog).toHaveBeenCalledWith(baseUser, {
            imageFrontBase64: "data:image/jpeg;base64,ZmFrZQ==",
        });
        expect(result.data).toEqual(
            expect.objectContaining({
                stage: KycStage.IDENTITY_DOCUMENT,
                outcome: "REVIEW_LIKELY",
                providerStatus: KycProviderStatus.INCONCLUSIVE,
                canSubmit: true,
                reasonMessage: null,
                autofill: { documentNumber: "A1234567" },
                comparisonSummary: expect.objectContaining({
                    nameMatches: true,
                    dobMatches: true,
                }),
                warnings: expect.arrayContaining([
                    "The document back side could not be confidently detected.",
                    "This document can still be submitted, but reviewer intervention is likely.",
                ]),
            }),
        );
        expect(result.message).toBe("Document uploaded successfully, please submit.");
        expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    stage: KycStage.IDENTITY_DOCUMENT,
                    status: KycAttemptStatus.DRAFT,
                    isCurrent: false,
                    attemptNo: 0,
                    reasonMessage: null,
                    evidenceSummary: expect.objectContaining({
                        previewMessage: "Document uploaded successfully, please submit.",
                        canSubmit: true,
                        outcome: "REVIEW_LIKELY",
                    }),
                    reasonDetails: expect.objectContaining({
                        previewMessage: "Document uploaded successfully, please submit.",
                        providerInteraction: expect.objectContaining({
                            provider: "DOJAH",
                            request: expect.objectContaining({
                                inputType: "base64",
                            }),
                        }),
                    }),
                }),
            }),
        );
    });

    it("treats invalid but reviewable previews as review likely even without extracted text", async () => {
        authService.previewDocumentWithProviderLog.mockResolvedValue({
            message: "Document needs review and can be submitted for manual review.",
            data: {
                isValid: false,
                canSubmit: true,
                hasExtractedText: false,
                reason: "INVALID",
                documentType: "PASSPORT",
                country: "NG",
                hasPortrait: true,
                hasFrontSide: true,
                hasBackSide: false,
            },
        });

        const result = await service.previewIdentityDocument(baseUser, {
            imageFrontBase64: "data:image/jpeg;base64,ZmFrZQ==",
        } as any);

        expect(result.data).toEqual(
            expect.objectContaining({
                outcome: "REVIEW_LIKELY",
                providerStatus: KycProviderStatus.INCONCLUSIVE,
                canSubmit: true,
                reasonCode: "INVALID",
                reasonMessage: null,
            }),
        );
        expect(result.message).toBe("Document uploaded successfully, please submit.");
    });

    it("converts OCR preparation failures into bad-request preview errors", async () => {
        (validateAddressDocument as jest.Mock).mockRejectedValue(
            new OcrDocumentPreparationError("Unreadable document"),
        );

        try {
            await service.previewAddressDocument(baseUser, pdfFile, KycMethod.UTILITY_BILL);
            fail("Expected previewAddressDocument to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
            expect((error as Error).message).toBe("Unreadable document");
        }
    });

    it("maps clear address preview mismatches into a reject-likely staged payload", async () => {
        (validateAddressDocument as jest.Mock).mockResolvedValue({
            confidence: 95,
            matchedName: false,
            matchedAddress: true,
            matchedResidentialAddress: false,
            isAllowedDocumentType: true,
            requiresManualReview: false,
            decision: "REJECT",
            reason: "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
            documentDate: "2026-04-20T00:00:00.000Z",
            isRecent: true,
        });

        const result = await service.previewAddressDocument(baseUser, pdfFile, KycMethod.UTILITY_BILL);

        expect(result.data).toEqual(
            expect.objectContaining({
                stage: KycStage.ADDRESS,
                outcome: "REJECT_LIKELY",
                providerStatus: KycProviderStatus.FAILED,
                canSubmit: false,
                reasonCode: "PROFILE_NAME_MISMATCH",
                reasonMessage: "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
                comparisonSummary: expect.objectContaining({
                    matchedName: false,
                    matchedAddress: true,
                    isRecent: true,
                }),
                warnings: expect.arrayContaining([
                    "The submitted address document does not carry your name. Please upload a recent proof of address that shows your full name.",
                ]),
            }),
        );
    });

    it("passes Dojah provider signals into address preview validation", async () => {
        const providerSignals = {
            documentType: "Utility Bill",
            nameMatches: true,
            documentDate: "2026-04-20",
        };
        authService.analyzeAddressDocumentSignals.mockResolvedValue(providerSignals);
        (validateAddressDocument as jest.Mock).mockResolvedValue({
            confidence: 95,
            matchedName: true,
            matchedAddress: true,
            matchedResidentialAddress: true,
            addressDocumentType: "UTILITY_BILL",
            isAllowedDocumentType: true,
            requiresManualReview: false,
            decision: "APPROVE",
        });

        await service.previewAddressDocument(baseUser, pdfFile, KycMethod.UTILITY_BILL);

        expect(authService.analyzeAddressDocumentSignals).toHaveBeenCalledWith(baseUser, pdfFile);
        expect(validateAddressDocument).toHaveBeenCalledWith(
            pdfFile.buffer,
            "Ada",
            "Lovelace",
            "22 Broad Street, Lagos",
            "application/pdf",
            providerSignals,
        );
    });

    it("blocks staged address submit when preview detects an unsupported address document type", async () => {
        (validateAddressDocument as jest.Mock).mockResolvedValue({
            confidence: 95,
            matchedName: true,
            matchedAddress: false,
            matchedResidentialAddress: false,
            addressDocumentType: null,
            isAllowedDocumentType: false,
            requiresManualReview: false,
            decision: "REJECT",
            reason: "Please upload a valid address verification document.",
            documentDate: "2026-04-20T00:00:00.000Z",
            isRecent: true,
        });

        const result = await service.previewAddressDocument(baseUser, pdfFile, KycMethod.UTILITY_BILL);

        expect(result.data).toEqual(
            expect.objectContaining({
                outcome: "REJECT_LIKELY",
                providerStatus: KycProviderStatus.FAILED,
                canSubmit: false,
                reasonCode: "DOCUMENT_UNSUPPORTED",
                reasonMessage: "Please upload a valid address verification document.",
                comparisonSummary: expect.objectContaining({
                    matchedAddress: false,
                    isAllowedDocumentType: false,
                }),
                warnings: expect.arrayContaining([
                    "Please upload a valid address verification document.",
                ]),
            }),
        );
    });

    it("maps valid income previews into staged manual-review payloads", async () => {
        (validateIncomeDocument as jest.Mock).mockResolvedValue({
            confidence: 92,
            matchedName: true,
            incomeDocumentType: "BANK_STATEMENT",
            isAllowedDocumentType: true,
            isRecent: true,
            countryConfirmed: true,
            requiresManualReview: true,
            decision: "REVIEW",
            reason: "Your bank statement passed automated checks and will be reviewed by our team.",
        });

        const result = await service.previewIncomeDocument(baseUser, pdfFile, KycMethod.OTHER);

        expect(result.data).toEqual(
            expect.objectContaining({
                stage: KycStage.INCOME,
                outcome: "REVIEW_LIKELY",
                providerStatus: KycProviderStatus.INCONCLUSIVE,
                canSubmit: true,
                reasonCode: null,
                reasonMessage: null,
                warnings: expect.arrayContaining([
                    "This statement can be submitted and will go to manual review.",
                ]),
            }),
        );
        expect(result.message).toBe("Document uploaded successfully, please submit.");
        expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    stage: KycStage.INCOME,
                    status: KycAttemptStatus.DRAFT,
                    isCurrent: false,
                    attemptNo: 0,
                    reasonMessage: null,
                }),
            }),
        );
    });

    it("passes Dojah provider signals into income preview validation and blocks suspected fake statements", async () => {
        const providerSignals = {
            isValid: false,
            reason: "Printed photocopy detected",
            documentType: "Bank Statement",
            nameMatches: true,
            documentDate: "2026-04-20",
            country: "Nigeria",
            countryCode: "NG",
        };
        authService.analyzeIncomeDocumentSignals.mockResolvedValue(providerSignals);
        (validateIncomeDocument as jest.Mock).mockResolvedValue({
            confidence: 95,
            matchedName: true,
            incomeDocumentType: "BANK_STATEMENT",
            isAllowedDocumentType: true,
            isRecent: true,
            countryConfirmed: true,
            providerVerified: false,
            providerReason: "Printed photocopy detected",
            providerDocumentType: "Bank Statement",
            providerNameMatches: true,
            requiresManualReview: false,
            decision: "REJECT",
            reason: "This bank statement could not be verified as an original document. Please upload an original Nigerian bank statement that shows your full name.",
        });

        const result = await service.previewIncomeDocument(baseUser, pdfFile, KycMethod.OTHER);

        expect(authService.analyzeIncomeDocumentSignals).toHaveBeenCalledWith(baseUser, pdfFile);
        expect(validateIncomeDocument).toHaveBeenCalledWith(
            pdfFile.buffer,
            "Ada",
            "Lovelace",
            "application/pdf",
            providerSignals,
        );
        expect(result.data).toEqual(
            expect.objectContaining({
                stage: KycStage.INCOME,
                outcome: "REJECT_LIKELY",
                providerStatus: KycProviderStatus.FAILED,
                canSubmit: false,
                reasonCode: "DOCUMENT_INVALID",
                reasonMessage: "This bank statement could not be verified as an original document. Please upload an original Nigerian bank statement that shows your full name.",
                comparisonSummary: expect.objectContaining({
                    providerVerified: false,
                    providerReason: "Printed photocopy detected",
                    providerDocumentType: "Bank Statement",
                    providerNameMatches: true,
                }),
            }),
        );
    });

    it("maps invalid income previews into reject-likely payloads and blocks submit", async () => {
        (validateIncomeDocument as jest.Mock).mockResolvedValue({
            confidence: 88,
            matchedName: false,
            incomeDocumentType: "BANK_STATEMENT",
            isAllowedDocumentType: true,
            isRecent: true,
            countryConfirmed: true,
            requiresManualReview: false,
            decision: "REJECT",
            reason: "The submitted bank statement does not match the name on your profile. Please upload your own recent bank statement.",
        });

        const result = await service.previewIncomeDocument(baseUser, pdfFile, KycMethod.OTHER);

        expect(result.data).toEqual(
            expect.objectContaining({
                stage: KycStage.INCOME,
                outcome: "REJECT_LIKELY",
                providerStatus: KycProviderStatus.FAILED,
                canSubmit: false,
                reasonCode: "PROFILE_NAME_MISMATCH",
                reasonMessage: "The submitted bank statement does not match the name on your profile. Please upload your own recent bank statement.",
            }),
        );
    });

    it("creates a current address stage attempt and evidence asset after submit", async () => {
        const submittedAt = new Date("2026-04-20T10:00:00.000Z");
        const previewAttempt = {
            id: 300,
            userId: baseUser.id,
            stage: KycStage.ADDRESS,
            method: KycMethod.UTILITY_BILL,
            attemptNo: 0,
            isCurrent: false,
            status: KycAttemptStatus.DRAFT,
            reasonDetails: {
                previewSignature: "6de015546719a2276827808ab60fd76d4f612e5a4e63984dbc25c0fda5d655fd",
                previewPayload: {
                    canSubmit: true,
                    comparisonSummary: {
                        decision: "REVIEW",
                    },
                },
            },
            evidenceSummary: {
                previewSignature: "6de015546719a2276827808ab60fd76d4f612e5a4e63984dbc25c0fda5d655fd",
            },
        } as any;
        const createdAttempt = {
            id: 301,
            userId: baseUser.id,
            stage: KycStage.ADDRESS,
            method: KycMethod.UTILITY_BILL,
            attemptNo: 2,
            isCurrent: true,
            status: KycAttemptStatus.PENDING_REVIEW,
            providerName: KycProviderName.OCR,
            providerStatus: KycProviderStatus.INCONCLUSIVE,
            decisionMode: KycDecisionMode.MANUAL,
            providerRef: "ocr-21",
            reasonCode: "ADDRESS_MISMATCH",
            reasonMessage: "Address mismatch",
            extractedFields: null,
            comparisonSummary: { matchedName: false },
            evidenceSummary: { assetCount: 1, mimeType: "application/pdf" },
            reviewerId: null,
            reviewNote: null,
            submittedAt,
            reviewedAt: null,
            escalatedAt: null,
            version: 3,
        } as any;

        tierVerificationService.verifyAddressFromPreview.mockResolvedValue({
            message: "Address document submitted for review",
        });
        prisma.kycStageAttempt.findFirst
            .mockResolvedValueOnce(previewAttempt)
            .mockResolvedValueOnce(createdAttempt);

        const result = await service.submitAddressDocument(baseUser, pdfFile, KycMethod.UTILITY_BILL);

        expect(tierVerificationService.verifyAddressFromPreview).toHaveBeenCalledWith(
            baseUser,
            pdfFile,
            KycMethod.UTILITY_BILL,
            expect.objectContaining({
                canSubmit: true,
                comparisonSummary: expect.objectContaining({
                    decision: "REVIEW",
                }),
            }),
        );
        expect(result.data).toEqual(
            expect.objectContaining({
                attemptId: 301,
                stage: KycStage.ADDRESS,
                status: KycAttemptStatus.PENDING_REVIEW,
                providerStatus: KycProviderStatus.INCONCLUSIVE,
                outcome: "UNDER_REVIEW",
                nextAction: expect.objectContaining({
                    type: "WAIT",
                    stage: KycStage.ADDRESS,
                }),
            }),
        );
    });

    it("returns a staged rejection payload when BVN verification creates a rejected legacy record", async () => {
        const submittedAt = new Date("2026-04-20T10:00:00.000Z");
        const createdAttempt = {
            id: 401,
            userId: baseUser.id,
            stage: KycStage.GOVERNMENT_ID,
            method: KycMethod.BVN,
            attemptNo: 1,
            isCurrent: true,
            status: KycAttemptStatus.REJECTED,
            providerName: KycProviderName.DOJAH,
            providerStatus: KycProviderStatus.FAILED,
            decisionMode: KycDecisionMode.AUTO,
            providerRef: "dojah-bvn-41",
            reasonCode: "DOB_MATCHED_BUT_NAMES_MISMATCHED_MANUAL_CHECK_FAILED",
            reasonMessage: "DOB matched but names mismatched. Manual check failed.",
            extractedFields: { identifierType: KycMethod.BVN },
            comparisonSummary: { dobMatches: true, nameMatches: false },
            evidenceSummary: { identifierType: KycMethod.BVN, verified: false },
            reviewerId: null,
            reviewNote: "DOB matched but names mismatched. Manual check failed.",
            submittedAt,
            reviewedAt: submittedAt,
            escalatedAt: null,
            version: 2,
        } as any;

        authService.bvnVerification.mockRejectedValue(new HttpException(
            "Incorrect first name, last name or date of birth",
            HttpStatus.BAD_REQUEST,
        ));
        prisma.kycStageAttempt.findFirst.mockResolvedValue(createdAttempt);

        const result = await service.submitGovernmentIdBvn(baseUser, {
            firstName: "Ada",
            lastName: "Lovelace",
            dateOfBirth: "1815-12-10",
            bvn: "22222222222",
        });

        expect(authService.bvnVerification).toHaveBeenCalledWith(baseUser, {
            firstName: "Ada",
            lastName: "Lovelace",
            dateOfBirth: "1815-12-10",
            bvn: "22222222222",
        });
        expect(result.data).toEqual(
            expect.objectContaining({
                attemptId: 401,
                stage: KycStage.GOVERNMENT_ID,
                status: KycAttemptStatus.REJECTED,
                providerStatus: KycProviderStatus.FAILED,
                outcome: "REJECTED_HARD_STOP",
                nextAction: expect.objectContaining({
                    type: "RESUBMIT",
                    stage: KycStage.GOVERNMENT_ID,
                }),
            }),
        );
    });

    it("updates an existing identity attempt and rebuilds evidence assets on submit", async () => {
        const submittedAt = new Date("2026-04-21T09:00:00.000Z");
        const reviewedAt = new Date("2026-04-21T09:30:00.000Z");
        const dto = {
            documentType: DocumentType.INTERNATIONAL_PASSPORT,
            country: "NIGERIA",
            documentNumber: "A1234567",
            imageFrontBase64: "data:image/jpeg;base64,ZmFrZQ==",
            imageBackBase64: "data:image/png;base64,YmFjaw==",
        };
        const previewAttempt = {
            id: 500,
            userId: baseUser.id,
            stage: KycStage.IDENTITY_DOCUMENT,
            method: KycMethod.INTERNATIONAL_PASSPORT,
            attemptNo: 0,
            isCurrent: false,
            status: KycAttemptStatus.DRAFT,
            reasonDetails: {
                previewSignature: "5c8c2df8a10fbe1bded4453f2a7148e2275ad872f5ed7db84a4d5edaded42bfe",
                providerInteraction: {
                    provider: "DOJAH",
                    request: {
                        inputType: "base64",
                        imageFrontSide: "ZmFrZQ==",
                    },
                    response: {
                        parsed: {
                            firstName: "Ada",
                            lastName: "Lovelace",
                            dateOfBirth: "1815-12-10",
                            documentNumber: "A1234567",
                        },
                    },
                },
                previewPayload: {
                    canSubmit: true,
                    isValid: true,
                    documentType: "passport",
                    documentNumber: "A1234567",
                },
            },
            evidenceSummary: {
                previewSignature: "5c8c2df8a10fbe1bded4453f2a7148e2275ad872f5ed7db84a4d5edaded42bfe",
            },
        } as any;
        const updatedAttempt = {
            id: 501,
            userId: baseUser.id,
            stage: KycStage.IDENTITY_DOCUMENT,
            method: KycMethod.INTERNATIONAL_PASSPORT,
            attemptNo: 4,
            isCurrent: true,
            status: KycAttemptStatus.APPROVED,
            providerName: KycProviderName.DOJAH,
            providerStatus: KycProviderStatus.PASSED,
            decisionMode: KycDecisionMode.AUTO,
            providerRef: "dojah-55",
            reasonCode: null,
            reasonMessage: null,
            extractedFields: { documentNumber: "A1234567" },
            comparisonSummary: { nameMatches: true },
            evidenceSummary: { assetCount: 2, hasBackImage: true },
            reviewerId: 99,
            reviewNote: "Approved after review",
            submittedAt,
            reviewedAt,
            escalatedAt: null,
            version: 7,
        } as any;

        authService.documentVerificationBase64FromPreview.mockResolvedValue({
            message: "Document verified successfully",
        });
        prisma.kycStageAttempt.findFirst
            .mockResolvedValueOnce(previewAttempt)
            .mockResolvedValueOnce(updatedAttempt);

        const result = await service.submitIdentityDocument(baseUser, dto as any);

        expect(authService.documentVerificationBase64FromPreview).toHaveBeenCalledWith(
            baseUser,
            dto,
            expect.objectContaining({
                canSubmit: true,
                isValid: true,
                documentType: "passport",
                documentNumber: "A1234567",
                providerInteraction: expect.objectContaining({
                    provider: "DOJAH",
                    response: expect.objectContaining({
                        parsed: expect.objectContaining({
                            firstName: "Ada",
                            lastName: "Lovelace",
                        }),
                    }),
                }),
            }),
        );
        expect(result.data).toEqual(
            expect.objectContaining({
                attemptId: 501,
                stage: KycStage.IDENTITY_DOCUMENT,
                status: KycAttemptStatus.APPROVED,
                providerStatus: KycProviderStatus.PASSED,
                outcome: "APPROVED",
                autofill: {
                    documentNumber: "A1234567",
                },
                nextAction: expect.objectContaining({
                    type: "COMPLETE",
                    stage: KycStage.IDENTITY_DOCUMENT,
                }),
            }),
        );
    });
});