import {
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    forwardRef,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
    DocumentType,
    DocumentVerificationStatus,
    Prisma,
    KycAttemptStatus,
    KycEvidenceKind,
    KycEvidenceSide,
    KycMethod,
    KycProviderStatus,
    KycStage,
    KycStageAttempt,
    KycStatus,
    User,
} from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { validateDocumentFile } from "@/core/validators/file-validator";
import {
    OcrDocumentPreparationError,
    validateAddressDocument,
    validateIncomeDocument,
} from "@/libs/ocr";
import {
    BvnVerificationDto,
    DocumentPreviewDto,
    DocumentVerificationBase64Dto,
    NinVerificationDto,
} from "../dtos";
import type { AuthService } from "./index";
import { TierVerificationService } from "./tier-verification.service";

type PreviewOutcome = "READY" | "REVIEW_LIKELY" | "REJECT_LIKELY" | "BLOCKED";
type SubmitOutcome = "APPROVED" | "UNDER_REVIEW" | "REJECTED_HARD_STOP";
type StageNextActionType =
    | "START"
    | "SUBMIT"
    | "RESUBMIT"
    | "WAIT"
    | "COMPLETE"
    | "CONTACT_SUPPORT";
type PreviewDecision = "APPROVE" | "REJECT" | "REVIEW";

const DRAFT_PREVIEW_ATTEMPT_NO = 0;
const PREVIEW_READY_MESSAGE = "Document uploaded successfully, please submit.";
const PREVIEW_REQUIRED_MESSAGE =
    "Please upload the document again and wait for preview to complete before submitting.";

type EvidenceAssetInput = {
    kind: KycEvidenceKind;
    storageUrl: string;
    storageFieldId?: string | null;
    originalName?: string | null;
    mimeType: string;
    checksumSha256?: string | null;
    pageCount?: number | null;
    side?: KycEvidenceSide | null;
};

@Injectable()
export class IndividualKycStageService {
    private readonly logger = new Logger(IndividualKycStageService.name);

    constructor(
        private readonly prisma: PrismaService,
        @Inject("AUTH_SERVICE")
        private readonly authService: AuthService,
        @Inject(forwardRef(() => TierVerificationService))
        private readonly tierVerificationService: TierVerificationService,
    ) {}

    async previewIdentityDocument(
        user: User,
        dto: DocumentPreviewDto,
    ): Promise<ApiResponse> {
        const legacyResponse =
            (await this.authService.previewDocumentWithProviderLog(
                user,
                dto,
            )) as {
                message: string;
                data?: Record<string, any> | null;
                providerInteraction?: Record<string, unknown> | null;
            };
        const previewData = legacyResponse.data ?? {};
        const canSubmit = Boolean(
            previewData.canSubmit ??
            (previewData.isValid || previewData.hasExtractedText),
        );
        let outcome: PreviewOutcome = "BLOCKED";

        if (previewData.isValid) {
            outcome = "READY";
        } else if (canSubmit) {
            outcome = "REVIEW_LIKELY";
        }

        const providerStatus = this.mapIdentityPreviewProviderStatus(
            previewData.isValid,
            canSubmit,
            previewData.hasExtractedText,
        );
        const reasonCode = this.mapReasonCode(previewData.reason);
        const rawReasonMessage =
            legacyResponse.message || previewData.reason || null;
        const reasonMessage = canSubmit ? null : rawReasonMessage;
        const message = canSubmit
            ? PREVIEW_READY_MESSAGE
            : reasonMessage || "Please upload a valid document.";
        const previewPayload = {
            stage: KycStage.IDENTITY_DOCUMENT,
            outcome,
            providerStatus,
            canSubmit,
            reasonCode,
            reasonMessage,
            extractedFields: this.pickDefinedFields({
                documentType: previewData.documentType,
                country: previewData.country,
                firstName: previewData.firstName,
                lastName: previewData.lastName,
                givenNames: previewData.givenNames,
                documentNumber: previewData.documentNumber,
                dateOfBirth: previewData.dateOfBirth,
                expiryDate: previewData.expiryDate,
                issueDate: previewData.issueDate,
                sex: previewData.sex,
                nationality: previewData.nationality,
            }),
            comparisonSummary: this.pickDefinedFields({
                expectedFirstName: user.firstName ?? null,
                expectedLastName: user.lastName ?? null,
                expectedDateOfBirth: this.formatDate(user.dateOfBirth),
                extractedFirstName: previewData.firstName,
                extractedLastName: previewData.lastName,
                extractedDateOfBirth: previewData.dateOfBirth,
                nameMatches:
                    this.normalizedEquals(
                        user.firstName,
                        previewData.firstName,
                    ) &&
                    this.normalizedEquals(user.lastName, previewData.lastName),
                dobMatches: this.sameDate(
                    user.dateOfBirth,
                    previewData.dateOfBirth,
                ),
            }),
            autofill: previewData.documentNumber
                ? { documentNumber: previewData.documentNumber }
                : null,
            warnings: this.buildIdentityPreviewWarnings(previewData, canSubmit),
            isValid: Boolean(previewData.isValid),
            hasExtractedText: Boolean(previewData.hasExtractedText),
            reason: previewData.reason ?? null,
            documentType: previewData.documentType ?? null,
            country: previewData.country ?? null,
            firstName: previewData.firstName ?? null,
            lastName: previewData.lastName ?? null,
            givenNames: previewData.givenNames ?? null,
            documentNumber: previewData.documentNumber ?? null,
            dateOfBirth: previewData.dateOfBirth ?? null,
            expiryDate: previewData.expiryDate ?? null,
            issueDate: previewData.issueDate ?? null,
            sex: previewData.sex ?? null,
            nationality: previewData.nationality ?? null,
            hasPortrait: Boolean(previewData.hasPortrait),
            hasFrontSide: Boolean(previewData.hasFrontSide),
            hasBackSide: Boolean(previewData.hasBackSide),
        };

        await this.persistPreviewSnapshot({
            userId: user.id,
            stage: KycStage.IDENTITY_DOCUMENT,
            method: dto.documentType
                ? this.mapDocumentTypeToMethod(dto.documentType)
                : KycMethod.OTHER,
            signature: this.buildIdentityPreviewSignature(dto),
            providerStatus,
            reasonCode,
            reasonMessage,
            message,
            payload: previewPayload,
            providerInteraction: this.asRecord(
                legacyResponse.providerInteraction,
            ),
        });

        return buildResponse({
            message,
            data: previewPayload,
        });
    }

    async previewAddressDocument(
        user: User,
        file: Express.Multer.File,
        method: KycMethod = KycMethod.OTHER,
    ): Promise<ApiResponse> {
        this.validateStageFile(file);

        const providerSignals =
            await this.authService.analyzeAddressDocumentSignals(user, file);

        const ocrResult = await validateAddressDocument(
            file.buffer,
            user.firstName || "",
            user.lastName || "",
            user.residentialAddress || null,
            file.mimetype,
            providerSignals,
        ).catch((error: unknown) => this.handleDocumentProcessingError(error));

        const decision =
            ocrResult.decision ??
            (ocrResult.requiresManualReview ? "REVIEW" : "APPROVE");
        const providerStatus = this.getAddressPreviewProviderStatus(decision);
        const canSubmit = decision !== "REJECT";
        const outcome = this.getAddressPreviewOutcome(decision);
        let reasonCode: string | null = null;

        if (ocrResult.isAllowedDocumentType === false) {
            reasonCode = "DOCUMENT_UNSUPPORTED";
        } else if (outcome === "REJECT_LIKELY") {
            reasonCode = this.mapReasonCode(ocrResult.reason);
        }
        const reasonMessage = canSubmit
            ? null
            : ocrResult.reason ||
              "Please upload a valid address verification document.";
        const message = this.getAddressPreviewMessage(canSubmit, reasonMessage);

        this.logger.log(
            `[KYC][ADDRESS][PREVIEW] user=${user.id} outcome=${outcome} decision=${decision} ` +
                `providerStatus=${providerStatus} canSubmit=${canSubmit} providerAnalyzed=${providerSignals !== null} ` +
                `providerVerified=${ocrResult.providerVerified ?? null} reason=${ocrResult.reason ?? "none"} ` +
                `providerReason=${ocrResult.providerReason ?? "none"}`,
        );

        if (!canSubmit) {
            this.logger.warn(
                `[KYC][ADDRESS][PREVIEW] blocked user=${user.id} outcome=${outcome} ` +
                    `reason=${ocrResult.reason ?? "none"} providerReason=${ocrResult.providerReason ?? "none"}`,
            );
        }

        const previewPayload = {
            stage: KycStage.ADDRESS,
            method,
            outcome,
            providerStatus,
            canSubmit,
            reasonCode,
            reasonMessage,
            extractedFields: null,
            comparisonSummary: this.pickDefinedFields({
                matchedName: ocrResult.matchedName,
                matchedAddress: ocrResult.matchedAddress,
                matchedResidentialAddress: ocrResult.matchedResidentialAddress,
                addressDocumentType: ocrResult.addressDocumentType ?? null,
                isAllowedDocumentType: ocrResult.isAllowedDocumentType ?? null,
                providerVerified: ocrResult.providerVerified ?? null,
                providerReason: ocrResult.providerReason ?? null,
                providerDocumentType: ocrResult.providerDocumentType ?? null,
                providerNameMatches: ocrResult.providerNameMatches ?? null,
                providerDocumentDate: ocrResult.providerDocumentDate ?? null,
                providerCountry: ocrResult.providerCountry ?? null,
                providerCountryCode: ocrResult.providerCountryCode ?? null,
                confidence: ocrResult.confidence,
                documentDate: ocrResult.documentDate ?? null,
                isRecent: ocrResult.isRecent ?? null,
                decision,
            }),
            autofill: null,
            warnings: this.buildAddressPreviewWarnings({
                outcome,
                canSubmit,
                matchedName: ocrResult.matchedName,
                matchedAddress: ocrResult.matchedAddress,
                hasDocumentDate: Boolean(ocrResult.documentDate),
                reason: ocrResult.reason,
            }),
        };

        await this.persistPreviewSnapshot({
            userId: user.id,
            stage: KycStage.ADDRESS,
            method,
            signature: this.buildFilePreviewSignature(file, method),
            providerStatus,
            reasonCode,
            reasonMessage,
            message,
            payload: previewPayload,
            providerInteraction:
                this.extractProviderInteraction(providerSignals),
        });

        return buildResponse({
            message,
            data: previewPayload,
        });
    }

    async previewIncomeDocument(
        user: User,
        file: Express.Multer.File,
        method: KycMethod = KycMethod.OTHER,
    ): Promise<ApiResponse> {
        this.validateStageFile(file);

        const providerSignals =
            await this.authService.analyzeIncomeDocumentSignals(user, file);

        const ocrResult = await validateIncomeDocument(
            file.buffer,
            user.firstName || "",
            user.lastName || "",
            file.mimetype,
            providerSignals,
        ).catch((error: unknown) => this.handleDocumentProcessingError(error));

        const decision =
            ocrResult.decision ??
            (ocrResult.requiresManualReview ? "REVIEW" : "REJECT");
        const providerStatus = this.getIncomePreviewProviderStatus(decision);
        const outcome = this.getIncomePreviewOutcome(decision);
        const canSubmit = decision !== "REJECT";
        const reasonCode =
            outcome === "REJECT_LIKELY"
                ? this.mapReasonCode(ocrResult.reason)
                : null;
        const reasonMessage = canSubmit
            ? null
            : ocrResult.reason || "Please upload a valid income document.";
        const message = this.getIncomePreviewMessage(canSubmit, reasonMessage);

        this.logger.log(
            `[KYC][INCOME][PREVIEW] user=${user.id} outcome=${outcome} decision=${decision} ` +
                `providerStatus=${providerStatus} canSubmit=${canSubmit} providerAnalyzed=${providerSignals !== null} ` +
                `providerVerified=${ocrResult.providerVerified ?? null} reason=${ocrResult.reason ?? "none"} ` +
                `providerReason=${ocrResult.providerReason ?? "none"}`,
        );

        if (!canSubmit) {
            this.logger.warn(
                `[KYC][INCOME][PREVIEW] blocked user=${user.id} outcome=${outcome} ` +
                    `reason=${ocrResult.reason ?? "none"} providerReason=${ocrResult.providerReason ?? "none"}`,
            );
        }

        const previewPayload = {
            stage: KycStage.INCOME,
            method,
            outcome,
            providerStatus,
            canSubmit,
            reasonCode,
            reasonMessage,
            extractedFields: null,
            comparisonSummary: this.pickDefinedFields({
                matchedName: ocrResult.matchedName,
                confidence: ocrResult.confidence,
                isAllowedDocumentType: ocrResult.isAllowedDocumentType ?? null,
                incomeDocumentType: ocrResult.incomeDocumentType ?? null,
                documentDate: ocrResult.documentDate ?? null,
                isRecent: ocrResult.isRecent ?? null,
                countryConfirmed: ocrResult.countryConfirmed ?? null,
                providerVerified: ocrResult.providerVerified ?? null,
                providerReason: ocrResult.providerReason ?? null,
                providerDocumentType: ocrResult.providerDocumentType ?? null,
                providerNameMatches: ocrResult.providerNameMatches ?? null,
                decision,
            }),
            autofill: null,
            warnings: this.buildIncomePreviewWarnings({
                canSubmit,
                matchedName: ocrResult.matchedName,
                isAllowedDocumentType: ocrResult.isAllowedDocumentType ?? null,
                countryConfirmed: ocrResult.countryConfirmed ?? null,
                isRecent: ocrResult.isRecent ?? null,
                reason: ocrResult.reason,
            }),
        };

        await this.persistPreviewSnapshot({
            userId: user.id,
            stage: KycStage.INCOME,
            method,
            signature: this.buildFilePreviewSignature(file, method),
            providerStatus,
            reasonCode,
            reasonMessage,
            message,
            payload: previewPayload,
            providerInteraction:
                this.extractProviderInteraction(providerSignals),
        });

        return buildResponse({
            message,
            data: previewPayload,
        });
    }

    async submitIdentityDocument(
        user: User,
        dto: DocumentVerificationBase64Dto,
    ): Promise<ApiResponse> {
        const previewPayload = await this.getPersistedPreviewPayload({
            userId: user.id,
            stage: KycStage.IDENTITY_DOCUMENT,
            method: this.mapDocumentTypeToMethod(dto.documentType),
            signature: this.buildIdentityPreviewSignature(dto),
        });
        const legacyResponse =
            (await this.authService.documentVerificationBase64FromPreview(
                user,
                dto,
                previewPayload,
            )) as {
                message: string;
            };
        const attempt = await this.getCurrentStageAttempt(
            user.id,
            KycStage.IDENTITY_DOCUMENT,
        );

        return buildResponse({
            message: legacyResponse.message,
            data: this.buildSubmitResponse(attempt),
        });
    }

    async submitAddressDocument(
        user: User,
        file: Express.Multer.File,
        method: KycMethod = KycMethod.OTHER,
    ): Promise<ApiResponse> {
        const previewPayload = await this.getPersistedPreviewPayload({
            userId: user.id,
            stage: KycStage.ADDRESS,
            method,
            signature: this.buildFilePreviewSignature(file, method),
        });
        const legacyResponse =
            (await this.tierVerificationService.verifyAddressFromPreview(
                user,
                file,
                method,
                previewPayload,
            )) as {
                message: string;
            };
        const attempt = await this.getCurrentStageAttempt(
            user.id,
            KycStage.ADDRESS,
        );

        return buildResponse({
            message: legacyResponse.message,
            data: this.buildSubmitResponse(attempt),
        });
    }

    async submitIncomeDocument(
        user: User,
        file: Express.Multer.File,
        method: KycMethod = KycMethod.OTHER,
    ): Promise<ApiResponse> {
        const previewPayload = await this.getPersistedPreviewPayload({
            userId: user.id,
            stage: KycStage.INCOME,
            method,
            signature: this.buildFilePreviewSignature(file, method),
        });
        const legacyResponse =
            (await this.tierVerificationService.verifyIncomeFromPreview(
                user,
                file,
                method,
                previewPayload,
            )) as {
                message: string;
            };
        const attempt = await this.getCurrentStageAttempt(
            user.id,
            KycStage.INCOME,
        );

        return buildResponse({
            message: legacyResponse.message,
            data: this.buildSubmitResponse(attempt),
        });
    }

    async submitGovernmentIdBvn(
        user: User,
        dto: BvnVerificationDto,
    ): Promise<ApiResponse> {
        return this.submitGovernmentId(
            user,
            KycMethod.BVN,
            () =>
                this.authService.bvnVerification(user, dto) as Promise<{
                    message: string;
                }>,
            "BVN verification failed",
        );
    }

    async submitGovernmentIdNin(
        user: User,
        dto: NinVerificationDto,
    ): Promise<ApiResponse> {
        return this.submitGovernmentId(
            user,
            KycMethod.NIN,
            () =>
                this.authService.ninVerification(user, dto) as Promise<{
                    message: string;
                }>,
            "NIN verification failed",
        );
    }

    private async submitGovernmentId(
        user: User,
        method: KycMethod,
        submitLegacy: () => Promise<{ message: string }>,
        fallbackMessage: string,
    ): Promise<ApiResponse> {
        try {
            const legacyResponse = await submitLegacy();
            const attempt = await this.getCurrentStageAttempt(
                user.id,
                KycStage.GOVERNMENT_ID,
                method,
            );

            return buildResponse({
                message: legacyResponse.message,
                data: this.buildSubmitResponse(attempt),
            });
        } catch (error) {
            const attempt = await this.tryGetCurrentStageAttempt(
                user.id,
                KycStage.GOVERNMENT_ID,
                method,
            );
            if (!attempt) {
                throw error;
            }

            const message =
                error instanceof Error && error.message
                    ? error.message
                    : fallbackMessage;

            return buildResponse({
                message,
                data: this.buildSubmitResponse(attempt),
            });
        }
    }

    private async tryGetCurrentStageAttempt(
        userId: number,
        stage: KycStage,
        method?: KycMethod,
    ): Promise<KycStageAttempt | null> {
        try {
            return await this.getCurrentStageAttempt(userId, stage, method);
        } catch {
            return null;
        }
    }

    private async getCurrentStageAttempt(
        userId: number,
        stage: KycStage,
        method?: KycMethod,
    ): Promise<KycStageAttempt> {
        const attempt = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId,
                journeyType: "INDIVIDUAL",
                stage,
                isCurrent: true,
                ...(method ? { method } : {}),
            },
            orderBy: [
                { attemptNo: "desc" },
                { updatedAt: "desc" },
                { id: "desc" },
            ],
        });

        if (!attempt) {
            throw new HttpException(
                `Unable to find current ${stage.toLowerCase()} attempt`,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }

        return attempt;
    }

    private async persistPreviewSnapshot(params: {
        userId: number;
        stage: KycStage;
        method: KycMethod;
        signature: string;
        providerStatus: KycProviderStatus;
        reasonCode?: string | null;
        reasonMessage?: string | null;
        message: string;
        payload: Record<string, unknown>;
        providerInteraction?: Record<string, unknown> | null;
    }): Promise<void> {
        const existingPreview = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId: params.userId,
                journeyType: "INDIVIDUAL",
                stage: params.stage,
                attemptNo: DRAFT_PREVIEW_ATTEMPT_NO,
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        });

        const draftData = {
            userId: params.userId,
            journeyType: "INDIVIDUAL" as const,
            stage: params.stage,
            method: params.method,
            attemptNo: DRAFT_PREVIEW_ATTEMPT_NO,
            isCurrent: false,
            status: KycAttemptStatus.DRAFT,
            providerStatus: params.providerStatus,
            reasonCode: params.reasonCode ?? null,
            reasonMessage: params.reasonMessage ?? null,
            extractedFields:
                (params.payload.extractedFields as
                    | Prisma.InputJsonValue
                    | null
                    | undefined) ?? null,
            comparisonSummary:
                (params.payload.comparisonSummary as
                    | Prisma.InputJsonValue
                    | null
                    | undefined) ?? null,
            evidenceSummary: {
                previewMessage: params.message,
                previewSignature: params.signature,
                canSubmit: params.payload.canSubmit === true,
                outcome: params.payload.outcome ?? null,
                providerStatus: params.providerStatus,
            } as Prisma.InputJsonValue,
            reasonDetails: {
                previewMessage: params.message,
                previewReasonMessage: params.reasonMessage ?? null,
                previewSignature: params.signature,
                previewPayload: params.payload,
                ...(params.providerInteraction
                    ? { providerInteraction: params.providerInteraction }
                    : {}),
            } as Prisma.InputJsonValue,
            submittedAt: new Date(),
        };

        if (existingPreview) {
            await this.prisma.kycStageAttempt.update({
                where: { id: existingPreview.id },
                data: draftData,
            });
            return;
        }

        await this.prisma.kycStageAttempt.create({
            data: draftData,
        });
    }

    private async getPersistedPreviewPayload(params: {
        userId: number;
        stage: KycStage;
        method: KycMethod;
        signature: string;
    }): Promise<Record<string, unknown>> {
        const previewAttempt = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId: params.userId,
                journeyType: "INDIVIDUAL",
                stage: params.stage,
                attemptNo: DRAFT_PREVIEW_ATTEMPT_NO,
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        });

        const reasonDetails = this.asRecord(previewAttempt?.reasonDetails);
        const evidenceSummary = this.asRecord(previewAttempt?.evidenceSummary);
        const previewPayload = this.asRecord(reasonDetails?.previewPayload);
        const providerInteraction = this.asRecord(
            reasonDetails?.providerInteraction,
        );
        let previewSignature: string | null = null;

        if (typeof reasonDetails?.previewSignature === "string") {
            previewSignature = reasonDetails.previewSignature;
        } else if (typeof evidenceSummary?.previewSignature === "string") {
            previewSignature = evidenceSummary.previewSignature;
        }

        if (
            !previewAttempt ||
            !previewPayload ||
            previewAttempt.method !== params.method ||
            previewSignature !== params.signature
        ) {
            throw new HttpException(
                PREVIEW_REQUIRED_MESSAGE,
                HttpStatus.BAD_REQUEST,
            );
        }

        if (previewPayload.canSubmit === false) {
            throw new HttpException(
                this.getPersistedPreviewFailureMessage(
                    previewPayload,
                    reasonDetails,
                    evidenceSummary,
                ),
                HttpStatus.BAD_REQUEST,
            );
        }

        return providerInteraction
            ? {
                  ...previewPayload,
                  providerInteraction,
              }
            : previewPayload;
    }

    private buildIdentityPreviewSignature(
        dto: Pick<
            DocumentPreviewDto,
            "documentType" | "imageFrontBase64" | "imageBackBase64"
        >,
    ): string {
        return createHash("sha256")
            .update(
                JSON.stringify({
                    documentType: dto.documentType ?? null,
                    imageFrontBase64: this.normalizeBase64ForSignature(
                        dto.imageFrontBase64,
                    ),
                    imageBackBase64: this.normalizeBase64ForSignature(
                        dto.imageBackBase64,
                    ),
                }),
            )
            .digest("hex");
    }

    private buildFilePreviewSignature(
        file: Pick<Express.Multer.File, "buffer" | "mimetype">,
        method: KycMethod,
    ): string {
        const hash = createHash("sha256");
        hash.update(method);
        hash.update(file.mimetype ?? "");
        hash.update(file.buffer);
        return hash.digest("hex");
    }

    private normalizeBase64ForSignature(value?: string | null): string | null {
        if (!value) {
            return null;
        }

        return this.readBase64DataUrl(value).payload.trim();
    }

    private readBase64DataUrl(value: string): {
        payload: string;
        mimeType: string | null;
    } {
        const marker = ";base64,";

        if (!value.startsWith("data:")) {
            return { payload: value, mimeType: null };
        }

        const markerIndex = value.toLowerCase().indexOf(marker);

        if (markerIndex < 0) {
            return { payload: value, mimeType: null };
        }

        const mimeType = value.slice("data:".length, markerIndex).trim();
        return {
            payload: value.slice(markerIndex + marker.length),
            mimeType: mimeType.length > 0 ? mimeType : null,
        };
    }

    private getPersistedPreviewFailureMessage(
        previewPayload: Record<string, unknown>,
        reasonDetails: Record<string, any> | null,
        evidenceSummary: Record<string, any> | null,
    ): string {
        const reasonMessage =
            typeof previewPayload.reasonMessage === "string" &&
            previewPayload.reasonMessage.trim()
                ? previewPayload.reasonMessage.trim()
                : null;

        if (reasonMessage) {
            return reasonMessage;
        }

        let previewMessage: string | null = null;

        if (
            typeof reasonDetails?.previewMessage === "string" &&
            reasonDetails.previewMessage.trim()
        ) {
            previewMessage = reasonDetails.previewMessage.trim();
        } else if (
            typeof evidenceSummary?.previewMessage === "string" &&
            evidenceSummary.previewMessage.trim()
        ) {
            previewMessage = evidenceSummary.previewMessage.trim();
        }

        return previewMessage || PREVIEW_REQUIRED_MESSAGE;
    }

    private buildSubmitResponse(attempt: KycStageAttempt) {
        const outcome = this.mapAttemptToSubmitOutcome(attempt.status);
        const extractedFields =
            attempt.extractedFields &&
            typeof attempt.extractedFields === "object" &&
            !Array.isArray(attempt.extractedFields)
                ? (attempt.extractedFields as Record<string, unknown>)
                : null;
        let autofillDocumentNumber: string | null = null;

        if (typeof extractedFields?.extractedDocumentNumber === "string") {
            autofillDocumentNumber = extractedFields.extractedDocumentNumber;
        } else if (typeof extractedFields?.documentNumber === "string") {
            autofillDocumentNumber = extractedFields.documentNumber;
        }

        return {
            attemptId: attempt.id,
            stage: attempt.stage,
            status: attempt.status,
            providerStatus: attempt.providerStatus,
            outcome,
            reasonCode: attempt.reasonCode,
            reasonMessage: attempt.reasonMessage,
            decisionMode: attempt.decisionMode,
            extractedFields: attempt.extractedFields,
            comparisonSummary: attempt.comparisonSummary,
            autofill: autofillDocumentNumber
                ? { documentNumber: autofillDocumentNumber }
                : null,
            nextAction: {
                type: this.getNextActionType(attempt.status),
                stage: attempt.stage,
                route: null,
                label: null,
            },
        };
    }

    private mapIdentityPreviewProviderStatus(
        isValid?: boolean,
        canSubmit?: boolean,
        hasExtractedText?: boolean,
    ): KycProviderStatus {
        if (isValid) {
            return KycProviderStatus.PASSED;
        }

        if (canSubmit || hasExtractedText) {
            return KycProviderStatus.INCONCLUSIVE;
        }

        return KycProviderStatus.FAILED;
    }

    private mapIdentityProviderStatus(userDocument: {
        verificationStatus: DocumentVerificationStatus;
        dojahVerified: boolean;
        dojahExtractedFirstName: string | null;
        dojahExtractedDocNumber: string | null;
    }): KycProviderStatus {
        if (
            userDocument.verificationStatus ===
            DocumentVerificationStatus.VERIFIED
        ) {
            return KycProviderStatus.PASSED;
        }

        if (
            userDocument.dojahVerified ||
            userDocument.dojahExtractedFirstName ||
            userDocument.dojahExtractedDocNumber
        ) {
            return KycProviderStatus.INCONCLUSIVE;
        }

        return KycProviderStatus.FAILED;
    }

    private mapDocumentTypeToMethod(documentType: DocumentType): KycMethod {
        switch (documentType) {
            case DocumentType.INTERNATIONAL_PASSPORT:
                return KycMethod.INTERNATIONAL_PASSPORT;
            case DocumentType.DRIVER_LICENSE:
                return KycMethod.DRIVER_LICENSE;
            case DocumentType.NIN:
                return KycMethod.NIN_SLIP;
            default:
                return KycMethod.OTHER;
        }
    }

    private mapLegacyStatus(status: KycStatus): KycAttemptStatus {
        switch (status) {
            case KycStatus.APPROVED:
                return KycAttemptStatus.APPROVED;
            case KycStatus.REJECTED:
                return KycAttemptStatus.REJECTED;
            case KycStatus.ESCALATED:
                return KycAttemptStatus.ESCALATED;
            case KycStatus.PENDING:
            default:
                return KycAttemptStatus.PENDING_REVIEW;
        }
    }

    private mapAttemptStatusToProviderStatus(
        status: KycAttemptStatus,
    ): KycProviderStatus {
        if (status === KycAttemptStatus.APPROVED) {
            return KycProviderStatus.PASSED;
        }

        if (
            status === KycAttemptStatus.REJECTED ||
            status === KycAttemptStatus.EXPIRED
        ) {
            return KycProviderStatus.FAILED;
        }

        return KycProviderStatus.INCONCLUSIVE;
    }

    private mapAttemptToSubmitOutcome(status: KycAttemptStatus): SubmitOutcome {
        switch (status) {
            case KycAttemptStatus.APPROVED:
                return "APPROVED";
            case KycAttemptStatus.REJECTED:
                return "REJECTED_HARD_STOP";
            default:
                return "UNDER_REVIEW";
        }
    }

    private getNextActionType(status: KycAttemptStatus): StageNextActionType {
        switch (status) {
            case KycAttemptStatus.APPROVED:
                return "COMPLETE";
            case KycAttemptStatus.REJECTED:
                return "RESUBMIT";
            case KycAttemptStatus.ESCALATED:
            case KycAttemptStatus.PENDING_REVIEW:
                return "WAIT";
            default:
                return "SUBMIT";
        }
    }

    private mapReasonCode(reason?: string | null): string | null {
        if (!reason) {
            return null;
        }

        const normalized = reason.trim().toUpperCase();

        if (normalized.includes("COUNTRY COULD NOT BE CONFIRMED AS NIGERIA")) {
            return "DOCUMENT_COUNTRY_NOT_CONFIRMED";
        }

        if (
            normalized.includes("ONLY NIGERIAN") ||
            normalized.includes("VALID NIGERIAN")
        ) {
            return "DOCUMENT_COUNTRY_NOT_NIGERIA";
        }

        if (normalized.includes("EXPIRED")) {
            return "DOCUMENT_EXPIRED";
        }

        if (
            normalized.includes("OLDER THAN 3 MONTHS") ||
            normalized.includes("LAST 3 MONTHS")
        ) {
            return "DOCUMENT_EXPIRED";
        }

        if (
            normalized.includes("COULD NOT BE VERIFIED") ||
            normalized.includes("ORIGINAL DOCUMENT")
        ) {
            return "DOCUMENT_INVALID";
        }

        if (normalized.includes("NAME")) {
            return "PROFILE_NAME_MISMATCH";
        }

        if (normalized.includes("DOB") || normalized.includes("BIRTH")) {
            return "PROFILE_DOB_MISMATCH";
        }

        if (
            normalized.includes("NOT_SUPPORTED") ||
            normalized.includes("UNSUPPORTED")
        ) {
            return "DOCUMENT_UNSUPPORTED";
        }

        if (normalized.includes("BANK STATEMENT")) {
            return "DOCUMENT_UNSUPPORTED";
        }

        if (normalized.includes("ADDRESS")) {
            return "ADDRESS_MISMATCH";
        }

        if (normalized.includes("INCOME")) {
            return "INCOME_VALIDATION_REVIEW";
        }

        return this.normalizeReasonCode(normalized) || "REVIEW_REQUIRED";
    }

    private normalizeReasonCode(value: string): string {
        let normalizedReasonCode = "";

        for (const character of value) {
            const codePoint = character.codePointAt(0) ?? 0;
            const isUpperAlpha = codePoint >= 65 && codePoint <= 90;
            const isDigit = codePoint >= 48 && codePoint <= 57;

            if (isUpperAlpha || isDigit) {
                normalizedReasonCode += character;
            } else if (
                normalizedReasonCode.length > 0 &&
                !normalizedReasonCode.endsWith("_")
            ) {
                normalizedReasonCode += "_";
            }
        }

        return normalizedReasonCode.endsWith("_")
            ? normalizedReasonCode.slice(0, -1)
            : normalizedReasonCode;
    }

    private getAddressPreviewProviderStatus(
        decision: PreviewDecision,
    ): KycProviderStatus {
        switch (decision) {
            case "APPROVE":
                return KycProviderStatus.PASSED;
            case "REJECT":
                return KycProviderStatus.FAILED;
            default:
                return KycProviderStatus.INCONCLUSIVE;
        }
    }

    private getAddressPreviewOutcome(
        decision: PreviewDecision,
    ): PreviewOutcome {
        switch (decision) {
            case "APPROVE":
                return "READY";
            case "REJECT":
                return "REJECT_LIKELY";
            default:
                return "REVIEW_LIKELY";
        }
    }

    private getAddressPreviewMessage(
        canSubmit: boolean,
        reason?: string | null,
    ): string {
        if (canSubmit) {
            return PREVIEW_READY_MESSAGE;
        }

        return reason || "Please upload a valid address verification document.";
    }

    private getIncomePreviewProviderStatus(
        decision: PreviewDecision,
    ): KycProviderStatus {
        switch (decision) {
            case "REVIEW":
                return KycProviderStatus.INCONCLUSIVE;
            case "REJECT":
                return KycProviderStatus.FAILED;
            default:
                return KycProviderStatus.PASSED;
        }
    }

    private getIncomePreviewOutcome(decision: PreviewDecision): PreviewOutcome {
        switch (decision) {
            case "REVIEW":
                return "REVIEW_LIKELY";
            case "REJECT":
                return "REJECT_LIKELY";
            default:
                return "READY";
        }
    }

    private getIncomePreviewMessage(
        canSubmit: boolean,
        reason?: string | null,
    ): string {
        if (canSubmit) {
            return PREVIEW_READY_MESSAGE;
        }

        return reason || "Please upload a valid income document.";
    }

    private buildIncomePreviewWarnings(params: {
        canSubmit: boolean;
        matchedName: boolean;
        isAllowedDocumentType?: boolean | null;
        countryConfirmed?: boolean | null;
        isRecent?: boolean | null;
        reason?: string | null;
    }): string[] {
        return this.buildWarnings([
            params.canSubmit
                ? null
                : params.reason || "Please upload a valid income document.",
            params.isAllowedDocumentType === false
                ? "Only bank statements are accepted for income verification."
                : null,
            params.countryConfirmed
                ? null
                : "The uploaded statement must be from a Nigerian bank.",
            params.matchedName
                ? null
                : "The statement name must match your profile.",
            params.isRecent
                ? null
                : "The statement must be dated within the last 3 months.",
            params.canSubmit
                ? "This statement can be submitted and will go to manual review."
                : null,
        ]);
    }

    private buildAddressPreviewWarnings(params: {
        outcome: PreviewOutcome;
        canSubmit: boolean;
        matchedName: boolean;
        matchedAddress: boolean;
        hasDocumentDate: boolean;
        reason?: string | null;
    }): string[] {
        const warnings: Array<string | null> = [
            params.canSubmit
                ? null
                : "Please upload a valid address verification document.",
            params.outcome === "REJECT_LIKELY"
                ? params.reason ||
                  "This upload appears likely to be declined if submitted."
                : null,
            params.outcome === "REVIEW_LIKELY"
                ? "This upload may still require manual review before a final decision can be made."
                : null,
            params.matchedName || params.outcome === "REJECT_LIKELY"
                ? null
                : "We could not confidently confirm your name from the uploaded document.",
            params.matchedAddress || params.outcome === "REJECT_LIKELY"
                ? null
                : "The upload did not clearly look like a proof-of-address document.",
            params.hasDocumentDate
                ? null
                : "We could not confirm a recent document date from the upload.",
        ];

        return this.buildWarnings(warnings);
    }

    private buildIdentityPreviewWarnings(
        previewData: Record<string, any>,
        canSubmit: boolean,
    ): string[] {
        return this.buildWarnings([
            previewData.hasPortrait
                ? null
                : "No portrait was detected in the uploaded document.",
            previewData.hasFrontSide
                ? null
                : "The document front side could not be confidently detected.",
            previewData.hasBackSide || !previewData.documentType
                ? null
                : "The document back side could not be confidently detected.",
            previewData.isValid || !canSubmit
                ? null
                : "This document can still be submitted, but reviewer intervention is likely.",
        ]);
    }

    private buildWarnings(values: Array<string | null | undefined>): string[] {
        return values.filter((value): value is string => Boolean(value));
    }

    private validateStageFile(file: Express.Multer.File): void {
        const validation = validateDocumentFile({
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size,
            originalname: file.originalname,
        });

        if (!validation.isValid) {
            throw new HttpException(
                validation.error || "Invalid file",
                HttpStatus.BAD_REQUEST,
            );
        }
    }

    private handleDocumentProcessingError(error: unknown): never {
        if (error instanceof OcrDocumentPreparationError) {
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }

        throw error;
    }

    private sha256FromBase64(value?: string): string | null {
        if (!value) {
            return null;
        }

        const cleanValue = this.readBase64DataUrl(value).payload;
        return this.sha256Buffer(Buffer.from(cleanValue, "base64"));
    }

    private sha256Buffer(value: Buffer): string {
        return createHash("sha256").update(value).digest("hex");
    }

    private detectBase64MimeType(value?: string): string {
        if (!value) {
            return "image/jpeg";
        }

        return this.readBase64DataUrl(value).mimeType ?? "image/jpeg";
    }

    private toPrismaJson(
        value: Record<string, unknown> | null,
    ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
        return value === null
            ? Prisma.DbNull
            : (value as Prisma.InputJsonValue);
    }

    private parseJsonString(value?: string | null): Record<string, any> | null {
        if (!value) {
            return null;
        }

        try {
            const parsed = JSON.parse(value);
            return this.asRecord(parsed);
        } catch (error) {
            this.logger.warn(
                `Failed to parse Dojah raw response for stage sync: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }

    private asRecord(value: unknown): Record<string, any> | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }

        return value as Record<string, any>;
    }

    private extractProviderInteraction(
        value: unknown,
    ): Record<string, unknown> | null {
        const source = this.asRecord(value);
        return this.asRecord(source?.providerInteraction);
    }

    private asString(value: unknown): string | null {
        return typeof value === "string" && value.trim().length > 0
            ? value
            : null;
    }

    private buildGovernmentExtractedFields(
        method: KycMethod,
        identifier: string | null,
        providerEntity: Record<string, any> | null,
    ): Record<string, unknown> | null {
        return this.pickDefinedFields({
            identifierType: method,
            identifier,
            firstName: this.asString(providerEntity?.first_name),
            lastName: this.asString(providerEntity?.last_name),
            dateOfBirth: this.asString(providerEntity?.date_of_birth),
            phoneNumber: this.getGovernmentProviderPhone(providerEntity),
        });
    }

    private buildGovernmentComparisonSummary(
        user: {
            firstName: string | null;
            lastName: string | null;
            dateOfBirth: Date | null;
        },
        providerEntity: Record<string, any> | null,
    ): Record<string, unknown> | null {
        return this.pickDefinedFields({
            expectedFirstName: user.firstName ?? null,
            expectedLastName: user.lastName ?? null,
            expectedDateOfBirth: this.formatDate(user.dateOfBirth),
            providerFirstName: this.asString(providerEntity?.first_name),
            providerLastName: this.asString(providerEntity?.last_name),
            providerDateOfBirth: this.asString(providerEntity?.date_of_birth),
            nameMatches: providerEntity
                ? this.normalizedEquals(
                      user.firstName,
                      providerEntity.first_name,
                  ) &&
                  this.normalizedEquals(user.lastName, providerEntity.last_name)
                : null,
            dobMatches: providerEntity
                ? this.sameDate(user.dateOfBirth, providerEntity.date_of_birth)
                : null,
        });
    }

    private getGovernmentProviderPhone(
        providerEntity: Record<string, any> | null,
    ): string | null {
        return (
            this.asString(providerEntity?.phone_number1) ??
            this.asString(providerEntity?.phone_number)
        );
    }

    private getGovernmentRejectedMessage(method: KycMethod): string {
        return `${method === KycMethod.BVN ? "BVN" : "NIN"} verification was declined`;
    }

    private getRejectedReasonMessage(
        status: KycAttemptStatus,
        fallback: string,
    ): string | null {
        return status === KycAttemptStatus.REJECTED ? fallback : null;
    }

    private buildAddressComparisonSummary(
        user: {
            firstName: string | null;
            lastName: string | null;
            residentialAddress: string | null;
        },
        providerRaw: Record<string, any> | null,
    ): Record<string, unknown> | null {
        return this.pickDefinedFields({
            expectedName: this.buildDisplayName(user.firstName, user.lastName),
            expectedAddress: user.residentialAddress ?? null,
            matchedName: providerRaw?.matchedName ?? null,
            matchedAddress: providerRaw?.matchedAddress ?? null,
            matchedResidentialAddress:
                providerRaw?.matchedResidentialAddress ?? null,
            residentialAddressPresent: user.residentialAddress ? true : null,
            confidence: providerRaw?.confidence ?? null,
            reason: this.asString(providerRaw?.reason),
        });
    }

    private buildIncomeComparisonSummary(
        user: { firstName: string | null; lastName: string | null },
        providerRaw: Record<string, any> | null,
    ): Record<string, unknown> | null {
        return this.pickDefinedFields({
            expectedName: this.buildDisplayName(user.firstName, user.lastName),
            matchedName: providerRaw?.matchedName ?? null,
            confidence: providerRaw?.confidence ?? null,
            requiresManualReview: providerRaw?.requiresManualReview ?? null,
            reason: this.asString(providerRaw?.reason),
        });
    }

    private buildLegacyDocumentEvidenceSummary(
        evidenceAssets: EvidenceAssetInput[],
        mimeType: string,
        documentUrl?: string | null,
    ): Record<string, unknown> | null {
        return this.pickDefinedFields({
            assetCount: evidenceAssets.length,
            mimeType,
            documentUrl: documentUrl ?? null,
        });
    }

    private buildDisplayName(
        firstName?: string | null,
        lastName?: string | null,
    ): string | null {
        const value = [firstName, lastName]
            .filter((item): item is string => Boolean(item?.trim()))
            .join(" ")
            .trim();
        return value.length > 0 ? value : null;
    }

    private pickDefinedFields(
        value: Record<string, unknown>,
    ): Record<string, unknown> | null {
        const entries = Object.entries(value).filter(
            ([, item]) => item !== undefined,
        );
        return entries.length > 0 ? Object.fromEntries(entries) : null;
    }

    private normalizedEquals(
        left?: string | null,
        right?: string | null,
    ): boolean | null {
        if (!left || !right) {
            return null;
        }

        return left.trim().toLowerCase() === right.trim().toLowerCase();
    }

    private sameDate(
        date: Date | null | undefined,
        value?: string | null,
    ): boolean | null {
        if (!date || !value) {
            return null;
        }

        return this.formatDate(date) === value;
    }

    private formatDate(date: Date | null | undefined): string | null {
        if (!date) {
            return null;
        }

        return date.toISOString().slice(0, 10);
    }
}
