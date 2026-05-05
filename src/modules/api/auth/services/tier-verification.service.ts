/**
 * Tier Verification Service
 * Handles Tier 2/3 verification flows: address and income verification
 */

import {
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    forwardRef,
} from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    DocumentVerificationStatus,
    KycAttemptStatus,
    KycDecisionMode,
    KycEvidenceKind,
    KycEvidenceSide,
    KycMethod,
    KycProviderName,
    KycProviderStatus,
    KycStage,
    Prisma,
    User,
} from "@prisma/client";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { UploadFactory } from "@/modules/core/upload/services";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import {
    storageDirConfig,
    emailTemplateConfig,
    COMPANY_NAME,
    mailConfig,
} from "@/config";
import { generateRandomNum } from "@/utils";
import { EmailService } from "@/modules/core/email/services";
import {
    isPdfFile,
    validateDocumentFile,
} from "@/core/validators/file-validator";
import {
    OcrDocumentPreparationError,
    validateAddressDocument,
    validateIncomeDocument,
} from "@/libs/ocr";
import { CreateTradingPasswordDto } from "../dtos";
import type { AuthService } from "./index";
import { TierService } from "./tier.service";
import * as bcrypt from "bcryptjs";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { buildIndividualVerificationSnapshot } from "../utils/individual-kyc-stage-state.util";

type DocumentType = "address" | "income" | "business";

type StageManagedVerificationState = {
    documentVerified: boolean;
    addressVerified: boolean;
    incomeVerified: boolean;
    documentStatus: DocumentVerificationStatus | null;
    addressStatus: DocumentVerificationStatus | null;
    incomeStatus: DocumentVerificationStatus | null;
};

@Injectable()
export class TierVerificationService {
    private readonly logger = new Logger(TierVerificationService.name);
    private readonly uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;

    constructor(
        private readonly prisma: PrismaService,
        private readonly uploadFactory: UploadFactory,
        private readonly tierService: TierService,
        private readonly emailService: EmailService,
        @Inject(forwardRef(() => NotificationDispatcher))
        private readonly notificationDispatcher: NotificationDispatcher,
        @Inject(forwardRef(() => WsGateway))
        private readonly wsGateway: WsGateway,
        @Inject("AUTH_SERVICE")
        private readonly authService: AuthService,
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    private buildStageManagedVerificationState(source: {
        kycStageAttempts?: Array<{
            stage: string;
            method?: string | null;
            status?: string | null;
            isCurrent?: boolean;
        }> | null;
    }): StageManagedVerificationState {
        const verificationSnapshot = buildIndividualVerificationSnapshot({
            kycStageAttempts: source.kycStageAttempts,
        });

        return {
            documentVerified: verificationSnapshot.documentVerified,
            addressVerified:
                verificationSnapshot.addressStatus ===
                DocumentVerificationStatus.VERIFIED,
            incomeVerified:
                verificationSnapshot.incomeStatus ===
                DocumentVerificationStatus.VERIFIED,
            documentStatus: verificationSnapshot.documentStatus,
            addressStatus: verificationSnapshot.addressStatus,
            incomeStatus: verificationSnapshot.incomeStatus,
        };
    }

    private async getStageManagedVerificationState(
        user: Pick<User, "id">,
    ): Promise<StageManagedVerificationState> {
        const stageManagedState = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                kycStageAttempts: {
                    where: {
                        journeyType: "INDIVIDUAL",
                        stage: {
                            in: [
                                KycStage.IDENTITY_DOCUMENT,
                                KycStage.ADDRESS,
                                KycStage.INCOME,
                            ],
                        },
                        isCurrent: true,
                    },
                    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                    select: {
                        stage: true,
                        method: true,
                        status: true,
                        isCurrent: true,
                    },
                },
            },
        });

        return this.buildStageManagedVerificationState(stageManagedState ?? {});
    }

    private mapIndividualAttemptReasonCode(
        reason?: string | null,
    ): string | null {
        if (!reason) {
            return null;
        }

        const normalized = reason.trim().toUpperCase();

        if (normalized.includes("EXPIRED")) {
            return "DOCUMENT_EXPIRED";
        }

        if (
            normalized.includes("NOT_SUPPORTED") ||
            normalized.includes("UNSUPPORTED")
        ) {
            return "DOCUMENT_UNSUPPORTED";
        }

        if (normalized.includes("NAME")) {
            return "PROFILE_NAME_MISMATCH";
        }

        if (normalized.includes("DOB") || normalized.includes("BIRTH")) {
            return "PROFILE_DOB_MISMATCH";
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

    private async createCurrentIndividualStageAttempt(input: {
        userId: number;
        stage: KycStage;
        method: KycMethod;
        status: KycAttemptStatus;
        providerStatus: KycProviderStatus;
        decisionMode: KycDecisionMode;
        reasonMessage?: string | null;
        reasonDetails?: Prisma.InputJsonValue | null;
        comparisonSummary?: Prisma.InputJsonValue | null;
        evidenceSummary?: Prisma.InputJsonValue | null;
        evidenceAssets: Array<{
            kind: KycEvidenceKind;
            storageUrl: string;
            storageFieldId?: string | null;
            originalName?: string | null;
            mimeType: string;
            side?: KycEvidenceSide | null;
        }>;
    }): Promise<void> {
        const attemptAggregate = await this.prisma.kycStageAttempt.aggregate({
            where: {
                userId: input.userId,
                stage: input.stage,
            },
            _max: { attemptNo: true },
        });

        const currentAttempts = await this.prisma.kycStageAttempt.findMany({
            where: {
                userId: input.userId,
                stage: input.stage,
                isCurrent: true,
            },
            select: { id: true },
        });

        if (currentAttempts.length > 0) {
            await this.prisma.$transaction(
                currentAttempts.map((attempt) =>
                    this.prisma.kycStageAttempt.update({
                        where: { id: attempt.id },
                        data: { isCurrent: false },
                    }),
                ),
            );
        }

        await this.prisma.kycStageAttempt.create({
            data: {
                userId: input.userId,
                stage: input.stage,
                method: input.method,
                attemptNo: (attemptAggregate._max.attemptNo ?? 0) + 1,
                isCurrent: true,
                status: input.status,
                providerName: KycProviderName.OCR,
                providerStatus: input.providerStatus,
                decisionMode: input.decisionMode,
                reasonCode: this.mapIndividualAttemptReasonCode(
                    input.reasonMessage,
                ),
                reasonMessage: input.reasonMessage ?? null,
                reasonDetails: input.reasonDetails ?? undefined,
                comparisonSummary: input.comparisonSummary ?? undefined,
                evidenceSummary: input.evidenceSummary ?? undefined,
                reviewedAt:
                    input.status === KycAttemptStatus.APPROVED
                        ? new Date()
                        : null,
                evidenceAssets: {
                    create: input.evidenceAssets.map((asset) => ({
                        kind: asset.kind,
                        storageUrl: asset.storageUrl,
                        storageFieldId: asset.storageFieldId ?? null,
                        originalName: asset.originalName ?? null,
                        mimeType: asset.mimeType,
                        side: asset.side ?? null,
                    })),
                },
            },
        });
    }

    private async updateCurrentIndividualStageAttempt(
        userId: number,
        stage: KycStage,
        status: KycAttemptStatus,
        reasonMessage?: string,
    ): Promise<void> {
        const currentAttempt = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId,
                journeyType: "INDIVIDUAL",
                stage,
                isCurrent: true,
            },
            orderBy: [
                { attemptNo: "desc" },
                { updatedAt: "desc" },
                { id: "desc" },
            ],
            select: { id: true },
        });

        if (!currentAttempt) {
            return;
        }

        let providerStatus: KycProviderStatus = KycProviderStatus.INCONCLUSIVE;

        if (status === KycAttemptStatus.APPROVED) {
            providerStatus = KycProviderStatus.PASSED;
        } else if (status === KycAttemptStatus.REJECTED) {
            providerStatus = KycProviderStatus.FAILED;
        }

        await this.prisma.kycStageAttempt.update({
            where: { id: currentAttempt.id },
            data: {
                status,
                providerStatus,
                decisionMode: KycDecisionMode.MANUAL,
                reasonCode: this.mapIndividualAttemptReasonCode(reasonMessage),
                reasonMessage: reasonMessage ?? null,
                reasonDetails: reasonMessage
                    ? { reason: reasonMessage }
                    : undefined,
                reviewedAt:
                    status === KycAttemptStatus.APPROVED ||
                    status === KycAttemptStatus.REJECTED
                        ? new Date()
                        : null,
                version: { increment: 1 },
            },
        });
    }

    private ensureAddressVerificationPrerequisites(
        verificationState: Pick<
            StageManagedVerificationState,
            "documentVerified" | "documentStatus"
        >,
    ): void {
        if (verificationState.documentVerified) {
            return;
        }

        if (
            verificationState.documentStatus ===
            DocumentVerificationStatus.PENDING
        ) {
            throw new HttpException(
                "Document verification is pending review",
                HttpStatus.BAD_REQUEST,
            );
        }

        throw new HttpException(
            "Complete identity document verification before submitting address verification.",
            HttpStatus.FORBIDDEN,
        );
    }

    private ensureIncomeVerificationPrerequisites(
        verificationState: StageManagedVerificationState,
    ): void {
        if (verificationState.addressVerified) {
            return;
        }

        if (
            verificationState.addressStatus ===
            DocumentVerificationStatus.PENDING
        ) {
            throw new HttpException(
                "Address verification is pending review",
                HttpStatus.BAD_REQUEST,
            );
        }

        throw new HttpException(
            "Complete address verification before submitting income verification.",
            HttpStatus.FORBIDDEN,
        );
    }

    private buildAddressPendingReviewResponse(
        reason?: string | null,
    ): ApiResponse {
        return buildResponse({
            message: "Address verification is pending review",
            data: {
                status: "PENDING",
                reason: reason ?? null,
            },
        });
    }

    private async queueAddressPendingReview(params: {
        user: User;
        method: KycMethod;
        providerStatus: KycProviderStatus;
        reasonMessage?: string | null;
        responseReason?: string | null;
        reasonDetails: Prisma.InputJsonValue;
        comparisonSummary: Prisma.InputJsonValue;
        evidenceSummary: Prisma.InputJsonValue;
        evidenceAssets: Array<{
            kind: KycEvidenceKind;
            storageUrl: string;
            storageFieldId?: string | null;
            originalName?: string | null;
            mimeType: string;
            side?: KycEvidenceSide | null;
        }>;
    }): Promise<ApiResponse> {
        await this.createCurrentIndividualStageAttempt({
            userId: params.user.id,
            stage: KycStage.ADDRESS,
            method: params.method,
            status: KycAttemptStatus.PENDING_REVIEW,
            providerStatus: params.providerStatus,
            decisionMode: KycDecisionMode.MANUAL,
            reasonMessage: params.reasonMessage ?? null,
            reasonDetails: params.reasonDetails,
            comparisonSummary: params.comparisonSummary,
            evidenceSummary: params.evidenceSummary,
            evidenceAssets: params.evidenceAssets,
        });

        await this.tierService.syncTierAndCache(params.user.id);

        await this.notificationDispatcher.notify({
            userId: params.user.id,
            title: "Document Submitted",
            body: "Your address document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });

        if (params.user.email && emailTemplateConfig.document_pending_review) {
            this.emailService
                .sendMailWithTemplate({
                    from: { address: mailConfig.senderMail },
                    to: [{ email_address: { address: params.user.email } }],
                    template_key: emailTemplateConfig.document_pending_review,
                    merge_info: {
                        name: params.user.firstName || "User",
                        document_type: "Address Document",
                        company_name: COMPANY_NAME,
                    },
                })
                .catch((e) =>
                    this.logger.error(
                        `[KYC][ADDRESS] Failed to send pending review email for user ${params.user.id}: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                );
        }

        return this.buildAddressPendingReviewResponse(
            params.responseReason ?? params.reasonMessage ?? null,
        );
    }

    async verifyAddressFromPreview(
        user: User,
        file: Express.Multer.File,
        method: KycMethod,
        previewPayload: Record<string, unknown>,
    ): Promise<ApiResponse> {
        return this.verifyAddress(user, file, method, previewPayload);
    }

    async verifyIncomeFromPreview(
        user: User,
        file: Express.Multer.File,
        method: KycMethod,
        previewPayload: Record<string, unknown>,
    ): Promise<ApiResponse> {
        return this.verifyIncome(user, file, method, previewPayload);
    }

    private buildAddressValidationResultFromPreview(
        previewPayload: Record<string, unknown>,
    ) {
        const comparisonSummary = this.readJsonObject(
            previewPayload.comparisonSummary,
        );
        const decision = this.resolvePreviewDecision(
            comparisonSummary?.decision,
            previewPayload.outcome,
            previewPayload.providerStatus,
        );

        return {
            confidence: this.readNumberValue(comparisonSummary?.confidence),
            matchedName: comparisonSummary?.matchedName === true,
            matchedAddress: comparisonSummary?.matchedAddress === true,
            matchedResidentialAddress:
                comparisonSummary?.matchedResidentialAddress === true,
            addressDocumentType: this.readStringValue(
                comparisonSummary?.addressDocumentType,
            ),
            isAllowedDocumentType: this.readBooleanValue(
                comparisonSummary?.isAllowedDocumentType,
            ),
            providerVerified: this.readBooleanValue(
                comparisonSummary?.providerVerified,
            ),
            providerReason: this.readStringValue(
                comparisonSummary?.providerReason,
            ),
            providerDocumentType: this.readStringValue(
                comparisonSummary?.providerDocumentType,
            ),
            providerNameMatches: this.readBooleanValue(
                comparisonSummary?.providerNameMatches,
            ),
            providerDocumentDate: this.readStringValue(
                comparisonSummary?.providerDocumentDate,
            ),
            providerCountry: this.readStringValue(
                comparisonSummary?.providerCountry,
            ),
            providerCountryCode: this.readStringValue(
                comparisonSummary?.providerCountryCode,
            ),
            documentDate: this.readStringValue(comparisonSummary?.documentDate),
            isRecent: this.readBooleanValue(comparisonSummary?.isRecent),
            countryConfirmed: this.readBooleanValue(
                comparisonSummary?.countryConfirmed,
            ),
            requiresManualReview: decision === "REVIEW",
            decision,
            reason: this.readPreviewReasonMessage(previewPayload),
        };
    }

    private buildIncomeValidationResultFromPreview(
        previewPayload: Record<string, unknown>,
    ) {
        const comparisonSummary = this.readJsonObject(
            previewPayload.comparisonSummary,
        );
        const decision = this.resolvePreviewDecision(
            comparisonSummary?.decision,
            previewPayload.outcome,
            previewPayload.providerStatus,
        );

        return {
            confidence: this.readNumberValue(comparisonSummary?.confidence),
            matchedName: comparisonSummary?.matchedName === true,
            incomeDocumentType: this.readStringValue(
                comparisonSummary?.incomeDocumentType,
            ),
            isAllowedDocumentType: this.readBooleanValue(
                comparisonSummary?.isAllowedDocumentType,
            ),
            countryConfirmed: this.readBooleanValue(
                comparisonSummary?.countryConfirmed,
            ),
            isRecent: this.readBooleanValue(comparisonSummary?.isRecent),
            providerVerified: this.readBooleanValue(
                comparisonSummary?.providerVerified,
            ),
            providerReason: this.readStringValue(
                comparisonSummary?.providerReason,
            ),
            providerDocumentType: this.readStringValue(
                comparisonSummary?.providerDocumentType,
            ),
            providerNameMatches: this.readBooleanValue(
                comparisonSummary?.providerNameMatches,
            ),
            documentDate: this.readStringValue(comparisonSummary?.documentDate),
            requiresManualReview: decision === "REVIEW",
            decision,
            reason: this.readPreviewReasonMessage(previewPayload),
        };
    }

    private resolvePreviewDecision(
        rawDecision: unknown,
        outcome: unknown,
        providerStatus: unknown,
    ): "APPROVE" | "REJECT" | "REVIEW" {
        const normalizedDecision =
            typeof rawDecision === "string"
                ? rawDecision.trim().toUpperCase()
                : "";
        let previewDecision: "APPROVE" | "REJECT" | "REVIEW" | null = null;

        if (
            normalizedDecision === "APPROVE" ||
            normalizedDecision === "REJECT" ||
            normalizedDecision === "REVIEW"
        ) {
            previewDecision = normalizedDecision;
        }

        if (previewDecision) {
            return previewDecision;
        }

        const normalizedOutcome =
            typeof outcome === "string" ? outcome.trim().toUpperCase() : "";

        if (normalizedOutcome === "READY") {
            return "APPROVE";
        }

        if (normalizedOutcome === "REJECT_LIKELY") {
            return "REJECT";
        }

        if (normalizedOutcome === "REVIEW_LIKELY") {
            return "REVIEW";
        }

        const normalizedProviderStatus =
            typeof providerStatus === "string"
                ? providerStatus.trim().toUpperCase()
                : "";

        if (normalizedProviderStatus === KycProviderStatus.FAILED) {
            return "REJECT";
        }

        if (normalizedProviderStatus === KycProviderStatus.PASSED) {
            return "APPROVE";
        }

        return "REVIEW";
    }

    private readPreviewReasonMessage(
        previewPayload: Record<string, unknown>,
    ): string | null {
        return (
            this.readStringValue(previewPayload.reasonMessage) ??
            this.readStringValue(previewPayload.message) ??
            null
        );
    }

    private isJsonObject(value: unknown): value is Record<string, any> {
        return (
            Boolean(value) && typeof value === "object" && !Array.isArray(value)
        );
    }

    private readJsonObject(value: unknown): Record<string, any> | null {
        if (!this.isJsonObject(value)) {
            return null;
        }

        return value;
    }

    private readStringValue(value: unknown): string | null {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    private readBooleanValue(value: unknown): boolean | null {
        return typeof value === "boolean" ? value : null;
    }

    private readNumberValue(value: unknown): number | null {
        return typeof value === "number" && Number.isFinite(value)
            ? value
            : null;
    }

    private buildDocumentEvidence(
        file: Express.Multer.File,
        documentUrl: string,
    ) {
        const isPdf = file.mimetype === "application/pdf";

        return {
            evidenceSummary: {
                documentUrl,
                mimeType: file.mimetype,
                originalName: file.originalname,
            },
            evidenceAssets: [
                {
                    kind: isPdf
                        ? KycEvidenceKind.PDF
                        : KycEvidenceKind.FRONT_IMAGE,
                    storageUrl: documentUrl,
                    mimeType: file.mimetype,
                    originalName: file.originalname,
                    side: isPdf ? null : KycEvidenceSide.FRONT,
                },
            ],
        };
    }

    private resolveAddressDecision(ocrResult: {
        decision?: string | null;
        requiresManualReview?: boolean | null;
    }): string {
        return (
            ocrResult.decision ??
            (ocrResult.requiresManualReview ? "REVIEW" : "APPROVE")
        );
    }

    private resolveIncomeDecision(ocrResult: {
        decision?: string | null;
        requiresManualReview?: boolean | null;
    }): string {
        return (
            ocrResult.decision ??
            (ocrResult.requiresManualReview ? "REVIEW" : "REJECT")
        );
    }

    /**
     * Upload and validate address document for Tier 2 verification
     */
    async verifyAddress(
        user: User,
        file: Express.Multer.File,
        method?: KycMethod,
        previewPayload?: Record<string, unknown>,
    ): Promise<ApiResponse> {
        const resolvedMethod = method ?? KycMethod.OTHER;
        const verificationState =
            await this.getStageManagedVerificationState(user);

        // Check if already verified
        if (verificationState.addressVerified) {
            return buildResponse({
                message: "Address is already verified",
            });
        }

        this.ensureAddressVerificationPrerequisites(verificationState);

        // Block re-submission while a review is already in progress
        if (
            verificationState.addressStatus ===
            DocumentVerificationStatus.PENDING
        ) {
            return this.buildAddressPendingReviewResponse();
        }

        // Validate file
        const fileValidation = validateDocumentFile({
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size,
            originalname: file.originalname,
        });

        if (!fileValidation.isValid) {
            throw new HttpException(
                fileValidation.error || "Invalid file",
                HttpStatus.BAD_REQUEST,
            );
        }

        // Upload document
        const uploadResult = await this.uploadDocument(file, "address");
        const documentUrl = uploadResult.url;
        let providerSignals: Record<string, any> | null = null;

        const ocrResult = previewPayload
            ? this.buildAddressValidationResultFromPreview(previewPayload)
            : await (async () => {
                  providerSignals =
                      (await this.authService.analyzeAddressDocumentSignals(
                          user,
                          file,
                      )) as Record<string, any> | null;

                  return validateAddressDocument(
                      file.buffer,
                      user.firstName || "",
                      user.lastName || "",
                      user.residentialAddress || null,
                      file.mimetype,
                      providerSignals,
                  ).catch((error: unknown) =>
                      this.handleDocumentProcessingError(error),
                  );
              })();
        const providerInteraction = this.readJsonObject(
            previewPayload
                ? previewPayload.providerInteraction
                : providerSignals?.providerInteraction,
        );
        const decision = this.resolveAddressDecision(ocrResult);

        this.logger.log(
            `Address OCR result for user ${user.id}: confidence=${ocrResult.confidence}, matchedName=${ocrResult.matchedName}, matchedAddress=${ocrResult.matchedAddress}, matchedResidentialAddress=${ocrResult.matchedResidentialAddress}, isRecent=${ocrResult.isRecent}, decision=${decision}`,
        );
        const { evidenceSummary, evidenceAssets } = this.buildDocumentEvidence(
            file,
            documentUrl,
        );
        const comparisonSummary = {
            matchedName: ocrResult.matchedName,
            matchedAddress: ocrResult.matchedAddress,
            matchedResidentialAddress: ocrResult.matchedResidentialAddress,
            residentialAddressPresent: Boolean(user.residentialAddress),
            countryConfirmed: ocrResult.countryConfirmed ?? null,
            providerDocumentType: ocrResult.providerDocumentType ?? null,
            providerNameMatches: ocrResult.providerNameMatches ?? null,
            providerDocumentDate: ocrResult.providerDocumentDate ?? null,
            providerCountry: ocrResult.providerCountry ?? null,
            providerCountryCode: ocrResult.providerCountryCode ?? null,
            confidence: ocrResult.confidence,
            documentDate: ocrResult.documentDate ?? null,
            isRecent: ocrResult.isRecent ?? null,
            decision,
        };
        const reasonDetails = {
            confidence: ocrResult.confidence,
            matchedName: ocrResult.matchedName,
            matchedAddress: ocrResult.matchedAddress,
            matchedResidentialAddress: ocrResult.matchedResidentialAddress,
            residentialAddressPresent: Boolean(user.residentialAddress),
            countryConfirmed: ocrResult.countryConfirmed ?? null,
            providerDocumentType: ocrResult.providerDocumentType ?? null,
            providerNameMatches: ocrResult.providerNameMatches ?? null,
            providerDocumentDate: ocrResult.providerDocumentDate ?? null,
            providerCountry: ocrResult.providerCountry ?? null,
            providerCountryCode: ocrResult.providerCountryCode ?? null,
            documentDate: ocrResult.documentDate ?? null,
            isRecent: ocrResult.isRecent ?? null,
            decision,
            ...(providerInteraction ? { providerInteraction } : {}),
        };

        if (decision === "REVIEW") {
            return this.queueAddressPendingReview({
                user,
                method: resolvedMethod,
                providerStatus: KycProviderStatus.INCONCLUSIVE,
                reasonMessage: ocrResult.reason || null,
                responseReason: ocrResult.reason || null,
                reasonDetails,
                comparisonSummary,
                evidenceSummary,
                evidenceAssets,
            });
        }

        if (decision === "REJECT") {
            const rejectionReason =
                ocrResult.reason || "Address verification was rejected.";

            await this.createCurrentIndividualStageAttempt({
                userId: user.id,
                stage: KycStage.ADDRESS,
                method: resolvedMethod,
                status: KycAttemptStatus.REJECTED,
                providerStatus: KycProviderStatus.FAILED,
                decisionMode: KycDecisionMode.AUTO,
                reasonMessage: rejectionReason,
                reasonDetails,
                comparisonSummary,
                evidenceSummary,
                evidenceAssets,
            });

            await this.tierService.syncTierAndCache(user.id);

            if (user.email && emailTemplateConfig.document_rejected) {
                this.emailService
                    .sendMailWithTemplate({
                        from: { address: mailConfig.senderMail },
                        to: [{ email_address: { address: user.email } }],
                        template_key: emailTemplateConfig.document_rejected,
                        merge_info: {
                            first_name: user.firstName || "User",
                            document_type: "Address",
                            company_name: COMPANY_NAME,
                            rejection_reason: rejectionReason,
                            status: "Rejected",
                        },
                    })
                    .catch((e) =>
                        this.logger.error(
                            `[KYC][ADDRESS] Failed to send rejection email for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`,
                        ),
                    );
            }

            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Address Verification Rejected",
                body: rejectionReason,
                category: "security",
                enablePush: true,
            });

            this.wsGateway.notifyProfileUpdate(user.id);

            return buildResponse({
                message: rejectionReason,
                data: {
                    status: "REJECTED",
                    reason: rejectionReason,
                },
            });
        }

        return this.queueAddressPendingReview({
            user,
            method: resolvedMethod,
            providerStatus: KycProviderStatus.PASSED,
            reasonMessage:
                "Address document passed automated checks and is pending manual review.",
            responseReason: null,
            reasonDetails,
            comparisonSummary,
            evidenceSummary,
            evidenceAssets,
        });
    }

    /**
     * Upload and validate income document for Tier 3 verification
     */
    async verifyIncome(
        user: User,
        file: Express.Multer.File,
        method?: KycMethod,
        previewPayload?: Record<string, unknown>,
    ): Promise<ApiResponse> {
        const resolvedMethod = method ?? KycMethod.OTHER;
        const verificationState =
            await this.getStageManagedVerificationState(user);

        // Check if already verified
        if (verificationState.incomeVerified) {
            return buildResponse({
                message: "Income is already verified",
            });
        }

        this.ensureIncomeVerificationPrerequisites(verificationState);

        // Validate file
        const fileValidation = validateDocumentFile({
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size,
            originalname: file.originalname,
        });

        if (!fileValidation.isValid) {
            throw new HttpException(
                fileValidation.error || "Invalid file",
                HttpStatus.BAD_REQUEST,
            );
        }

        // Upload document
        const uploadResult = await this.uploadDocument(file, "income");
        const documentUrl = uploadResult.url;
        let providerSignals: Record<string, any> | null = null;

        const ocrResult = previewPayload
            ? this.buildIncomeValidationResultFromPreview(previewPayload)
            : await (async () => {
                  providerSignals =
                      (await this.authService.analyzeIncomeDocumentSignals(
                          user,
                          file,
                      )) as Record<string, any> | null;

                  return validateIncomeDocument(
                      file.buffer,
                      user.firstName || "",
                      user.lastName || "",
                      file.mimetype,
                      providerSignals,
                  ).catch((error: unknown) =>
                      this.handleDocumentProcessingError(error),
                  );
              })();
        const providerInteraction = this.readJsonObject(
            previewPayload
                ? previewPayload.providerInteraction
                : providerSignals?.providerInteraction,
        );
        const decision = this.resolveIncomeDecision(ocrResult);

        this.logger.log(
            `Income OCR result for user ${user.id}: confidence=${ocrResult.confidence}, matchedName=${ocrResult.matchedName}, isRecent=${ocrResult.isRecent}, countryConfirmed=${ocrResult.countryConfirmed}, isAllowedDocumentType=${ocrResult.isAllowedDocumentType}, decision=${decision}`,
        );
        const { evidenceSummary, evidenceAssets } = this.buildDocumentEvidence(
            file,
            documentUrl,
        );
        const comparisonSummary = {
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
        };
        const reasonDetails = {
            confidence: ocrResult.confidence,
            matchedName: ocrResult.matchedName,
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
            ...(providerInteraction ? { providerInteraction } : {}),
        };

        if (decision === "REJECT") {
            const rejectionReason =
                ocrResult.reason || "Income verification was rejected.";

            await this.createCurrentIndividualStageAttempt({
                userId: user.id,
                stage: KycStage.INCOME,
                method: resolvedMethod,
                status: KycAttemptStatus.REJECTED,
                providerStatus: KycProviderStatus.FAILED,
                decisionMode: KycDecisionMode.AUTO,
                reasonMessage: rejectionReason,
                reasonDetails,
                comparisonSummary,
                evidenceSummary,
                evidenceAssets,
            });

            await this.tierService.syncTierAndCache(user.id);

            if (user.email && emailTemplateConfig.document_rejected) {
                this.emailService
                    .sendMailWithTemplate({
                        from: { address: mailConfig.senderMail },
                        to: [{ email_address: { address: user.email } }],
                        template_key: emailTemplateConfig.document_rejected,
                        merge_info: {
                            first_name: user.firstName || "User",
                            document_type: "Income",
                            company_name: COMPANY_NAME,
                            rejection_reason: rejectionReason,
                            status: "Rejected",
                        },
                    })
                    .catch((e) =>
                        this.logger.error(
                            `[KYC][INCOME] Failed to send rejection email for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`,
                        ),
                    );
            }

            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Income Verification Rejected",
                body: rejectionReason,
                category: "security",
                enablePush: true,
            });

            this.wsGateway.notifyProfileUpdate(user.id);

            return buildResponse({
                message: rejectionReason,
                data: {
                    status: "REJECTED",
                    reason: rejectionReason,
                },
            });
        }

        if (decision === "REVIEW") {
            const pendingReviewReason =
                "Your bank statement passed automated checks and is pending manual review.";

            await this.createCurrentIndividualStageAttempt({
                userId: user.id,
                stage: KycStage.INCOME,
                method: resolvedMethod,
                status: KycAttemptStatus.PENDING_REVIEW,
                providerStatus: KycProviderStatus.INCONCLUSIVE,
                decisionMode: KycDecisionMode.MANUAL,
                reasonMessage: pendingReviewReason,
                reasonDetails,
                comparisonSummary,
                evidenceSummary,
                evidenceAssets,
            });

            await this.tierService.syncTierAndCache(user.id);

            // In-app notification for pending review
            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Document Submitted",
                body: "Your bank statement has been submitted for review. We'll notify you once it's processed.",
                category: "security",
            });

            // Email notification for pending review
            if (user.email && emailTemplateConfig.document_pending_review) {
                this.emailService
                    .sendMailWithTemplate({
                        from: { address: mailConfig.senderMail },
                        to: [{ email_address: { address: user.email } }],
                        template_key:
                            emailTemplateConfig.document_pending_review,
                        merge_info: {
                            name: user.firstName || "User",
                            document_type: "Bank Statement",
                            company_name: COMPANY_NAME,
                        },
                    })
                    .catch((e) =>
                        this.logger.error(
                            `[KYC][INCOME] Failed to send pending review email for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`,
                        ),
                    );
            }

            return buildResponse({
                message: pendingReviewReason,
                data: {
                    status: "PENDING",
                    reason: pendingReviewReason,
                },
            });
        }

        return buildResponse({
            message:
                "Your bank statement passed automated checks and is pending manual review.",
            data: {
                status: "PENDING",
                reason: "Your bank statement passed automated checks and is pending manual review.",
            },
        });
    }

    /**
     * Create or update trading password
     */
    async createTradingPassword(
        user: User,
        dto: CreateTradingPasswordDto,
    ): Promise<ApiResponse> {
        if (dto.tradingPassword !== dto.confirmTradingPassword) {
            throw new HttpException(
                "Passwords do not match",
                HttpStatus.BAD_REQUEST,
            );
        }

        const hashedPassword = await bcrypt.hash(
            dto.tradingPassword,
            this.SALT_ROUNDS,
        );

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                tradingPassword: hashedPassword,
            },
        });

        this.logger.log(`Trading password created for user ${user.id}`);

        return buildResponse({
            message: "Trading password created successfully",
        });
    }

    /**
     * Check if user has trading password set
     */
    async hasTradingPassword(user: User): Promise<ApiResponse> {
        const userWithPassword = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { tradingPassword: true },
        });

        return buildResponse({
            message: "Trading password status",
            data: {
                hasTradingPassword: !!userWithPassword?.tradingPassword,
            },
        });
    }

    /**
     * Get verification status for tier upgrades
     */
    async getVerificationStatus(user: User): Promise<ApiResponse> {
        const userWithStatus = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                tier: true,
                kycStageAttempts: {
                    where: {
                        journeyType: "INDIVIDUAL",
                        stage: {
                            in: [KycStage.ADDRESS, KycStage.INCOME],
                        },
                        isCurrent: true,
                    },
                    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                    select: {
                        stage: true,
                        method: true,
                        status: true,
                        isCurrent: true,
                    },
                },
                tradingPassword: true,
            },
        });

        if (!userWithStatus) {
            throw new HttpException("User not found", HttpStatus.NOT_FOUND);
        }

        const verificationState =
            this.buildStageManagedVerificationState(userWithStatus);

        return buildResponse({
            message: "Verification status",
            data: {
                tier: userWithStatus.tier,
                address: {
                    verified: verificationState.addressVerified,
                    status: verificationState.addressStatus,
                },
                income: {
                    verified: verificationState.incomeVerified,
                    status: verificationState.incomeStatus,
                },
                hasTradingPassword: !!userWithStatus.tradingPassword,
            },
        });
    }

    /**
     * Upload document to storage
     */
    private async uploadDocument(
        file: Express.Multer.File,
        type: "address" | "income",
    ) {
        const date = Date.now();
        const documentDir = `${storageDirConfig.document}/${type}`;
        const documentName = `${type}-doc-${date}-${generateRandomNum(5)}`;

        try {
            if (isPdfFile(file.mimetype)) {
                if (this.uploadService instanceof CloudinaryService) {
                    throw new HttpException(
                        "PDF document uploads are not supported by the active storage provider",
                        HttpStatus.BAD_REQUEST,
                    );
                }

                return await this.uploadService.uploadImage({
                    dir: documentDir,
                    name: `${documentName}.pdf`,
                    body: file.buffer,
                    format: "png",
                });
            }

            return await this.uploadService.uploadCompressedImage({
                dir: documentDir,
                name: `${documentName}.webp`,
                format: "webp",
                body: file.buffer,
                quality: 100,
                width: 1200,
            });
        } catch (error) {
            if (
                error instanceof Error &&
                error.name === "ImageCompressionError"
            ) {
                throw new HttpException(
                    "Unsupported document format. Please upload a JPEG, PNG, or PDF file.",
                    HttpStatus.BAD_REQUEST,
                );
            }

            throw error;
        }
    }

    private handleDocumentProcessingError(error: unknown): never {
        if (error instanceof OcrDocumentPreparationError) {
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }

        throw error;
    }

    /**
     * Send document review notification email
     */
    async sendReviewNotification(
        userId: number,
        documentType: DocumentType,
        approved: boolean,
        rejectionReason?: string,
    ): Promise<void> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, firstName: true },
        });

        if (!user?.email) {
            this.logger.warn(
                `Cannot send notification: user ${userId} has no email`,
            );
            return;
        }

        const templateKey = approved
            ? emailTemplateConfig.document_approved
            : emailTemplateConfig.document_rejected;

        if (!templateKey) {
            this.logger.warn(
                `Email template not configured for document ${approved ? "approval" : "rejection"}`,
            );
            return;
        }

        const documentTypeFriendlyMap: Record<string, string> = {
            address: "Address",
            income: "Income",
            business: "Business Documents",
        };
        const documentTypeFriendly =
            documentTypeFriendlyMap[documentType] || documentType;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: templateKey,
                merge_info: {
                    first_name: user.firstName || "User",
                    document_type: documentTypeFriendly,
                    company_name: COMPANY_NAME,
                    rejection_reason: rejectionReason || "",
                    status: approved ? "Approved" : "Rejected",
                },
            });

            this.logger.log(
                `Review notification sent to ${user.email} for ${documentType} document - ${approved ? "approved" : "rejected"}`,
            );
        } catch (error) {
            this.logger.error(
                `Failed to send review notification to ${user.email}: ${error.message}`,
            );
        }
    }

    /**
     * Approve document verification (called by admin)
     */
    async approveDocument(
        userId: number,
        documentType: "address" | "income" | "business",
    ): Promise<ApiResponse> {
        const updateData: Record<string, unknown> = {};

        if (documentType === "business") {
            updateData.businessDocumentVerificationStatus =
                DocumentVerificationStatus.VERIFIED;
            updateData.isDocumentVerified = true;
        }

        if (documentType === "address" || documentType === "income") {
            await this.updateCurrentIndividualStageAttempt(
                userId,
                documentType === "address" ? KycStage.ADDRESS : KycStage.INCOME,
                KycAttemptStatus.APPROVED,
            );
        }

        if (Object.keys(updateData).length > 0) {
            await this.prisma.user.update({
                where: { id: userId },
                data: updateData,
            });
        }

        // Sync tier & flush cache
        await this.tierService.syncTierAndCache(userId);

        // Send email notification
        await this.sendReviewNotification(userId, documentType, true);

        // In-app notification + push
        const friendlyMap: Record<string, string> = {
            address: "Address",
            income: "Income",
            business: "Business Documents",
        };
        const friendlyType = friendlyMap[documentType] || documentType;
        await this.notificationDispatcher.notify({
            userId,
            title: "Document Approved",
            body: `Your ${friendlyType} verification has been approved.`,
            category: "security",
            enablePush: true,
        });

        // Push real-time profile update to connected client
        this.wsGateway.notifyProfileUpdate(userId);

        this.logger.log(
            `Admin approved ${documentType} document for user ${userId}`,
        );

        return buildResponse({
            message: `${friendlyType} approved successfully`,
        });
    }

    /**
     * Reject document verification (called by admin)
     */
    async rejectDocument(
        userId: number,
        documentType: "address" | "income" | "business",
        reason: string,
    ): Promise<ApiResponse> {
        const updateData: Record<string, unknown> = {};

        if (documentType === "business") {
            updateData.businessDocumentVerificationStatus =
                DocumentVerificationStatus.DECLINED;
            updateData.businessDocumentsUploaded = false;
        }

        if (documentType === "address" || documentType === "income") {
            await this.updateCurrentIndividualStageAttempt(
                userId,
                documentType === "address" ? KycStage.ADDRESS : KycStage.INCOME,
                KycAttemptStatus.REJECTED,
                reason,
            );
        }

        if (Object.keys(updateData).length > 0) {
            await this.prisma.user.update({
                where: { id: userId },
                data: updateData,
            });
        }

        // Sync tier & flush cache (rejection may lower tier)
        await this.tierService.syncTierAndCache(userId);

        // Send email notification
        await this.sendReviewNotification(userId, documentType, false, reason);

        // In-app notification + push
        const friendlyMap: Record<string, string> = {
            address: "Address",
            income: "Income",
            business: "Business Documents",
        };
        const friendlyType = friendlyMap[documentType] || documentType;
        await this.notificationDispatcher.notify({
            userId,
            title: "Document Rejected",
            body: `Your ${friendlyType} verification was rejected. Reason: ${reason}`,
            category: "security",
            enablePush: true,
        });

        // Push real-time profile update to connected client
        this.wsGateway.notifyProfileUpdate(userId);

        this.logger.log(
            `Admin rejected ${documentType} document for user ${userId}: ${reason}`,
        );

        return buildResponse({
            message: `${friendlyType} rejected`,
        });
    }
}
