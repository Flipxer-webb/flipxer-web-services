import { BadRequestException, GoneException, HttpStatus, Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
    SignUpDto,
    UserSigInDto,
    SendEmailVerificationCodeDto,
    VerifyEmailOtpDto,
    CreatePasswordDto,
    BvnVerificationDto,
    NinVerificationDto,
    OnboardIndividualDto,
    VerifyPhoneOtpDto,
    SendPhoneVerificationCodeDto,
    DocumentVerificationDto,
    DocumentVerificationBase64Dto,
    DocumentPreviewDto,
    DojahWidgetVerificationDto,
    SubmitBusinessRecordDto,
    SendForgotPasswordDto,
    ResetPasswordDto,
    ValidateAdminInviteDto,
    AcceptAdminInviteDto,
    RefreshTokenDto,
    BusinessDocumentUploadDto,
    UploadBusinessDocumentFileDto,
    SubmitBusinessDocumentsDto,
    Verify2FALoginDto,
} from "../dtos";
import * as bcrypt from "bcryptjs";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { generateFileName, generateId, generateRandomNum, decryptField } from "@/utils";
import { customAlphabet } from "nanoid";
import { DuplicateUserException } from "@/modules/api/user/errors";
import {
    UserNotFoundException,
    InvalidCredentialException,
    Invalid2FACodeException,
    TwoFactorLockedException,
    InvalidEmailVerificationCodeException,
    VerificationCodeExpiredException,
    DuplicateBvnVerificationException,
    DuplicateVerificationException,
    InvalidVerificationCodeException,
    VerificationGenericException,
    InvalidResetCodeException,
    ResetCodeExpiredException,
    InvalidResetRequestException,
    InvalidAdminInviteException,
    AdminInviteExpiredException,
    UserUnauthorizedException,
    InvalidRefreshToken,
    AuthGenericException,
    UserAccountDisabledException,
    RequiredFilesMissing,
} from "../errors";
import {
    Country,
    KycActorType,
    KycAttemptEventType,
    DocumentType,
    DocumentVerificationStatus,
    IdentityIdType,
    KycAttemptStatus,
    KycDecisionMode,
    KycEvidenceKind,
    KycEvidenceSide,
    KycMethod,
    KycProviderName,
    KycProviderStatus,
    KycStage,
    Prisma,
    Status,
    User,
    UserType,
} from "@prisma/client";
import { RoleNotFoundException } from "../../authorize/error";
import { ADMIN_USER_TYPES } from "../../authorize/decorator";
import {
    emailTemplateConfig,
    cloudinaryConfig,
    imagekitConfig,
    jwt_refresh_secret,
    jwtSecret,
    mailConfig,
    REFRESH_TOKEN_EXPIRATION,
    storageDirConfig,
    TOKEN_EXPIRATION,
    COMPANY_NAME,
    isProdEnvironment,
} from "@/config";
import { request as httpsRequest } from "node:https";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";

type UploadResult = UploadResponse | UploadApiResponse;

type LoginResponseUser = Pick<
    SignInUser,
    | "userType"
    | "isEmailVerified"
    | "isPhoneVerified"
    | "isPasswordCreated"
    | "bvn"
    | "nin"
    | "isDocumentVerified"
    | "businessRecordCompleted"
    | "businessDocumentVerificationStatus"
> & {
    role?: {
        name: string;
        slug?: string | null;
        rolePermission?: Array<{ permission: { name: string } }>;
    } | null;
    kycStageAttempts?: Array<{
        stage: string;
        method?: string | null;
        status?: string | null;
        isCurrent?: boolean;
    }> | null;
};

type IdentityDocumentTypeAssessment = {
    expectedDocumentType: DocumentType | null;
    detectedDocumentType: DocumentType | null;
    matches: boolean | null;
    message: string | null;
};

type SubmittedDocumentTypeInput = string | null | undefined;

type DocumentProfileMatch = {
    nameMatches: boolean;
    partialNameMatches: boolean;
    dobMatches: boolean;
    profileMatches: boolean;
};

type BuildIdentityDocumentDecisionParams = {
    documentType: DocumentType;
    documentNumber?: string | null;
    profileDocumentNumber?: string | null;
    isDocumentValid: boolean;
    hardRejectMessage?: string | null;
    dojahParsed?: Record<string, any> | null;
    documentProfileMatch: DocumentProfileMatch;
    documentTypeAssessment: IdentityDocumentTypeAssessment;
};

type IdentityDocumentDecisionContextDetails = {
    providerDocumentNumber: string | null;
    documentNumberMatches: boolean | null;
    profileDocumentNumber: string | null;
    profileDocumentNumberMatches: boolean | null;
    hasExtractedText: boolean;
    hasComparableName: boolean;
    hasComparableDob: boolean;
};

type DocumentReviewDisposition = {
    isDocumentValid: boolean;
    hardRejectMessage: string | null;
};

type IdentityDocumentDecisionDisposition = "APPROVE" | "AUTO_REJECT" | "MANUAL_REVIEW";

type IdentityDocumentDecision = {
    disposition: IdentityDocumentDecisionDisposition;
    attemptStatus: KycAttemptStatus;
    verificationStatus: DocumentVerificationStatus;
    providerStatus: KycProviderStatus;
    decisionMode: KycDecisionMode;
    responseMessage: string;
    attemptReasonCode: string | null;
    attemptReasonMessage: string | null;
    submissionNote: string | null;
    decisionEventType: KycAttemptEventType | null;
    decisionEventNote: string | null;
    decisionContext: Prisma.InputJsonValue;
    notificationTitle?: string;
    notificationBody?: string;
    emailRejectionReason?: string | null;
};

type GovernmentIdentityMatchResult =
    | { disposition: "MATCHED" }
    | {
        disposition: "AUTO_REJECT";
        responseMessage: string;
        reasonMessage: string;
    }
    | {
        disposition: "MANUAL_REVIEW";
        responseMessage: string;
        reasonMessage: string;
    };

type ProviderAnalysisFile = Pick<Express.Multer.File, "buffer" | "mimetype" | "originalname">;

import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { DojahService } from "@/modules/factory/identityCompliance/providers/dojah/services";
import {
    DocumentMetaMap,
    DataStoredInToken,
    DocumentVerificationFileInterface,
    LoginPlatform,
    SignInOptions,
    UploadBusinessDocumentsFileInterface,
    VerificationStatus,
    SignInUser,
} from "../interfaces";
import { CryptoAccountQueueProducer } from "../../trade/queues/producers/producer.service";
import { authenticator } from "otplib";
import * as crypto from "node:crypto";
import { SmsService } from "@/modules/core/sms/services";
import { SessionService } from "../../session/services";
import { SessionInfo } from "../../session/interfaces";
import { TwoFactorRateLimitService } from "./two-factor-rate-limit.service";
import { SettingService } from "../../settings/services";
import { TierService } from "./tier.service";
import { KycStateMachineService } from "./kyc-state-machine.service";
import { IdentityResolutionService } from "./identity-resolution.service";
import { matchNames, matchDateOfBirth, normaliseName } from "@/utils/name-matcher";
import { prepareDocumentForProviderAnalysis } from "@/libs/ocr";
import type { AddressProviderSignals, IncomeProviderSignals } from "@/libs/ocr";
import { buildIndividualVerificationSnapshot } from "../utils/individual-kyc-stage-state.util";

import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { PermissionName } from "@/modules/api/authorize/enums/role";

/**
 * Build a spread-safe object for a file field in update operations.
 * Returns an empty object if the file is not present, avoiding inline ternaries.
 */
function fileFieldUpdate(
    file: { url: string; fileId: string; originalName?: string } | null,
    urlProp: string,
    fieldIdProp: string,
    fileNameProp: string,
    metaKey: string,
    userId: number,
): any {
    if (!file) return {};
    return {
        [urlProp]: file.url,
        [fieldIdProp]: file.fileId,
        [fileNameProp]: generateFileName(metaKey, userId, file.originalName),
    };
}

/**
 * Build file field values for create operations.
 * Returns null values if no file, avoiding inline ternaries.
 */
function fileFieldCreate(
    file: { url: string; fileId: string; originalName?: string } | null,
    urlProp: string,
    fieldIdProp: string,
    fileNameProp: string,
    metaKey: string,
    userId: number,
): any {
    return {
        [urlProp]: file?.url || null,
        [fieldIdProp]: file?.fileId || null,
        [fileNameProp]: file ? generateFileName(metaKey, userId, file.originalName) : null,
    };
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);
    private readonly uploadService: ImagekitService | CloudinaryService;
    private readonly SALT_ROUNDS = 10;
    private readonly SIGNUP_CACHE_TTL = 3600; // 1 hour
    private readonly getProfileCacheKey = (userId: number) => `user:profile:${userId}`;

    private maskSensitiveId(value?: string, visibleDigits: number = 4): string {
        if (!value) return "N/A";
        if (value.length <= visibleDigits) return value;
        return `${"*".repeat(Math.max(0, value.length - visibleDigits))}${value.slice(-visibleDigits)}`;
    }

    private deriveAdminUserType(roleSlug: string): UserType {
        return roleSlug === "super-admin" ? UserType.SUPER_ADMIN : UserType.ADMIN;
    }

    private buildGovernmentVerificationState(user: {
        bvn?: string | null;
        nin?: string | null;
        kycStageAttempts?: Array<{
            stage: string;
            method?: string | null;
            status?: string | null;
            isCurrent?: boolean;
        }> | null;
    }): { governmentIdVerified: boolean } {
        const verificationSnapshot = buildIndividualVerificationSnapshot({
            bvn: user.bvn ?? null,
            nin: user.nin ?? null,
            kycStageAttempts: user.kycStageAttempts,
        });

        return {
            governmentIdVerified:
                verificationSnapshot.bvnVerified
                || verificationSnapshot.ninVerified
                || Boolean(user.bvn)
                || Boolean(user.nin),
        };
    }

    private async hasCompletedGovernmentVerification(
        user: Pick<User, "id" | "bvn" | "nin">,
        method: "BVN" | "NIN",
    ): Promise<boolean> {
        const identifier = method === KycMethod.BVN ? user.bvn : user.nin;

        if (identifier) {
            // If the current attempt is REJECTED, the user is in NEEDS_RESUBMISSION — allow re-verification
            const rejectedCurrentAttempt = await this.prisma.kycStageAttempt.findFirst({
                where: {
                    userId: user.id,
                    journeyType: "INDIVIDUAL",
                    stage: KycStage.GOVERNMENT_ID,
                    method,
                    isCurrent: true,
                    status: KycAttemptStatus.REJECTED,
                },
                select: { id: true },
            });
            if (rejectedCurrentAttempt) {
                return false;
            }
            return true;
        }

        const approvedAttemptPromise = this.prisma.kycStageAttempt?.findFirst
            ? this.prisma.kycStageAttempt.findFirst({
                where: {
                    userId: user.id,
                    journeyType: "INDIVIDUAL",
                    stage: KycStage.GOVERNMENT_ID,
                    method,
                    isCurrent: true,
                    status: KycAttemptStatus.APPROVED,
                },
                select: { id: true },
            })
            : Promise.resolve(null);

        return Boolean(await approvedAttemptPromise);
    }

    private mapIndividualAttemptReasonCode(reason?: string | null): string | null {
        if (!reason) {
            return null;
        }

        const normalized = reason.trim().toUpperCase();

        if (normalized.includes("EXPIRED")) {
            return "DOCUMENT_EXPIRED";
        }

        if (normalized.includes("NOT_SUPPORTED") || normalized.includes("UNSUPPORTED")) {
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

        const reasonTokens = normalized.split(/[^A-Z0-9]+/).filter(Boolean);

        return reasonTokens.join("_") || "REVIEW_REQUIRED";
    }

    private mapDocumentTypeToKycMethod(documentType: DocumentType): KycMethod {
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

    private extractBase64MimeType(encodedFile: string | undefined): string {
        const detectedType = /^data:([^;]+);base64,/.exec(encodedFile ?? "")?.[1];

        return detectedType || "image/jpeg";
    }

    private extractGovernmentProviderPhoneNumber(entity?: Record<string, any>): string | null {
        if (typeof entity?.phone_number1 === "string") {
            return entity.phone_number1;
        }

        if (typeof entity?.phone_number === "string") {
            return entity.phone_number;
        }

        return null;
    }

    private buildGovernmentComparisonSummary(
        user: Pick<User, "firstName" | "lastName" | "dateOfBirth">,
        providerProfile: {
            firstName: string | null;
            lastName: string | null;
            dateOfBirth: string | null;
        },
    ) {
        const profileDateOfBirth = this.getUserDateOfBirth(user);
        const hasProviderProfile = Boolean(
            providerProfile.firstName || providerProfile.lastName || providerProfile.dateOfBirth,
        );

        if (!hasProviderProfile) {
            return undefined;
        }

        const nameResult = matchNames(
            user.firstName,
            user.lastName,
            providerProfile.firstName || "",
            providerProfile.lastName || "",
        );
        const dobMatches = profileDateOfBirth
            ? matchDateOfBirth(profileDateOfBirth, providerProfile.dateOfBirth || "")
            : null;

        return {
            profileFirstName: user.firstName || null,
            profileLastName: user.lastName || null,
            profileDateOfBirth,
            providerFirstName: providerProfile.firstName,
            providerLastName: providerProfile.lastName,
            providerDateOfBirth: providerProfile.dateOfBirth,
            nameMatches: nameResult.matches,
            nameMatchDetail: nameResult.detail,
            dobMatches,
        };
    }

    private getReviewedAtForAttemptStatus(status: KycAttemptStatus): Date | null {
        if (status === KycAttemptStatus.APPROVED || status === KycAttemptStatus.REJECTED) {
            return new Date();
        }

        return null;
    }

    private async createCurrentIndividualStageAttempt(
        db: PrismaService | Prisma.TransactionClient,
        input: {
            userId: number;
            stage: KycStage;
            method: KycMethod;
            status: KycAttemptStatus;
            providerName: KycProviderName;
            providerStatus: KycProviderStatus;
            decisionMode: KycDecisionMode;
            providerRef?: string | null;
            reasonCode?: string | null;
            reasonMessage?: string | null;
            reasonDetails?: Prisma.InputJsonValue | null;
            extractedFields?: Prisma.InputJsonValue | null;
            comparisonSummary?: Prisma.InputJsonValue | null;
            evidenceSummary?: Prisma.InputJsonValue | null;
            reviewerId?: number | null;
            reviewNote?: string | null;
            submittedAt?: Date;
            reviewedAt?: Date | null;
            escalatedAt?: Date | null;
            evidenceAssets?: Array<{
                kind: KycEvidenceKind;
                storageUrl: string;
                storageFieldId?: string | null;
                originalName?: string | null;
                mimeType: string;
                side?: KycEvidenceSide | null;
            }>;
        },
    ): Promise<{ id: number }> {
        const userId = this.normalizePositiveInt(input.userId, "KYC attempt user id");
        const stage = this.normalizeKycStage(input.stage);

        const nextAttemptAggregate = await db.kycStageAttempt.aggregate({
            where: {
                userId,
                stage,
            },
            _max: { attemptNo: true },
        });

        await db.$executeRaw`
            UPDATE "KycStageAttempts"
            SET "isCurrent" = false, "updatedAt" = NOW()
            WHERE "userId" = ${userId}
              AND "stage" = ${stage}::"KycStage"
              AND "isCurrent" = true
        `;

        return db.kycStageAttempt.create({
            data: {
                userId,
                stage,
                method: input.method,
                attemptNo: (nextAttemptAggregate._max.attemptNo ?? 0) + 1,
                isCurrent: true,
                status: input.status,
                providerName: input.providerName,
                providerStatus: input.providerStatus,
                decisionMode: input.decisionMode,
                providerRef: input.providerRef ?? null,
                reasonCode: input.reasonCode ?? null,
                reasonMessage: input.reasonMessage ?? null,
                reasonDetails: input.reasonDetails ?? undefined,
                extractedFields: input.extractedFields ?? undefined,
                comparisonSummary: input.comparisonSummary ?? undefined,
                evidenceSummary: input.evidenceSummary ?? undefined,
                reviewerId: input.reviewerId ?? null,
                reviewNote: input.reviewNote ?? null,
                submittedAt: input.submittedAt ?? new Date(),
                reviewedAt: input.reviewedAt ?? null,
                escalatedAt: input.escalatedAt ?? null,
                evidenceAssets: input.evidenceAssets?.length
                    ? {
                        create: input.evidenceAssets.map((asset) => ({
                            kind: asset.kind,
                            storageUrl: asset.storageUrl,
                            storageFieldId: asset.storageFieldId ?? null,
                            originalName: asset.originalName ?? null,
                            mimeType: asset.mimeType,
                            side: asset.side ?? null,
                        })),
                    }
                    : undefined,
            },
            select: { id: true },
        });
    }

    private async appendIndividualStageAttemptEvent(
        db: PrismaService | Prisma.TransactionClient,
        params: {
            attemptId: number;
            userId: number;
            stage: KycStage;
            eventType: KycAttemptEventType;
            actorType?: KycActorType | null;
            actorId?: number | null;
            providerName?: KycProviderName | null;
            providerStatus?: KycProviderStatus | null;
            providerRef?: string | null;
            note?: string | null;
            payload?: Prisma.InputJsonValue | null;
        },
    ): Promise<void> {
        await (db as any).kycAttemptEvent.create({
            data: {
                attemptId: params.attemptId,
                userId: params.userId,
                journeyType: "INDIVIDUAL",
                stage: params.stage,
                eventType: params.eventType,
                actorType: params.actorType ?? null,
                actorId: params.actorId ?? null,
                providerName: params.providerName ?? undefined,
                providerStatus: params.providerStatus ?? undefined,
                providerRef: params.providerRef ?? undefined,
                note: params.note ?? undefined,
                payload: params.payload ?? undefined,
            },
        });
    }

    private async persistGovernmentStageAttempt(params: {
        user: User;
        identityType: "BVN" | "NIN";
        identifier: string;
        status: KycAttemptStatus;
        providerStatus: KycProviderStatus;
        decisionMode: KycDecisionMode;
        providerRef?: string | null;
        providerRawResponse?: Record<string, any> | null;
        reasonMessage?: string | null;
        reasonDetails?: Prisma.InputJsonValue | null;
        preApprovalEventType?: KycAttemptEventType;
        preApprovalEventActorType?: KycActorType | null;
        preApprovalEventActorId?: number | null;
        preApprovalEventNote?: string | null;
        preApprovalEventPayload?: Prisma.InputJsonValue | null;
        eventType?: KycAttemptEventType;
        eventActorType?: KycActorType | null;
        eventActorId?: number | null;
        eventNote?: string | null;
        eventPayload?: Prisma.InputJsonValue | null;
    }): Promise<void> {
        const entity = params.providerRawResponse?.entity as Record<string, any> | undefined;
        const providerFirstName = typeof entity?.first_name === "string" ? entity.first_name : null;
        const providerLastName = typeof entity?.last_name === "string" ? entity.last_name : null;
        const providerDateOfBirth = typeof entity?.date_of_birth === "string" ? entity.date_of_birth : null;
        const providerPhoneNumber = this.extractGovernmentProviderPhoneNumber(entity);
        const comparisonSummary = this.buildGovernmentComparisonSummary(params.user, {
            firstName: providerFirstName,
            lastName: providerLastName,
            dateOfBirth: providerDateOfBirth,
        });
        const reviewedAt = this.getReviewedAtForAttemptStatus(params.status);

        const attempt = await this.createCurrentIndividualStageAttempt(this.prisma, {
            userId: params.user.id,
            stage: KycStage.GOVERNMENT_ID,
            method: params.identityType === "BVN" ? KycMethod.BVN : KycMethod.NIN,
            status: params.status,
            providerName: params.providerRawResponse ? KycProviderName.DOJAH : KycProviderName.NONE,
            providerStatus: params.providerStatus,
            decisionMode: params.decisionMode,
            providerRef: params.providerRef ?? null,
            reasonCode: this.mapIndividualAttemptReasonCode(params.reasonMessage),
            reasonMessage: params.reasonMessage ?? null,
            reasonDetails: params.reasonDetails ?? undefined,
            extractedFields: {
                identifierType: params.identityType,
                identifier: params.identifier,
                firstName: providerFirstName,
                lastName: providerLastName,
                dateOfBirth: providerDateOfBirth,
                phoneNumber: providerPhoneNumber,
            },
            comparisonSummary,
            evidenceSummary: {
                identifierType: params.identityType,
                identifier: this.maskSensitiveId(params.identifier),
                registeredPhoneNumber: providerPhoneNumber ? this.maskSensitiveId(providerPhoneNumber) : null,
            },
            reviewedAt,
        });

        const eventProviderName = params.providerRef === "DEV_BYPASS" || !params.providerRawResponse
            ? KycProviderName.NONE
            : KycProviderName.DOJAH;

        if (params.preApprovalEventType) {
            await this.appendIndividualStageAttemptEvent(this.prisma, {
                attemptId: attempt.id,
                userId: params.user.id,
                stage: KycStage.GOVERNMENT_ID,
                eventType: params.preApprovalEventType,
                actorType: params.preApprovalEventActorType ?? KycActorType.SYSTEM,
                actorId: params.preApprovalEventActorId ?? null,
                providerName: eventProviderName,
                providerStatus: params.providerStatus,
                providerRef: params.providerRef ?? null,
                note: params.preApprovalEventNote ?? params.reasonMessage ?? null,
                payload: params.preApprovalEventPayload ?? undefined,
            });
        }

        if (params.eventType) {
            await this.appendIndividualStageAttemptEvent(this.prisma, {
                attemptId: attempt.id,
                userId: params.user.id,
                stage: KycStage.GOVERNMENT_ID,
                eventType: params.eventType,
                actorType: params.eventActorType ?? KycActorType.SYSTEM,
                actorId: params.eventActorId ?? null,
                providerName: eventProviderName,
                providerStatus: params.providerStatus,
                providerRef: params.providerRef ?? null,
                note: params.eventNote ?? params.reasonMessage ?? null,
                payload: params.eventPayload ?? undefined,
            });
        }
    }

    private async getCurrentGovernmentAttemptStatus(
        userId: number,
        method: "BVN" | "NIN",
    ): Promise<KycAttemptStatus | null> {
        const attempt = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId,
                journeyType: "INDIVIDUAL",
                stage: KycStage.GOVERNMENT_ID,
                method,
                isCurrent: true,
            },
            orderBy: [{ attemptNo: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
            select: { status: true },
        });

        return attempt?.status ?? null;
    }

    private buildGovernmentAutoApprovalSubmissionEvent(params: {
        currentAttemptStatus: KycAttemptStatus | null;
        identityType: "BVN" | "NIN";
        identifier: string;
        source: "DEV_IDENTITY_BYPASS" | "PROVIDER_GOVERNMENT_ID_CHECK";
        providerRef?: string | null;
    }): {
        eventType: KycAttemptEventType;
        note: string;
        payload: Prisma.InputJsonValue;
    } {
        const eventType = params.currentAttemptStatus === KycAttemptStatus.REJECTED
            || params.currentAttemptStatus === KycAttemptStatus.EXPIRED
            ? KycAttemptEventType.RESUBMITTED
            : KycAttemptEventType.SUBMITTED;

        return {
            eventType,
            note: eventType === KycAttemptEventType.RESUBMITTED
                ? `${params.identityType} resubmitted for verification.`
                : `${params.identityType} submitted for verification.`,
            payload: {
                source: params.source,
                verificationType: params.identityType,
                identifier: this.maskSensitiveId(params.identifier),
                outcome: eventType,
                providerRef: params.providerRef ?? null,
            } as Prisma.InputJsonValue,
        };
    }

    private async getCurrentBusinessDocumentAttemptStatus(userId: number): Promise<KycAttemptStatus | null> {
        const attempt = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId,
                journeyType: "BUSINESS",
                stage: KycStage.BUSINESS_DOCUMENT,
                isCurrent: true,
            },
            orderBy: [{ attemptNo: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
            select: { status: true },
        });

        return attempt?.status ?? null;
    }

    private async createCurrentBusinessStageAttempt(
        db: PrismaService | Prisma.TransactionClient,
        input: {
            userId: number;
            status: KycAttemptStatus;
            providerRef?: string | null;
            reasonMessage?: string | null;
            extractedFields?: Prisma.InputJsonValue;
            evidenceSummary?: Prisma.InputJsonValue;
        },
    ): Promise<{ id: number }> {
        const userId = this.normalizePositiveInt(input.userId, "business KYC attempt user id");

        const nextAttemptAggregate = await db.kycStageAttempt.aggregate({
            where: {
                userId,
                journeyType: "BUSINESS",
                stage: KycStage.BUSINESS_DOCUMENT,
            },
            _max: { attemptNo: true },
        });
        const nextAttemptNo = (nextAttemptAggregate._max.attemptNo ?? 0) + 1;

        await db.$executeRaw`
            UPDATE "KycStageAttempts"
            SET "isCurrent" = false, "updatedAt" = NOW()
            WHERE "userId" = ${userId}
              AND "journeyType" = 'BUSINESS'::"KycJourneyType"
              AND "stage" = ${KycStage.BUSINESS_DOCUMENT}::"KycStage"
              AND "isCurrent" = true
        `;

        return db.kycStageAttempt.create({
            data: {
                userId,
                journeyType: "BUSINESS",
                stage: KycStage.BUSINESS_DOCUMENT,
                attemptNo: nextAttemptNo,
                status: input.status,
                isCurrent: true,
                providerName: KycProviderName.NONE,
                providerStatus: KycProviderStatus.NOT_REQUESTED,
                decisionMode: KycDecisionMode.MANUAL,
                providerRef: input.providerRef ?? null,
                reasonCode: this.mapIndividualAttemptReasonCode(input.reasonMessage),
                reasonMessage: input.reasonMessage ?? null,
                extractedFields: input.extractedFields,
                evidenceSummary: input.evidenceSummary,
            } as Prisma.KycStageAttemptUncheckedCreateInput,
            select: { id: true },
        });
    }

    private async appendBusinessStageAttemptEvent(
        db: PrismaService | Prisma.TransactionClient,
        params: {
            attemptId: number;
            userId: number;
            eventType: KycAttemptEventType;
            note?: string | null;
            providerRef?: string | null;
            actorType?: KycActorType;
            actorId?: number | null;
            providerName?: KycProviderName;
            providerStatus?: KycProviderStatus;
            payload?: Prisma.InputJsonValue | null;
        },
    ): Promise<void> {
        await (db as any).kycAttemptEvent.create({
            data: {
                attemptId: params.attemptId,
                userId: params.userId,
                journeyType: "BUSINESS",
                stage: KycStage.BUSINESS_DOCUMENT,
                eventType: params.eventType,
                actorType: params.actorType ?? KycActorType.USER,
                actorId: typeof params.actorId === "number" ? params.actorId : params.actorId ?? params.userId,
                providerName: params.providerName ?? KycProviderName.NONE,
                providerStatus: params.providerStatus ?? KycProviderStatus.NOT_REQUESTED,
                providerRef: params.providerRef ?? undefined,
                note: params.note ?? undefined,
                payload: params.payload ?? undefined,
            },
        });
    }

    private async persistBusinessDocumentStageAttempt(
        db: PrismaService | Prisma.TransactionClient,
        params: {
            user: User;
            currentAttemptStatus?: KycAttemptStatus | null;
            submissionSource: "MULTIPART_UPLOAD" | "STRUCTURED_URL_UPLOAD";
            cacDocumentNumber: string;
            evidenceSummary: Prisma.InputJsonValue;
        },
    ): Promise<{ id: number }> {
        const note = "Business documents submitted for review.";
        const attempt = await this.createCurrentBusinessStageAttempt(db, {
            userId: params.user.id,
            status: KycAttemptStatus.SUBMITTED,
            providerRef: params.cacDocumentNumber,
            reasonMessage: note,
            extractedFields: {
                cacDocumentNumber: params.cacDocumentNumber,
                submissionSource: params.submissionSource,
            } as Prisma.InputJsonValue,
            evidenceSummary: params.evidenceSummary,
        });
        const eventType = params.currentAttemptStatus === KycAttemptStatus.REJECTED
            || params.currentAttemptStatus === KycAttemptStatus.EXPIRED
            ? KycAttemptEventType.RESUBMITTED
            : KycAttemptEventType.SUBMITTED;

        await this.appendBusinessStageAttemptEvent(db, {
            attemptId: attempt.id,
            userId: params.user.id,
            eventType,
            note,
            providerRef: params.cacDocumentNumber,
            payload: {
                source: params.submissionSource,
                cacDocumentNumber: params.cacDocumentNumber,
                submissionSource: params.submissionSource,
                currentAttemptStatus: params.currentAttemptStatus ?? null,
            } as Prisma.InputJsonValue,
        });

        return attempt;
    }

    private resolveBusinessProviderCheckStatus(params: {
        verificationResult: {
            cac: { verified: boolean; nameMatches?: boolean | null };
            tin: { verified: boolean; nameMatches?: boolean | null };
            ocr: { verified: boolean; numberMatches?: boolean | null };
        };
        hasTinCheck: boolean;
        hasOcrCheck: boolean;
    }): KycProviderStatus {
        const checks = [
            {
                applicable: true,
                verified: params.verificationResult.cac.verified,
                matched: params.verificationResult.cac.nameMatches,
            },
            {
                applicable: params.hasTinCheck,
                verified: params.verificationResult.tin.verified,
                matched: params.verificationResult.tin.nameMatches,
            },
            {
                applicable: params.hasOcrCheck,
                verified: params.verificationResult.ocr.verified,
                matched: params.verificationResult.ocr.numberMatches,
            },
        ].filter((check) => check.applicable);

        const allPassed = checks.every((check) => check.verified === true && check.matched !== false);
        if (allPassed) {
            return KycProviderStatus.PASSED;
        }

        const hasFailure = checks.some((check) => check.verified === false || check.matched === false);
        return hasFailure ? KycProviderStatus.FAILED : KycProviderStatus.INCONCLUSIVE;
    }

    private async syncBusinessProviderCheckAttempt(params: {
        userId: number;
        cacDocumentNumber: string;
        attemptId?: number;
        verificationResult: {
            cac: {
                verified: boolean;
                companyName?: string | null;
                companyStatus?: string | null;
                registrationDate?: string | null;
                nameMatches?: boolean | null;
                rawResponse?: unknown;
            };
            tin: {
                verified: boolean;
                taxpayerName?: string | null;
                nameMatches?: boolean | null;
                rawResponse?: unknown;
            };
            ocr: {
                verified: boolean;
                extractedNumber?: string | null;
                extractedName?: string | null;
                numberMatches?: boolean | null;
                rawResponse?: unknown;
            };
        };
        hasTinCheck: boolean;
        hasOcrCheck: boolean;
    }): Promise<void> {
        const attempt = await this.prisma.kycStageAttempt.findFirst({
            where: params.attemptId
                ? {
                    id: params.attemptId,
                    userId: params.userId,
                    journeyType: "BUSINESS",
                    stage: KycStage.BUSINESS_DOCUMENT,
                }
                : {
                    userId: params.userId,
                    journeyType: "BUSINESS",
                    stage: KycStage.BUSINESS_DOCUMENT,
                    isCurrent: true,
                },
            orderBy: params.attemptId
                ? undefined
                : [{ attemptNo: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
            select: {
                id: true,
                status: true,
            },
        });

        if (!attempt) {
            return;
        }

        const providerStatus = this.resolveBusinessProviderCheckStatus({
            verificationResult: params.verificationResult,
            hasTinCheck: params.hasTinCheck,
            hasOcrCheck: params.hasOcrCheck,
        });
        const shouldPreserveStatus = attempt.status === KycAttemptStatus.APPROVED
            || attempt.status === KycAttemptStatus.REJECTED
            || attempt.status === KycAttemptStatus.EXPIRED
            || attempt.status === KycAttemptStatus.ESCALATED;
        const note = "Business document provider checks completed.";

        await this.prisma.kycStageAttempt.update({
            where: { id: attempt.id },
            data: {
                status: shouldPreserveStatus ? attempt.status : KycAttemptStatus.PENDING_REVIEW,
                providerName: KycProviderName.DOJAH,
                providerStatus,
                providerRef: params.cacDocumentNumber,
                decisionMode: KycDecisionMode.MANUAL,
                reasonMessage: providerStatus === KycProviderStatus.PASSED ? null : note,
                extractedFields: {
                    cacCompanyName: params.verificationResult.cac.companyName ?? null,
                    cacCompanyStatus: params.verificationResult.cac.companyStatus ?? null,
                    cacRegistrationDate: params.verificationResult.cac.registrationDate ?? null,
                    tinTaxpayerName: params.verificationResult.tin.taxpayerName ?? null,
                    cacOcrExtractedNumber: params.verificationResult.ocr.extractedNumber ?? null,
                    cacOcrExtractedName: params.verificationResult.ocr.extractedName ?? null,
                } as Prisma.InputJsonValue,
                comparisonSummary: {
                    hasTinCheck: params.hasTinCheck,
                    hasOcrCheck: params.hasOcrCheck,
                    cacVerified: params.verificationResult.cac.verified,
                    cacNameMatches: params.verificationResult.cac.nameMatches ?? null,
                    tinVerified: params.verificationResult.tin.verified,
                    tinNameMatches: params.verificationResult.tin.nameMatches ?? null,
                    ocrVerified: params.verificationResult.ocr.verified,
                    ocrNumberMatches: params.verificationResult.ocr.numberMatches ?? null,
                } as Prisma.InputJsonValue,
            },
        });

        await this.appendBusinessStageAttemptEvent(this.prisma, {
            attemptId: attempt.id,
            userId: params.userId,
            eventType: KycAttemptEventType.PROVIDER_CHECK,
            note,
            providerRef: params.cacDocumentNumber,
            actorType: KycActorType.PROVIDER,
            actorId: null,
            providerName: KycProviderName.DOJAH,
            providerStatus,
            payload: {
                source: "DOJAH_BUSINESS_VERIFICATION",
                cacDocumentNumber: params.cacDocumentNumber,
                hasTinCheck: params.hasTinCheck,
                hasOcrCheck: params.hasOcrCheck,
                verificationResult: params.verificationResult,
            } as Prisma.InputJsonValue,
        });
    }

    private getIdentityDocumentProviderStatus(params: {
        shouldAutoApprove: boolean;
        isDocumentValid: boolean;
        dojahParsed?: Record<string, any> | null;
    }): KycProviderStatus {
        if (params.shouldAutoApprove) {
            return KycProviderStatus.PASSED;
        }

        if (params.isDocumentValid || params.dojahParsed?.firstName || params.dojahParsed?.documentNumber) {
            return KycProviderStatus.INCONCLUSIVE;
        }

        return KycProviderStatus.FAILED;
    }

    private async getCurrentIdentityDocumentAttemptStatus(userId: number): Promise<KycAttemptStatus | null> {
        const attempt = await this.prisma.kycStageAttempt.findFirst({
            where: {
                userId,
                journeyType: "INDIVIDUAL",
                stage: KycStage.IDENTITY_DOCUMENT,
                isCurrent: true,
            },
            orderBy: [{ attemptNo: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
            select: { status: true },
        });

        return attempt?.status ?? null;
    }

    private async persistIdentityDocumentStageAttempt(
        db: PrismaService | Prisma.TransactionClient,
        params: {
            user: User;
            documentType: DocumentType;
            country: Country;
            documentNumber: string;
            submittedDocumentNumber?: string | null;
            documentImage1: { url: string; fileId?: string | null };
            documentImage2?: { url: string; fileId?: string | null } | null;
            frontMimeType: string;
            backMimeType?: string | null;
            dojahParsed?: Record<string, any> | null;
            isDocumentValid: boolean;
            decision: IdentityDocumentDecision;
            documentTypeAssessment: IdentityDocumentTypeAssessment;
            currentAttemptStatus?: KycAttemptStatus | null;
            documentProfileMatch: DocumentProfileMatch;
        },
    ): Promise<void> {
        const providerRef = typeof params.dojahParsed?.documentNumber === "string"
            ? params.dojahParsed.documentNumber
            : null;
        const expectedDocumentNumber = this.normalizeSubmittedDocumentNumber(params.submittedDocumentNumber);
        const extractedDocumentNumber = this.normalizeSubmittedDocumentNumber(providerRef);
        const documentNumberMatches = expectedDocumentNumber && extractedDocumentNumber
            ? expectedDocumentNumber === extractedDocumentNumber
            : null;

        const attempt = await this.createCurrentIndividualStageAttempt(db, {
            userId: params.user.id,
            stage: KycStage.IDENTITY_DOCUMENT,
            method: this.mapDocumentTypeToKycMethod(params.documentType),
            status: params.decision.attemptStatus,
            providerName: KycProviderName.DOJAH,
            providerStatus: params.decision.providerStatus,
            decisionMode: params.decision.decisionMode,
            providerRef,
            reasonCode: params.decision.attemptReasonCode,
            reasonMessage: params.decision.attemptReasonMessage,
            reasonDetails: params.decision.disposition === "APPROVE"
                ? undefined
                : params.decision.decisionContext,
            extractedFields: {
                documentType: params.documentType,
                country: params.country,
                documentNumber: params.documentNumber,
                submittedDocumentNumber: params.submittedDocumentNumber ?? null,
                extractedDocumentType: params.dojahParsed?.documentType ?? null,
                normalizedExtractedDocumentType: params.documentTypeAssessment.detectedDocumentType ?? null,
                extractedCountryCode: params.dojahParsed?.countryCode ?? null,
                extractedFirstName: params.dojahParsed?.firstName ?? null,
                extractedLastName: params.dojahParsed?.lastName ?? null,
                extractedDateOfBirth: params.dojahParsed?.dateOfBirth ?? null,
                extractedExpiryDate: params.dojahParsed?.expiryDate ?? null,
            },
            comparisonSummary: {
                nameMatches: params.documentProfileMatch.nameMatches,
                partialNameMatches: params.documentProfileMatch.partialNameMatches,
                dobMatches: params.documentProfileMatch.dobMatches,
                profileMatches: params.documentProfileMatch.profileMatches,
                documentTypeMatches: params.documentTypeAssessment.matches,
                documentNumberMatches,
            },
            evidenceSummary: {
                frontImageUrl: params.documentImage1.url,
                backImageUrl: params.documentImage2?.url ?? null,
            },
            reviewedAt: params.decision.disposition === "MANUAL_REVIEW" ? null : new Date(),
            evidenceAssets: [
                {
                    kind: KycEvidenceKind.FRONT_IMAGE,
                    storageUrl: params.documentImage1.url,
                    storageFieldId: params.documentImage1.fileId ?? null,
                    mimeType: params.frontMimeType,
                    side: KycEvidenceSide.FRONT,
                },
                ...(params.documentImage2
                    ? [{
                        kind: KycEvidenceKind.BACK_IMAGE,
                        storageUrl: params.documentImage2.url,
                        storageFieldId: params.documentImage2.fileId ?? null,
                        mimeType: params.backMimeType || params.frontMimeType,
                        side: KycEvidenceSide.BACK,
                    }]
                    : []),
            ],
        });

        const eventPayload = {
            source: "IDENTITY_DOCUMENT_SUBMISSION",
            documentType: params.documentType,
            country: params.country,
            documentNumber: this.maskSensitiveId(params.documentNumber),
            submittedDocumentNumber: params.submittedDocumentNumber
                ? this.maskSensitiveId(params.submittedDocumentNumber)
                : null,
            isDocumentValid: params.isDocumentValid,
            shouldAutoApprove: params.decision.disposition === "APPROVE",
            shouldAutoReject: params.decision.disposition === "AUTO_REJECT",
            disposition: params.decision.disposition,
            currentAttemptStatus: params.currentAttemptStatus ?? null,
            profileMatch: params.documentProfileMatch,
            decisionContext: params.decision.decisionContext,
        } as Prisma.InputJsonValue;
        const shouldResubmit = params.currentAttemptStatus === KycAttemptStatus.REJECTED
            || params.currentAttemptStatus === KycAttemptStatus.EXPIRED;

        const submissionEventType = shouldResubmit
            ? KycAttemptEventType.RESUBMITTED
            : KycAttemptEventType.SUBMITTED;
        const submissionNote = shouldResubmit
            ? params.decision.submissionNote ?? "Identity document resubmitted for verification."
            : params.decision.submissionNote ?? "Identity document submitted for verification.";

        await this.appendIndividualStageAttemptEvent(db, {
            attemptId: attempt.id,
            userId: params.user.id,
            stage: KycStage.IDENTITY_DOCUMENT,
            eventType: submissionEventType,
            actorType: KycActorType.USER,
            actorId: params.user.id,
            providerName: KycProviderName.DOJAH,
            providerStatus: params.decision.providerStatus,
            providerRef,
            note: submissionNote,
            payload: eventPayload,
        });

        if (params.decision.decisionEventType) {
            await this.appendIndividualStageAttemptEvent(db, {
                attemptId: attempt.id,
                userId: params.user.id,
                stage: KycStage.IDENTITY_DOCUMENT,
                eventType: params.decision.decisionEventType,
                actorType: KycActorType.SYSTEM,
                providerName: KycProviderName.DOJAH,
                providerStatus: params.decision.providerStatus,
                providerRef,
                note: params.decision.decisionEventNote,
                payload: eventPayload,
            });
        }
    }

    /**
     * Map Dojah error types to user-friendly messages
     */
    private mapDojahErrorToUserMessage(error: { name: string; message: string; status?: number }): string {
        const errorName = error.name?.toLowerCase() || '';
        const errorMessage = error.message?.toLowerCase() || '';

        // Network/timeout errors
        if (errorName.includes('network') || errorName.includes('timeout') || errorMessage.includes('timeout')) {
            return 'Connection issue with verification service. Please try again in a moment.';
        }

        // Validation errors - usually means image quality or format issues
        if (errorName.includes('validation') || error.status === 400) {
            if (errorMessage.includes('base64') || errorMessage.includes('image')) {
                return 'Invalid image format. Please upload a clear photo of your document.';
            }
            if (errorMessage.includes('size') || errorMessage.includes('large')) {
                return 'Image file is too large. Please upload a smaller image.';
            }
            return 'Document image could not be processed. Please ensure the image is clear and try again.';
        }

        // Not found - document type not recognized
        if (errorName.includes('notfound') || error.status === 404) {
            return 'Could not recognize this document type. Please upload a valid government-issued ID.';
        }

        // Third party service failure
        if (errorName.includes('thirdparty') || error.status === 424) {
            return 'Verification service is temporarily unavailable. Please try again in a few minutes.';
        }

        // Rate limiting
        if (errorName.includes('toomany') || error.status === 429) {
            return 'Too many verification attempts. Please wait a few minutes before trying again.';
        }

        // Authorization errors (internal issue)
        if (errorName.includes('authorization') || error.status === 401) {
            return 'Verification service configuration error. Please contact support.';
        }

        // Default message with the original error for debugging
        const originalMessage = error.message || 'Unknown error';
        return `Document verification failed: ${originalMessage}. Please try with a clearer image.`;
    }

    private applyDojahPostValidation(
        isDocumentValid: boolean,
        dojahParsed: any,
        userId: number,
        logger: Logger,
    ): DocumentReviewDisposition {
        const postValidation = this.getDocumentReviewDisposition(
            isDocumentValid,
            dojahParsed,
            userId,
            logger,
        );

        return postValidation;
    }

    private isNigeriaDocumentCountry(params: {
        country?: string | null;
        countryCode?: string | null;
    }): boolean {
        const normalizedCountry = String(params.country || "").trim().toLowerCase();
        const normalizedCountryCode = String(params.countryCode || "").trim().toLowerCase();

        return normalizedCountryCode === "ng"
            || normalizedCountry === "nigeria"
            || normalizedCountry === "federal republic of nigeria";
    }

    /**
     * Reject documents that are expired, unsupported, or otherwise invalid.
     * Manual review only applies after the document itself is valid.
     */
    private getDocumentReviewDisposition(
        isDocumentValid: boolean,
        dojahParsed: any,
        userId: number,
        logger: Logger,
    ): DocumentReviewDisposition {
        let validatedDocument = isDocumentValid;

        if (validatedDocument && this.isDocumentExpired(dojahParsed?.expiryDate)) {
            logger.warn(`Document for user ${userId} is expired: ${dojahParsed?.expiryDate}`);
            if (dojahParsed) {
                dojahParsed.reason = "Document has expired";
            }
            validatedDocument = false;
        }

        if (validatedDocument && !this.isNigeriaDocumentCountry({
            country: dojahParsed?.country,
            countryCode: dojahParsed?.countryCode,
        })) {
            logger.warn(
                `Document for user ${userId} is not confirmed as Nigerian: `
                + `country=${dojahParsed?.country || "unknown"}, countryCode=${dojahParsed?.countryCode || "unknown"}`,
            );
            if (dojahParsed) {
                dojahParsed.reason = dojahParsed?.country || dojahParsed?.countryCode
                    ? "DOCUMENT_COUNTRY_NOT_NIGERIA"
                    : "DOCUMENT_COUNTRY_NOT_CONFIRMED";
            }
            validatedDocument = false;
        }

        logger.log(
            `Document analysis for user ${userId}: ` +
            `valid=${validatedDocument}, ` +
            `docType=${dojahParsed?.documentType || "unknown"}, ` +
            `expiryDate=${dojahParsed?.expiryDate || "unknown"}, ` +
            `reason=${dojahParsed?.reason || "unknown"}`
        );

        const hardRejectMessage = validatedDocument
            ? null
            : this.getHardRejectDocumentMessage(dojahParsed?.reason)
                || this.mapDojahReasonToUserMessage(dojahParsed?.reason);

        if (!validatedDocument) {
            logger.log(
                `Document for user ${userId} is invalid (reason=${dojahParsed?.reason || "unknown"}), ` +
                `hasExtractedText=${dojahParsed?.hasExtractedText} — blocking submission`
            );
        }

        return {
            isDocumentValid: validatedDocument,
            hardRejectMessage,
        };
    }

    private getHardRejectDocumentMessage(reason?: string | null): string | null {
        if (!reason) {
            return null;
        }

        const upper = reason.toUpperCase();

        if (upper.includes("EXPIRED")) {
            return "Document appears to be expired. Please upload a valid, unexpired document.";
        }

        if (upper.includes("NOT_SUPPORTED") || upper.includes("UNSUPPORTED")) {
            return "This document type is not supported. Please upload a valid passport, driver's license, or national ID.";
        }

        if (upper.includes("DOCUMENT_COUNTRY_NOT_NIGERIA")) {
            return "Only Nigerian-issued documents are accepted. Please upload a valid Nigerian document.";
        }

        if (upper.includes("DOCUMENT_COUNTRY_NOT_CONFIRMED")) {
            return "We couldn't confirm that this document was issued in Nigeria. Please upload a valid Nigerian document.";
        }

        return null;
    }

    /**
     * Call Dojah document verification API with base64 images.
     * Returns a structured result, never throws.
     */
    private async callDojahDocumentVerification(
        cleanFrontBase64: string,
        cleanBackBase64: string | undefined,
        user: User,
        dto: DocumentVerificationBase64Dto,
        startTime: number,
        logger: Logger,
    ) {
        try {
            const providerBackImage = this.resolveIdentityProviderBackImage(dto.documentType, cleanBackBase64);
            const verificationResult = await this.dojahService.verifyDocumentWithNameMatch(
                {
                    inputType: "base64",
                    imageFrontSide: cleanFrontBase64,
                    ...(providerBackImage && { imageBackSide: providerBackImage }),
                },
                user.firstName,
                user.lastName
            );
            logger.log(`Dojah API completed in ${Date.now() - startTime}ms for user ${user.id}`);
            return {
                success: true,
                isValid: verificationResult.isValid,
                nameMatches: verificationResult.nameMatches,
                parsed: verificationResult.parsed,
                raw: JSON.stringify(verificationResult),
                error: null,
            };
        } catch (error) {
            logger.error(`Dojah document analysis failed for user ${user.id}`, {
                errorName: error.name,
                errorMessage: error.message,
                errorStatus: error.status,
                errorStack: error.stack,
                durationMs: Date.now() - startTime,
                payloadSize: {
                    frontImage: dto.imageFrontBase64?.length || 0,
                    backImage: dto.imageBackBase64?.length || 0,
                },
            });
            return {
                success: false,
                isValid: false,
                nameMatches: false,
                parsed: null,
                raw: null,
                error: {
                    name: error.name,
                    message: error.message,
                    status: error.status,
                },
            };
        }
    }

    private async callDojahUrlDocumentVerification(
        imageFrontSide: string,
        imageBackSide: string | undefined,
        documentType: SubmittedDocumentTypeInput,
        user: User,
        logger: Logger,
    ) {
        try {
            const providerBackImage = this.resolveIdentityProviderBackImage(documentType, imageBackSide);
            const verificationResult = await this.dojahService.verifyDocumentWithNameMatch(
                {
                    inputType: "url",
                    imageFrontSide,
                    ...(providerBackImage && { imageBackSide: providerBackImage }),
                },
                user.firstName,
                user.lastName,
            );

            return {
                success: true,
                isValid: verificationResult.isValid,
                nameMatches: verificationResult.nameMatches,
                parsed: verificationResult.parsed,
                raw: JSON.stringify(verificationResult),
            };
        } catch (error) {
            logger.warn(
                `Dojah document analysis failed for user ${user.id}, falling back to manual review: ${error instanceof Error ? error.message : String(error)}`,
            );

            return {
                success: false,
                isValid: false,
                nameMatches: false,
                parsed: null,
                raw: null,
            };
        }
    }

    /**
     * Check if a document is expired based on expiry date string
     * Returns true if expired, false if valid or no expiry date
     */
    private isDocumentExpired(expiryDateStr: string | null | undefined): boolean {
        if (!expiryDateStr) return false;

        try {
            // Parse common date formats (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY)
            let expiryDate: Date | null = null;

            if (/^\d{4}-\d{2}-\d{2}$/.test(expiryDateStr)) {
                // YYYY-MM-DD format
                expiryDate = new Date(expiryDateStr);
            } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(expiryDateStr)) {
                // DD/MM/YYYY format
                const [day, month, year] = expiryDateStr.split('/');
                expiryDate = new Date(`${year}-${month}-${day}`);
            } else if (/^\d{2}-\d{2}-\d{4}$/.test(expiryDateStr)) {
                // DD-MM-YYYY format
                const [day, month, year] = expiryDateStr.split('-');
                expiryDate = new Date(`${year}-${month}-${day}`);
            } else {
                // Try parsing as generic date
                expiryDate = new Date(expiryDateStr);
            }

            if (Number.isNaN(expiryDate.getTime())) {
                this.logger.warn(`Could not parse expiry date: ${expiryDateStr}`);
                return false;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            return expiryDate < today;
        } catch (error) {
            this.logger.warn(`Error parsing expiry date ${expiryDateStr}:`, error);
            return false;
        }
    }

    constructor(
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService,
        private readonly emailService: EmailService,
        private readonly uploadFactory: UploadFactory,
        @Inject(IdentityComplianceInjectionToken.DOJAH)
        private readonly dojahService: DojahService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        private readonly smsService: SmsService,
        private readonly sessionService: SessionService,
        private readonly twoFactorRateLimitService: TwoFactorRateLimitService,
        private readonly settingService: SettingService,
        private readonly tierService: TierService,
        private readonly redisCacheService: RedisCacheService,
        private readonly distributedLockService: DistributedLockService,
        private readonly kycStateMachine: KycStateMachineService,
        @Inject(forwardRef(() => NotificationDispatcher))
        private readonly notificationDispatcher: NotificationDispatcher,
        @Inject(forwardRef(() => WsGateway))
        private readonly wsGateway: WsGateway,
        private readonly identityResolution: IdentityResolutionService,
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    private normalizePositiveInt(value: number, fieldName: string): number {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new BadRequestException(`Invalid ${fieldName}`);
        }

        return value;
    }

    private normalizeKycStage(stage: KycStage): KycStage {
        switch (stage) {
            case KycStage.GOVERNMENT_ID:
            case KycStage.IDENTITY_DOCUMENT:
            case KycStage.ADDRESS:
            case KycStage.INCOME:
            case KycStage.BUSINESS_DOCUMENT:
                return stage;
            default:
                throw new BadRequestException("Invalid KYC stage");
        }
    }

    private normalizeRequiredBusinessText(value: string, fieldName: string): string {
        const normalized = typeof value === "string" ? value.trim() : "";
        if (!normalized) {
            throw new BadRequestException(`Invalid ${fieldName}`);
        }

        return normalized;
    }

    private normalizeOptionalBusinessText(value?: string | null): string | null {
        const normalized = typeof value === "string" ? value.trim() : "";
        return normalized || null;
    }

    private normalizeBusinessDate(value: string, fieldName: string): Date {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            throw new BadRequestException(`Invalid ${fieldName}`);
        }

        return date;
    }

    private normalizeOwnershipPercentage(value: number): number {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 5 || value > 100) {
            throw new BadRequestException("Invalid ownership percentage");
        }

        return value;
    }

    // Separated platform validation logic
    private validateLoginPlatform(
        userType: UserType,
        loginPlatform: LoginPlatform
    ): void {
        switch (loginPlatform) {
            case LoginPlatform.ADMIN:
                if (!ADMIN_USER_TYPES.includes(userType)) {
                    throw new InvalidCredentialException(
                        "Incorrect email or password",
                        HttpStatus.UNAUTHORIZED
                    );
                }
                break;
            case LoginPlatform.USER:
                if (ADMIN_USER_TYPES.includes(userType)) {
                    throw new InvalidCredentialException(
                        "Incorrect email or password",
                        HttpStatus.UNAUTHORIZED
                    );
                }
                break;
            default:
                throw new AuthGenericException(
                    "Invalid login platform",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
        }
    }

    // SECURITY: Account lockout after failed login attempts
    private readonly MAX_FAILED_ATTEMPTS = 5;
    private readonly LOCKOUT_DURATION_MINUTES = 30;

    private async handleFailedLogin(
        user: Pick<SignInUser, "id"> & Partial<SignInUser> & {
            failedLoginAttempts?: number | null;
            lastFailedLogin?: Date | null;
            lockedUntil?: Date | null;
        },
        ip: string
    ): Promise<void> {
        const now = new Date();
        const lockoutWindow = new Date(now.getTime() - this.LOCKOUT_DURATION_MINUTES * 60 * 1000);

        // Check if user is currently locked out
        if ((user as any).lockedUntil && new Date((user as any).lockedUntil) > now) {
            const remainingMinutes = Math.ceil(
                (new Date((user as any).lockedUntil).getTime() - now.getTime()) / 60000
            );
            throw new UserAccountDisabledException(
                `Account temporarily locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        // Reset counter if outside lockout window
        let failedAttempts = (user as any).failedLoginAttempts || 0;
        const lastFailedLogin = (user as any).lastFailedLogin;
        if (lastFailedLogin && new Date(lastFailedLogin) < lockoutWindow) {
            failedAttempts = 0;
        }

        failedAttempts++;

        const updateData: any = {
            failedLoginAttempts: failedAttempts,
            lastFailedLogin: now,
            ipAddress: ip,
        };

        // Lock account after MAX_FAILED_ATTEMPTS
        if (failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
            updateData.lockedUntil = new Date(now.getTime() + this.LOCKOUT_DURATION_MINUTES * 60 * 1000);

            // Also flag the account
            await this.prisma.$transaction(async (tx) => {
                const flaggedRecord = await tx.flagged.upsert({
                    where: { userId: user.id },
                    create: {
                        userId: user.id,
                        flagged: true,
                        reason: `Account locked: ${this.MAX_FAILED_ATTEMPTS} failed login attempts`,
                    },
                    update: {
                        flagged: true,
                        reason: `Account locked: ${this.MAX_FAILED_ATTEMPTS} failed login attempts`,
                        updatedAt: now,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        ...updateData,
                        flaggedId: flaggedRecord.id,
                    },
                });
            });

            this.logger.warn(`Account locked for user ${user.id} after ${this.MAX_FAILED_ATTEMPTS} failed attempts from IP: ${ip}`);

            throw new UserAccountDisabledException(
                `Account temporarily locked due to too many failed attempts. Try again in ${this.LOCKOUT_DURATION_MINUTES} minutes.`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: updateData,
        });
    }

    async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, this.SALT_ROUNDS);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    /**
     * Get default security methods structure
     */
    private getDefaultSecurityMethods() {
        return {
            sms: false,
            email: false,
            authenticator: false,
            tradingPassword: false,
        };
    }

    /**
     * Get or create security methods for a user by email
     */
    private async getOrCreateSecurityMethods(email: string, _methodType: 'email' | 'sms') {
        const user = await this.prisma.user.findUnique({
            where: { email },
            select: { securityMethods: true },
        });
        return (user?.securityMethods as any) || this.getDefaultSecurityMethods();
    }

    /**
     * Get or create security methods for a user by phone
     */
    private async getOrCreateSecurityMethodsByPhone(phone: string) {
        const user = await this.prisma.user.findUnique({
            where: { phone },
            select: { securityMethods: true },
        });
        return (user?.securityMethods as any) || this.getDefaultSecurityMethods();
    }

    async generateTokens(payload: any) {
        const accessToken = await this.jwtService.signAsync(payload, {
            secret: jwtSecret,
            expiresIn: TOKEN_EXPIRATION,
        });

        const refreshToken = await this.jwtService.signAsync(payload, {
            secret: jwt_refresh_secret,
            expiresIn: REFRESH_TOKEN_EXPIRATION,
        });

        return { accessToken, refreshToken };
    }

    async requestPasswordReset(
        dto: SendForgotPasswordDto
    ): Promise<ApiResponse> {
        const email = dto.email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email },
        });
        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        const userId = this.normalizePositiveInt(user.id, "password reset user id");

        const code = crypto.randomBytes(4).toString("hex").toUpperCase();

        await this.prisma.$executeRaw`
            DELETE FROM "PasswordResetRequests"
            WHERE "userId" = ${userId}
        `;

        await this.prisma.passwordResetRequest.create({
            data: {
                userId,
                code: code,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });

        const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
        const username = user.email;
        const team = COMPANY_NAME;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: email } }],
                template_key: emailTemplateConfig.forgot_password,
                merge_info: {
                    name,
                    product_name: COMPANY_NAME,
                    otp: code,                  // Use otp instead of password_reset_link
                    expiry_minutes: "30",       // Match template variable
                    username,
                    team,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to send password reset email: ${errorMessage}`);
            throw new AuthGenericException(
                "Failed to send password reset email",
                HttpStatus.BAD_REQUEST,
                {
                    cause: error instanceof Error ? error : new Error(errorMessage),
                }
            );
        }

        return buildResponse({
            message: "Password reset email sent successfully",
            data: { email },
        });
    }

    async resetPassword(dto: ResetPasswordDto): Promise<ApiResponse> {
        const email = dto.email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email },
            include: { passwordResetRequest: true },
        });

        if (!user?.passwordResetRequest) {
            throw new InvalidResetRequestException(
                "Invalid password reset request"
            );
        }

        const resetCodeMatch =
            user.passwordResetRequest.code.length === dto.resetCode.length &&
            crypto.timingSafeEqual(
                Buffer.from(user.passwordResetRequest.code, "utf8"),
                Buffer.from(dto.resetCode, "utf8")
            );
        if (!resetCodeMatch) {
            throw new InvalidResetCodeException("Invalid reset code");
        }

        const createdAt = user.passwordResetRequest.createdAt;
        if (Date.now() - createdAt.getTime() > 30 * 60 * 1000) {
            await this.prisma.passwordResetRequest.delete({
                where: { userId: user.id },
            });
            throw new ResetCodeExpiredException("Reset code has expired");
        }

        const isSameAsCurrentPassword = await this.comparePassword(
            dto.password,
            user.password
        );

        if (isSameAsCurrentPassword) {
            throw new InvalidResetRequestException(
                "Your new password must be different from your current password",
                HttpStatus.BAD_REQUEST
            );
        }

        const hashedPassword = await this.hashPassword(dto.password);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                passwordChangedAt: new Date(),
                updatedAt: new Date(),
            },
        });

        await this.prisma.passwordResetRequest.delete({
            where: { userId: user.id },
        });

        return buildResponse({
            message: "Password reset successfully",
        });
    }

    async validateAdminInvite(dto: ValidateAdminInviteDto): Promise<ApiResponse> {
        const token = dto.token.trim();

        const invite = await (this.prisma as any).adminInvite.findUnique({
            where: { token },
            include: {
                role: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
        });

        if (!invite || invite.acceptedAt) {
            throw new InvalidAdminInviteException();
        }

        if (invite.expiresAt.getTime() < Date.now()) {
            throw new AdminInviteExpiredException();
        }

        return buildResponse({
            message: "Admin invite is valid",
            data: {
                email: invite.email,
                firstName: invite.firstName,
                lastName: invite.lastName,
                role: invite.role,
                expiresAt: invite.expiresAt,
            },
        });
    }

    async acceptAdminInvite(dto: AcceptAdminInviteDto): Promise<ApiResponse> {
        const token = dto.token.trim();
        const phone = dto.phone.trim();

        const invite = await (this.prisma as any).adminInvite.findUnique({
            where: { token },
            include: {
                role: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        isAdmin: true,
                    },
                },
            },
        });

        if (!invite || invite.acceptedAt) {
            throw new InvalidAdminInviteException();
        }

        if (invite.expiresAt.getTime() < Date.now()) {
            throw new AdminInviteExpiredException();
        }

        const existingUser = await this.prisma.user.findUnique({
            where: { email: invite.email },
        });

        if (existingUser) {
            throw new DuplicateUserException(
                "An account with this email already exists. Please login",
                HttpStatus.BAD_REQUEST,
            );
        }

        if (!invite.role.isAdmin) {
            throw new RoleNotFoundException(
                "Admin role not found",
                HttpStatus.NOT_FOUND,
            );
        }

        const existingPhone = await this.prisma.user.findUnique({
            where: { phone },
            select: { id: true },
        });

        if (existingPhone) {
            throw new DuplicateUserException(
                "Phone number is already in use",
                HttpStatus.BAD_REQUEST,
            );
        }

        const hashedPassword = await this.hashPassword(dto.password);
        const identifier = generateId({ type: "identifier" });

        const [admin] = await this.prisma.$transaction([
            this.prisma.user.create({
                data: {
                    identifier,
                    firstName: invite.firstName,
                    lastName: invite.lastName,
                    email: invite.email,
                    phone,
                    password: hashedPassword,
                    userType: this.deriveAdminUserType(invite.role.slug),
                    roleId: invite.roleId,
                    isEmailVerified: true,
                    isPasswordCreated: true,
                    status: Status.ACTIVE,
                },
                select: {
                    id: true,
                    identifier: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    role: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                    createdAt: true,
                },
            }),
            (this.prisma as any).adminInvite.update({
                where: { id: invite.id },
                data: { acceptedAt: new Date() },
            }),
        ]);

        this.logger.log(`Admin invite accepted for ${invite.email}`);

        return buildResponse({
            message: "Admin account created successfully",
            data: admin,
        });
    }

    async signUp(options: SignUpDto, ip: string): Promise<ApiResponse> {
        const email = options.email.toLowerCase().trim();
        const existingUser = await this.prisma.user.findUnique({
            where: { email },
            include: {
                flaggedRecord: true
            }
        });

        // Allow re-registration if user was deleted
        if (existingUser && !existingUser.isDeleted) {
            throw new DuplicateUserException(
                "An account with this email already exist. Please login",
                HttpStatus.BAD_REQUEST
            );
        }

        // Security: Prevent blocked/flagged users from bypassing bans via re-registration
        if (existingUser?.isDeleted) {
            // Check if user was blocked
            if (existingUser.status === Status.BLOCKED) {
                throw new UserAccountDisabledException(
                    "This account has been permanently blocked. Please contact support.",
                    HttpStatus.FORBIDDEN
                );
            }

            // Check if user was flagged
            if (existingUser.flaggedRecord?.flagged) {
                throw new UserAccountDisabledException(
                    `This account has been flagged: ${existingUser.flaggedRecord.reason || 'Policy violation'}. Please contact support.`,
                    HttpStatus.FORBIDDEN
                );
            }

            // Allow re-registration for non-blocked, non-flagged deleted accounts
            Logger.log(`Removing deleted account for re-registration: ${existingUser.email}`);
            await this.prisma.user.delete({
                where: { id: existingUser.id },
            });
        }

        // Validate role exists
        const role = await this.prisma.role.findUnique({
            where: {
                slug: options.accountType.toLowerCase(),
            },
        });

        if (!role) {
            throw new RoleNotFoundException(
                "Role not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Store signup data in Redis instead of creating user
        const cacheKey = `pending_signup:${email}`;
        const signupData = {
            ...options,
            email, // Store normalized email
            residentialAddress: options.residentialAddress?.trim() || null,
            ipAddress: ip,
            roleId: role.id
        };

        await this.redisCacheService.set(cacheKey, signupData, this.SIGNUP_CACHE_TTL);

        // DO NOT send email here. It will be sent when user selects verification method.

        return buildResponse({
            message: "Account initialization successful. Please proceed to verification.",
        });
    }

    async sendAccountVerificationEmail(
        options: SendEmailVerificationCodeDto
    ): Promise<ApiResponse> {
        const verificationCode = customAlphabet("1234567890", 6)();
        const email = options.email.toLowerCase().trim();

        // Check if user exists in DB
        const emailExist = await this.prisma.user.findUnique({
            where: { email: email },
            select: { id: true, isEmailVerified: true, firstName: true },
        });

        let firstName: string;

        if (emailExist) {
            // Case 1: User already exists
            if (emailExist.isEmailVerified) {
                throw new DuplicateUserException(
                    "Account already verified. Kindly login",
                    HttpStatus.BAD_REQUEST
                );
            }
            firstName = emailExist.firstName || "User";
        } else {
            // Case 2: Check Redis for pending signup
            const cacheKey = `pending_signup:${email}`;
            const cachedSignup = await this.redisCacheService.get<any>(cacheKey);

            if (!cachedSignup) {
                throw new UserNotFoundException(
                    "Account with email not found. Kindly register first",
                    HttpStatus.BAD_REQUEST
                );
            }
            firstName = cachedSignup.firstName || "User";
        }

        await this.prisma.accountVerificationRequest.upsert({
            where: {
                email: options.email,
            },
            create: {
                code: verificationCode,
                email: options.email,
            },
            update: {
                code: verificationCode,
            },
        });

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: options.email } }],
                template_key: emailTemplateConfig.verify_account,
                merge_info: {
                    otp: verificationCode, // Matches {{otp}}
                    expiry_minutes: "10",  // Matches {{expiry_minutes}}
                    name: firstName,       // Matches {{name}}
                    product_name: COMPANY_NAME,
                    team: COMPANY_NAME,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to send account verification email: ${errorMessage}`);
            throw new AuthGenericException(
                "Failed to send account verification email",
                HttpStatus.BAD_REQUEST,
                {
                    cause: error instanceof Error ? error : new Error(errorMessage),
                }
            );
        }

        return buildResponse({
            message: `An email verification code has been sent to your email, ${options.email}`,
            data: {
                email: options.email,
            },
        });
    }

    async verifyEmailOtp(options: VerifyEmailOtpDto): Promise<ApiResponse> {
        const email = options.email.toLowerCase().trim();
        let user: User;
        let isNewUser = false;

        // Check if user exists in DB
        const emailExist = await this.prisma.user.findUnique({
            where: { email },
        });

        if (emailExist) {
            if (emailExist.isEmailVerified) {
                throw new DuplicateUserException(
                    "Account already verified. Kindly login",
                    HttpStatus.BAD_REQUEST
                );
            }
        } else {
            // Check Redis for pending signup
            const cacheKey = `pending_signup:${email}`;
            const cachedSignup = await this.redisCacheService.get<any>(cacheKey);

            if (!cachedSignup) {
                throw new UserNotFoundException(
                    "Account with email not found or signup session expired. Kindly register again",
                    HttpStatus.BAD_REQUEST
                );
            }
            isNewUser = true;
        }

        const verificationData =
            await this.prisma.accountVerificationRequest.findUnique({
                where: {
                    email_code: { email, code: options.otp },
                },
            });

        if (!verificationData) {
            throw new InvalidEmailVerificationCodeException(
                "Invalid verification code",
                HttpStatus.BAD_REQUEST
            );
        }

        // SECURITY: OTP codes expire after 10 minutes
        const TEN_MINUTES_MS = 10 * 60 * 1000;
        const timeDifference =
            Date.now() - verificationData.updatedAt.getTime();

        if (timeDifference > TEN_MINUTES_MS) {
            // Clean up expired code
            await this.prisma.accountVerificationRequest.delete({
                where: { email },
            }).catch(() => { }); // Ignore if already deleted

            throw new VerificationCodeExpiredException(
                "Your verification code has expired (valid for 10 minutes). Please request a new one.",
                HttpStatus.BAD_REQUEST
            );
        }

        if (isNewUser) {
            // Create the user now
            const cacheKey = `pending_signup:${email}`;
            const cachedSignup = await this.redisCacheService.get<any>(cacheKey); // Fetch again to be safe

            const createUserOptions: Prisma.UserUncheckedCreateInput = {
                email: cachedSignup.email,
                identifier: generateId({ type: "identifier" }),
                userType: cachedSignup.accountType,
                roleId: cachedSignup.roleId,
                ipAddress: cachedSignup.ipAddress,
                firstName: cachedSignup.firstName,
                lastName: cachedSignup.lastName,
                businessName: cachedSignup.businessName?.trim() || null,
                dateOfBirth: new Date(cachedSignup.dateOfBirth),
                residentialAddress: cachedSignup.residentialAddress?.trim() || null,
                isEmailVerified: true,
                securityMethods: {
                    sms: false,
                    email: true, // Enable email as security method
                    authenticator: false,
                    tradingPassword: false,
                },
            };

            user = await this.prisma.user.create({
                data: createUserOptions,
            });

            // Clean up Redis
            await this.redisCacheService.del(cacheKey);
        } else {
            // Update existing user
            user = await this.prisma.user.update({
                where: { email },
                data: {
                    isEmailVerified: true,
                    // Auto-enable email as a security method
                    securityMethods: {
                        ...await this.getOrCreateSecurityMethods(email, 'email'),
                        email: true,
                    },
                },
            });
        }

        await this.prisma.accountVerificationRequest.delete({
            where: { email },
        });

        // Sync tier & flush profile cache after email verification
        await this.tierService.syncTierAndCache(user.id);

        // Generate tokens for auto-login
        const tokens = await this.generateTokens({
            sub: user.id,
        });
        await this.saveRefreshToken(user.id, tokens.refreshToken);

        return buildResponse({
            message: "Email verification completed",
            data: tokens, // Return tokens to allow auto-login on frontend
        });
    }

    async sendPhoneVerificationOtp(
        user: User,
        options: SendPhoneVerificationCodeDto
    ): Promise<ApiResponse> {
        const verificationCode = customAlphabet("1234567890", 6)();

        if (user.isPhoneVerified) {
            throw new DuplicateVerificationException(
                "Phone number is already verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const alreadyInUse = await this.prisma.user.findFirst({
            where: { id: { not: user.id }, phone: options.phone },
        });

        if (alreadyInUse) {
            throw new VerificationGenericException(
                "Phone is already in use by another account",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { phone: options.phone },
        });

        await this.prisma.phoneVerificationRequest.upsert({
            where: {
                phone: options.phone,
            },
            create: {
                code: verificationCode,
                phone: options.phone,
            },
            update: {
                code: verificationCode,
            },
        });

        // Send verification code via SMS
        await this.smsService.sendVerificationCode(options.phone, verificationCode);

        return buildResponse({
            message: `A phone verification code has been sent to your phone, ${options.phone}`,
            data: {
                phone: options.phone,
            },
        });
    }

    async verifyPhoneOtp(
        user: User,
        options: VerifyPhoneOtpDto
    ): Promise<ApiResponse> {
        if (user.isPhoneVerified) {
            throw new DuplicateVerificationException(
                "Phone number already verified",
                HttpStatus.BAD_REQUEST
            );
        }

        const verificationData =
            await this.prisma.phoneVerificationRequest.findUnique({
                where: {
                    phone_code: { phone: options.phone, code: options.otp },
                },
            });

        if (!verificationData) {
            throw new InvalidVerificationCodeException(
                "Invalid phone verification code",
                HttpStatus.BAD_REQUEST
            );
        }

        // SECURITY: Phone OTP codes expire after 5 minutes
        const FIVE_MINUTES_MS = 5 * 60 * 1000;
        const timeDifference =
            Date.now() - verificationData.updatedAt.getTime();

        if (timeDifference > FIVE_MINUTES_MS) {
            throw new VerificationCodeExpiredException(
                "Your verification code has expired (valid for 5 minutes). Please request a new one.",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { phone: options.phone },
            data: {
                isPhoneVerified: true,
                // Auto-enable SMS as a security method
                securityMethods: {
                    ...await this.getOrCreateSecurityMethodsByPhone(options.phone),
                    sms: true,
                },
            },
        });

        await this.prisma.phoneVerificationRequest.delete({
            where: { phone: options.phone },
        });

        return buildResponse({
            message: "Phone verification completed",
        });
    }

    async createPassword(user: User, dto: CreatePasswordDto) {
        const hashedPassword = await this.hashPassword(dto.password);
        await this.prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword, isPasswordCreated: true },
        });
        return buildResponse({
            message: "Password created successfully",
        });
    }

    private sendDocumentAutoApprovalNotifications(
        userId: number,
        userEmail: string,
        firstName: string,
        documentType: string,
        logger: Logger,
    ): void {
        if (emailTemplateConfig.document_approved) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: userEmail } }],
                template_key: emailTemplateConfig.document_approved,
                merge_info: {
                    first_name: firstName || "User",
                    document_type: documentType,
                    company_name: COMPANY_NAME,
                    rejection_reason: "",
                    status: "Approved",
                },
            }).catch((e) => logger.error(`[KYC][DOCUMENT] Failed to send approval email for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));
        }
        this.notificationDispatcher.notify({
            userId,
            title: "Document Verified",
            body: "Your identity document has been verified successfully.",
            category: "security",
            enablePush: true,
        }).catch((e) => logger.error(`[KYC][DOCUMENT] Failed to send notification for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));
        this.wsGateway.notifyProfileUpdate(userId);
    }

    private sendPendingReviewEmail(
        userId: number,
        userEmail: string,
        firstName: string,
        documentType: string,
    ): void {
        if (userEmail && emailTemplateConfig.document_pending_review) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: userEmail } }],
                template_key: emailTemplateConfig.document_pending_review,
                merge_info: {
                    name: firstName || "User",
                    document_type: documentType,
                    company_name: COMPANY_NAME,
                },
            }).catch((e) => this.logger.error(`[KYC] Failed to send pending review email for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));
        }
    }

    private sendDocumentAutoRejectNotifications(
        userId: number,
        userEmail: string,
        firstName: string,
        documentType: string,
        rejectionReason: string,
        logger: Logger,
    ): void {
        if (userEmail && emailTemplateConfig.document_rejected) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: userEmail } }],
                template_key: emailTemplateConfig.document_rejected,
                merge_info: {
                    first_name: firstName || "User",
                    document_type: documentType,
                    company_name: COMPANY_NAME,
                    rejection_reason: rejectionReason,
                    status: "Rejected",
                },
            }).catch((e) => logger.error(`[KYC][DOCUMENT] Failed to send rejection email for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));
        }

        this.notificationDispatcher.notify({
            userId,
            title: "Document Rejected",
            body: rejectionReason,
            category: "security",
            enablePush: true,
        }).catch((e) => logger.error(`[KYC][DOCUMENT] Failed to send rejection notification for user ${userId}: ${e instanceof Error ? e.message : String(e)}`));

        this.wsGateway.notifyProfileUpdate(userId);
    }

    private getGovernmentIdentityRejectMessage(identityType: "BVN" | "NIN"): string {
        return `The submitted ${identityType} details do not match your profile. Please submit the correct ${identityType} that belongs to you and matches your name and date of birth.`;
    }

    private getGovernmentIdentityPendingReviewMessage(identityType: "BVN" | "NIN"): string {
        return `We couldn't confidently compare the submitted ${identityType} details to your profile. Your verification has been sent for manual review.`;
    }

    private async handleGovernmentIdentityAutoReject(params: {
        user: User;
        result: any;
        identityType: "BVN" | "NIN";
        identifier: string;
        hasComparableName: boolean;
        hasComparableDob: boolean;
        nameMatchDetail: string | null;
        dobMatches: boolean | null;
    }): Promise<GovernmentIdentityMatchResult> {
        const reasonMessage = this.getGovernmentIdentityRejectMessage(params.identityType);

        this.logger.warn(`[KYC][${params.identityType}] User data mismatch for user ${params.user.id} after Dojah response`);
        await this.persistGovernmentStageAttempt({
            user: params.user,
            identityType: params.identityType,
            identifier: params.identifier,
            status: KycAttemptStatus.REJECTED,
            providerStatus: KycProviderStatus.FAILED,
            decisionMode: KycDecisionMode.AUTO,
            providerRef: params.result?.data?.entity?.reference_id,
            providerRawResponse: params.result?.data,
            reasonMessage,
            reasonDetails: {
                hasComparableName: params.hasComparableName,
                hasComparableDob: params.hasComparableDob,
                nameMatchDetail: params.nameMatchDetail,
                dobMatches: params.dobMatches,
            },
            eventType: KycAttemptEventType.REJECTED,
            eventActorType: KycActorType.SYSTEM,
            eventNote: reasonMessage,
            eventPayload: {
                source: "PROVIDER_GOVERNMENT_ID_CHECK",
                verificationType: params.identityType,
                identifier: this.maskSensitiveId(params.identifier),
                outcome: "REJECTED",
                providerRef: params.result?.data?.entity?.reference_id ?? null,
                hasComparableName: params.hasComparableName,
                hasComparableDob: params.hasComparableDob,
                nameMatchDetail: params.nameMatchDetail,
                dobMatches: params.dobMatches,
            },
        });
        await this.redisCacheService.del(this.getProfileCacheKey(params.user.id));

        this.notificationDispatcher.notify({
            userId: params.user.id,
            title: "Identity Verification Unsuccessful",
            body: reasonMessage,
            category: "security",
            enablePush: true,
        }).catch((e) => this.logger.error(`[KYC][${params.identityType}] Failed to send rejection notification for user ${params.user.id}: ${e instanceof Error ? e.message : String(e)}`));

        if (params.user.email && emailTemplateConfig.document_rejected) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: params.user.email } }],
                template_key: emailTemplateConfig.document_rejected,
                merge_info: {
                    first_name: params.user.firstName || "User",
                    document_type: params.identityType,
                    company_name: COMPANY_NAME,
                    rejection_reason: reasonMessage,
                    status: "Rejected",
                },
            }).catch((e) => this.logger.error(`[KYC][${params.identityType}] Failed to send rejection email for user ${params.user.id}: ${e instanceof Error ? e.message : String(e)}`));
        }

        return {
            disposition: "AUTO_REJECT",
            responseMessage: reasonMessage,
            reasonMessage,
        };
    }

    private async handleGovernmentIdentityManualReview(params: {
        user: User;
        result: any;
        identityType: "BVN" | "NIN";
        identifier: string;
        hasComparableName: boolean;
        hasComparableDob: boolean;
        nameMatchDetail: string | null;
        dobMatches: boolean | null;
    }): Promise<GovernmentIdentityMatchResult> {
        const currentAttemptStatus = await this.getCurrentGovernmentAttemptStatus(params.user.id, params.identityType);
        const eventType = currentAttemptStatus === KycAttemptStatus.REJECTED
            || currentAttemptStatus === KycAttemptStatus.EXPIRED
            ? KycAttemptEventType.RESUBMITTED
            : KycAttemptEventType.SUBMITTED;
        const reviewMessage = this.getGovernmentIdentityPendingReviewMessage(params.identityType);
        const reviewNote = `Manual review needed: hasComparableName=${params.hasComparableName}, hasComparableDob=${params.hasComparableDob}, nameMatches=${params.nameMatchDetail ? "evaluated" : "unknown"}, dobMatches=${params.dobMatches ?? "unknown"}`;

        this.logger.warn(`[KYC][${params.identityType}] Incomplete provider identity data for user ${params.user.id}; routing to manual review`);
        await this.persistGovernmentStageAttempt({
            user: params.user,
            identityType: params.identityType,
            identifier: params.identifier,
            status: KycAttemptStatus.PENDING_REVIEW,
            providerStatus: KycProviderStatus.INCONCLUSIVE,
            decisionMode: KycDecisionMode.MANUAL,
            providerRef: params.result?.data?.entity?.reference_id,
            providerRawResponse: params.result?.data,
            reasonMessage: reviewMessage,
            reasonDetails: {
                hasComparableName: params.hasComparableName,
                hasComparableDob: params.hasComparableDob,
                nameMatchDetail: params.nameMatchDetail,
                dobMatches: params.dobMatches,
            },
            eventType,
            eventActorType: KycActorType.SYSTEM,
            eventNote: reviewNote,
            eventPayload: {
                source: "PROVIDER_GOVERNMENT_ID_CHECK",
                verificationType: params.identityType,
                identifier: this.maskSensitiveId(params.identifier),
                outcome: eventType,
                providerRef: params.result?.data?.entity?.reference_id ?? null,
                hasComparableName: params.hasComparableName,
                hasComparableDob: params.hasComparableDob,
                nameMatchDetail: params.nameMatchDetail,
                dobMatches: params.dobMatches,
            },
        });
        await this.redisCacheService.del(this.getProfileCacheKey(params.user.id));

        this.notificationDispatcher.notify({
            userId: params.user.id,
            title: "Identity Verification Under Review",
            body: reviewMessage,
            category: "security",
            enablePush: true,
        }).catch((e) => this.logger.error(`[KYC][${params.identityType}] Failed to send pending notification for user ${params.user.id}: ${e instanceof Error ? e.message : String(e)}`));

        if (params.user.email && emailTemplateConfig.document_pending_review) {
            this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: params.user.email } }],
                template_key: emailTemplateConfig.document_pending_review,
                merge_info: {
                    name: params.user.firstName || "User",
                    document_type: params.identityType,
                    company_name: COMPANY_NAME,
                },
            }).catch((e) => this.logger.error(`[KYC][${params.identityType}] Failed to send pending review email for user ${params.user.id}: ${e instanceof Error ? e.message : String(e)}`));
        }

        return {
            disposition: "MANUAL_REVIEW",
            responseMessage: reviewMessage,
            reasonMessage: reviewMessage,
        };
    }

    private normalizeSubmittedDocumentType(value: SubmittedDocumentTypeInput = null): DocumentType | null {
        if (!value) {
            return null;
        }

        if (value === DocumentType.INTERNATIONAL_PASSPORT) {
            return DocumentType.INTERNATIONAL_PASSPORT;
        }

        if (value === DocumentType.DRIVER_LICENSE) {
            return DocumentType.DRIVER_LICENSE;
        }

        if (value === DocumentType.NIN) {
            return DocumentType.NIN;
        }

        const normalized = String(value)
            .trim()
            .toLowerCase()
            .replaceAll(/[_-]+/g, " ");

        if (normalized.includes("passport")) {
            return DocumentType.INTERNATIONAL_PASSPORT;
        }

        if (normalized.includes("driver") || normalized.includes("license")) {
            return DocumentType.DRIVER_LICENSE;
        }

        if (normalized.includes("nin") || normalized.includes("national")) {
            return DocumentType.NIN;
        }

        return null;
    }

    private shouldSendIdentityBackImageToProvider(documentType: SubmittedDocumentTypeInput = null): boolean {
        const normalizedDocumentType = this.normalizeSubmittedDocumentType(documentType);

        return normalizedDocumentType !== DocumentType.INTERNATIONAL_PASSPORT
            && normalizedDocumentType !== DocumentType.DRIVER_LICENSE
            && normalizedDocumentType !== DocumentType.NIN;
    }

    private resolveIdentityProviderBackImage(
        documentType: SubmittedDocumentTypeInput = null,
        imageBackSide?: string,
    ): string | undefined {
        if (!imageBackSide || !this.shouldSendIdentityBackImageToProvider(documentType)) {
            return undefined;
        }

        return imageBackSide;
    }

    private formatSubmittedDocumentTypeLabel(value: SubmittedDocumentTypeInput = null): string {
        switch (this.normalizeSubmittedDocumentType(value)) {
            case DocumentType.INTERNATIONAL_PASSPORT:
                return "Passport";
            case DocumentType.DRIVER_LICENSE:
                return "Driver's License";
            case DocumentType.NIN:
                return "NIN Slip";
            default:
                return "document";
        }
    }

    private formatSubmittedDocumentTypePromptLabel(value: SubmittedDocumentTypeInput = null): string {
        switch (this.normalizeSubmittedDocumentType(value)) {
            case DocumentType.INTERNATIONAL_PASSPORT:
                return "passport";
            case DocumentType.DRIVER_LICENSE:
                return "driver's license";
            case DocumentType.NIN:
                return "NIN slip";
            default:
                return "document";
        }
    }

    private assessSubmittedIdentityDocumentType(
        expectedDocumentType: SubmittedDocumentTypeInput = null,
        providerDocumentType: SubmittedDocumentTypeInput = null,
    ): IdentityDocumentTypeAssessment {
        const expected = this.normalizeSubmittedDocumentType(expectedDocumentType);
        const detected = this.normalizeSubmittedDocumentType(providerDocumentType);

        if (!expected || !detected) {
            return {
                expectedDocumentType: expected,
                detectedDocumentType: detected,
                matches: null,
                message: null,
            };
        }

        if (expected === detected) {
            return {
                expectedDocumentType: expected,
                detectedDocumentType: detected,
                matches: true,
                message: null,
            };
        }

        const expectedLabel = this.formatSubmittedDocumentTypePromptLabel(expected);

        return {
            expectedDocumentType: expected,
            detectedDocumentType: detected,
            matches: false,
            message: `Wrong document. Please upload a valid ${expectedLabel}.`,
        };
    }

    private normalizeSubmittedDocumentNumber(value?: string | null): string | null {
        if (!value) {
            return null;
        }

        const normalized = value.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase();
        return normalized || null;
    }

    private resolveIdentityPreviewOutcome(
        isDocumentTypeMismatch: boolean,
        previewIsValid: boolean,
    ): "BLOCKED" | "READY" | "REVIEW_LIKELY" {
        if (isDocumentTypeMismatch) {
            return "BLOCKED";
        }

        if (previewIsValid) {
            return "READY";
        }

        return "REVIEW_LIKELY";
    }

    private resolveIdentityPreviewReasonCode(
        isDocumentTypeMismatch: boolean,
        previewIsValid: boolean,
    ): "DOCUMENT_TYPE_MISMATCH" | "DOCUMENT_INVALID" | null {
        if (isDocumentTypeMismatch) {
            return "DOCUMENT_TYPE_MISMATCH";
        }

        if (previewIsValid) {
            return null;
        }

        return "DOCUMENT_INVALID";
    }

    private resolveIdentityPreviewIsValid(
        documentTypeAssessment: IdentityDocumentTypeAssessment,
        reviewDisposition: DocumentReviewDisposition,
    ): boolean {
        if (documentTypeAssessment.matches === false) {
            return false;
        }

        return reviewDisposition.isDocumentValid;
    }

    private resolveIdentityPreviewMessage(params: {
        documentTypeAssessment: IdentityDocumentTypeAssessment;
        previewIsValid: boolean;
        reviewDisposition: DocumentReviewDisposition;
        providerReason?: string | null;
    }): string {
        if (params.documentTypeAssessment.message) {
            return params.documentTypeAssessment.message;
        }

        if (params.previewIsValid) {
            return "Document upload completed.";
        }

        return params.reviewDisposition.hardRejectMessage
            || this.mapDojahReasonToUserMessage(params.providerReason);
    }

    private resolveIdentityPreviewProviderStatus(previewIsValid: boolean): "PASSED" | "FAILED" {
        if (previewIsValid) {
            return "PASSED";
        }

        return "FAILED";
    }

    private resolveIdentityPreviewReason(
        isDocumentTypeMismatch: boolean,
        providerReason?: string | null,
    ): string | null | undefined {
        if (isDocumentTypeMismatch) {
            return "DOCUMENT_TYPE_MISMATCH";
        }

        return providerReason;
    }

    private buildIdentityPreviewAutofill(documentNumber?: string | null): { documentNumber: string } | null {
        if (!documentNumber) {
            return null;
        }

        return { documentNumber };
    }

    private stripImageBase64Prefix(base64String: string): string {
        return base64String.replace(/^data:image\/\w+;base64,/, "");
    }

    private stripOptionalImageBase64Prefix(base64String?: string | null): string | undefined {
        if (!base64String) {
            return undefined;
        }

        return this.stripImageBase64Prefix(base64String);
    }

    private resolveStoredDocumentNumber(
        submittedDocumentNumber?: string | null,
        extractedDocumentNumber?: string | null,
    ): string | null {
        const submittedValue = submittedDocumentNumber?.trim();
        if (submittedValue) {
            return submittedValue;
        }

        const extractedValue = extractedDocumentNumber?.trim();
        return extractedValue || null;
    }

    private buildIdentityDocumentDecision(params: BuildIdentityDocumentDecisionParams): IdentityDocumentDecision {
        const providerDocumentNumber = typeof params.dojahParsed?.documentNumber === "string"
            ? params.dojahParsed.documentNumber
            : null;
        const expectedDocumentNumber = this.normalizeSubmittedDocumentNumber(params.documentNumber);
        const extractedDocumentNumber = this.normalizeSubmittedDocumentNumber(providerDocumentNumber);
        const profileDocumentNumber = this.normalizeSubmittedDocumentNumber(params.profileDocumentNumber);
        const documentNumberMatches = expectedDocumentNumber && extractedDocumentNumber
            ? expectedDocumentNumber === extractedDocumentNumber
            : null;
        const profileDocumentNumberMatches = profileDocumentNumber && extractedDocumentNumber
            ? profileDocumentNumber === extractedDocumentNumber
            : null;
        const hasComparableName = Boolean(
            (params.dojahParsed?.firstName || params.dojahParsed?.givenNames)
            && params.dojahParsed?.lastName,
        );
        const hasComparableDob = Boolean(params.dojahParsed?.dateOfBirth);
        const hasExtractedText = Boolean(
            params.dojahParsed?.hasExtractedText
            || hasComparableName
            || params.dojahParsed?.documentNumber
            || hasComparableDob,
        );

        const decisionContextDetails = {
            providerDocumentNumber,
            documentNumberMatches,
            profileDocumentNumber,
            profileDocumentNumberMatches,
            hasExtractedText,
            hasComparableName,
            hasComparableDob,
        };

        if (!params.isDocumentValid) {
            const userReasonMessage = params.hardRejectMessage
                || this.mapDojahReasonToUserMessage(params.dojahParsed?.reason);

            return {
                disposition: "AUTO_REJECT",
                attemptStatus: KycAttemptStatus.REJECTED,
                verificationStatus: DocumentVerificationStatus.DECLINED,
                providerStatus: KycProviderStatus.FAILED,
                decisionMode: KycDecisionMode.AUTO,
                responseMessage: userReasonMessage,
                attemptReasonCode: this.mapIndividualAttemptReasonCode(userReasonMessage),
                attemptReasonMessage: userReasonMessage,
                submissionNote: null,
                decisionEventType: KycAttemptEventType.REJECTED,
                decisionEventNote: userReasonMessage,
                decisionContext: this.createIdentityDocumentDecisionContext(
                    params,
                    "AUTO_REJECT",
                    decisionContextDetails,
                ),
                notificationTitle: "Document Rejected",
                notificationBody: userReasonMessage,
                emailRejectionReason: userReasonMessage,
            };
        }

        const hasProfileNinMismatch = params.documentType === DocumentType.NIN
            && Boolean(profileDocumentNumber)
            && Boolean(extractedDocumentNumber)
            && profileDocumentNumber !== extractedDocumentNumber;

        if (hasProfileNinMismatch) {
            const userReasonMessage = "The NIN on the uploaded slip does not match the NIN verified on your profile. Please upload the correct NIN slip that belongs to you.";

            return {
                disposition: "AUTO_REJECT",
                attemptStatus: KycAttemptStatus.REJECTED,
                verificationStatus: DocumentVerificationStatus.DECLINED,
                providerStatus: KycProviderStatus.FAILED,
                decisionMode: KycDecisionMode.AUTO,
                responseMessage: userReasonMessage,
                attemptReasonCode: "PROFILE_NIN_MISMATCH",
                attemptReasonMessage: userReasonMessage,
                submissionNote: null,
                decisionEventType: KycAttemptEventType.REJECTED,
                decisionEventNote: userReasonMessage,
                decisionContext: this.createIdentityDocumentDecisionContext(
                    params,
                    "AUTO_REJECT",
                    decisionContextDetails,
                ),
                notificationTitle: "Document Rejected",
                notificationBody: userReasonMessage,
                emailRejectionReason: userReasonMessage,
            };
        }

        if (params.isDocumentValid && params.documentProfileMatch.profileMatches) {
            return {
                disposition: "APPROVE",
                attemptStatus: KycAttemptStatus.APPROVED,
                verificationStatus: DocumentVerificationStatus.VERIFIED,
                providerStatus: KycProviderStatus.PASSED,
                decisionMode: KycDecisionMode.AUTO,
                responseMessage: "Document verified successfully",
                attemptReasonCode: null,
                attemptReasonMessage: null,
                submissionNote: null,
                decisionEventType: KycAttemptEventType.APPROVED,
                decisionEventNote: "Auto-approved: document valid, name matched, and DOB matched",
                decisionContext: this.createIdentityDocumentDecisionContext(
                    params,
                    "APPROVE",
                    decisionContextDetails,
                ),
            };
        }

        const hasNameMismatch = hasComparableName && !params.documentProfileMatch.nameMatches;
        const hasDobMismatch = hasComparableDob && !params.documentProfileMatch.dobMatches;
        const shouldAutoReject = this.shouldAutoRejectIdentityDocument({
            isDocumentValid: params.isDocumentValid,
            hasNameMismatch,
            hasDobMismatch,
        });

        if (shouldAutoReject) {
            const userReasonMessage = "The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.";

            return {
                disposition: "AUTO_REJECT",
                attemptStatus: KycAttemptStatus.REJECTED,
                verificationStatus: DocumentVerificationStatus.DECLINED,
                providerStatus: KycProviderStatus.FAILED,
                decisionMode: KycDecisionMode.AUTO,
                responseMessage: userReasonMessage,
                attemptReasonCode: "DOCUMENT_PROFILE_MISMATCH",
                attemptReasonMessage: userReasonMessage,
                submissionNote: null,
                decisionEventType: KycAttemptEventType.REJECTED,
                decisionEventNote: userReasonMessage,
                decisionContext: this.createIdentityDocumentDecisionContext(
                    params,
                    "AUTO_REJECT",
                    decisionContextDetails,
                ),
                notificationTitle: "Document Rejected",
                notificationBody: userReasonMessage,
                emailRejectionReason: userReasonMessage,
            };
        }

        const manualReviewNote = `Manual review needed: valid=${params.isDocumentValid}, nameMatches=${params.documentProfileMatch.nameMatches}, dobMatches=${params.documentProfileMatch.dobMatches}`;

        return {
            disposition: "MANUAL_REVIEW",
            attemptStatus: KycAttemptStatus.PENDING_REVIEW,
            verificationStatus: DocumentVerificationStatus.PENDING,
            providerStatus: params.isDocumentValid || hasExtractedText
                ? KycProviderStatus.INCONCLUSIVE
                : KycProviderStatus.FAILED,
            decisionMode: KycDecisionMode.MANUAL,
            responseMessage: "Document verification is pending review",
            attemptReasonCode: this.mapIndividualAttemptReasonCode(manualReviewNote),
            attemptReasonMessage: manualReviewNote,
            submissionNote: manualReviewNote,
            decisionEventType: null,
            decisionEventNote: null,
            decisionContext: this.createIdentityDocumentDecisionContext(
                params,
                "MANUAL_REVIEW",
                decisionContextDetails,
            ),
        };
    }

    private createIdentityDocumentDecisionContext(
        params: BuildIdentityDocumentDecisionParams,
        disposition: IdentityDocumentDecisionDisposition,
        details: IdentityDocumentDecisionContextDetails,
    ): Prisma.InputJsonValue {
        return {
            provider: "DOJAH",
            disposition,
            providerReason: params.dojahParsed?.reason ?? null,
            isDocumentValid: params.isDocumentValid,
            hasExtractedText: details.hasExtractedText,
            hasComparableName: details.hasComparableName,
            hasComparableDob: details.hasComparableDob,
            expectedDocumentType: params.documentType,
            extractedDocumentType: params.dojahParsed?.documentType ?? null,
            normalizedExtractedDocumentType: params.documentTypeAssessment.detectedDocumentType ?? null,
            documentTypeMatches: params.documentTypeAssessment.matches,
            expectedDocumentNumber: params.documentNumber
                ? this.maskSensitiveId(params.documentNumber)
                : null,
            extractedDocumentNumber: details.providerDocumentNumber
                ? this.maskSensitiveId(details.providerDocumentNumber)
                : null,
            documentNumberMatches: details.documentNumberMatches,
            profileDocumentNumber: details.profileDocumentNumber
                ? this.maskSensitiveId(details.profileDocumentNumber)
                : null,
            profileDocumentNumberMatches: details.profileDocumentNumberMatches,
            profileMatch: {
                ...params.documentProfileMatch,
            },
        };
    }

    private shouldAutoRejectIdentityDocument(params: {
        isDocumentValid: boolean;
        hasNameMismatch: boolean;
        hasDobMismatch: boolean;
    }): boolean {
        return params.isDocumentValid && (params.hasNameMismatch || params.hasDobMismatch);
    }

    private ensureIdentityProfilePresent(user: User, identityType: "BVN" | "NIN"): void {
        if (!user.firstName || !user.lastName || !user.dateOfBirth) {
            throw new VerificationGenericException(
                `Please complete your profile (name and date of birth) before verifying ${identityType}`,
                HttpStatus.BAD_REQUEST
            );
        }
    }

    private getUserDateOfBirth(user: Pick<User, "dateOfBirth">): string | null {
        return user.dateOfBirth ? user.dateOfBirth.toISOString().split("T")[0] : null;
    }

    private evaluateDocumentProfileMatch(
        user: Pick<User, "firstName" | "lastName" | "dateOfBirth">,
        parsedDocument: Record<string, any> | null | undefined,
        nameMatches: boolean,
    ): DocumentProfileMatch {
        const profileDateOfBirth = this.getUserDateOfBirth(user);
        const dobMatches = Boolean(
            profileDateOfBirth &&
            parsedDocument?.dateOfBirth &&
            matchDateOfBirth(profileDateOfBirth, parsedDocument.dateOfBirth),
        );
        const partialNameMatches = nameMatches || this.hasPartialDocumentNameMatch(user, parsedDocument);

        return {
            nameMatches,
            partialNameMatches,
            dobMatches,
            profileMatches: nameMatches && dobMatches,
        };
    }

    private isDocumentProfileNameAccepted(documentProfileMatch: DocumentProfileMatch): boolean {
        return documentProfileMatch.nameMatches;
    }

    private hasPartialDocumentNameMatch(
        user: Pick<User, "firstName" | "lastName">,
        parsedDocument: Record<string, any> | null | undefined,
    ): boolean {
        const profileTokens = [user.firstName, user.lastName]
            .map((name) => this.normalizeIdentityNameText(name))
            .filter((name): name is string => Boolean(name));

        if (!profileTokens.length) {
            return false;
        }

        const extractedTokens = [
            parsedDocument?.firstName,
            parsedDocument?.lastName,
            parsedDocument?.givenNames,
        ]
            .flatMap((name) => this.normalizeIdentityNameText(name)?.split(" ") ?? [])
            .filter((name, index, names) => name.length > 1 && names.indexOf(name) === index);

        return extractedTokens.some((extractedName) => profileTokens.includes(extractedName));
    }

    private normalizeIdentityNameText(value?: string | null): string | null {
        if (typeof value !== "string") {
            return null;
        }

        const normalized = value
            .toLowerCase()
            .normalize("NFD")
            .replaceAll(/[\u0300-\u036f]/g, "")
            .replaceAll(/[^a-z0-9]+/g, " ")
            .trim();

        return normalized || null;
    }

    private async updateIdentityWithConflictGuard(
        userId: number,
        identityType: "BVN" | "NIN",
        data: Prisma.UserUpdateInput,
    ): Promise<void> {
        try {
            await this.prisma.user.update({
                where: { id: userId },
                data,
            });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw new VerificationGenericException(
                    `This ${identityType} is already linked to another account. If this is yours, please contact support.`,
                    HttpStatus.CONFLICT,
                );
            }
            throw err;
        }
    }

    private async rejectOnIdentityMismatch(
        user: User,
        result: any,
        identityType: "BVN" | "NIN",
        identifier: string,
    ): Promise<GovernmentIdentityMatchResult> {
        const providerFirstName = result?.data?.entity?.first_name || "";
        const providerLastName = result?.data?.entity?.last_name || "";
        const providerDateOfBirth = result?.data?.entity?.date_of_birth || "";
        const hasComparableName = Boolean(providerFirstName && providerLastName);
        const hasComparableDob = Boolean(providerDateOfBirth);
        const nameResult = hasComparableName
            ? matchNames(
                user.firstName,
                user.lastName,
                providerFirstName,
                providerLastName,
            )
            : { matches: false, detail: "Provider name data unavailable" };
        const dobMatches = hasComparableDob
            ? matchDateOfBirth(
                user.dateOfBirth.toISOString().split("T")[0],
                providerDateOfBirth,
            )
            : false;

        if ((hasComparableDob && !dobMatches) || (hasComparableName && !nameResult.matches)) {
            return this.handleGovernmentIdentityAutoReject({
                user,
                result,
                identityType,
                identifier,
                hasComparableName,
                hasComparableDob,
                nameMatchDetail: hasComparableName ? nameResult.detail : null,
                dobMatches: hasComparableDob ? dobMatches : null,
            });
        }

        if (!hasComparableName || !hasComparableDob) {
            return this.handleGovernmentIdentityManualReview({
                user,
                result,
                identityType,
                identifier,
                hasComparableName,
                hasComparableDob,
                nameMatchDetail: hasComparableName ? nameResult.detail : null,
                dobMatches: hasComparableDob ? dobMatches : null,
            });
        }

        return { disposition: "MATCHED" };
    }

    private async processDevIdentityBypass(
        userId: number,
        identityType: "BVN" | "NIN",
    ): Promise<{ identifier: string }> {
        const generatedValue = generateId({ type: "numeric" });

        if (identityType === "BVN") {
            await this.identityResolution.resolveOrCreate(IdentityIdType.BVN, generatedValue, userId);
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    bvn: generatedValue,
                },
            });
        } else {
            await this.identityResolution.resolveOrCreate(IdentityIdType.NIN, generatedValue, userId);
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    nin: generatedValue,
                },
            });
        }

        return {
            identifier: generatedValue,
        };
    }

    private async finalizeIdentityVerification(userId: number, identityType: "BVN" | "NIN"): Promise<void> {
        await this.tierService.syncTierAndCache(userId);
        this.logger.log(`[KYC][${identityType}] Tier/profile cache refreshed for user ${userId}`);

        try {
            await this.cryptoAccountQueueProducer.enqueue(userId);
            this.logger.log(`[KYC][${identityType}] Crypto account enqueue successful for user ${userId}`);
        } catch (error) {
            this.logger.error(`Error in sub account setup: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, firstName: true },
            });

            if (user?.email && emailTemplateConfig.document_approved) {
                await this.emailService.sendMailWithTemplate({
                    from: { address: mailConfig.senderMail },
                    to: [{ email_address: { address: user.email } }],
                    template_key: emailTemplateConfig.document_approved,
                    merge_info: {
                        first_name: user.firstName || "User",
                        document_type: identityType,
                        company_name: COMPANY_NAME,
                        rejection_reason: "",
                        status: "Approved",
                    },
                });
                this.logger.log(`[KYC][${identityType}] Approval email sent to user ${userId}`);
            } else {
                this.logger.warn(`[KYC][${identityType}] Skipped approval email for user ${userId}: missing email or template`);
            }
        } catch (error) {
            this.logger.error(`[KYC][${identityType}] Failed to send approval email for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            await this.notificationDispatcher.notify({
                userId,
                title: "Identity Verified",
                body: `Your ${identityType} verification has been approved.`,
                category: "security",
                enablePush: true,
            });
            this.wsGateway.notifyProfileUpdate(userId);
            this.logger.log(`[KYC][${identityType}] In-app notification sent to user ${userId}`);
        } catch (error) {
            this.logger.error(`[KYC][${identityType}] Failed to send notification for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async bvnVerification(user: User, dto: BvnVerificationDto) {
        const maskedBvn = this.maskSensitiveId(dto.bvn);
        this.logger.log(`[KYC][BVN] Verification initiated for user ${user.id} (bvn=${maskedBvn})`);

        if (await this.hasCompletedGovernmentVerification(user, KycMethod.BVN)) {
            this.logger.warn(`[KYC][BVN] Duplicate verification attempt for user ${user.id}`);
            throw new DuplicateBvnVerificationException(
                "Bvn verification already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        const bvnInUseByAnother = await this.prisma.user.findFirst({
            where: { id: { not: user.id }, bvn: dto.bvn },
        });

        if (bvnInUseByAnother) {
            this.logger.warn(`[KYC][BVN] BVN already in use (user=${user.id}, bvn=${maskedBvn})`);
            throw new VerificationGenericException(
                "This BVN is already linked to another account. If this is your BVN, please contact support for assistance.",
                HttpStatus.CONFLICT
            );
        }

        this.ensureIdentityProfilePresent(user, "BVN");
        const profileDateOfBirth = this.getUserDateOfBirth(user);

        // SECURITY: Block test BVN bypass in production
        if (dto.bvn === "22222222222") {
            if (isProdEnvironment) {
                this.logger.warn(`[SECURITY] Blocked test BVN bypass attempt for user ${user.id}`);
                throw new VerificationGenericException(
                    "Invalid BVN number",
                    HttpStatus.BAD_REQUEST
                );
            }
            // Development only - log the bypass usage
            this.logger.warn(`[SECURITY][DEV-ONLY] Test BVN bypass used for user ${user.id}`);
            const { identifier: generatedBvn } = await this.processDevIdentityBypass(user.id, "BVN");
            const currentAttemptStatus = await this.getCurrentGovernmentAttemptStatus(user.id, "BVN");
            const submissionEvent = this.buildGovernmentAutoApprovalSubmissionEvent({
                currentAttemptStatus,
                identityType: "BVN",
                identifier: generatedBvn,
                source: "DEV_IDENTITY_BYPASS",
                providerRef: "DEV_BYPASS",
            });
            await this.persistGovernmentStageAttempt({
                user,
                identityType: "BVN",
                identifier: generatedBvn,
                status: KycAttemptStatus.APPROVED,
                providerStatus: KycProviderStatus.PASSED,
                decisionMode: KycDecisionMode.AUTO,
                providerRef: "DEV_BYPASS",
                providerRawResponse: { entity: { reference_id: "DEV_BYPASS" } },
                preApprovalEventType: submissionEvent.eventType,
                preApprovalEventNote: submissionEvent.note,
                preApprovalEventPayload: submissionEvent.payload,
                eventType: KycAttemptEventType.APPROVED,
                eventActorType: KycActorType.SYSTEM,
                eventNote: "Development-only BVN bypass approved directly on the stage attempt.",
                eventPayload: {
                    source: "DEV_IDENTITY_BYPASS",
                    verificationType: "BVN",
                    identifier: this.maskSensitiveId(generatedBvn),
                },
            });
        } else {
            this.logger.debug(`[KYC][BVN] Calling Dojah verification for user ${user.id}`);
            const result = await this.dojahService.verifyBvn({
                bvn: dto.bvn,
                first_name: user.firstName || undefined,
                last_name: user.lastName || undefined,
                dob: profileDateOfBirth || undefined,
            });
            this.logger.log(`[KYC][BVN] Dojah verification response received for user ${user.id}`);

            const identityMatchDecision = await this.rejectOnIdentityMismatch(user, result, "BVN", dto.bvn);
            if (identityMatchDecision.disposition === "AUTO_REJECT") {
                return buildResponse({
                    message: identityMatchDecision.responseMessage,
                    data: {
                        status: "REJECTED",
                        outcome: "REJECTED_HARD_STOP",
                        reasonMessage: identityMatchDecision.reasonMessage,
                    },
                });
            }

            if (identityMatchDecision.disposition === "MANUAL_REVIEW") {
                return buildResponse({
                    message: identityMatchDecision.responseMessage,
                    data: {
                        status: "PENDING_REVIEW",
                        outcome: "UNDER_REVIEW",
                        reasonMessage: identityMatchDecision.reasonMessage,
                    },
                });
            }
            await this.identityResolution.resolveOrCreate(IdentityIdType.BVN, dto.bvn, user.id, {
                firstName: result.data.entity.first_name,
                lastName: result.data.entity.last_name,
                dateOfBirth: result.data.entity.date_of_birth,
            });
            const providerRef = result?.data?.entity?.reference_id ?? null;
            const currentAttemptStatus = await this.getCurrentGovernmentAttemptStatus(user.id, "BVN");
            const submissionEvent = this.buildGovernmentAutoApprovalSubmissionEvent({
                currentAttemptStatus,
                identityType: "BVN",
                identifier: dto.bvn,
                source: "PROVIDER_GOVERNMENT_ID_CHECK",
                providerRef,
            });
            await this.updateIdentityWithConflictGuard(user.id, "BVN", {
                bvn: dto.bvn,
                bvnRegisteredPhone: result.data.entity.phone_number1,
            });
            await this.persistGovernmentStageAttempt({
                user,
                identityType: "BVN",
                identifier: dto.bvn,
                status: KycAttemptStatus.APPROVED,
                providerStatus: KycProviderStatus.PASSED,
                decisionMode: KycDecisionMode.AUTO,
                providerRef,
                providerRawResponse: result?.data,
                preApprovalEventType: submissionEvent.eventType,
                preApprovalEventNote: submissionEvent.note,
                preApprovalEventPayload: submissionEvent.payload,
                eventType: KycAttemptEventType.APPROVED,
                eventActorType: KycActorType.SYSTEM,
                eventPayload: {
                    source: "PROVIDER_GOVERNMENT_ID_CHECK",
                    verificationType: "BVN",
                    identifier: this.maskSensitiveId(dto.bvn),
                    outcome: "APPROVED",
                    providerRef,
                },
            });
        }
        this.logger.log(`[KYC][BVN] Verification persisted for user ${user.id}`);

        await this.finalizeIdentityVerification(user.id, "BVN");

        return buildResponse({
            message: "Bvn Verification successfully",
        });
    }

    async ninVerification(user: User, dto: NinVerificationDto) {
        const maskedNin = this.maskSensitiveId(dto.nin);
        this.logger.log(`[KYC][NIN] Verification initiated for user ${user.id} (nin=${maskedNin})`);

        if (await this.hasCompletedGovernmentVerification(user, KycMethod.NIN)) {
            this.logger.warn(`[KYC][NIN] Duplicate verification attempt for user ${user.id}`);
            throw new DuplicateVerificationException(
                "NIN verification already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        const ninInUseByAnother = await this.prisma.user.findFirst({
            where: { id: { not: user.id }, nin: dto.nin },
        });

        if (ninInUseByAnother) {
            this.logger.warn(`[KYC][NIN] NIN already in use (user=${user.id}, nin=${maskedNin})`);
            throw new VerificationGenericException(
                "This NIN is already linked to another account. If this is your NIN, please contact support for assistance.",
                HttpStatus.CONFLICT
            );
        }

        this.ensureIdentityProfilePresent(user, "NIN");
        const profileDateOfBirth = this.getUserDateOfBirth(user);

        // SECURITY: Block test NIN bypass in production
        if (dto.nin === "00000000001") {
            if (isProdEnvironment) {
                this.logger.warn(`[SECURITY] Blocked test NIN bypass attempt for user ${user.id}`);
                throw new VerificationGenericException(
                    "Invalid NIN number",
                    HttpStatus.BAD_REQUEST
                );
            }
            // Development only - log the bypass usage
            this.logger.warn(`[SECURITY][DEV-ONLY] Test NIN bypass used for user ${user.id}`);
            const { identifier: generatedNin } = await this.processDevIdentityBypass(user.id, "NIN");
            const currentAttemptStatus = await this.getCurrentGovernmentAttemptStatus(user.id, "NIN");
            const submissionEvent = this.buildGovernmentAutoApprovalSubmissionEvent({
                currentAttemptStatus,
                identityType: "NIN",
                identifier: generatedNin,
                source: "DEV_IDENTITY_BYPASS",
                providerRef: "DEV_BYPASS",
            });
            await this.persistGovernmentStageAttempt({
                user,
                identityType: "NIN",
                identifier: generatedNin,
                status: KycAttemptStatus.APPROVED,
                providerStatus: KycProviderStatus.PASSED,
                decisionMode: KycDecisionMode.AUTO,
                providerRef: "DEV_BYPASS",
                providerRawResponse: { entity: { reference_id: "DEV_BYPASS" } },
                preApprovalEventType: submissionEvent.eventType,
                preApprovalEventNote: submissionEvent.note,
                preApprovalEventPayload: submissionEvent.payload,
                eventType: KycAttemptEventType.APPROVED,
                eventActorType: KycActorType.SYSTEM,
                eventNote: "Development-only NIN bypass approved directly on the stage attempt.",
                eventPayload: {
                    source: "DEV_IDENTITY_BYPASS",
                    verificationType: "NIN",
                    identifier: this.maskSensitiveId(generatedNin),
                },
            });
        } else {
            this.logger.debug(`[KYC][NIN] Calling Dojah verification for user ${user.id}`);
            const result = await this.dojahService.verifyNin({
                nin: dto.nin,
                first_name: user.firstName || undefined,
                last_name: user.lastName || undefined,
                dob: profileDateOfBirth || undefined,
            });
            this.logger.log(`[KYC][NIN] Dojah verification response received for user ${user.id}`);

            const identityMatchDecision = await this.rejectOnIdentityMismatch(user, result, "NIN", dto.nin);
            if (identityMatchDecision.disposition === "AUTO_REJECT") {
                return buildResponse({
                    message: identityMatchDecision.responseMessage,
                    data: {
                        status: "REJECTED",
                        outcome: "REJECTED_HARD_STOP",
                        reasonMessage: identityMatchDecision.reasonMessage,
                    },
                });
            }

            if (identityMatchDecision.disposition === "MANUAL_REVIEW") {
                return buildResponse({
                    message: identityMatchDecision.responseMessage,
                    data: {
                        status: "PENDING_REVIEW",
                        outcome: "UNDER_REVIEW",
                        reasonMessage: identityMatchDecision.reasonMessage,
                    },
                });
            }
            await this.identityResolution.resolveOrCreate(IdentityIdType.NIN, dto.nin, user.id, {
                firstName: result.data.entity.first_name,
                lastName: result.data.entity.last_name,
                dateOfBirth: result.data.entity.date_of_birth,
            });
            const providerRef = result?.data?.entity?.reference_id ?? null;
            const currentAttemptStatus = await this.getCurrentGovernmentAttemptStatus(user.id, "NIN");
            const submissionEvent = this.buildGovernmentAutoApprovalSubmissionEvent({
                currentAttemptStatus,
                identityType: "NIN",
                identifier: dto.nin,
                source: "PROVIDER_GOVERNMENT_ID_CHECK",
                providerRef,
            });
            await this.updateIdentityWithConflictGuard(user.id, "NIN", {
                nin: dto.nin,
                ninRegisteredPhone: result.data.entity.phone_number,
            });
            await this.persistGovernmentStageAttempt({
                user,
                identityType: "NIN",
                identifier: dto.nin,
                status: KycAttemptStatus.APPROVED,
                providerStatus: KycProviderStatus.PASSED,
                decisionMode: KycDecisionMode.AUTO,
                providerRef,
                providerRawResponse: result?.data,
                preApprovalEventType: submissionEvent.eventType,
                preApprovalEventNote: submissionEvent.note,
                preApprovalEventPayload: submissionEvent.payload,
                eventType: KycAttemptEventType.APPROVED,
                eventActorType: KycActorType.SYSTEM,
                eventPayload: {
                    source: "PROVIDER_GOVERNMENT_ID_CHECK",
                    verificationType: "NIN",
                    identifier: this.maskSensitiveId(dto.nin),
                    outcome: "APPROVED",
                    providerRef,
                },
            });
        }
        this.logger.log(`[KYC][NIN] Verification persisted for user ${user.id}`);

        await this.finalizeIdentityVerification(user.id, "NIN");

        return buildResponse({
            message: "NIN Verification successfully",
        });
    }

    async onboardIndividual(user: User, dto: OnboardIndividualDto) {
        // Check if user already has profile info set
        if (user.firstName && user.lastName && user.dateOfBirth) {
            throw new VerificationGenericException(
                "User profile already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                firstName: dto.firstName,
                lastName: dto.lastName,
                dateOfBirth: new Date(dto.dateOfBirth),
                residentialAddress: dto.residentialAddress.trim(),
            },
        });

        try {
            await this.cryptoAccountQueueProducer.enqueue(user.id);
        } catch (error) {
            this.logger.error(`Error in sub account setup: ${error instanceof Error ? error.message : String(error)}`);
        }

        return buildResponse({
            message: "Profile updated successfully",
        });
    }

    async documentVerification(
        user: User,
        files: DocumentVerificationFileInterface,
        dto: DocumentVerificationDto
    ) {
        const logger = new Logger("DocumentVerification");

        const currentAttemptStatus = await this.getCurrentIdentityDocumentAttemptStatus(user.id);

        if (currentAttemptStatus === KycAttemptStatus.APPROVED) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        if (
            currentAttemptStatus === KycAttemptStatus.SUBMITTED
            || currentAttemptStatus === KycAttemptStatus.PENDING_REVIEW
            || currentAttemptStatus === KycAttemptStatus.ESCALATED
        ) {
            throw new VerificationGenericException(
                "Document verification is pending review",
                HttpStatus.BAD_REQUEST
            );
        }

        // Upload document images
        const documentImage1Promise = this.uploadAsFile(files.documentImage1);
        const documentImage2Promise = files.documentImage2
            ? this.uploadAsFile(files.documentImage2)
            : Promise.resolve(null);

        const [documentImage1, documentImage2] = await Promise.all([
            documentImage1Promise,
            documentImage2Promise,
        ]);

        const dojahResult = await this.callDojahUrlDocumentVerification(
            documentImage1.url,
            documentImage2?.url,
            dto.documentType,
            user,
            logger,
        );
        let {
            isValid: isDocumentValid,
            nameMatches,
            parsed: dojahParsed,
            raw: dojahRawResponse,
        } = dojahResult;

        const postValidation = this.applyDojahPostValidation(isDocumentValid, dojahParsed, user.id, logger);
        isDocumentValid = postValidation.isDocumentValid;

        if (dojahResult.success && !nameMatches) {
            logger.warn(
                `Name mismatch for user ${user.id}: ` +
                `expected "${user.firstName} ${user.lastName}", ` +
                `got "${dojahParsed?.firstName || ""} ${dojahParsed?.lastName || ""}"`
            );
        }

        const documentProfileMatch = this.evaluateDocumentProfileMatch(user, dojahParsed, nameMatches);

        if (isDocumentValid && !documentProfileMatch.dobMatches) {
            logger.warn(
                `Document DOB mismatch for user ${user.id}: expected=${this.getUserDateOfBirth(user) || "missing"}, got=${dojahParsed?.dateOfBirth || "missing"}`,
            );
        }

        const documentTypeAssessment = this.assessSubmittedIdentityDocumentType(
            dto.documentType,
            dojahParsed?.documentType ?? null,
        );
        if (documentTypeAssessment.message) {
            throw new VerificationGenericException(
                documentTypeAssessment.message,
                HttpStatus.BAD_REQUEST,
            );
        }

        const resolvedDocumentNumber = this.resolveStoredDocumentNumber(
            dto.documentNumber,
            typeof dojahParsed?.documentNumber === "string" ? dojahParsed.documentNumber : null,
        );

        if (!resolvedDocumentNumber) {
            throw new VerificationGenericException(
                "We couldn't extract the document number from the uploaded document. Please upload a clearer image.",
                HttpStatus.BAD_REQUEST,
            );
        }

        const decision = this.buildIdentityDocumentDecision({
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
            profileDocumentNumber: dto.documentType === DocumentType.NIN ? user.nin ?? null : null,
            isDocumentValid,
            hardRejectMessage: postValidation.hardRejectMessage,
            dojahParsed,
            documentProfileMatch,
            documentTypeAssessment,
        });

        await this.prisma.$transaction(
            async (tx) => {
                await tx.userDocument.upsert({
                    where: { userId: user.id },
                    update: {
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: resolvedDocumentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus: decision.verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: this.isDocumentProfileNameAccepted(documentProfileMatch),
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                        updatedAt: new Date(),
                    },
                    create: {
                        userId: user.id,
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: resolvedDocumentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus: decision.verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: this.isDocumentProfileNameAccepted(documentProfileMatch),
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                    },
                });

                await this.persistIdentityDocumentStageAttempt(tx, {
                    user,
                    documentType: dto.documentType,
                    country: dto.country,
                    documentNumber: dto.documentNumber,
                    documentImage1,
                    documentImage2,
                    frontMimeType: files.documentImage1[0].mimetype,
                    backMimeType: files.documentImage2?.[0]?.mimetype ?? null,
                    dojahParsed,
                    isDocumentValid,
                    decision,
                    documentTypeAssessment,
                    currentAttemptStatus,
                    documentProfileMatch,
                });
            },
            { timeout: 30000 }
        );

        // Sync tier & flush profile cache after document verification
        await this.tierService.syncTierAndCache(user.id);

        if (decision.disposition === "APPROVE") {
            this.sendDocumentAutoApprovalNotifications(user.id, user.email, user.firstName, "Identity Document", logger);
            return buildResponse({
                message: decision.responseMessage,
            });
        }

        if (decision.disposition === "AUTO_REJECT") {
            this.sendDocumentAutoRejectNotifications(
                user.id,
                user.email,
                user.firstName,
                "Identity Document",
                decision.emailRejectionReason || decision.responseMessage,
                logger,
            );

            return buildResponse({
                message: decision.responseMessage,
                data: {
                    status: "DECLINED",
                    outcome: "REJECTED_HARD_STOP",
                    reasonMessage: decision.responseMessage,
                },
            });
        }

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Document Submitted",
            body: "Your identity document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });

        this.sendPendingReviewEmail(user.id, user.email, user.firstName, "Identity Document");

        return buildResponse({
            message: decision.responseMessage,
            data: {
                status: "PENDING_REVIEW",
                outcome: "UNDER_REVIEW",
                reasonMessage: decision.responseMessage,
            },
        });
    }

    private async uploadDocumentImage(
        file: string
    ): Promise<UploadResponse | UploadApiResponse> {
        const date = Date.now();
        const body = Buffer.from(file, "base64");

        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.document,
            name: `documet-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 989,
        });
    }

    async uploadAsFile(file?: Express.Multer.File[]) {
        if (!file?.length || !file[0]?.buffer) {
            throw new RequiredFilesMissing();
        }

        const date = Date.now();
        const body = file[0].buffer;
        const mimetype = file[0].mimetype?.toLowerCase() || "";

        // PDFs cannot be processed by Sharp — upload directly without compression
        const isPdf =
            mimetype === "application/pdf" ||
            file[0].originalname?.toLowerCase().endsWith(".pdf");

        if (isPdf) {
            const result = await this.uploadService.uploadImage({
                dir: storageDirConfig.document,
                name: `document-${date}-${generateRandomNum(5)}.pdf`,
                format: "png",
                body: body,
            });
            return result;
        }

        const result = await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.document,
            name: `document-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 989,
        });

        return result;
    }

    /**
     * Upload a base64 image to storage and return the URL
     * Strips data:image prefix if present
     */
    private async uploadBase64Image(base64String: string): Promise<{
        url: string;
        fileId: string;
    }> {
        // Strip data:image prefix if present (e.g., "data:image/jpeg;base64,")
        const cleanBase64 = this.stripImageBase64Prefix(base64String);
        const date = Date.now();
        const body = Buffer.from(cleanBase64, "base64");

        const result = await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.document,
            name: `document-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 989,
        });

        // Handle both Cloudinary (secure_url/public_id) and ImageKit (url/fileId) responses
        const url = "secure_url" in result ? result.secure_url : result.url;
        const fileId = "public_id" in result ? result.public_id : result.fileId;

        return { url, fileId };
    }

    /**
     * Preview/pre-validate document using Dojah OCR
     * Does NOT save anything to database - just returns extracted data
     * Used for real-time validation as user uploads documents
     */
    async previewDocument(user: User, dto: DocumentPreviewDto) {
        const result = await this.previewDocumentWithProviderLog(user, dto);

        return {
            success: result.success,
            message: result.message,
            data: result.data,
        };
    }

    async previewDocumentWithProviderLog(
        user: User,
        dto: DocumentPreviewDto,
    ): Promise<{
        success: boolean;
        message: string;
        data: Record<string, unknown> | null;
        providerInteraction: Record<string, unknown> | null;
    }> {
        const logger = new Logger("DocumentPreview");

        // Strip data:image prefix for Dojah API
        const cleanFrontBase64 = this.stripImageBase64Prefix(dto.imageFrontBase64);
        const cleanBackBase64 = this.stripOptionalImageBase64Prefix(dto.imageBackBase64);

        logger.log(`Document preview starting for user ${user.id}`, {
            frontImageSize: dto.imageFrontBase64?.length || 0,
            backImageSize: dto.imageBackBase64?.length || 0,
        });

        const startTime = Date.now();
        const providerBackImage = this.resolveIdentityProviderBackImage(dto.documentType, cleanBackBase64);
        const providerRequest = {
            inputType: "base64",
            imageFrontSide: cleanFrontBase64,
            ...(providerBackImage && { imageBackSide: providerBackImage }),
        } as const;

        try {
            const result = await this.dojahService.analyzeDocument(providerRequest);
            return this.buildIdentityPreviewSuccessResponse({
                user,
                dto,
                logger,
                startTime,
                providerRequest,
                result,
            });
        } catch (error) {
            return this.buildIdentityPreviewFailureResponse({
                userId: user.id,
                logger,
                startTime,
                error,
                providerRequest,
            });
        }
    }

    private buildIdentityPreviewSuccessResponse(params: {
        user: User;
        dto: DocumentPreviewDto;
        logger: Logger;
        startTime: number;
        providerRequest: {
            inputType: "base64";
            imageFrontSide: string;
            imageBackSide?: string;
        };
        result: {
            parsed: Record<string, any>;
        } & Record<string, unknown>;
    }): {
        success: boolean;
        message: string;
        data: Record<string, unknown>;
        providerInteraction: Record<string, unknown>;
    } {
        const parsed = params.result.parsed;
        const reviewDisposition = this.getDocumentReviewDisposition(
            Boolean(parsed?.isValid),
            parsed,
            params.user.id,
            params.logger,
        );
        const documentTypeAssessment = this.assessSubmittedIdentityDocumentType(
            params.dto.documentType,
            parsed.documentType,
        );
        const previewIsValid = this.resolveIdentityPreviewIsValid(
            documentTypeAssessment,
            reviewDisposition,
        );
        const isDocumentTypeMismatch = documentTypeAssessment.matches === false;
        const canProceedForReview = !isDocumentTypeMismatch;
        const message = this.resolveIdentityPreviewMessage({
            documentTypeAssessment,
            previewIsValid,
            reviewDisposition,
            providerReason: parsed.reason,
        });
        const outcome = this.resolveIdentityPreviewOutcome(isDocumentTypeMismatch, previewIsValid);
        const providerStatus = this.resolveIdentityPreviewProviderStatus(previewIsValid);
        const reasonCode = this.resolveIdentityPreviewReasonCode(isDocumentTypeMismatch, previewIsValid);
        const reason = this.resolveIdentityPreviewReason(isDocumentTypeMismatch, parsed.reason);
        const autofill = this.buildIdentityPreviewAutofill(parsed.documentNumber);
        const durationMs = Date.now() - params.startTime;

        params.logger.log(
            `Document preview completed in ${durationMs}ms for user ${params.user.id}: ` +
            `valid=${previewIsValid}, outcome=${outcome}, providerStatus=${providerStatus}, ` +
            `canSubmit=${canProceedForReview}, type=${parsed.documentType}, ` +
            `reasonCode=${reasonCode}, reason=${reason ?? parsed.reason ?? "none"}`,
        );

        this.logInvalidIdentityPreview(params.user.id, previewIsValid, {
            outcome,
            providerStatus,
            canSubmit: canProceedForReview,
            reasonCode,
            reason: reason ?? parsed.reason,
            documentType: parsed.documentType,
            country: parsed.country,
            hasPortrait: parsed.hasPortrait,
            hasFrontSide: parsed.hasFrontSide,
            hasBackSide: parsed.hasBackSide,
            extractedFields: {
                firstName: !!parsed.firstName,
                lastName: !!parsed.lastName,
                documentNumber: !!parsed.documentNumber,
                dateOfBirth: !!parsed.dateOfBirth,
            },
        }, params.logger);

        return {
            success: true,
            message,
            data: {
                stage: "IDENTITY_DOCUMENT",
                outcome,
                providerStatus,
                isValid: previewIsValid,
                canSubmit: canProceedForReview,
                reasonCode,
                reasonMessage: message,
                reason,
                documentType: parsed.documentType,
                country: parsed.country,
                documentNumber: parsed.documentNumber ?? null,
                autofill,
                extractedFields: {
                    documentNumber: parsed.documentNumber ?? null,
                    expiryDate: parsed.expiryDate ?? null,
                    issueDate: parsed.issueDate ?? null,
                    countryCode: parsed.countryCode ?? null,
                },
                documentTypeMatches: documentTypeAssessment.matches,
                hasPortrait: parsed.hasPortrait,
                hasFrontSide: parsed.hasFrontSide,
                hasBackSide: parsed.hasBackSide,
                hasExtractedText: parsed.hasExtractedText,
            },
            providerInteraction: {
                provider: "DOJAH",
                request: params.providerRequest,
                response: params.result,
            },
        };
    }

    private buildIdentityPreviewFailureResponse(params: {
        userId: number;
        logger: Logger;
        startTime: number;
        error: unknown;
        providerRequest: {
            inputType: "base64";
            imageFrontSide: string;
            imageBackSide?: string;
        };
    }): {
        success: boolean;
        message: string;
        data: null;
        providerInteraction: Record<string, unknown>;
    } {
        const durationMs = Date.now() - params.startTime;
        const errorStatus = typeof (params.error as { status?: unknown })?.status === "number"
            ? (params.error as { status: number }).status
            : undefined;

        params.logger.error(`Document preview failed in ${durationMs}ms for user ${params.userId}`, {
            errorName: params.error instanceof Error ? params.error.name : "UnknownError",
            errorMessage: params.error instanceof Error ? params.error.message : String(params.error),
        });

        const userMessage = this.mapDojahErrorToUserMessage({
            name: params.error instanceof Error ? params.error.name : "UnknownError",
            message: params.error instanceof Error ? params.error.message : String(params.error),
            status: errorStatus,
        });

        return {
            success: false,
            message: userMessage,
            data: null,
            providerInteraction: {
                provider: "DOJAH",
                request: params.providerRequest,
                response: null,
                error: {
                    name: params.error instanceof Error ? params.error.name : "UnknownError",
                    message: params.error instanceof Error ? params.error.message : String(params.error),
                    status: errorStatus ?? null,
                },
            },
        };
    }

    private logInvalidIdentityPreview(
        userId: number,
        previewIsValid: boolean,
        metadata: Record<string, unknown>,
        logger: Logger,
    ): void {
        if (previewIsValid) {
            return;
        }

        logger.warn(`Document preview INVALID for user ${userId}:`, metadata);
    }

    private resolveProviderDocumentNameMatch(
        user: Pick<User, "firstName" | "lastName">,
        parsed: {
            firstName?: string | null;
            lastName?: string | null;
            givenNames?: string | null;
        },
    ): boolean | null {
        if (!user.firstName || !user.lastName) {
            return null;
        }

        if (parsed.firstName && parsed.lastName) {
            return matchNames(
                user.firstName,
                user.lastName,
                parsed.firstName,
                parsed.lastName,
            ).matches;
        }

        const providerNameText = normaliseName(
            [parsed.firstName, parsed.givenNames, parsed.lastName]
                .filter((value): value is string => Boolean(value))
                .join(" "),
        );

        if (!providerNameText) {
            return null;
        }

        return providerNameText.includes(normaliseName(user.firstName))
            && providerNameText.includes(normaliseName(user.lastName))
            ? true
            : null;
    }

    private async buildProviderAnalysisRequest(
        file: ProviderAnalysisFile,
    ): Promise<{
        providerRequest: {
            inputType: "base64";
            imageFrontSide: string;
        };
        requestMetadata: Record<string, unknown>;
    } | null> {
        if (!file?.buffer?.length) {
            return null;
        }

        const preparedBuffer = await prepareDocumentForProviderAnalysis(file.buffer, file.mimetype);

        if (!preparedBuffer.length) {
            return null;
        }

        const imageFrontSide = preparedBuffer.toString("base64");

        return {
            providerRequest: {
                inputType: "base64",
                imageFrontSide,
            },
            requestMetadata: {
                endpoint: "/api/v1/document/analysis",
                inputType: "base64",
                fileName: file.originalname ?? null,
                mimeType: file.mimetype ?? null,
                originalByteLength: file.buffer.length,
                preparedByteLength: preparedBuffer.length,
                preparedBase64Length: imageFrontSide.length,
                originalSha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
                preparedSha256: crypto.createHash("sha256").update(preparedBuffer).digest("hex"),
            },
        };
    }

    private buildProviderAnalysisErrorPayload(error: unknown): Record<string, unknown> {
        const errorLike = error as {
            name?: unknown;
            message?: unknown;
            status?: unknown;
            responseBody?: unknown;
            requestMetadata?: unknown;
            response?: {
                status?: unknown;
                data?: unknown;
            };
            providerErrorName?: unknown;
        };
        let status: number | null = null;

        if (typeof errorLike?.status === "number") {
            status = errorLike.status;
        } else if (typeof errorLike?.response?.status === "number") {
            status = errorLike.response.status;
        }

        return {
            name: typeof errorLike?.name === "string" ? errorLike.name : "Error",
            message: typeof errorLike?.message === "string" ? errorLike.message : String(error),
            status,
            ...(typeof errorLike?.providerErrorName === "string" ? { providerErrorName: errorLike.providerErrorName } : {}),
            responseBody: errorLike?.responseBody ?? errorLike?.response?.data ?? null,
            requestMetadata:
                errorLike?.requestMetadata && typeof errorLike.requestMetadata === "object"
                    ? errorLike.requestMetadata as Record<string, unknown>
                    : null,
        };
    }

    private buildProviderAnalysisFailureInteraction(
        requestMetadata: Record<string, unknown>,
        error: unknown,
    ): {
        provider: "DOJAH";
        request: Record<string, unknown>;
        error: Record<string, unknown>;
    } {
        return {
            provider: "DOJAH",
            request: requestMetadata,
            error: this.buildProviderAnalysisErrorPayload(error),
        };
    }

    async analyzeAddressDocumentSignals(
        user: Pick<User, "id" | "firstName" | "lastName">,
        file: ProviderAnalysisFile,
    ): Promise<AddressProviderSignals | null> {
        if (!file?.buffer?.length) {
            return null;
        }

        const providerAnalysisRequest = await this.buildProviderAnalysisRequest(file).catch((error: unknown) => {
            this.logger.warn(
                `[KYC][ADDRESS] Failed to prepare address document preview for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        });

        if (!providerAnalysisRequest) {
            return null;
        }

        try {
            const result = await this.dojahService.analyzeDocument(providerAnalysisRequest.providerRequest);

            return {
                isValid: result.parsed.isValid,
                reason: result.parsed.reason ?? null,
                documentType: result.parsed.documentType ?? null,
                rawText: result.parsed.rawText ?? null,
                nameMatches: this.resolveProviderDocumentNameMatch(user, {
                    firstName: result.parsed.firstName ?? null,
                    lastName: result.parsed.lastName ?? null,
                    givenNames: result.parsed.givenNames ?? null,
                }),
                documentDate: result.parsed.issueDate ?? null,
                country: result.parsed.country ?? null,
                countryCode: result.parsed.countryCode ?? null,
                providerInteraction: {
                    provider: "DOJAH",
                    request: providerAnalysisRequest.requestMetadata,
                    response: result as Record<string, unknown>,
                },
            };
        } catch (error) {
            this.logger.warn(
                `[KYC][ADDRESS] Failed to analyze address document preview for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
            );

            return {
                providerInteraction: this.buildProviderAnalysisFailureInteraction(
                    providerAnalysisRequest.requestMetadata,
                    error,
                ),
            };
        }
    }

    async analyzeIncomeDocumentSignals(
        user: Pick<User, "id" | "firstName" | "lastName">,
        file: ProviderAnalysisFile,
    ): Promise<IncomeProviderSignals | null> {
        if (!file?.buffer?.length) {
            return null;
        }

        const providerAnalysisRequest = await this.buildProviderAnalysisRequest(file).catch((error: unknown) => {
            this.logger.warn(
                `[KYC][INCOME] Failed to prepare income document preview for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        });

        if (!providerAnalysisRequest) {
            return null;
        }

        try {
            const result = await this.dojahService.analyzeDocument(providerAnalysisRequest.providerRequest);

            return {
                isValid: result.parsed.isValid,
                reason: result.parsed.reason ?? null,
                documentType: result.parsed.documentType ?? null,
                rawText: result.parsed.rawText ?? null,
                nameMatches: this.resolveProviderDocumentNameMatch(user, {
                    firstName: result.parsed.firstName ?? null,
                    lastName: result.parsed.lastName ?? null,
                    givenNames: result.parsed.givenNames ?? null,
                }),
                documentDate: result.parsed.issueDate ?? null,
                country: result.parsed.country ?? null,
                countryCode: result.parsed.countryCode ?? null,
                providerInteraction: {
                    provider: "DOJAH",
                    request: providerAnalysisRequest.requestMetadata,
                    response: result as Record<string, unknown>,
                },
            };
        } catch (error) {
            this.logger.warn(
                `[KYC][INCOME] Failed to analyze income document preview for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
            );

            return {
                providerInteraction: this.buildProviderAnalysisFailureInteraction(
                    providerAnalysisRequest.requestMetadata,
                    error,
                ),
            };
        }

    }
    /**
     * Map Dojah reason codes to user-friendly messages
     */
    private mapDojahReasonToUserMessage(reason?: string): string {
        if (!reason) {
            return "Document could not be verified. Please upload a valid document.";
        }

        const upperReason = reason.toUpperCase();

        if (upperReason === "NOT_VALID" || upperReason === "INVALID") {
            return "Document could not be verified. Please upload a valid document.";
        }
        if (upperReason.includes("BLUR") || upperReason.includes("UNCLEAR")) {
            return "Image is unclear. Please upload a clearer photo.";
        }
        if (upperReason.includes("EXPIRED")) {
            return "Document is expired. Please upload a valid, unexpired document.";
        }
        if (upperReason.includes("NOT_SUPPORTED") || upperReason.includes("UNSUPPORTED")) {
            return "This document is not supported. Please upload a valid passport, driver's license, or NIN slip.";
        }

        return "Document could not be verified. Please upload a valid document.";
    }

    /** Map Dojah/client document type strings to internal DocumentType enum. */
    private mapDojahToDocumentType(dojahDocTypeRaw?: string, fallbackDocType?: string): DocumentType {
        const dojahDocType = dojahDocTypeRaw?.toLowerCase();
        if (dojahDocType?.includes("passport")) return DocumentType.INTERNATIONAL_PASSPORT;
        if (dojahDocType?.includes("driver") || dojahDocType?.includes("license")) return DocumentType.DRIVER_LICENSE;

        const providedType = fallbackDocType?.toLowerCase();
        if (providedType?.includes("passport")) return DocumentType.INTERNATIONAL_PASSPORT;
        if (providedType?.includes("driver") || providedType?.includes("license")) return DocumentType.DRIVER_LICENSE;

        return DocumentType.NIN;
    }

    /**
     * Submit Dojah Widget verification result
     * Receives verification data from Dojah Widget and saves to database
     */
    async submitDojahWidgetVerification(user: User, _dto: DojahWidgetVerificationDto) {
        this.logger.warn(`[KYC][DOCUMENT] Retired Dojah widget endpoint hit for user ${user.id}`);
        throw new GoneException("Dojah widget verification has been retired. Use the document upload flow instead.");
    }

    /**
     * Document verification optimized for Dojah integration
     * Accepts base64-encoded images directly - no FormData needed
     * Stores images for manual review while using Dojah for auto-verification
     */
    async documentVerificationBase64(
        user: User,
        dto: DocumentVerificationBase64Dto
    ) {
        const logger = new Logger("DocumentVerificationBase64");

        const currentAttemptStatus = await this.getCurrentIdentityDocumentAttemptStatus(user.id);

        if (currentAttemptStatus === KycAttemptStatus.APPROVED) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        if (
            currentAttemptStatus === KycAttemptStatus.SUBMITTED
            || currentAttemptStatus === KycAttemptStatus.PENDING_REVIEW
            || currentAttemptStatus === KycAttemptStatus.ESCALATED
        ) {
            throw new VerificationGenericException(
                "Document verification is pending review",
                HttpStatus.BAD_REQUEST
            );
        }

        // Strip data:image prefix for Dojah API (required per Dojah docs)
        const stripDataImageBase64Prefix = (imageBase64: string): string => {
            const dataImagePrefix = "data:image/";
            const base64Marker = ";base64,";

            if (!imageBase64.startsWith(dataImagePrefix)) {
                return imageBase64;
            }

            const markerIndex = imageBase64.indexOf(base64Marker, dataImagePrefix.length);
            if (markerIndex === -1) {
                return imageBase64;
            }

            const imageType = imageBase64.slice(dataImagePrefix.length, markerIndex);
            return /^\w+$/.test(imageType)
                ? imageBase64.slice(markerIndex + base64Marker.length)
                : imageBase64;
        };
        const cleanFrontBase64 = stripDataImageBase64Prefix(dto.imageFrontBase64);
        const cleanBackBase64 = dto.imageBackBase64
            ? stripDataImageBase64Prefix(dto.imageBackBase64)
            : undefined;

        // Log payload sizes for debugging
        logger.log(`Document verification starting for user ${user.id}`, {
            frontImageSize: dto.imageFrontBase64?.length || 0,
            backImageSize: dto.imageBackBase64?.length || 0,
            documentType: dto.documentType,
            country: dto.country,
        });

        const startTime = Date.now();

        // Upload images to storage (for manual review if needed) and verify with Dojah in parallel
        const [documentImage1, documentImage2, dojahResult] = await Promise.all([
            this.uploadBase64Image(dto.imageFrontBase64),
            dto.imageBackBase64 ? this.uploadBase64Image(dto.imageBackBase64) : Promise.resolve(null),
            this.callDojahDocumentVerification(cleanFrontBase64, cleanBackBase64, user, dto, startTime, logger),
        ]);

        let { isValid: isDocumentValid, nameMatches, parsed: dojahParsed, raw: dojahRawResponse, error: dojahError } = dojahResult;

        // If Dojah failed with an error, throw it to the frontend with a user-friendly message
        if (!dojahResult.success && dojahError) {
            const userMessage = this.mapDojahErrorToUserMessage(dojahError);
            throw new VerificationGenericException(
                userMessage,
                dojahError.status || HttpStatus.BAD_REQUEST
            );
        }

        const postValidation = this.applyDojahPostValidation(isDocumentValid, dojahParsed, user.id, logger);
        isDocumentValid = postValidation.isDocumentValid;
        const documentProfileMatch = this.evaluateDocumentProfileMatch(user, dojahParsed, nameMatches);

        if (isDocumentValid && !documentProfileMatch.dobMatches) {
            logger.warn(
                `Document DOB mismatch for user ${user.id}: expected=${this.getUserDateOfBirth(user) || "missing"}, got=${dojahParsed?.dateOfBirth || "missing"}`,
            );
        }

        const documentTypeAssessment = this.assessSubmittedIdentityDocumentType(
            dto.documentType,
            dojahParsed?.documentType ?? null,
        );
        if (documentTypeAssessment.message) {
            throw new VerificationGenericException(
                documentTypeAssessment.message,
                HttpStatus.BAD_REQUEST,
            );
        }

        const resolvedDocumentNumber = this.resolveStoredDocumentNumber(
            dto.documentNumber,
            typeof dojahParsed?.documentNumber === "string" ? dojahParsed.documentNumber : null,
        );

        if (!resolvedDocumentNumber) {
            throw new VerificationGenericException(
                "We couldn't extract the document number from the uploaded document. Please upload a clearer image.",
                HttpStatus.BAD_REQUEST,
            );
        }

        const decision = this.buildIdentityDocumentDecision({
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
            profileDocumentNumber: dto.documentType === DocumentType.NIN ? user.nin ?? null : null,
            isDocumentValid,
            hardRejectMessage: postValidation.hardRejectMessage,
            dojahParsed,
            documentProfileMatch,
            documentTypeAssessment,
        });

        await this.prisma.$transaction(
            async (tx) => {
                await tx.userDocument.upsert({
                    where: { userId: user.id },
                    update: {
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: resolvedDocumentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus: decision.verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: this.isDocumentProfileNameAccepted(documentProfileMatch),
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                        updatedAt: new Date(),
                    },
                    create: {
                        userId: user.id,
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: resolvedDocumentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        // Dojah verification fields
                        verificationStatus: decision.verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: this.isDocumentProfileNameAccepted(documentProfileMatch),
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                    },
                });

                await this.persistIdentityDocumentStageAttempt(tx, {
                    user,
                    documentType: dto.documentType,
                    country: dto.country,
                    documentNumber: resolvedDocumentNumber,
                    submittedDocumentNumber: dto.documentNumber,
                    documentImage1,
                    documentImage2,
                    frontMimeType: this.extractBase64MimeType(dto.imageFrontBase64),
                    backMimeType: dto.imageBackBase64 ? this.extractBase64MimeType(dto.imageBackBase64) : null,
                    dojahParsed,
                    isDocumentValid,
                    decision,
                    documentTypeAssessment,
                    currentAttemptStatus,
                    documentProfileMatch,
                });
            },
            { timeout: 30000 }
        );

        // Sync tier & flush profile cache after base64 document verification
        await this.tierService.syncTierAndCache(user.id);

        if (decision.disposition === "APPROVE") {
            this.sendDocumentAutoApprovalNotifications(user.id, user.email, user.firstName, "Identity Document", logger);
            return buildResponse({
                message: decision.responseMessage,
            });
        }

        if (decision.disposition === "AUTO_REJECT") {
            this.sendDocumentAutoRejectNotifications(
                user.id,
                user.email,
                user.firstName,
                "Identity Document",
                decision.emailRejectionReason || decision.responseMessage,
                logger,
            );

            return buildResponse({
                message: decision.responseMessage,
                data: {
                    status: "DECLINED",
                    outcome: "REJECTED_HARD_STOP",
                    reasonMessage: decision.responseMessage,
                },
            });
        }

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Document Submitted",
            body: "Your identity document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });

        this.sendPendingReviewEmail(user.id, user.email, user.firstName, "Identity Document");

        return buildResponse({
            message: decision.responseMessage,
            data: {
                status: "PENDING_REVIEW",
                outcome: "UNDER_REVIEW",
                reasonMessage: decision.responseMessage,
            },
        });
    }

    async documentVerificationBase64FromPreview(
        user: User,
        dto: DocumentVerificationBase64Dto,
        previewPayload: Record<string, unknown>,
    ) {
        const logger = new Logger("DocumentVerificationBase64FromPreview");

        const currentAttemptStatus = await this.getCurrentIdentityDocumentAttemptStatus(user.id);

        if (currentAttemptStatus === KycAttemptStatus.APPROVED) {
            throw new VerificationGenericException(
                "Document has already been verified",
                HttpStatus.BAD_REQUEST
            );
        }

        if (
            currentAttemptStatus === KycAttemptStatus.SUBMITTED
            || currentAttemptStatus === KycAttemptStatus.PENDING_REVIEW
            || currentAttemptStatus === KycAttemptStatus.ESCALATED
        ) {
            throw new VerificationGenericException(
                "Document verification is pending review",
                HttpStatus.BAD_REQUEST
            );
        }

        logger.log(`Document verification starting from persisted preview for user ${user.id}`, {
            frontImageSize: dto.imageFrontBase64?.length || 0,
            backImageSize: dto.imageBackBase64?.length || 0,
            documentType: dto.documentType,
            country: dto.country,
        });

        const persistedPreviewResult = this.buildIdentityVerificationResultFromPreview(previewPayload);

        const [documentImage1, documentImage2] = await Promise.all([
            this.uploadBase64Image(dto.imageFrontBase64),
            dto.imageBackBase64 ? this.uploadBase64Image(dto.imageBackBase64) : Promise.resolve(null),
        ]);

        let {
            isValid: isDocumentValid,
            nameMatches,
            parsed: dojahParsed,
            raw: dojahRawResponse,
        } = persistedPreviewResult;

        const previewNameMatch = this.resolveProviderDocumentNameMatch(user, {
            firstName: dojahParsed?.firstName ?? null,
            lastName: dojahParsed?.lastName ?? null,
            givenNames: dojahParsed?.givenNames ?? null,
        });

        if (previewNameMatch !== null) {
            nameMatches = previewNameMatch;
        }

        const postValidation = this.applyDojahPostValidation(isDocumentValid, dojahParsed, user.id, logger);
        isDocumentValid = postValidation.isDocumentValid;
        const documentProfileMatch = this.evaluateDocumentProfileMatch(user, dojahParsed, nameMatches);

        if (isDocumentValid && !documentProfileMatch.dobMatches) {
            logger.warn(
                `Document DOB mismatch for user ${user.id}: expected=${this.getUserDateOfBirth(user) || "missing"}, got=${dojahParsed?.dateOfBirth || "missing"}`,
            );
        }

        const documentTypeAssessment = this.assessSubmittedIdentityDocumentType(
            dto.documentType,
            dojahParsed?.documentType ?? null,
        );
        if (documentTypeAssessment.message) {
            throw new VerificationGenericException(
                documentTypeAssessment.message,
                HttpStatus.BAD_REQUEST,
            );
        }

        const resolvedDocumentNumber = this.resolveStoredDocumentNumber(
            dto.documentNumber,
            typeof dojahParsed?.documentNumber === "string" ? dojahParsed.documentNumber : null,
        );

        if (!resolvedDocumentNumber) {
            throw new VerificationGenericException(
                "We couldn't extract the document number from the uploaded document. Please upload a clearer image.",
                HttpStatus.BAD_REQUEST,
            );
        }

        const decision = this.buildIdentityDocumentDecision({
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
            profileDocumentNumber: dto.documentType === DocumentType.NIN ? user.nin ?? null : null,
            isDocumentValid,
            hardRejectMessage: postValidation.hardRejectMessage,
            dojahParsed,
            documentProfileMatch,
            documentTypeAssessment,
        });

        await this.prisma.$transaction(
            async (tx) => {
                await tx.userDocument.upsert({
                    where: { userId: user.id },
                    update: {
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: resolvedDocumentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        verificationStatus: decision.verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: this.isDocumentProfileNameAccepted(documentProfileMatch),
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                        updatedAt: new Date(),
                    },
                    create: {
                        userId: user.id,
                        type: dto.documentType,
                        country: dto.country,
                        documentNumber: resolvedDocumentNumber,
                        documentImageUrl: documentImage1.url,
                        documentImageFieldId: documentImage1.fileId,
                        ...(documentImage2 && {
                            documentImageUrl2: documentImage2.url,
                            documentImage2FieldId: documentImage2.fileId,
                        }),
                        verificationStatus: decision.verificationStatus,
                        dojahVerified: isDocumentValid,
                        dojahDocumentType: dojahParsed?.documentType || null,
                        dojahCountryCode: dojahParsed?.countryCode || null,
                        dojahExtractedFirstName: dojahParsed?.firstName || null,
                        dojahExtractedLastName: dojahParsed?.lastName || null,
                        dojahExtractedDob: dojahParsed?.dateOfBirth || null,
                        dojahExtractedDocNumber: dojahParsed?.documentNumber || null,
                        dojahExtractedExpiryDate: dojahParsed?.expiryDate || null,
                        dojahNameMatches: this.isDocumentProfileNameAccepted(documentProfileMatch),
                        dojahVerifiedAt: new Date(),
                        dojahRawResponse,
                    },
                });

                await this.persistIdentityDocumentStageAttempt(tx, {
                    user,
                    documentType: dto.documentType,
                    country: dto.country,
                    documentNumber: resolvedDocumentNumber,
                    submittedDocumentNumber: dto.documentNumber,
                    documentImage1,
                    documentImage2,
                    frontMimeType: this.extractBase64MimeType(dto.imageFrontBase64),
                    backMimeType: dto.imageBackBase64 ? this.extractBase64MimeType(dto.imageBackBase64) : null,
                    dojahParsed,
                    isDocumentValid,
                    decision,
                    documentTypeAssessment,
                    currentAttemptStatus,
                    documentProfileMatch,
                });
            },
            { timeout: 30000 }
        );

        await this.tierService.syncTierAndCache(user.id);

        if (decision.disposition === "APPROVE") {
            this.sendDocumentAutoApprovalNotifications(user.id, user.email, user.firstName, "Identity Document", logger);
            return buildResponse({
                message: decision.responseMessage,
            });
        }

        if (decision.disposition === "AUTO_REJECT") {
            this.sendDocumentAutoRejectNotifications(
                user.id,
                user.email,
                user.firstName,
                "Identity Document",
                decision.emailRejectionReason || decision.responseMessage,
                logger,
            );

            return buildResponse({
                message: decision.responseMessage,
                data: {
                    status: "DECLINED",
                    outcome: "REJECTED_HARD_STOP",
                    reasonMessage: decision.responseMessage,
                },
            });
        }

        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Document Submitted",
            body: "Your identity document has been submitted for review. We'll notify you once it's processed.",
            category: "security",
        });

        this.sendPendingReviewEmail(user.id, user.email, user.firstName, "Identity Document");

        return buildResponse({
            message: decision.responseMessage,
            data: {
                status: "PENDING_REVIEW",
                outcome: "UNDER_REVIEW",
                reasonMessage: decision.responseMessage,
            },
        });
    }

    private buildIdentityVerificationResultFromPreview(previewPayload: Record<string, unknown>): {
        isValid: boolean;
        nameMatches: boolean;
        parsed: Record<string, any>;
        raw: string;
    } {
        const comparisonSummary = this.readPreviewDocumentObject(previewPayload.comparisonSummary);
        const extractedFields = this.readPreviewDocumentObject(previewPayload.extractedFields);
        const providerInteraction = this.readPreviewDocumentObject(previewPayload.providerInteraction);
        const providerResponse = this.readPreviewDocumentObject(providerInteraction?.response);
        const providerParsed = this.readPreviewDocumentObject(providerResponse?.parsed);
        const previewIsValid = typeof previewPayload.isValid === "boolean"
            ? previewPayload.isValid
            : null;

        return {
            isValid: previewIsValid ?? (providerParsed?.isValid === true),
            nameMatches: typeof providerResponse?.nameMatches === "boolean"
                ? providerResponse.nameMatches
                : comparisonSummary?.nameMatches === true,
            parsed: {
                reason: this.readPreviewDocumentString(previewPayload.reason)
                    ?? this.readPreviewDocumentString(previewPayload.reasonMessage)
                    ?? this.readPreviewDocumentString(providerParsed?.reason),
                documentType: this.readPreviewDocumentString(providerParsed?.documentType)
                    ?? this.readPreviewDocumentString(previewPayload.documentType),
                country: this.readPreviewDocumentString(providerParsed?.country)
                    ?? this.readPreviewDocumentString(previewPayload.country)
                    ?? this.readPreviewDocumentString(extractedFields?.country),
                countryCode: this.readPreviewDocumentString(providerParsed?.countryCode)
                    ?? this.readPreviewDocumentString(previewPayload.countryCode)
                    ?? this.readPreviewDocumentString(extractedFields?.countryCode),
                firstName: this.readPreviewDocumentString(providerParsed?.firstName)
                    ?? this.readPreviewDocumentString(previewPayload.firstName),
                lastName: this.readPreviewDocumentString(providerParsed?.lastName)
                    ?? this.readPreviewDocumentString(previewPayload.lastName),
                givenNames: this.readPreviewDocumentString(providerParsed?.givenNames)
                    ?? this.readPreviewDocumentString(previewPayload.givenNames),
                documentNumber: this.readPreviewDocumentString(providerParsed?.documentNumber)
                    ?? this.readPreviewDocumentString(previewPayload.documentNumber)
                    ?? this.readPreviewDocumentString(extractedFields?.documentNumber),
                dateOfBirth: this.readPreviewDocumentString(providerParsed?.dateOfBirth)
                    ?? this.readPreviewDocumentString(previewPayload.dateOfBirth),
                expiryDate: this.readPreviewDocumentString(providerParsed?.expiryDate)
                    ?? this.readPreviewDocumentString(previewPayload.expiryDate)
                    ?? this.readPreviewDocumentString(extractedFields?.expiryDate),
                issueDate: this.readPreviewDocumentString(providerParsed?.issueDate)
                    ?? this.readPreviewDocumentString(previewPayload.issueDate)
                    ?? this.readPreviewDocumentString(extractedFields?.issueDate),
                sex: this.readPreviewDocumentString(providerParsed?.sex)
                    ?? this.readPreviewDocumentString(previewPayload.sex),
                nationality: this.readPreviewDocumentString(providerParsed?.nationality)
                    ?? this.readPreviewDocumentString(previewPayload.nationality),
                hasExtractedText: providerParsed?.hasExtractedText === true || previewPayload.hasExtractedText === true,
                hasPortrait: providerParsed?.hasPortrait === true || previewPayload.hasPortrait === true,
                hasFrontSide: providerParsed?.hasFrontSide === true || previewPayload.hasFrontSide === true,
                hasBackSide: providerParsed?.hasBackSide === true || previewPayload.hasBackSide === true,
            },
            raw: JSON.stringify(providerInteraction ?? {
                source: "PERSISTED_PREVIEW",
                previewPayload,
            }),
        };
    }

    private readPreviewDocumentObject(value: unknown): Record<string, any> | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }

        return value as Record<string, any>;
    }

    private readPreviewDocumentString(value: unknown): string | null {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    async updloadBusinessDocuments(
        user: User,
        files: UploadBusinessDocumentsFileInterface,
        dto: BusinessDocumentUploadDto
    ) {
        const currentAttemptStatus = await this.getCurrentBusinessDocumentAttemptStatus(user.id);
        let stageAttemptId: number | undefined;

        if (currentAttemptStatus && currentAttemptStatus !== KycAttemptStatus.REJECTED && currentAttemptStatus !== KycAttemptStatus.EXPIRED) {
            throw new VerificationGenericException(
                `Document has already been uploaded and is ${currentAttemptStatus}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const safeUpload = async (
            file: Express.Multer.File[] | undefined,
            label: string
        ) => {
            if (!file) return null;
            try {
                return await this.uploadAsFile(file);
            } catch (err) {
                this.logger.error(
                    `[BusinessDocumentsUpload][UploadPhase] File "${label}" failed for user ${user.id}: ${err?.name} - ${err?.message}`,
                    err?.stack
                );
                throw err;
            }
        };

        let cacImage: UploadResult | null = null;
        let articleImage: UploadResult | null = null;
        let boardResolutionImage: UploadResult | null = null;
        let proofOfAddressImage: UploadResult | null = null;
        let meansOfIdImage: UploadResult | null = null;

        try {
            [
                cacImage,
                articleImage,
                boardResolutionImage,
                proofOfAddressImage,
                meansOfIdImage,
            ] = await Promise.all([
                safeUpload(files.cacImage, "cacImage"),
                safeUpload(files.articleOfAssociationImage, "articleOfAssociationImage"),
                safeUpload(files.boardResolutionAuthorizedAcctOpeningImage, "boardResolutionImage"),
                safeUpload(files.proofOfAddressForBeneficialOwner, "proofOfAddress"),
                safeUpload(files.meansOfIdentificationForBeneficialOwner, "meansOfId"),
            ]);
        } catch (error) {
            this.logger.error(
                `[BusinessDocumentsUpload][UploadPhase] Failed for user ${user.id} | ${error?.name}: ${error?.message}`,
                error?.stack
            );
            throw error;
        }

        try {
            await this.prisma.$transaction(
                async (tx) => {
                    await tx.businessDocument.upsert({
                        where: { userId: user.id },
                        update: {},
                        create: {
                            userId: user.id,
                            cacDocumentNumber: dto.cacDocumentNumber,
                            cacImageUrl: cacImage?.url || null,
                            cacImageUrlFieldId: cacImage?.fileId || null,
                            cacImageFileName: cacImage?.url
                                ? generateFileName(
                                    DocumentMetaMap.cacImage,
                                    user.id,
                                    files.cacImage?.[0]?.originalname
                                )
                                : null,
                            articleOfAssociationNumber:
                                dto.articleOfAssociationNumber || null,
                            articleOfAssociationImageUrl:
                                articleImage?.url || null,
                            articleOfAssociationImageUrlFieldId:
                                articleImage?.fileId || null,
                            articleOfAssociationFileName: articleImage?.url
                                ? generateFileName(
                                    DocumentMetaMap.articleOfAssociationImage,
                                    user.id,
                                    files.articleOfAssociationImage?.[0]
                                        ?.originalname
                                )
                                : null,
                            boardResolutionAuthorizedAcctOpeningImageUrl:
                                boardResolutionImage?.url || null,
                            boardResolutionAuthorizedAcctOpeningImageUrlFieldId:
                                boardResolutionImage?.fileId || null,
                            boardResolutionAuthorizedAcctOpeningFileName:
                                boardResolutionImage?.url
                                    ? generateFileName(
                                        DocumentMetaMap.boardResolutionAuthorizedAcctOpeningImage,
                                        user.id,
                                        files
                                            .boardResolutionAuthorizedAcctOpeningImage?.[0]
                                            ?.originalname
                                    )
                                    : null,
                            meansOfIdentificationForBeneficialOwner:
                                meansOfIdImage?.url || null,
                            meansOfIdentificationForBeneficialOwnerImageFieldId:
                                meansOfIdImage?.fileId || null,
                            meansOfIdentificationForBeneficialOwnerFileName:
                                meansOfIdImage?.url
                                    ? generateFileName(
                                        DocumentMetaMap.meansOfIdentificationForBeneficialOwner,
                                        user.id,
                                        files
                                            .meansOfIdentificationForBeneficialOwner?.[0]
                                            ?.originalname
                                    )
                                    : null,
                            proofOfAddressForBeneficialOwner:
                                proofOfAddressImage?.url || null,
                            proofOfAddressForBeneficialOwnerImageFieldId:
                                proofOfAddressImage?.fileId || null,
                            proofOfAddressForBeneficialOwnerFileName:
                                proofOfAddressImage?.url
                                    ? generateFileName(
                                        DocumentMetaMap.proofOfAddressForBeneficialOwner,
                                        user.id,
                                        files
                                            .proofOfAddressForBeneficialOwner?.[0]
                                            ?.originalname
                                    )
                                    : null,
                        },
                    });

                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            businessDocumentsUploaded: true,
                            businessDocumentVerificationStatus:
                                DocumentVerificationStatus.PENDING,
                        },
                    });

                    const attempt = await this.persistBusinessDocumentStageAttempt(tx, {
                        user,
                        currentAttemptStatus,
                        submissionSource: "MULTIPART_UPLOAD",
                        cacDocumentNumber: dto.cacDocumentNumber,
                        evidenceSummary: {
                            cacImageUrl: cacImage?.url ?? null,
                            articleOfAssociationImageUrl: articleImage?.url ?? null,
                            boardResolutionImageUrl: boardResolutionImage?.url ?? null,
                            proofOfAddressUrl: proofOfAddressImage?.url ?? null,
                            meansOfIdentificationUrl: meansOfIdImage?.url ?? null,
                        } as Prisma.InputJsonValue,
                    });
                    stageAttemptId = attempt.id;
                },
                { timeout: 30000 }
            );
        } catch (error) {
            this.logger.error(
                `[BusinessDocumentsUpload][DatabasePhase] Failed for user ${user.id} | ${error?.name}: ${error?.message} | prismaCode=${error?.code}`,
                error?.stack
            );
            throw error;
        }

        // Invalidate backend profile cache so pending status is visible immediately
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Business Documents Submitted",
            body: "Your business documents have been submitted for review. We'll notify you once they're processed.",
            category: "security",
        });

        this.sendPendingReviewEmail(user.id, user.email, user.firstName, "Business Documents");

        // Fire-and-forget: Run Dojah business verification in background
        // This does NOT block the user response — results are stored async
        this.runDojahBusinessVerification(user.id, dto.cacDocumentNumber, files.cacImage?.[0], stageAttemptId)
            .catch((err) => {
                this.logger.error(
                    `[BusinessDocumentsUpload][DojahVerification] Background verification failed for user ${user.id}: ${err?.message}`,
                    err?.stack
                );
            });

        return buildResponse({
            message: "Document Verification successfully",
        });
    }

    /**
     * Upload a single business document file to ImageKit.
     * Returns the uploaded URL and fileId so the frontend can collect them
     * and send them all in a single submit call.
     */
    async uploadSingleBusinessDocumentFile(
        user: User,
        file: Express.Multer.File,
        dto: UploadBusinessDocumentFileDto
    ) {
        if (!this.isValidBusinessDocumentFieldName(dto.fieldName)) {
            throw new VerificationGenericException(
                `Invalid field name: ${dto.fieldName}`,
                HttpStatus.BAD_REQUEST
            );
        }

        try {
            const result = await this.uploadAsFile([file]);
            return buildResponse({
                message: "File uploaded successfully",
                data: {
                    fieldName: dto.fieldName,
                    url: result.url,
                    fileId: result.fileId,
                    originalName: file.originalname,
                },
            });
        } catch (error) {
            this.logger.error(
                `[BusinessDocumentFile] Upload failed for user ${user.id}, field ${dto.fieldName}: ${error?.message}`,
                error?.stack
            );
            throw error;
        }
    }

    /**
     * Submit all previously-uploaded business document URLs.
     * Creates the businessDocument record and triggers Dojah verification.
     */
    async submitBusinessDocumentsFromUrls(
        user: User,
        dto: SubmitBusinessDocumentsDto
    ) {
        const currentAttemptStatus = await this.getCurrentBusinessDocumentAttemptStatus(user.id);
        let stageAttemptId: number | undefined;

        if (currentAttemptStatus && currentAttemptStatus !== KycAttemptStatus.REJECTED && currentAttemptStatus !== KycAttemptStatus.EXPIRED) {
            throw new VerificationGenericException(
                `Document has already been uploaded and is ${currentAttemptStatus}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const { uploadedFiles } = dto;
        const invalidFieldName = Object.keys(uploadedFiles).find(
            (fieldName) => !this.isValidBusinessDocumentFieldName(fieldName)
        );

        if (invalidFieldName) {
            throw new VerificationGenericException(
                `Invalid field name: ${invalidFieldName}`,
                HttpStatus.BAD_REQUEST
            );
        }

        // cacImage is required
        if (!uploadedFiles.cacImage?.url) {
            throw new VerificationGenericException(
                "CAC image is required",
                HttpStatus.BAD_REQUEST
            );
        }

        const getField = (name: string) => uploadedFiles[name] || null;
        const getPersonField = (
            kind: "directors" | "shareholders",
            index: number,
            name: "idDocument" | "proofOfAddress"
        ) => getField(`${kind}[${index}].${name}`);

        // Pre-build upsert data outside the transaction callback to reduce its cognitive complexity.
        const updateData = {
            cacDocumentNumber: dto.cacDocumentNumber,
            ...fileFieldUpdate(getField("cacImage"), "cacImageUrl", "cacImageUrlFieldId", "cacImageFileName", DocumentMetaMap.cacImage, user.id),
            articleOfAssociationNumber: dto.articleOfAssociationNumber || null,
            ...fileFieldUpdate(getField("articleOfAssociationImage"), "articleOfAssociationImageUrl", "articleOfAssociationImageUrlFieldId", "articleOfAssociationFileName", DocumentMetaMap.articleOfAssociationImage, user.id),
            ...fileFieldUpdate(getField("boardResolutionAuthorizedAcctOpeningImage"), "boardResolutionAuthorizedAcctOpeningImageUrl", "boardResolutionAuthorizedAcctOpeningImageUrlFieldId", "boardResolutionAuthorizedAcctOpeningFileName", DocumentMetaMap.boardResolutionAuthorizedAcctOpeningImage, user.id),
            ...fileFieldUpdate(getField("meansOfIdentificationForBeneficialOwner"), "meansOfIdentificationForBeneficialOwner", "meansOfIdentificationForBeneficialOwnerImageFieldId", "meansOfIdentificationForBeneficialOwnerFileName", DocumentMetaMap.meansOfIdentificationForBeneficialOwner, user.id),
            ...fileFieldUpdate(getField("proofOfAddressForBeneficialOwner"), "proofOfAddressForBeneficialOwner", "proofOfAddressForBeneficialOwnerImageFieldId", "proofOfAddressForBeneficialOwnerFileName", DocumentMetaMap.proofOfAddressForBeneficialOwner, user.id),
            ...fileFieldUpdate(getField("applicationForRegistration"), "applicationForRegistrationUrl", "applicationForRegistrationFieldId", "applicationForRegistrationFileName", "application_for_registration", user.id),
            ...fileFieldUpdate(getField("memart"), "memartUrl", "memartFieldId", "memartFileName", "memart", user.id),
            ...fileFieldUpdate(getField("companyUtilityBills"), "companyUtilityBillsUrl", "companyUtilityBillsFieldId", "companyUtilityBillsFileName", "company_utility_bills", user.id),
            ...fileFieldUpdate(getField("companyAmlPolicy"), "companyAmlPolicyUrl", "companyAmlPolicyFieldId", "companyAmlPolicyFileName", "company_aml_policy", user.id),
            ...fileFieldUpdate(getField("scumlCertificate"), "scumlCertificateUrl", "scumlCertificateFieldId", "scumlCertificateFileName", "scuml_certificate", user.id),
            ...fileFieldUpdate(getField("companyOrganogram"), "companyOrganogramUrl", "companyOrganogramFieldId", "companyOrganogramFileName", "company_organogram", user.id),
            ...fileFieldUpdate(getField("companyLicense"), "companyLicenseUrl", "companyLicenseFieldId", "companyLicenseFileName", "company_license", user.id),
            ...fileFieldUpdate(getField("flowsBusinessFunds"), "flowsBusinessFundsUrl", "flowsBusinessFundsFieldId", "flowsBusinessFundsFileName", "flows_business_funds", user.id),
            companyWebsite: dto.companyWebsite ?? null,
            companyTaxId: dto.companyTaxId ?? null,
            companyAddress: dto.companyAddress ?? null,
            natureOfBusiness: dto.natureOfBusiness ?? null,
            purposeOfTransaction: dto.purposeOfTransaction ?? null,
            purposeOfTransactionOther: dto.purposeOfTransactionOther ?? null,
        };

        const createData = {
            userId: user.id,
            cacDocumentNumber: dto.cacDocumentNumber,
            ...fileFieldCreate(getField("cacImage"), "cacImageUrl", "cacImageUrlFieldId", "cacImageFileName", DocumentMetaMap.cacImage, user.id),
            articleOfAssociationNumber: dto.articleOfAssociationNumber || null,
            ...fileFieldCreate(getField("articleOfAssociationImage"), "articleOfAssociationImageUrl", "articleOfAssociationImageUrlFieldId", "articleOfAssociationFileName", DocumentMetaMap.articleOfAssociationImage, user.id),
            ...fileFieldCreate(getField("boardResolutionAuthorizedAcctOpeningImage"), "boardResolutionAuthorizedAcctOpeningImageUrl", "boardResolutionAuthorizedAcctOpeningImageUrlFieldId", "boardResolutionAuthorizedAcctOpeningFileName", DocumentMetaMap.boardResolutionAuthorizedAcctOpeningImage, user.id),
            ...fileFieldCreate(getField("meansOfIdentificationForBeneficialOwner"), "meansOfIdentificationForBeneficialOwner", "meansOfIdentificationForBeneficialOwnerImageFieldId", "meansOfIdentificationForBeneficialOwnerFileName", DocumentMetaMap.meansOfIdentificationForBeneficialOwner, user.id),
            ...fileFieldCreate(getField("proofOfAddressForBeneficialOwner"), "proofOfAddressForBeneficialOwner", "proofOfAddressForBeneficialOwnerImageFieldId", "proofOfAddressForBeneficialOwnerFileName", DocumentMetaMap.proofOfAddressForBeneficialOwner, user.id),
            ...fileFieldCreate(getField("applicationForRegistration"), "applicationForRegistrationUrl", "applicationForRegistrationFieldId", "applicationForRegistrationFileName", "application_for_registration", user.id),
            ...fileFieldCreate(getField("memart"), "memartUrl", "memartFieldId", "memartFileName", "memart", user.id),
            ...fileFieldCreate(getField("companyUtilityBills"), "companyUtilityBillsUrl", "companyUtilityBillsFieldId", "companyUtilityBillsFileName", "company_utility_bills", user.id),
            ...fileFieldCreate(getField("companyAmlPolicy"), "companyAmlPolicyUrl", "companyAmlPolicyFieldId", "companyAmlPolicyFileName", "company_aml_policy", user.id),
            ...fileFieldCreate(getField("scumlCertificate"), "scumlCertificateUrl", "scumlCertificateFieldId", "scumlCertificateFileName", "scuml_certificate", user.id),
            ...fileFieldCreate(getField("companyOrganogram"), "companyOrganogramUrl", "companyOrganogramFieldId", "companyOrganogramFileName", "company_organogram", user.id),
            ...fileFieldCreate(getField("companyLicense"), "companyLicenseUrl", "companyLicenseFieldId", "companyLicenseFileName", "company_license", user.id),
            ...fileFieldCreate(getField("flowsBusinessFunds"), "flowsBusinessFundsUrl", "flowsBusinessFundsFieldId", "flowsBusinessFundsFileName", "flows_business_funds", user.id),
            companyWebsite: dto.companyWebsite ?? null,
            companyTaxId: dto.companyTaxId ?? null,
            companyAddress: dto.companyAddress ?? null,
            natureOfBusiness: dto.natureOfBusiness ?? null,
            purposeOfTransaction: dto.purposeOfTransaction ?? null,
            purposeOfTransactionOther: dto.purposeOfTransactionOther ?? null,
        };

        try {
            await this.prisma.$transaction(
                async (tx) => {
                    const businessDocument = await tx.businessDocument.upsert({
                        where: { userId: user.id },
                        update: updateData,
                        create: createData,
                    });
                    const businessDocumentId = this.normalizePositiveInt(
                        businessDocument.id,
                        "business document id",
                    );

                    // Directors/shareholders are stored as structured rows tied to BusinessDocument
                    const directors = Array.isArray(dto.directors) ? dto.directors : [];
                    const shareholders = Array.isArray(dto.shareholders) ? dto.shareholders : [];
                    const directorRows: Prisma.BusinessDirectorCreateManyInput[] = directors.map((director, index) => ({
                        businessDocumentId,
                        fullName: this.normalizeRequiredBusinessText(director.fullName, "director full name"),
                        nationality: this.normalizeRequiredBusinessText(director.nationality, "director nationality"),
                        dateOfBirth: this.normalizeBusinessDate(director.dateOfBirth, "director date of birth"),
                        residentialAddress: this.normalizeRequiredBusinessText(director.residentialAddress, "director residential address"),
                        businessAddress: this.normalizeRequiredBusinessText(director.businessAddress, "director business address"),
                        nin: this.normalizeOptionalBusinessText(director.nin),
                        idDocumentUrl: getPersonField("directors", index, "idDocument")?.url || null,
                        idDocumentFieldId: getPersonField("directors", index, "idDocument")?.fileId || null,
                        idDocumentFileName: getPersonField("directors", index, "idDocument")
                            ? generateFileName("director_id_document", user.id, getPersonField("directors", index, "idDocument")?.originalName)
                            : null,
                        proofOfAddressUrl: getPersonField("directors", index, "proofOfAddress")?.url || null,
                        proofOfAddressFieldId: getPersonField("directors", index, "proofOfAddress")?.fileId || null,
                        proofOfAddressFileName: getPersonField("directors", index, "proofOfAddress")
                            ? generateFileName("director_proof_of_address", user.id, getPersonField("directors", index, "proofOfAddress")?.originalName)
                            : null,
                    }));
                    const shareholderRows: Prisma.BusinessShareholderCreateManyInput[] = shareholders.map((shareholder, index) => ({
                        businessDocumentId,
                        fullName: this.normalizeRequiredBusinessText(shareholder.fullName, "shareholder full name"),
                        nationality: this.normalizeRequiredBusinessText(shareholder.nationality, "shareholder nationality"),
                        dateOfBirth: this.normalizeBusinessDate(shareholder.dateOfBirth, "shareholder date of birth"),
                        residentialAddress: this.normalizeRequiredBusinessText(shareholder.residentialAddress, "shareholder residential address"),
                        businessAddress: this.normalizeRequiredBusinessText(shareholder.businessAddress, "shareholder business address"),
                        nin: this.normalizeOptionalBusinessText(shareholder.nin),
                        ownershipPercentage: this.normalizeOwnershipPercentage(shareholder.ownershipPercentage),
                        idDocumentUrl: getPersonField("shareholders", index, "idDocument")?.url || null,
                        idDocumentFieldId: getPersonField("shareholders", index, "idDocument")?.fileId || null,
                        idDocumentFileName: getPersonField("shareholders", index, "idDocument")
                            ? generateFileName("shareholder_id_document", user.id, getPersonField("shareholders", index, "idDocument")?.originalName)
                            : null,
                        proofOfAddressUrl: getPersonField("shareholders", index, "proofOfAddress")?.url || null,
                        proofOfAddressFieldId: getPersonField("shareholders", index, "proofOfAddress")?.fileId || null,
                        proofOfAddressFileName: getPersonField("shareholders", index, "proofOfAddress")
                            ? generateFileName("shareholder_proof_of_address", user.id, getPersonField("shareholders", index, "proofOfAddress")?.originalName)
                            : null,
                    }));

                    await tx.businessDirector.deleteMany({
                        where: { businessDocumentId },
                    });
                    await tx.businessShareholder.deleteMany({
                        where: { businessDocumentId },
                    });

                    if (directors.length > 0) {
                        await tx.businessDirector.createMany({
                            data: directorRows,
                        });
                    }

                    if (shareholders.length > 0) {
                        await tx.businessShareholder.createMany({
                            data: shareholderRows,
                        });
                    }
                    

                    await tx.user.update({
                        where: { id: user.id },
                        data: {
                            businessDocumentsUploaded: true,
                            businessDocumentVerificationStatus:
                                DocumentVerificationStatus.PENDING,
                        },
                    });

                    const attempt = await this.persistBusinessDocumentStageAttempt(tx, {
                        user,
                        currentAttemptStatus,
                        submissionSource: "STRUCTURED_URL_UPLOAD",
                        cacDocumentNumber: dto.cacDocumentNumber,
                        evidenceSummary: {
                            cacImageUrl: getField("cacImage")?.url ?? null,
                            articleOfAssociationImageUrl: getField("articleOfAssociationImage")?.url ?? null,
                            boardResolutionImageUrl: getField("boardResolutionAuthorizedAcctOpeningImage")?.url ?? null,
                            proofOfAddressUrl: getField("proofOfAddressForBeneficialOwner")?.url ?? null,
                            meansOfIdentificationUrl: getField("meansOfIdentificationForBeneficialOwner")?.url ?? null,
                            directorsCount: directors.length,
                            shareholdersCount: shareholders.length,
                        } as Prisma.InputJsonValue,
                    });
                    stageAttemptId = attempt.id;
                },
                { timeout: 30000 }
            );
        } catch (error) {
            this.logger.error(
                `[SubmitBusinessDocuments][DatabasePhase] Failed for user ${user.id} | ${error?.name}: ${error?.message} | prismaCode=${error?.code}`,
                error?.stack
            );
            throw error;
        }

        // Invalidate backend profile cache
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        // In-app notification for pending review
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Business Documents Submitted",
            body: "Your business documents have been submitted for review. We'll notify you once they're processed.",
            category: "security",
        });

        this.sendPendingReviewEmail(user.id, user.email, user.firstName, "Business Documents");

        // For Dojah verification we need the CAC image buffer.
        // Since we already uploaded to ImageKit, fetch it back as base64.
        this.runDojahBusinessVerificationFromStoredDocument(
            user.id,
            dto.cacDocumentNumber,
            stageAttemptId,
        ).catch((err) => {
            this.logger.error(
                `[SubmitBusinessDocuments][DojahVerification] Background verification failed for user ${user.id}: ${err?.message}`,
                err?.stack
            );
        });

        return buildResponse({
            message: "Document Verification successfully",
        });
    }

    private isValidBusinessDocumentFieldName(fieldName: string): boolean {
        const companyFields = new Set([
            "cacImage",
            "articleOfAssociationImage",
            "boardResolutionAuthorizedAcctOpeningImage",
            "proofOfAddressForBeneficialOwner",
            "meansOfIdentificationForBeneficialOwner",
            "applicationForRegistration",
            "memart",
            "companyUtilityBills",
            "companyAmlPolicy",
            "scumlCertificate",
            "companyOrganogram",
            "companyLicense",
            "flowsBusinessFunds",
        ]);

        if (companyFields.has(fieldName)) {
            return true;
        }

        if (/^directors\[\d+\]\.(idDocument|proofOfAddress)$/.test(fieldName)) {
            return true;
        }

        if (/^shareholders\[\d+\]\.(idDocument|proofOfAddress)$/.test(fieldName)) {
            return true;
        }

        return false;
    }

    /**
     * Background Dojah verification for business documents.
     * Runs CAC lookup, TIN verification, and CAC document OCR in parallel.
     * Stores results back into BusinessDocument record.
     */
    private async runDojahBusinessVerification(
        userId: number,
        cacDocumentNumber: string,
        cacImageFile?: Express.Multer.File,
        attemptId?: number,
    ): Promise<void> {
        try {
            // Fetch business record for TIN and business name
            const businessRecord = await this.prisma.businessRecord.findUnique({
                where: { userId },
            });

            const businessName = businessRecord?.businessName || "";
            const tin = businessRecord?.taxIdentificationNumber;

            // Convert CAC image buffer to base64 for OCR
            let cacImageBase64: string | undefined;
            if (cacImageFile?.buffer) {
                cacImageBase64 = cacImageFile.buffer.toString("base64");
            }
            const hasTinCheck = Boolean(tin);
            const hasOcrCheck = Boolean(cacImageBase64);

            this.logger.log(
                `[DojahBusinessVerification] Starting for user ${userId}: ` +
                `RC=${cacDocumentNumber}, TIN=${tin ? "provided" : "none"}, ` +
                `OCR=${cacImageBase64 ? "has image" : "no image"}, businessName=${businessName}`
            );

            const verificationResult = await this.dojahService.verifyBusinessDocuments({
                cacDocumentNumber,
                taxIdentificationNumber: tin,
                cacImageBase64,
                businessName,
            });

            // Store results in BusinessDocument
            await this.prisma.businessDocument.update({
                where: { userId },
                data: {
                    // CAC lookup results
                    cacVerified: verificationResult.cac.verified,
                    cacVerifiedAt: verificationResult.cac.verified ? new Date() : null,
                    cacCompanyName: verificationResult.cac.companyName || null,
                    cacCompanyStatus: verificationResult.cac.companyStatus || null,
                    cacRegistrationDate: verificationResult.cac.registrationDate || null,
                    cacNameMatches: verificationResult.cac.nameMatches ?? null,
                    cacRawResponse: verificationResult.cac.rawResponse || null,

                    // TIN verification results
                    tinVerified: verificationResult.tin.verified,
                    tinVerifiedAt: verificationResult.tin.verified ? new Date() : null,
                    tinTaxpayerName: verificationResult.tin.taxpayerName || null,
                    tinNameMatches: verificationResult.tin.nameMatches ?? null,
                    tinRawResponse: verificationResult.tin.rawResponse || null,

                    // CAC Document OCR results
                    cacOcrVerified: verificationResult.ocr.verified,
                    cacOcrVerifiedAt: verificationResult.ocr.verified ? new Date() : null,
                    cacOcrExtractedNumber: verificationResult.ocr.extractedNumber || null,
                    cacOcrExtractedName: verificationResult.ocr.extractedName || null,
                    cacOcrNumberMatches: verificationResult.ocr.numberMatches ?? null,
                    cacOcrRawResponse: verificationResult.ocr.rawResponse || null,
                },
            });

            await this.syncBusinessProviderCheckAttempt({
                userId,
                cacDocumentNumber,
                attemptId,
                verificationResult,
                hasTinCheck,
                hasOcrCheck,
            });

            this.logger.log(
                `[DojahBusinessVerification] Completed for user ${userId}: ` +
                `CAC=${verificationResult.cac.verified}(name=${verificationResult.cac.nameMatches}), ` +
                `TIN=${verificationResult.tin.verified}(name=${verificationResult.tin.nameMatches}), ` +
                `OCR=${verificationResult.ocr.verified}(num=${verificationResult.ocr.numberMatches})`
            );
        } catch (error) {
            this.logger.error(
                `[DojahBusinessVerification] Failed for user ${userId}: ${error?.message}`,
                error?.stack
            );
            // Don't re-throw — this is a background task
        }
    }

    private getTrustedDocumentOrigins(): Set<string> {
        const trustedOrigins = new Set<string>();

        if (imagekitConfig.url) {
            try {
                trustedOrigins.add(new URL(imagekitConfig.url).origin);
            } catch {
                this.logger.warn("Invalid IMAGEKIT_URL configured; skipping URL origin allowlist entry");
            }
        }

        if (cloudinaryConfig.cloud_name) {
            trustedOrigins.add(`https://res.cloudinary.com/${cloudinaryConfig.cloud_name}`);
        }

        // Keep a safe fallback for standard ImageKit domains.
        trustedOrigins.add("https://ik.imagekit.io");

        return trustedOrigins;
    }

    private resolveTrustedDocumentUrl(rawUrl: string): URL | null {
        try {
            const parsedUrl = new URL(rawUrl);
            if (parsedUrl.protocol !== "https:") {
                return null;
            }

            return this.getTrustedDocumentOrigins().has(parsedUrl.origin)
                ? parsedUrl
                : null;
        } catch {
            return null;
        }
    }

    private async fetchTrustedDocumentBuffer(trustedUrl: URL): Promise<Buffer> {
        if (trustedUrl.protocol !== "https:" || !this.getTrustedDocumentOrigins().has(trustedUrl.origin)) {
            throw new BadRequestException("Untrusted document URL");
        }

        return await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const request = httpsRequest(trustedUrl, { method: "GET", timeout: 30000 }, (response) => {
                const statusCode = response.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    response.resume();
                    reject(new Error(`Unexpected document fetch status: ${statusCode}`));
                    return;
                }

                response.on("data", (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                response.on("end", () => {
                    resolve(Buffer.concat(chunks));
                });
                response.on("error", reject);
            });

            request.on("timeout", () => {
                request.destroy(new Error("Timed out fetching trusted document"));
            });
            request.on("error", reject);
            request.end();
        });
    }

    /**
     * Dojah verification variant that fetches the CAC image from a URL
     * instead of requiring a Multer file buffer.
     * Used by the sequential-upload submit flow.
     */
    private async runDojahBusinessVerificationFromStoredDocument(
        userId: number,
        cacDocumentNumber: string,
        attemptId?: number,
    ): Promise<void> {
        const businessDocument = await this.prisma.businessDocument.findUnique({
            where: { userId },
            select: { cacImageUrl: true },
        });
        const cacImageUrl = businessDocument?.cacImageUrl;

        if (!cacImageUrl) {
            this.logger.warn(
                `[DojahBusinessVerificationFromUrl] No CAC image URL for user ${userId}, skipping`
            );
            return;
        }

        const trustedImageUrl = this.resolveTrustedDocumentUrl(cacImageUrl);
        if (!trustedImageUrl) {
            this.logger.warn(
                `[DojahBusinessVerificationFromUrl] Untrusted CAC image URL for user ${userId}, skipping`
            );
            return;
        }

        try {
            // Fetch the document only after re-validating it against the trusted CDN allowlist.
            const buffer = await this.fetchTrustedDocumentBuffer(trustedImageUrl);

            // Create a synthetic Multer-like file object
            const syntheticFile: Express.Multer.File = {
                buffer,
                fieldname: "cacImage",
                originalname: "cacImage.webp",
                encoding: "7bit",
                mimetype: "image/webp",
                size: buffer.length,
                stream: null as any,
                destination: "",
                filename: "",
                path: "",
            };

            await this.runDojahBusinessVerification(
                userId,
                cacDocumentNumber,
                syntheticFile,
                attemptId,
            );
        } catch (error) {
            this.logger.error(
                `[DojahBusinessVerificationFromUrl] Failed for user ${userId}: ${error?.message}`,
                error?.stack
            );
        }
    }

    async submitBusinessRecord(user: User, dto: SubmitBusinessRecordDto) {
        const record = await this.prisma.$transaction(
            async (tx) => {
                const record = await tx.businessRecord.upsert({
                    where: { userId: user.id },
                    update: {
                        businessName: dto.businessName,
                        natureOfBusiness: dto.natureOfBusiness,
                        expectedTransactionFrequency:
                            dto.expectedTransactionFrequency,
                        expectedTransactionVolume:
                            dto.expectedTransactionVolumes,
                        taxIdentificationNumber: dto.taxIdentificationNumber,
                    },
                    create: {
                        userId: user.id,
                        businessName: dto.businessName,
                        natureOfBusiness: dto.natureOfBusiness,
                        expectedTransactionFrequency:
                            dto.expectedTransactionFrequency,
                        expectedTransactionVolume:
                            dto.expectedTransactionVolumes,
                        taxIdentificationNumber: dto.taxIdentificationNumber,
                    },
                });

                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        businessRecordCompleted: true,
                        firstName: dto.firstName,
                        lastName: dto.lastName,
                        businessName: dto.businessName,
                    },
                });
                return record;
            },
            { maxWait: 10000, timeout: 30000 }
        );

        await this.cryptoAccountQueueProducer.enqueue(user.id);
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        return buildResponse({
            message: "Business record submitted successfully",
            data: record,
        });
    }

    async userSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.USER, ip);
    }

    async adminSignIn(options: UserSigInDto, ip: string): Promise<ApiResponse> {
        return await this.signIn(options, LoginPlatform.ADMIN, ip);
    }

    /**
     * Create a login session with error handling.
     * Session creation failure should NOT prevent login.
     */
    private async createLoginSession(
        userId: number,
        deviceInfo: { deviceName?: string; deviceType?: string; browser?: string; os?: string },
        ip: string,
    ): Promise<string | undefined> {
        try {
            const sessionInfo: SessionInfo = {
                deviceName: deviceInfo.deviceName,
                deviceType: deviceInfo.deviceType,
                browser: deviceInfo.browser,
                os: deviceInfo.os,
                ipAddress: ip,
            };
            const sessionResult = await this.sessionService.createSession(userId, sessionInfo);
            return sessionResult.sessionId;
        } catch (sessionError: unknown) {
            const errMsg = sessionError instanceof Error ? sessionError.message : JSON.stringify(sessionError);
            Logger.error(`Failed to create session for user ${userId}: ${errMsg}`);
            return undefined;
        }
    }

    private buildAdminPermissions(user: { userType: string; role?: { rolePermission?: Array<{ permission: { name: string } }> } }): string[] {
        if (user.userType === UserType.SUPER_ADMIN) {
            return Object.values(PermissionName);
        }
        return (user.role?.rolePermission ?? []).map((rp: any) => rp.permission.name);
    }

    private buildVerificationStatus(user: LoginResponseUser): VerificationStatus {
        const normalizedUserType = user.userType.toLowerCase();
        const governmentVerificationState = this.buildGovernmentVerificationState(user);
        const individualVerificationSnapshot = normalizedUserType === "individual"
            ? buildIndividualVerificationSnapshot({
                bvn: user.bvn ?? null,
                nin: user.nin ?? null,
                kycStageAttempts: user.kycStageAttempts ?? undefined,
            })
            : null;
        const verificationStatus: VerificationStatus = {
            emailVerified: user.isEmailVerified,
            phoneVerified: user.isPhoneVerified,
            passwordCreated: user.isPasswordCreated,
            governmentIdVerified: governmentVerificationState.governmentIdVerified,
            documentVerified: normalizedUserType === "individual"
                ? Boolean(individualVerificationSnapshot?.documentVerified)
                : user.isDocumentVerified,
        };

        if (normalizedUserType === "business") {
            verificationStatus.businessRecordCompleted = user.businessRecordCompleted;
            verificationStatus.businessDocumentVerificationStatus = user.businessDocumentVerificationStatus || null;
        }

        return verificationStatus;
    }

    private buildLoginSuccessResponse(
        user: LoginResponseUser,
        loginPlatform: LoginPlatform,
        tokens: { accessToken: string; refreshToken: string },
        sessionId?: string,
    ): ApiResponse {
        if (loginPlatform === LoginPlatform.ADMIN) {
            const permissions = this.buildAdminPermissions(user);

            return buildResponse({
                message: "Login successful",
                data: {
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    userType: user.userType,
                    role: user.role ? { name: user.role.name, slug: user.role.slug ?? null } : null,
                    permissions,
                },
            });
        }

        return buildResponse({
            message: "Login successful",
            data: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                sessionId,
                userType: user.userType.toLowerCase(),
                verificationStatus: this.buildVerificationStatus(user),
            },
        });
    }

    private assertUserCanSignIn(
        user: {
            email: string;
            userType: UserType;
            status: Status;
            password?: string | null;
            flaggedRecord?: { flagged: boolean; reason: string } | null;
        },
        loginPlatform: LoginPlatform,
    ): void {
        const flagged = user.flaggedRecord || { flagged: false, reason: "" };

        if (flagged.flagged && flagged.reason === "Multiple failed login attempts") {
            throw new UserAccountDisabledException(
                `Account is flagged: ${flagged.reason || "Multiple failed login attempts"}. Please contact support.`,
                HttpStatus.FORBIDDEN,
            );
        }

        if (user.status === Status.BLOCKED) {
            throw new UserAccountDisabledException(
                "Account is disabled. Kindly contact customer support",
                HttpStatus.BAD_REQUEST,
            );
        }

        this.validateLoginPlatform(user.userType, loginPlatform);

        if (!user.password) {
            throw new AuthGenericException(
                "Please create your password first",
                HttpStatus.BAD_REQUEST,
            );
        }
    }

    private async verifyTwoFactorLoginCode(
        user: { id: number; twoFactorSecret: string },
        code: string,
    ): Promise<void> {
        let isValid = authenticator.verify({
            token: code,
            secret: decryptField(user.twoFactorSecret),
        });

        if (!isValid) {
            isValid = await this.settingService.verifyBackupCode(user.id, code);
        }

        if (isValid) {
            await this.twoFactorRateLimitService.recordSuccessfulAttempt(user.id.toString(), "login");
            return;
        }

        const rateLimitResult = await this.twoFactorRateLimitService.checkAttempt(user.id.toString(), "login");
        if (!rateLimitResult.allowed) {
            throw new TwoFactorLockedException(
                "Too many failed 2FA attempts",
                rateLimitResult.lockoutDuration,
            );
        }

        const failedResult = await this.twoFactorRateLimitService.recordFailedAttempt(user.id.toString(), "login");
        if (failedResult.lockoutEndsAt) {
            throw new TwoFactorLockedException(
                "Invalid verification code",
                failedResult.lockoutDuration,
            );
        }

        throw new Invalid2FACodeException(
            `Invalid verification code. ${failedResult.remainingAttempts} attempts remaining.`,
        );
    }

    private async signIn(
        options: SignInOptions,
        loginPlatform: LoginPlatform,
        ip: string
    ): Promise<ApiResponse> {
        const baseSelect = {
            id: true,
            identifier: true,
            password: true,
            userType: true,
            status: true,
            role: { select: { name: true, slug: true, rolePermission: { select: { permission: { select: { name: true } } } } } },
            lastLogin: true,
            loginCount: true,
            flaggedRecord: true,
            flaggedId: true,
            email: true,
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            bvn: true,
            nin: true,
            isDocumentVerified: true,
            businessRecordCompleted: true,
            businessDocumentVerificationStatus: true,
            isTwoFactorEnabled: true,
            twoFactorSecret: true,
            kycStageAttempts: {
                where: {
                    journeyType: "INDIVIDUAL",
                    stage: {
                        in: [KycStage.GOVERNMENT_ID, KycStage.IDENTITY_DOCUMENT],
                    },
                    isCurrent: true,
                },
                orderBy: [{ updatedAt: Prisma.SortOrder.desc }, { id: Prisma.SortOrder.desc }],
                select: {
                    stage: true,
                    method: true,
                    status: true,
                    isCurrent: true,
                },
            },
            // Account lockout fields
            failedLoginAttempts: true,
            lastFailedLogin: true,
            lockedUntil: true,
        } satisfies Prisma.UserSelect;

        const email = options.email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email },
            select:
                loginPlatform === LoginPlatform.USER
                    ? baseSelect
                    : {
                        ...baseSelect,
                        isEmailVerified: false,
                        isPhoneVerified: false,
                        isPasswordCreated: false,
                        bvn: false,
                        nin: false,
                        isDocumentVerified: false,
                        businessRecordCompleted: false,
                        businessDocumentVerificationStatus: false,
                        kycStageAttempts: false,
                    },
        });

        if (!user) {
            throw new InvalidCredentialException("Invalid email or password");
        }

        this.assertUserCanSignIn(user, loginPlatform);

        Logger.log(`[LoginDebug] Attempting login for ${user.email}. Hash exists: ${!!user.password}`);

        const passwordMatch = await this.comparePassword(
            options.password,
            user.password
        );

        Logger.log(`[LoginDebug] Password match result for ${user.email}: ${passwordMatch}`);

        if (!passwordMatch) {
            await this.handleFailedLogin(user, ip);
            throw new InvalidCredentialException("Invalid email or password");
        }

        // Check if 2FA is enabled - return temporary token for 2FA verification
        // Apply to BOTH user and admin logins for enhanced security
        if (user.isTwoFactorEnabled && user.twoFactorSecret) {

            const tempToken = await this.jwtService.signAsync(
                { sub: user.id, type: "2fa_pending", platform: loginPlatform },
                { secret: jwtSecret, expiresIn: "5m" }
            );

            return buildResponse({
                message: "Two-factor authentication required",
                data: {
                    requiresTwoFactor: true,
                    tempToken: tempToken,
                    email: user.email, // Help user identify which account
                },
            });
        }

        // Create session for user logins with error handling
        const sessionId = loginPlatform === LoginPlatform.USER
            ? await this.createLoginSession(user.id, options, ip)
            : undefined;

        const tokenPayload: Record<string, any> = {
            sub: user.id,
            platform: loginPlatform,
            sessionId,
        };

        const tokens = await this.generateTokens(tokenPayload);

        await this.saveRefreshToken(user.id, tokens.refreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                ipAddress: ip,
                loginCount: 0,
                lastLogin: new Date(),
            },
        });

        return this.buildLoginSuccessResponse(user, loginPlatform, tokens, sessionId);
    }

    async refreshToken(options: RefreshTokenDto): Promise<ApiResponse> {
        const payload = this.jwtService.verify<DataStoredInToken>(options.refreshToken, {
            secret: jwt_refresh_secret,
        });

        // SECURITY: Distributed lock prevents concurrent refresh token rotation race condition
        return this.distributedLockService.withLock(
            `refresh:${payload.sub}`,
            async () => {
                const validationResult = await this.validateRefreshToken(
                    payload.sub,
                    options.refreshToken
                );

                if (!validationResult.valid) {
                    if (validationResult.reuse) {
                        // Token reuse detected — possible theft. Invalidate entire family.
                        Logger.warn(`SECURITY: Refresh token reuse detected for user ${payload.sub}. Invalidating all tokens.`);
                        await this.prisma.user.update({
                            where: { id: payload.sub },
                            data: { refreshToken: null, refreshTokenFamily: null },
                        });
                    }
                    throw new InvalidRefreshToken(
                        "Invalid refresh token",
                        HttpStatus.UNAUTHORIZED
                    );
                }

                if (payload.sessionId) {
                    const isSessionValid = await this.sessionService.validateSession(
                        payload.sessionId
                    );

                    if (!isSessionValid) {
                        throw new InvalidRefreshToken(
                            "Session expired or invalid",
                            HttpStatus.UNAUTHORIZED
                        );
                    }
                }

                const newTokens = await this.generateTokens({
                    sub: payload.sub,
                    ...(payload.platform ? { platform: payload.platform } : {}),
                    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
                });

                // Rotate token but keep the same family
                await this.saveRefreshToken(payload.sub, newTokens.refreshToken, validationResult.family);

                return buildResponse({
                    message: `Refresh token generated`,
                    data: newTokens,
                });
            },
            { ttlMs: 10000, maxWaitMs: 5000 }
        );
    }

    private hashToken(token: string): string {
        return crypto.createHash("sha256").update(token).digest("hex");
    }

    async saveRefreshToken(id: number, refreshToken: string, family?: string) {
        return this.prisma.user.update({
            where: { id: id },
            data: {
                refreshToken: this.hashToken(refreshToken),
                refreshTokenFamily: family ?? crypto.randomUUID(),
            },
        });
    }

    async validateRefreshToken(
        id: number,
        refreshToken: string
    ): Promise<{ valid: boolean; reuse?: boolean; family?: string }> {
        const user = await this.prisma.user.findUnique({
            where: { id: id },
            select: { refreshToken: true, refreshTokenFamily: true },
        });
        if (!user?.refreshToken) return { valid: false };
        const hashedIncoming = this.hashToken(refreshToken);
        if (user.refreshToken.length !== hashedIncoming.length) {
            return { valid: false, reuse: !!user.refreshTokenFamily };
        }
        try {
            const matches = crypto.timingSafeEqual(
                Buffer.from(user.refreshToken, "utf8"),
                Buffer.from(hashedIncoming, "utf8")
            );
            if (matches) {
                return { valid: true, family: user.refreshTokenFamily ?? undefined };
            }
            return { valid: false, reuse: !!user.refreshTokenFamily };
        } catch {
            return { valid: false };
        }
    }

    /**
     * Verify 2FA code and complete login
     */
    async verify2FALogin(dto: Verify2FALoginDto, ip: string): Promise<ApiResponse> {
        // Verify the temp token
        let payload: { sub: number; type: string; platform: LoginPlatform };
        try {
            payload = await this.jwtService.verifyAsync(dto.tempToken, {
                secret: jwtSecret,
            });
        } catch {
            throw new UserUnauthorizedException(
                "Invalid or expired token. Please log in again.",
                HttpStatus.UNAUTHORIZED
            );
        }

        if (payload.type !== "2fa_pending") {
            throw new UserUnauthorizedException(
                "Invalid token type",
                HttpStatus.UNAUTHORIZED
            );
        }

        // Get user with 2FA details
        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: {
                id: true,
                twoFactorSecret: true,
                isTwoFactorEnabled: true,
                userType: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                bvn: true,
                nin: true,
                isDocumentVerified: true,
                businessRecordCompleted: true,
                businessDocumentVerificationStatus: true,
                kycStageAttempts: {
                    where: {
                        journeyType: "INDIVIDUAL",
                        stage: {
                            in: [KycStage.GOVERNMENT_ID, KycStage.IDENTITY_DOCUMENT],
                        },
                        isCurrent: true,
                    },
                    orderBy: [{ updatedAt: Prisma.SortOrder.desc }, { id: Prisma.SortOrder.desc }],
                    select: {
                        stage: true,
                        method: true,
                        status: true,
                        isCurrent: true,
                    },
                },
                role: { select: { name: true, slug: true, rolePermission: { select: { permission: { select: { name: true } } } } } },
            },
        });

        if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
            throw new UserUnauthorizedException(
                "2FA is not enabled for this account",
                HttpStatus.BAD_REQUEST
            );
        }

        await this.verifyTwoFactorLoginCode(user, dto.code);

        // Create session for user logins (2FA complete) with error handling
        // Create session for user logins (2FA complete) with error handling
        const sessionId = payload.platform === LoginPlatform.USER
            ? await this.createLoginSession(user.id, dto, ip)
            : undefined;

        const tokens = await this.generateTokens({
            sub: user.id,
            platform: payload.platform,
            sessionId,
        });

        await this.saveRefreshToken(user.id, tokens.refreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                ipAddress: ip,
                loginCount: 0,
                lastLogin: new Date(),
            },
        });

        return this.buildLoginSuccessResponse(user, payload.platform, tokens, sessionId);
    }

    /**
     * Reset 2FA rate limit for a user (Admin function)
     */
    async reset2FARateLimit(dto: { userId: number; context?: "login" | "transaction" }): Promise<ApiResponse> {
        // Verify user exists
        const user = await this.prisma.user.findUnique({
            where: { id: dto.userId },
            select: { id: true, email: true, isTwoFactorEnabled: true },
        });

        if (!user) {
            throw new UserNotFoundException("User not found");
        }

        // Reset rate limit
        await this.twoFactorRateLimitService.resetAttempts(
            user.id.toString(),
            dto.context
        );

        const contextMsg = dto.context
            ? `${dto.context} 2FA rate limit`
            : "all 2FA rate limits";

        return buildResponse({
            message: `Successfully reset ${contextMsg} for user ${user.email}`,
            data: {
                userId: user.id,
                email: user.email,
                contextReset: dto.context || "all",
            },
        });
    }


}

