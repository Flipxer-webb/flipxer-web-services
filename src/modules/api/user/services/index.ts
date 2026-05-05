import {
    storageDirConfig,
    emailTemplateConfig,
    COMPANY_NAME,
    mailConfig,
} from "@/config";
import {
    MIN_BUY_AMOUNT_USDT,
    MIN_SELL_AMOUNT_USDT,
    MIN_SWAP_AMOUNT_USDT,
    SUPPORTED_TRADE_ASSETS,
} from "@/modules/api/trade/constants";
import { createHmac } from "node:crypto";
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    buildPaginationMeta,
    defaultPagination,
    generateRandomNum,
} from "@/utils";
import { buildResponse } from "@/utils/api-response-util";
import {
    BadRequestException,
    Injectable,
    forwardRef,
    Inject,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { AuthService } from "../../auth/services";
import { IndividualKycStageService } from "../../auth/services/individual-kyc-stage.service";
import { TierService } from "../../auth/services/tier.service";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { UploadApiResponse } from "cloudinary";
import { UploadResponse } from "imagekit/dist/libs/interfaces";
import {
    GetUserAssetsDto,
    UpdateProfilePasswordDto,
    UpdateUserDetailsDto,
    SendRecoveryEmailOtpDto,
    VerifyRecoveryEmailOtpDto,
    GetUserListDto,
} from "../dtos";
import {
    UserNotFoundException,
    AuthGenericException,
    InvalidVerificationCodeException,
    VerificationCodeExpiredException,
    DuplicateVerificationException,
} from "../../auth/errors";
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import {
    DocumentVerificationStatus,
    OrderStatus,
    Prisma,
    User,
    UserType,
} from "@prisma/client";
import { IncorrectPasswordException } from "../errors";
import { customAlphabet } from "nanoid";
import { Ticker } from "@/libs/quidax/types/trade";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { LedgerService } from "@/modules/api/trade/services/ledger/ledger.service";
import { RateService } from "@/modules/api/trade/services/rate.service";
import {
    getCurrentGovernmentMethod,
    getCurrentIndividualStageAttempt,
    isIndividualAttemptApproved,
    isIndividualAttemptPending,
    isIndividualAttemptRejected,
} from "../../auth/utils/individual-kyc-stage-state.util";

type IndividualKycStage =
    | "GOVERNMENT_ID"
    | "IDENTITY_DOCUMENT"
    | "ADDRESS"
    | "INCOME";
type KycJourneyOverallStatus =
    | "NOT_STARTED"
    | "IN_PROGRESS"
    | "IN_REVIEW"
    | "ACTION_REQUIRED"
    | "VERIFIED";
type KycJourneyNextActionType =
    | "START"
    | "SUBMIT"
    | "RESUBMIT"
    | "WAIT"
    | "COMPLETE"
    | "CONTACT_SUPPORT";
type KycJourneyStageStatus =
    | "NOT_STARTED"
    | "PENDING_REVIEW"
    | "APPROVED"
    | "REJECTED";
type KycJourneyStageDisplayState =
    | "NOT_STARTED"
    | "READY"
    | "UNDER_REVIEW"
    | "VERIFIED"
    | "NEEDS_RESUBMISSION"
    | "BLOCKED";
type BusinessVerificationStatus =
    | "NOT_STARTED"
    | "PENDING_REVIEW"
    | "APPROVED"
    | "REJECTED";
type BusinessVerificationDisplayState =
    | "NOT_STARTED"
    | "READY"
    | "UNDER_REVIEW"
    | "VERIFIED"
    | "NEEDS_RESUBMISSION";
type JourneyTimestamp = Date | string | null;

interface KycJourneyStageDto {
    stage: IndividualKycStage;
    label: string;
    status: KycJourneyStageStatus;
    providerStatus: string | null;
    displayState: KycJourneyStageDisplayState;
    currentAttemptId: number | null;
    currentMethod: string | null;
    blockedBy: IndividualKycStage[];
    canSubmit: boolean;
    canResubmit: boolean;
    canEscalate: boolean;
    submittedAt: string | null;
    reviewedAt: string | null;
    reasonCode: string | null;
    reasonMessage: string | null;
    helperText: string | null;
    route: string | null;
    actionLabel: string | null;
}

interface KycJourneyNextActionDto {
    type: KycJourneyNextActionType;
    stage: IndividualKycStage | null;
    route: string | null;
    label: string | null;
    message: string | null;
}

interface KycJourneyDto {
    overallStatus: KycJourneyOverallStatus;
    currentStage: IndividualKycStage | null;
    nextStage: IndividualKycStage | null;
    completedStages: IndividualKycStage[];
    pendingStages: IndividualKycStage[];
    blockedStages: IndividualKycStage[];
    currentTier: number;
    eligibleTierAfterNextApproval: number | null;
    nextAction: KycJourneyNextActionDto;
    stages: KycJourneyStageDto[];
}

interface BusinessVerificationDto {
    stage: "BUSINESS_DOCUMENT";
    status: BusinessVerificationStatus;
    displayState: BusinessVerificationDisplayState;
    providerStatus: string | null;
    currentAttemptId: number | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    reasonCode: string | null;
    reasonMessage: string | null;
}

interface JourneyStageAttemptRecord {
    id: number;
    journeyType?: string | null;
    stage: string;
    method: string | null;
    status: string;
    providerStatus: string | null;
    reasonCode: string | null;
    reasonMessage: string | null;
    submittedAt: JourneyTimestamp;
    reviewedAt: JourneyTimestamp;
    isCurrent?: boolean;
}

interface JourneyStageState {
    verified: boolean;
    pending: boolean;
    rejected: boolean;
    providerStatus: string | null;
    currentAttemptId: number | null;
    currentMethod: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    reasonCode: string | null;
    reasonMessage: string | null;
}

@Injectable()
export class UserService {
    private readonly uploadService: ImagekitService | CloudinaryService;
    private readonly logger = new Logger(UserService.name);

    // Profile cache configuration
    private readonly PROFILE_CACHE_TTL = 300; // 5 minutes
    private readonly getProfileCacheKey = (userId: number) =>
        `user:profile:${userId}`;

    constructor(
        private readonly prisma: PrismaService,
        @Inject(forwardRef(() => AuthService))
        private readonly authService: AuthService,
        private readonly individualKycStageService: IndividualKycStageService,
        private readonly emailService: EmailService,
        private readonly uploadFactory: UploadFactory,
        private readonly quidaxCacheService: QuidaxCacheService,
        private readonly tierService: TierService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        private readonly redisCacheService: RedisCacheService,
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService,
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "imagekit",
        });
    }

    buildKycReadModel(profile: any) {
        const kycJourney = this.buildKycJourney(profile);

        if (profile?.userType === UserType.BUSINESS) {
            const businessVerification =
                this.buildBusinessVerification(profile);

            return {
                businessVerification,
                verificationRequirements:
                    this.getBusinessVerificationRequirements(
                        profile,
                        businessVerification,
                    ),
                kycJourney,
            };
        }

        return {
            kycJourney,
        };
    }

    private normalizeProfileContract<T extends Record<string, any>>(
        profileData: T,
    ) {
        const {
            isEmailVerified,
            isPhoneVerified,
            isPasswordCreated,
            isDocumentVerified,
            bvn,
            nin,
            verificationRequirements,
            emailVerified,
            phoneVerified,
            passwordCreated,
            documentVerified,
            ...restProfileData
        } = profileData;

        const normalizedBooleanFields: Record<string, boolean> = {};

        if (typeof emailVerified === "boolean") {
            normalizedBooleanFields.emailVerified = emailVerified;
        } else if (typeof isEmailVerified === "boolean") {
            normalizedBooleanFields.emailVerified = isEmailVerified;
        }

        if (typeof phoneVerified === "boolean") {
            normalizedBooleanFields.phoneVerified = phoneVerified;
        } else if (typeof isPhoneVerified === "boolean") {
            normalizedBooleanFields.phoneVerified = isPhoneVerified;
        }

        if (typeof passwordCreated === "boolean") {
            normalizedBooleanFields.passwordCreated = passwordCreated;
        } else if (typeof isPasswordCreated === "boolean") {
            normalizedBooleanFields.passwordCreated = isPasswordCreated;
        }

        if (typeof documentVerified === "boolean") {
            normalizedBooleanFields.documentVerified = documentVerified;
            normalizedBooleanFields.isDocumentVerified = documentVerified;
        } else if (typeof isDocumentVerified === "boolean") {
            normalizedBooleanFields.documentVerified = isDocumentVerified;
            normalizedBooleanFields.isDocumentVerified = isDocumentVerified;
        }

        return {
            ...restProfileData,
            bvn: this.maskGovernmentIdentifier(
                typeof bvn === "string" ? bvn : null,
            ),
            nin: this.maskGovernmentIdentifier(
                typeof nin === "string" ? nin : null,
            ),
            ...normalizedBooleanFields,
        };
    }

    private getErrorMessage(
        error: unknown,
        fallback = "Unknown error",
    ): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }

        if (typeof error === "string" && error.trim().length > 0) {
            return error;
        }

        try {
            const serialized = JSON.stringify(error);
            return serialized && serialized !== "{}" ? serialized : fallback;
        } catch {
            return fallback;
        }
    }

    private getValidatedUserId(userId: unknown): number {
        if (
            typeof userId === "number" &&
            Number.isSafeInteger(userId) &&
            userId > 0
        ) {
            return userId;
        }

        throw new BadRequestException("Invalid user id");
    }

    async getProfile(user: User) {
        const startTime = Date.now();
        const shouldEnsureIndividualStages =
            user.userType === UserType.INDIVIDUAL;

        // Try to get from cache first
        const cacheKey = this.getProfileCacheKey(user.id);
        const cachedProfile = await this.redisCacheService.get<any>(cacheKey);

        if (cachedProfile) {
            if (
                shouldEnsureIndividualStages &&
                this.shouldRefreshCachedIndividualProfile(cachedProfile?.data)
            ) {
                this.logger.debug(
                    `[PERF] Profile cache REFRESH for user ${user.id} after stage-attempt migration check`,
                );
            } else {
                const nextKycReadModel = this.buildKycReadModel(
                    cachedProfile?.data,
                );
                const normalizedCachedData = this.normalizeProfileContract(
                    cachedProfile.data,
                );
                const didRequirementsChange =
                    cachedProfile?.data?.userType === UserType.BUSINESS &&
                    JSON.stringify(
                        cachedProfile?.data?.verificationRequirements ?? null,
                    ) !==
                        JSON.stringify(
                            nextKycReadModel.verificationRequirements ?? null,
                        );
                const didBusinessVerificationChange =
                    cachedProfile?.data?.userType === UserType.BUSINESS &&
                    JSON.stringify(
                        cachedProfile?.data?.businessVerification ?? null,
                    ) !==
                        JSON.stringify(
                            nextKycReadModel.businessVerification ?? null,
                        );
                const didJourneyChange =
                    JSON.stringify(cachedProfile?.data?.kycJourney ?? null) !==
                    JSON.stringify(nextKycReadModel.kycJourney ?? null);
                const hadLegacyProfileFlags = [
                    "isEmailVerified",
                    "isPhoneVerified",
                    "isPasswordCreated",
                ].some((legacyKey) =>
                    Object.hasOwn(cachedProfile.data ?? {}, legacyKey),
                );

                if (
                    didRequirementsChange ||
                    didBusinessVerificationChange ||
                    didJourneyChange ||
                    hadLegacyProfileFlags
                ) {
                    cachedProfile.data = {
                        ...normalizedCachedData,
                        ...nextKycReadModel,
                    };
                    await this.redisCacheService.set(
                        cacheKey,
                        cachedProfile,
                        this.PROFILE_CACHE_TTL,
                    );
                }

                this.logger.debug(
                    `[PERF] Profile cache HIT for user ${user.id} in ${Date.now() - startTime}ms`,
                );
                return {
                    ...cachedProfile,
                    data: {
                        ...normalizedCachedData,
                        ...nextKycReadModel,
                    },
                };
            }
        }

        this.logger.debug(`[PERF] Profile cache MISS for user ${user.id}`);
        const dbStartTime = Date.now();

        // OPTIMIZATION: Run both queries in parallel instead of sequential
        const [profile, defaultWallet] = await Promise.all([
            this.prisma.user.findUnique({
                where: { id: user.id },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    businessName: true,
                    email: true,
                    recoveryEmail: true,
                    photo: true,
                    phone: true,
                    userType: true,
                    gender: true,
                    dateOfBirth: true,
                    bvn: true,
                    nin: true,
                    country: true,
                    status: true,
                    isEmailVerified: true,
                    isPhoneVerified: true,
                    isPasswordCreated: true,
                    isDocumentVerified: true,
                    documentVerificationStatus: true,
                    tier: true,
                    businessRecordCompleted: true,
                    businessDocumentsUploaded: true,
                    businessDocumentVerificationStatus: true,
                    businessRecord: {
                        select: {
                            id: true,
                            userId: true,
                            businessName: true,
                            natureOfBusiness: true,
                            taxIdentificationNumber: true,
                            expectedTransactionVolume: true,
                            expectedTransactionFrequency: true,
                        },
                    },
                    accountLimit: {
                        select: {
                            buyToken: true,
                            receiveToken: true,
                            sellTokenFiat: true,
                            sendToken: true,
                            swapToken: true,
                        },
                    },
                    flaggedRecord: {
                        select: {
                            id: true,
                            flagged: true,
                            reason: true,
                            createdAt: true,
                            updatedAt: true,
                        },
                    },
                    kycStageAttempts: {
                        where: {
                            isCurrent: true,
                            OR: [
                                {
                                    journeyType: "INDIVIDUAL",
                                    stage: {
                                        in: [
                                            "GOVERNMENT_ID",
                                            "IDENTITY_DOCUMENT",
                                            "ADDRESS",
                                            "INCOME",
                                        ],
                                    },
                                },
                                {
                                    journeyType: "BUSINESS",
                                    stage: "BUSINESS_DOCUMENT",
                                },
                            ],
                        },
                        select: {
                            id: true,
                            journeyType: true,
                            stage: true,
                            method: true,
                            status: true,
                            providerStatus: true,
                            reasonCode: true,
                            reasonMessage: true,
                            submittedAt: true,
                            reviewedAt: true,
                            isCurrent: true,
                        },
                    },
                },
            }),
            this.prisma.assetWallet.findFirst({
                where: {
                    userId: user.id,
                    assetCurrency: "USDT",
                },
                select: {
                    assetCurrency: true,
                    defaultNetwork: true,
                    depositAddress: true,
                    destinationTag: true,
                    user: {
                        select: {
                            firstName: true,
                            lastName: true,
                        },
                    },
                },
            }),
        ]);

        this.logger.log(
            `[PERF] Profile DB queries (parallel) for user ${user.id}: ${Date.now() - dbStartTime}ms`,
        );

        if (!profile) {
            throw new UserNotFoundException(
                "User not found",
                HttpStatus.NOT_FOUND,
            );
        }

        // Use DB-stored tier as single source of truth
        const userTier = (profile as any).tier ?? 0;
        const profileKycReadModel = this.buildKycReadModel(profile);
        const normalizedProfile = this.normalizeProfileContract(profile);

        const response = {
            message: "Profile successfully retrieved",
            data: {
                ...normalizedProfile,
                recoveryEmail: profile.recoveryEmail || null,
                assetWallet: defaultWallet,
                // Tier info — sourced from DB column, kept in sync by syncTierAndCache
                tier: userTier,
                withdrawalLimit: this.tierService.getWithdrawalLimit(userTier),
                canTransact: userTier > 0,
                // KYC read-model payloads are derived from current attempts.
                ...profileKycReadModel,
            },
        };

        // Cache the response
        await this.redisCacheService.set(
            cacheKey,
            response,
            this.PROFILE_CACHE_TTL,
        );

        this.logger.log(
            `[PERF] TOTAL getProfile for user ${user.id}: ${Date.now() - startTime}ms`,
        );
        return response;
    }

    private buildKycJourney(profile: any): KycJourneyDto | null {
        if (!profile || profile.userType === UserType.BUSINESS) {
            return null;
        }

        const governmentStageState = this.getGovernmentStageState(profile);
        const documentStageState = this.getDocumentStageState({
            attempt: this.getCurrentJourneyStageAttempt(
                profile,
                "IDENTITY_DOCUMENT",
            ),
            rejectedMessage: "Document verification was declined",
        });
        const addressStageState = this.getDocumentStageState({
            attempt: this.getCurrentJourneyStageAttempt(profile, "ADDRESS"),
            rejectedMessage: "Address verification was declined",
        });
        const incomeStageState = this.getDocumentStageState({
            attempt: this.getCurrentJourneyStageAttempt(profile, "INCOME"),
            rejectedMessage: "Income verification was declined",
        });

        const stages: KycJourneyStageDto[] = [
            this.buildJourneyStage({
                stage: "GOVERNMENT_ID",
                completed: governmentStageState.verified,
                blocked: !profile.isEmailVerified && !profile.emailVerified,
                underReview: governmentStageState.pending,
                rejected: governmentStageState.rejected,
                route: "/verify-bvn",
                currentMethod: governmentStageState.currentMethod,
                currentAttemptId: governmentStageState.currentAttemptId,
                providerStatus: governmentStageState.providerStatus,
                submittedAt: governmentStageState.submittedAt,
                reviewedAt: governmentStageState.reviewedAt,
                reasonCode: governmentStageState.reasonCode,
                readyLabel: "Verify BVN or NIN",
                resubmitLabel: "Resubmit BVN or NIN",
                blockedBy: [],
                blockedHelperText: "Verify your email to continue KYC.",
                reasonMessage: governmentStageState.reasonMessage,
            }),
            this.buildJourneyStage({
                stage: "IDENTITY_DOCUMENT",
                completed: documentStageState.verified,
                blocked: !governmentStageState.verified,
                underReview: documentStageState.pending,
                rejected: documentStageState.rejected,
                route: "/document-type",
                currentMethod: documentStageState.currentMethod,
                currentAttemptId: documentStageState.currentAttemptId,
                providerStatus: documentStageState.providerStatus,
                submittedAt: documentStageState.submittedAt,
                reviewedAt: documentStageState.reviewedAt,
                reasonCode: documentStageState.reasonCode,
                readyLabel: "Complete ID Verification",
                resubmitLabel: "Resubmit ID Document",
                blockedBy: ["GOVERNMENT_ID"],
                reasonMessage: documentStageState.reasonMessage,
            }),
            this.buildJourneyStage({
                stage: "ADDRESS",
                completed: addressStageState.verified,
                blocked: !documentStageState.verified,
                underReview: addressStageState.pending,
                rejected: addressStageState.rejected,
                route: "/verify-address",
                currentMethod: addressStageState.currentMethod,
                currentAttemptId: addressStageState.currentAttemptId,
                providerStatus: addressStageState.providerStatus,
                submittedAt: addressStageState.submittedAt,
                reviewedAt: addressStageState.reviewedAt,
                reasonCode: addressStageState.reasonCode,
                readyLabel: "Verify Address",
                resubmitLabel: "Resubmit Address Document",
                blockedBy: ["IDENTITY_DOCUMENT"],
                reasonMessage: addressStageState.reasonMessage,
            }),
            this.buildJourneyStage({
                stage: "INCOME",
                completed: incomeStageState.verified,
                blocked: !addressStageState.verified,
                underReview: incomeStageState.pending,
                rejected: incomeStageState.rejected,
                route: "/verify-income",
                currentMethod: incomeStageState.currentMethod,
                currentAttemptId: incomeStageState.currentAttemptId,
                providerStatus: incomeStageState.providerStatus,
                submittedAt: incomeStageState.submittedAt,
                reviewedAt: incomeStageState.reviewedAt,
                reasonCode: incomeStageState.reasonCode,
                readyLabel: "Verify Income",
                resubmitLabel: "Resubmit Income Document",
                blockedBy: ["ADDRESS"],
                reasonMessage: incomeStageState.reasonMessage,
            }),
        ];

        const completedStages = stages
            .filter((stage) => stage.displayState === "VERIFIED")
            .map((stage) => stage.stage);
        const pendingStages = stages
            .filter((stage) => stage.displayState === "UNDER_REVIEW")
            .map((stage) => stage.stage);
        const blockedStages = stages
            .filter((stage) => stage.displayState === "BLOCKED")
            .map((stage) => stage.stage);

        const overallStatus = this.getJourneyOverallStatus(stages);
        const nextAction = this.buildJourneyNextAction(
            profile,
            stages,
            overallStatus,
        );

        return {
            overallStatus,
            currentStage: nextAction.stage,
            nextStage: nextAction.stage,
            completedStages,
            pendingStages,
            blockedStages,
            currentTier: profile.tier ?? 0,
            eligibleTierAfterNextApproval:
                this.getEligibleTierAfterNextApproval(nextAction.stage),
            nextAction,
            stages,
        };
    }

    private getGovernmentStageState(profile: any): JourneyStageState {
        const stageAttempt = this.getCurrentJourneyStageAttempt(
            profile,
            "GOVERNMENT_ID",
        );
        return {
            verified: isIndividualAttemptApproved(stageAttempt?.status),
            currentMethod: this.resolveGovernmentMethod(
                profile,
                stageAttempt?.method,
            ),
            pending: isIndividualAttemptPending(stageAttempt?.status),
            rejected: isIndividualAttemptRejected(stageAttempt?.status),
            providerStatus: stageAttempt?.providerStatus ?? null,
            currentAttemptId: stageAttempt?.id ?? null,
            submittedAt: this.toJourneyTimestamp(stageAttempt?.submittedAt),
            reviewedAt: this.toJourneyTimestamp(stageAttempt?.reviewedAt),
            reasonCode: stageAttempt?.reasonCode ?? null,
            reasonMessage: stageAttempt?.reasonMessage ?? null,
        };
    }

    private getDocumentStageState(params: {
        attempt: JourneyStageAttemptRecord | null;
        rejectedMessage: string;
    }): JourneyStageState {
        const { attempt, rejectedMessage } = params;

        if (attempt) {
            const verified = attempt.status === "APPROVED";
            const rejected =
                !verified && this.isJourneyStageRejected(attempt.status);
            const pending =
                !verified && this.isJourneyStagePending(attempt.status);

            return {
                verified,
                pending,
                rejected,
                providerStatus: attempt.providerStatus ?? null,
                currentAttemptId: attempt.id,
                currentMethod: this.formatJourneyMethod(attempt.method),
                submittedAt: this.toJourneyTimestamp(attempt.submittedAt),
                reviewedAt: this.toJourneyTimestamp(attempt.reviewedAt),
                reasonCode: attempt.reasonCode ?? null,
                reasonMessage:
                    attempt.reasonMessage ??
                    (rejected ? rejectedMessage : null),
            };
        }

        return {
            verified: false,
            pending: false,
            rejected: false,
            providerStatus: null,
            currentAttemptId: null,
            currentMethod: null,
            submittedAt: null,
            reviewedAt: null,
            reasonCode: null,
            reasonMessage: null,
        };
    }

    private shouldRefreshCachedIndividualProfile(profile: any): boolean {
        if (profile?.userType !== UserType.INDIVIDUAL) {
            return false;
        }

        return (
            !Array.isArray(profile?.kycStageAttempts) ||
            !Object.hasOwn(profile, "bvn") ||
            !Object.hasOwn(profile, "nin")
        );
    }

    private getCurrentJourneyStageAttempt(
        profile: any,
        stage: IndividualKycStage,
    ): JourneyStageAttemptRecord | null {
        return getCurrentIndividualStageAttempt(
            profile?.kycStageAttempts,
            stage,
        );
    }

    private getCurrentBusinessDocumentAttempt(
        profile: any,
    ): JourneyStageAttemptRecord | null {
        return (
            (profile?.kycStageAttempts ?? []).find(
                (attempt: any) =>
                    attempt?.isCurrent !== false &&
                    attempt?.journeyType === "BUSINESS" &&
                    attempt?.stage === "BUSINESS_DOCUMENT",
            ) ?? null
        );
    }

    private createBusinessVerification(
        overrides: Partial<BusinessVerificationDto> = {},
    ): BusinessVerificationDto {
        return {
            stage: "BUSINESS_DOCUMENT",
            status: "NOT_STARTED",
            displayState: "NOT_STARTED",
            providerStatus: null,
            currentAttemptId: null,
            submittedAt: null,
            reviewedAt: null,
            reasonCode: null,
            reasonMessage: null,
            ...overrides,
        };
    }

    private resolveBusinessVerificationStatus(
        status: string,
    ): BusinessVerificationStatus {
        if (status === "APPROVED") {
            return "APPROVED";
        }

        if (this.isJourneyStageRejected(status)) {
            return "REJECTED";
        }

        if (this.isJourneyStagePending(status)) {
            return "PENDING_REVIEW";
        }

        return "NOT_STARTED";
    }

    private resolveBusinessVerificationDisplayState(
        status: BusinessVerificationStatus,
        businessRecordCompleted: boolean,
    ): BusinessVerificationDisplayState {
        switch (status) {
            case "APPROVED":
                return "VERIFIED";
            case "REJECTED":
                return "NEEDS_RESUBMISSION";
            case "PENDING_REVIEW":
                return "UNDER_REVIEW";
            default:
                return businessRecordCompleted ? "READY" : "NOT_STARTED";
        }
    }

    private isBusinessDocumentVerified(profile: any): boolean {
        return (
            profile?.businessDocumentVerificationStatus ===
            DocumentVerificationStatus.VERIFIED
        );
    }

    private buildBusinessVerification(
        profile: any,
    ): BusinessVerificationDto | null {
        if (profile?.userType !== UserType.BUSINESS) {
            return null;
        }

        const currentBusinessAttempt =
            this.getCurrentBusinessDocumentAttempt(profile);

        if (currentBusinessAttempt) {
            const status = this.resolveBusinessVerificationStatus(
                currentBusinessAttempt.status,
            );

            return this.createBusinessVerification({
                status,
                displayState: this.resolveBusinessVerificationDisplayState(
                    status,
                    Boolean(profile.businessRecordCompleted),
                ),
                providerStatus: currentBusinessAttempt.providerStatus ?? null,
                currentAttemptId: currentBusinessAttempt.id,
                submittedAt: this.toJourneyTimestamp(
                    currentBusinessAttempt.submittedAt,
                ),
                reviewedAt: this.toJourneyTimestamp(
                    currentBusinessAttempt.reviewedAt,
                ),
                reasonCode: currentBusinessAttempt.reasonCode ?? null,
                reasonMessage: currentBusinessAttempt.reasonMessage ?? null,
            });
        }

        if (this.isBusinessDocumentVerified(profile)) {
            return this.createBusinessVerification({
                status: "APPROVED",
                displayState: "VERIFIED",
            });
        }

        return this.createBusinessVerification({
            displayState: profile?.businessRecordCompleted
                ? "READY"
                : "NOT_STARTED",
        });
    }

    private isJourneyStagePending(status?: string | null): boolean {
        return isIndividualAttemptPending(status);
    }

    private isJourneyStageRejected(status?: string | null): boolean {
        return isIndividualAttemptRejected(status);
    }

    private resolveGovernmentMethod(
        profile: any,
        method?: string | null,
    ): string | null {
        return this.formatJourneyMethod(
            getCurrentGovernmentMethod({
                kycStageAttempts: profile?.kycStageAttempts,
                bvn: profile?.bvn,
                nin: profile?.nin,
            }) ?? method,
        );
    }

    private formatJourneyMethod(method?: string | null): string | null {
        return method ?? null;
    }

    private maskGovernmentIdentifier(value?: string | null): string | null {
        if (!value) {
            return null;
        }

        const trimmedValue = value.trim();

        if (trimmedValue.length <= 4) {
            return trimmedValue;
        }

        return `****${trimmedValue.slice(-4)}`;
    }

    private toJourneyTimestamp(value?: Date | string | null): string | null {
        if (!value) {
            return null;
        }

        return new Date(value).toISOString();
    }

    private buildJourneyStage(params: {
        stage: IndividualKycStage;
        completed: boolean;
        blocked: boolean;
        underReview: boolean;
        rejected: boolean;
        route: string;
        currentMethod: string | null;
        currentAttemptId: number | null;
        providerStatus: string | null;
        submittedAt: string | null;
        reviewedAt: string | null;
        reasonCode: string | null;
        readyLabel: string;
        resubmitLabel: string;
        blockedBy: IndividualKycStage[];
        blockedHelperText?: string;
        reasonMessage?: string | null;
    }): KycJourneyStageDto {
        const labelMap: Record<IndividualKycStage, string> = {
            GOVERNMENT_ID: "Government ID",
            IDENTITY_DOCUMENT: "Identity Document",
            ADDRESS: "Address",
            INCOME: "Income",
        };
        const lastBlockedStage = params.blockedBy.at(-1);

        const defaultBlockedHelper = lastBlockedStage
            ? `Complete ${labelMap[lastBlockedStage].toLowerCase()} first.`
            : null;

        if (params.completed) {
            return {
                stage: params.stage,
                label: labelMap[params.stage],
                status: "APPROVED",
                providerStatus: params.providerStatus,
                displayState: "VERIFIED",
                currentAttemptId: params.currentAttemptId,
                currentMethod: params.currentMethod,
                blockedBy: params.blockedBy,
                canSubmit: false,
                canResubmit: false,
                canEscalate: false,
                submittedAt: params.submittedAt,
                reviewedAt: params.reviewedAt,
                reasonCode: params.reasonCode,
                reasonMessage: null,
                helperText: `${labelMap[params.stage]} verified.`,
                route: params.route,
                actionLabel: null,
            };
        }

        if (params.underReview) {
            return {
                stage: params.stage,
                label: labelMap[params.stage],
                status: "PENDING_REVIEW",
                providerStatus: params.providerStatus,
                displayState: "UNDER_REVIEW",
                currentAttemptId: params.currentAttemptId,
                currentMethod: params.currentMethod,
                blockedBy: params.blockedBy,
                canSubmit: false,
                canResubmit: false,
                canEscalate: true,
                submittedAt: params.submittedAt,
                reviewedAt: params.reviewedAt,
                reasonCode: params.reasonCode,
                reasonMessage:
                    params.reasonMessage ??
                    `${labelMap[params.stage]} is under review.`,
                helperText:
                    params.reasonMessage ??
                    `${labelMap[params.stage]} is under review.`,
                route: params.route,
                actionLabel: null,
            };
        }

        if (params.rejected) {
            return {
                stage: params.stage,
                label: labelMap[params.stage],
                status: "REJECTED",
                providerStatus: params.providerStatus,
                displayState: "NEEDS_RESUBMISSION",
                currentAttemptId: params.currentAttemptId,
                currentMethod: params.currentMethod,
                blockedBy: params.blockedBy,
                canSubmit: false,
                canResubmit: true,
                canEscalate: false,
                submittedAt: params.submittedAt,
                reviewedAt: params.reviewedAt,
                reasonCode: params.reasonCode,
                reasonMessage:
                    params.reasonMessage ??
                    `${labelMap[params.stage]} was declined.`,
                helperText:
                    params.reasonMessage ??
                    `${labelMap[params.stage]} was declined.`,
                route: params.route,
                actionLabel: params.resubmitLabel,
            };
        }

        if (params.blocked) {
            return {
                stage: params.stage,
                label: labelMap[params.stage],
                status: "NOT_STARTED",
                providerStatus: params.providerStatus,
                displayState: "BLOCKED",
                currentAttemptId: params.currentAttemptId,
                currentMethod: params.currentMethod,
                blockedBy: params.blockedBy,
                canSubmit: false,
                canResubmit: false,
                canEscalate: false,
                submittedAt: params.submittedAt,
                reviewedAt: params.reviewedAt,
                reasonCode: params.reasonCode,
                reasonMessage: null,
                helperText: params.blockedHelperText ?? defaultBlockedHelper,
                route: params.route,
                actionLabel: null,
            };
        }

        return {
            stage: params.stage,
            label: labelMap[params.stage],
            status: "NOT_STARTED",
            providerStatus: params.providerStatus,
            displayState: "READY",
            currentAttemptId: params.currentAttemptId,
            currentMethod: params.currentMethod,
            blockedBy: params.blockedBy,
            canSubmit: true,
            canResubmit: false,
            canEscalate: false,
            submittedAt: params.submittedAt,
            reviewedAt: params.reviewedAt,
            reasonCode: params.reasonCode,
            reasonMessage: null,
            helperText: null,
            route: params.route,
            actionLabel: params.readyLabel,
        };
    }

    private getJourneyOverallStatus(
        stages: KycJourneyStageDto[],
    ): KycJourneyOverallStatus {
        if (stages.every((stage) => stage.displayState === "VERIFIED")) {
            return "VERIFIED";
        }

        if (stages.some((stage) => stage.displayState === "UNDER_REVIEW")) {
            return "IN_REVIEW";
        }

        if (
            stages.some((stage) => stage.displayState === "NEEDS_RESUBMISSION")
        ) {
            return "ACTION_REQUIRED";
        }

        if (
            stages.every(
                (stage) =>
                    stage.displayState === "READY" ||
                    stage.displayState === "BLOCKED",
            )
        ) {
            return "NOT_STARTED";
        }

        return "IN_PROGRESS";
    }

    private buildJourneyNextAction(
        profile: any,
        stages: KycJourneyStageDto[],
        overallStatus: KycJourneyOverallStatus,
    ): KycJourneyNextActionDto {
        if (overallStatus === "VERIFIED") {
            return {
                type: "COMPLETE",
                stage: null,
                route: "/",
                label: null,
                message: null,
            };
        }

        // Support both raw Prisma shape (isEmailVerified) and normalized cached shape (emailVerified)
        if (!profile.isEmailVerified && !profile.emailVerified) {
            return {
                type: "START",
                stage: null,
                route: "/profile",
                label: "Verify Email",
                message: "Verify your email to continue KYC.",
            };
        }

        const pendingStage = stages.find(
            (stage) => stage.displayState === "UNDER_REVIEW",
        );
        if (pendingStage) {
            return {
                type: "WAIT",
                stage: pendingStage.stage,
                route: "/",
                label: "Verification Pending",
                message: pendingStage.helperText,
            };
        }

        const rejectedStage = stages.find(
            (stage) => stage.displayState === "NEEDS_RESUBMISSION",
        );
        if (rejectedStage) {
            return {
                type: "RESUBMIT",
                stage: rejectedStage.stage,
                route: rejectedStage.route,
                label: rejectedStage.actionLabel,
                message: rejectedStage.reasonMessage,
            };
        }

        const readyStage = stages.find(
            (stage) => stage.displayState === "READY",
        );
        if (readyStage) {
            return {
                type: readyStage.stage === "GOVERNMENT_ID" ? "START" : "SUBMIT",
                stage: readyStage.stage,
                route: readyStage.route,
                label: readyStage.actionLabel,
                message: null,
            };
        }

        return {
            type: "CONTACT_SUPPORT",
            stage: null,
            route: null,
            label: "Contact Support",
            message: "We could not determine the next KYC step.",
        };
    }

    private getEligibleTierAfterNextApproval(
        stage: IndividualKycStage | null,
    ): number | null {
        const tierMap: Record<IndividualKycStage, number> = {
            GOVERNMENT_ID: 1,
            IDENTITY_DOCUMENT: 2,
            ADDRESS: 3,
            INCOME: 4,
        };

        return stage ? tierMap[stage] : null;
    }

    private getBusinessVerificationRequirements(
        profile: any,
        businessVerification: BusinessVerificationDto | null = this.buildBusinessVerification(
            profile,
        ),
    ) {
        const requirements = {
            nextStep: "COMPLETE",
            details: null as string | null,
        };

        if (!profile.businessRecordCompleted) {
            requirements.nextStep = "BUSINESS_RECORD";
        } else if (businessVerification?.status === "APPROVED") {
            requirements.nextStep = "COMPLETE";
        } else if (businessVerification?.status === "PENDING_REVIEW") {
            requirements.nextStep = "WAIT_FOR_VERIFICATION";
        } else if (businessVerification?.status === "REJECTED") {
            requirements.nextStep = "BUSINESS_DOCUMENT_UPLOAD";
            requirements.details =
                businessVerification.reasonMessage ??
                "Previous documents were declined";
        } else {
            requirements.nextStep = "BUSINESS_DOCUMENT_UPLOAD";
        }
        return requirements;
    }

    /**
     * Get active (non-expired) limit override for a user.
     * Returns null if no override exists, it has expired, or the table is unavailable.
     */
    private async getActiveLimitOverride(userId: number) {
        try {
            const override = await this.prisma.limitOverride.findUnique({
                where: { userId },
            });

            if (!override) return null;

            if (override.expiresAt && override.expiresAt < new Date()) {
                this.logger.debug(
                    `Limit override for user ${userId} has expired (${override.expiresAt.toISOString()})`,
                );
                return null;
            }

            return override;
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : JSON.stringify(error);
            this.logger.warn(
                `Failed to fetch limit override for user ${userId}, proceeding with tier defaults: ${message}`,
            );
            return null;
        }
    }

    /**
     * Get the user's daily usage per operation type for the frontend.
     * Returns per-operation (buy/sell/swap/send) used today and daily limits.
     */
    async getWithdrawalUsage(user: User) {
        // Use DB-stored tier as single source of truth
        const userTier = (user as any).tier ?? 0;
        const defaultDailyLimits = this.tierService.getDailyLimits(
            userTier,
            user.userType,
        );
        const override = await this.getActiveLimitOverride(user.id);
        const dailyLimits =
            override?.dailyLimitUSD !== null &&
            override?.dailyLimitUSD !== undefined
                ? {
                      buy: override.dailyLimitUSD,
                      sell: override.dailyLimitUSD,
                      swap: override.dailyLimitUSD,
                      send: override.dailyLimitUSD,
                  }
                : defaultDailyLimits;

        // Calculate daily totals from start of today (calendar-day, UTC)
        const now = new Date();
        const startOfToday = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );

        const orders = await this.prisma.order.findMany({
            where: {
                userId: user.id,
                createdAt: { gte: startOfToday },
                status: {
                    in: [
                        OrderStatus.filled,
                        OrderStatus.completed,
                        OrderStatus.done,
                    ],
                },
            },
            select: { amount: true, currency: true, orderCategory: true },
        });

        const uniqueCurrencies: string[] = Array.from(
            new Set(
                orders
                    .map((order) =>
                        typeof order.currency === "string"
                            ? order.currency.toLowerCase()
                            : null,
                    )
                    .filter((currency): currency is string =>
                        Boolean(currency),
                    ),
            ),
        );
        const usdRates = new Map<string, number>();

        await Promise.all(
            uniqueCurrencies.map(async (currency: string) => {
                try {
                    const rate =
                        await this.liveCoinWatchService.getPriceInUSD(currency);
                    usdRates.set(currency, rate || 0);
                } catch (error) {
                    usdRates.set(currency, 0);
                    this.logger.warn(
                        `Failed to fetch USD rate for ${currency}: ${this.getErrorMessage(error)}`,
                    );
                }
            }),
        );

        // Build per-operation USD totals
        const usageByOp: Record<string, number> = {
            buy: 0,
            sell: 0,
            swap: 0,
            send: 0,
        };
        for (const order of orders) {
            if (order.amount && order.currency) {
                const rate = usdRates.get(order.currency.toLowerCase()) ?? 0;
                const usdAmount = order.amount * (rate || 0);

                const cat = order.orderCategory;
                if (cat === "BUY") usageByOp.buy += usdAmount;
                else if (cat === "SELL") usageByOp.sell += usdAmount;
                else if (cat === "SWAP") usageByOp.swap += usdAmount;
                else if (cat === "SEND") usageByOp.send += usdAmount;
            }
        }

        const round = (v: number) => Math.round(v * 100) / 100;

        const buildOpData = (op: "buy" | "sell" | "swap" | "send") => {
            const limit = dailyLimits[op];
            const used = usageByOp[op];
            const isUnlimited = limit === "unlimited";
            const numericLimit = isUnlimited ? -1 : limit;
            const remaining = isUnlimited
                ? -1
                : Math.max(0, numericLimit - used);
            const percentUsed = isUnlimited
                ? 0
                : Math.min(100, (used / numericLimit) * 100);
            return {
                usedToday: round(used),
                dailyLimit: numericLimit,
                remainingToday: remaining === -1 ? -1 : round(remaining),
                percentUsed: round(percentUsed),
            };
        };

        return {
            message: "Withdrawal usage retrieved",
            data: {
                buy: buildOpData("buy"),
                sell: buildOpData("sell"),
                swap: buildOpData("swap"),
                send: buildOpData("send"),
                tier: userTier,
                canTransact: userTier > 0,
            },
        };
    }

    async getUserList(query: GetUserListDto) {
        const {
            pageNumber,
            pageSize,
            sortBy,
            status,
            accountType,
            startDate,
            endDate,
            searchText,
            paginated,
        } = query;

        const resolvedPageNumber =
            !pageNumber || pageNumber <= 1
                ? defaultPagination.pageNumber
                : pageNumber;
        const resolvedPageSize =
            !pageSize || pageSize <= 0 ? defaultPagination.pageSize : pageSize;

        const dbQuery: Prisma.UserFindManyArgs = {
            where: {
                isDeleted: false,
                ...(status && { status }),
                ...(accountType && { userType: accountType }),
                ...(startDate &&
                    endDate && {
                        createdAt: {
                            gte: new Date(startDate),
                            lte: new Date(endDate),
                        },
                    }),
                ...(searchText && {
                    OR: [
                        {
                            firstName: {
                                contains: searchText,
                                mode: "insensitive",
                            },
                        },
                        {
                            lastName: {
                                contains: searchText,
                                mode: "insensitive",
                            },
                        },
                        {
                            email: {
                                contains: searchText,
                                mode: "insensitive",
                            },
                        },
                        {
                            phone: {
                                contains: searchText,
                                mode: "insensitive",
                            },
                        },
                    ],
                }),
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                recoveryEmail: true,
                phone: true,
                photo: true,
                status: true,
                userType: true,
                createdAt: true,
            },
            orderBy: { createdAt: sortBy },
        };

        const [users, count] = await this.prisma.$transaction([
            this.prisma.user.findMany({
                ...dbQuery,
                ...(paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
            this.prisma.user.count({ where: dbQuery.where }),
        ]);

        return {
            success: true,
            message: "Users list retrieved",
            data: {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    users.length,
                ),
                records: users.map((user) => ({
                    id: user.id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    phone: user.phone,
                    photo: user.photo,
                    status: user.status,
                    userType: user.userType,
                    createdAt: user.createdAt,
                })),
            },
        };
    }

    async updateUserDetails(
        options: UpdateUserDetailsDto,
        user: User,
        photo?: Express.Multer.File,
    ) {
        const profileUpdateOptions: Prisma.UserUncheckedUpdateInput = {
            ...options,
            dateOfBirth: options.dateOfBirth
                ? new Date(options.dateOfBirth)
                : undefined,
        };

        if (photo) {
            try {
                const uploadResponse = await this.uploadProfileImage(photo);
                if (user?.photoFileId) {
                    try {
                        await this.uploadService.removeImage({
                            fileId: user.photoFileId,
                            key: process.env.IMAGEKIT_PRIVATE_KEY,
                        });
                    } catch (error) {
                        Logger.error(
                            `Failed to delete image ${user.photoFileId}:`,
                            error,
                        );
                    }
                }
                profileUpdateOptions.photo = uploadResponse.url;
                profileUpdateOptions.photoFileId = uploadResponse.fileId;
            } catch (error) {
                Logger.error(
                    `Failed to upload profile image for user ${user.id}:`,
                    error,
                );
                throw new AuthGenericException(
                    "Failed to update profile image",
                    HttpStatus.INTERNAL_SERVER_ERROR,
                );
            }
        }

        const updatedUser = await this.prisma.user.update({
            where: { id: user.id },
            data: profileUpdateOptions,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                recoveryEmail: true,
                photo: true,
                phone: true,
                gender: true,
                dateOfBirth: true,
                country: true,
            },
        });

        // Invalidate profile cache after update
        await this.redisCacheService.del(this.getProfileCacheKey(user.id));

        return {
            message: "Profile details updated successfully",
            data: {
                ...updatedUser,
                recoveryEmail: updatedUser.recoveryEmail || null,
            },
        };
    }

    private async uploadProfileImage(
        file: Express.Multer.File,
    ): Promise<UploadApiResponse | UploadResponse> {
        const date = Date.now();
        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.profile,
            name: `profile-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: file.buffer,
            quality: 100,
            width: 320,
            type: "image",
        });
    }

    async getUserAggregatedWalletBalance(user: User) {
        // Fetch ledger balances and all rates in parallel
        // Use RateService instead of QuidaxCacheService for consistency with getUserWallets
        const [ledgerBalances, allRates] = await Promise.all([
            this.ledgerService.getAllBalances(user.id),
            this.rateService.getAllRates(),
        ]);

        // Create map for rates (AssetRate has sellRate/buyRate)
        const rateMap = new Map(
            allRates.map((r) => [r.currency.toUpperCase(), r]),
        );

        let totalBalance = 0;

        for (const [currency, balanceInfo] of ledgerBalances) {
            const assetCurrencyUpper = currency.toUpperCase();
            const balance = Number(balanceInfo.available);

            // Get rate from RateService map
            const rateData = rateMap.get(assetCurrencyUpper);
            let usedRate = 0;

            if (rateData) {
                // Use sellRate (Ask price) for valuation, consistent with getUserWallets logic
                // This represents the price required to BUY the asset back from the user
                usedRate = rateData.sellRate;
            }

            if (usedRate > 0 && !Number.isNaN(balance)) {
                totalBalance += balance * usedRate;
            }
        }

        return {
            message: "Aggregated wallet balance retrieved",
            data: {
                total: totalBalance, // Return number, frontend handles formatting
                referenceCurrency: "ngn",
            },
        };
    }

    async getUserWallets(userId: number, query: GetUserAssetsDto) {
        const startTime = Date.now();
        const { pageNumber, pageSize, sortBy } = query;
        const supportedTradeAssetsBySymbol = new Map<string, string>(
            SUPPORTED_TRADE_ASSETS.map((asset) => [asset.symbol, asset.name]),
        );
        const includeSupportedAssets = query.includeSupported === "true";
        const searchText = query.searchText?.toLowerCase();

        const matchesSearch = (symbol: string, name?: string) => {
            if (!searchText) {
                return true;
            }

            return (
                symbol.toLowerCase().includes(searchText) ||
                name?.toLowerCase().includes(searchText)
            );
        };

        const createSyntheticAsset = (
            currency: string,
            assetName?: string,
        ) => ({
            id: `ledger:${userId}:${currency}`,
            userId,
            quidaxWalletId: "",
            assetName: assetName ?? currency,
            assetCurrency: currency,
            balance: 0,
            locked: 0,
            staked: 0,
            convertedBalance: 0,
            referenceCurrency: "ngn",
            isCrypto: true,
            defaultNetwork: "",
            blockchainEnabled: false,
            depositAddress: "",
            destinationTag: null,
            isActive: false,
            addressSynced: false,
            networks: [],
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });

        const resolvedPageNumber =
            !pageNumber || pageNumber <= 1
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize =
            !pageSize || pageSize <= 0 ? defaultPagination.pageSize : pageSize;

        const dbQuery: Prisma.AssetWalletFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where: {
                userId: userId,
                ...(query.searchText && {
                    OR: [
                        {
                            assetName: {
                                contains: query.searchText,
                                mode: "insensitive",
                            },
                        },
                        {
                            assetCurrency: {
                                contains: query.searchText,
                                mode: "insensitive",
                            },
                        },
                    ],
                }),
            },
        };

        // OPTIMIZATION: Run all queries in parallel instead of sequential
        const dbStartTime = Date.now();
        const [assets, dynamicRates, liveMarketData, ledgerBalances] =
            await Promise.all([
                this.prisma.assetWallet.findMany(dbQuery),
                // Query 2: Fetch dynamic rates from RateService (uses LiveCoinWatch)
                this.rateService.getAllRates(),
                // Query 3: Fetch live Quidax rates (from cache or API)
                this.quidaxCacheService.getMarketTickers(),
                // Query 4: Fetch ledger balances (virtual balance system)
                this.ledgerService.getAllBalances(userId),
            ]);

        this.logger.log(
            `[PERF] getUserWallets DB+API queries (parallel) for user ${userId}: ${Date.now() - dbStartTime}ms`,
        );

        const assetCurrencies = new Set(
            assets.map((asset) => asset.assetCurrency.toUpperCase()),
        );

        const syntheticAssets = Array.from(ledgerBalances.entries())
            .filter(([currency, balanceInfo]) => {
                const normalizedCurrency = currency.toUpperCase();
                if (assetCurrencies.has(normalizedCurrency)) {
                    return false;
                }

                const available = Number(balanceInfo.available);
                const held = Number(balanceInfo.held);
                const hasLedgerBalance =
                    (!Number.isNaN(available) && available > 0) ||
                    (!Number.isNaN(held) && held > 0);

                if (!hasLedgerBalance) {
                    return false;
                }

                return matchesSearch(
                    normalizedCurrency,
                    supportedTradeAssetsBySymbol.get(normalizedCurrency),
                );
            })
            .map(([currency]) => {
                const normalizedCurrency = currency.toUpperCase();

                return createSyntheticAsset(
                    normalizedCurrency,
                    supportedTradeAssetsBySymbol.get(normalizedCurrency),
                );
            });

        const mergedAssetCurrencies = new Set([
            ...assetCurrencies,
            ...syntheticAssets.map((asset) =>
                asset.assetCurrency.toUpperCase(),
            ),
        ]);

        const supportedCatalogAssets = includeSupportedAssets
            ? SUPPORTED_TRADE_ASSETS.filter(({ symbol, name }) => {
                  if (mergedAssetCurrencies.has(symbol)) {
                      return false;
                  }

                  return matchesSearch(symbol, name);
              }).map(({ symbol, name }) => createSyntheticAsset(symbol, name))
            : [];

        const mergedAssets = [
            ...assets,
            ...syntheticAssets,
            ...supportedCatalogAssets,
        ];
        const paginatedAssets =
            query.paginated === "true"
                ? mergedAssets.slice(
                      (resolvedPageNumber - 1) * resolvedPageSize,
                      resolvedPageNumber * resolvedPageSize,
                  )
                : mergedAssets;

        // Fetch LiveCoinWatch market data for percentage change fallback
        const uniqueAssets = [
            ...new Set(paginatedAssets.map((a) => a.assetCurrency)),
        ];
        const lcwStartTime = Date.now();
        const lcwData =
            await this.liveCoinWatchService.getBatchMarketData(uniqueAssets);
        this.logger.log(
            `[PERF] LiveCoinWatch batch fetch for ${uniqueAssets.length} assets: ${Date.now() - lcwStartTime}ms`,
        );

        // Create a map of dynamic rates by currency
        const dynamicRatesMap = new Map(
            dynamicRates.map((rate) => [rate.currency.toLowerCase(), rate]),
        );
        const referenceCurrency = "ngn"; // Change to 'usdt' or dynamic as needed

        // Merge data into asset response
        const responseData: DataWithPagination<any> & {
            tradeMinimums: {
                buy: number;
                sell: number;
                swap: number;
            };
        } = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    mergedAssets.length,
                    paginatedAssets.length,
                ),
            }),
            tradeMinimums: {
                buy: MIN_BUY_AMOUNT_USDT,
                sell: MIN_SELL_AMOUNT_USDT,
                swap: MIN_SWAP_AMOUNT_USDT,
            },
            records: paginatedAssets.map((asset) => {
                const assetCurrency = asset.assetCurrency.toLowerCase();
                const assetCurrencyUpper = asset.assetCurrency.toUpperCase();

                // Get ledger balance (virtual balance system)
                const ledgerBalance = ledgerBalances.get(assetCurrencyUpper);
                // Use ledger balance if available, otherwise fall back to 0 (swept to main wallet)
                const balance = ledgerBalance
                    ? Number(ledgerBalance.available)
                    : 0;
                const heldBalance = ledgerBalance
                    ? Number(ledgerBalance.held)
                    : 0;

                // Dynamic rate lookup (from RateService - uses LiveCoinWatch)
                const dynamicRate = dynamicRatesMap.get(assetCurrency);
                const buyRate = dynamicRate?.buyRate ?? 0;
                const sellRate = dynamicRate?.sellRate ?? 0;

                // Live market data lookup
                const marketSymbol = `${assetCurrency}${referenceCurrency}`;
                const ticker = liveMarketData?.[marketSymbol]?.ticker;

                // LiveCoinWatch data lookup
                const marketData = lcwData[assetCurrency];

                // Prioritize LiveCoinWatch for market stats (24h change) as it's more reliable/global
                // Fallback to Quidax generic calculation if LCW is unavailable
                const percentChange =
                    marketData?.change24h ??
                    this.calculatePercentageChange(ticker);

                // Calculate Live Converted Balance using dynamic rate
                let liveConvertedBalance: any = "0";

                // Use dynamic rate for conversion (consistent with buy/sell operations)
                if (sellRate > 0) {
                    liveConvertedBalance = (balance * sellRate).toFixed(2);
                } else if (ticker?.sell) {
                    // Fallback to Quidax ticker if dynamic rate unavailable
                    const rate = Number.parseFloat(ticker.sell);
                    if (!Number.isNaN(rate) && !Number.isNaN(balance)) {
                        liveConvertedBalance = (balance * rate).toFixed(2);
                    }
                }

                return {
                    ...asset,
                    balance: balance.toString(), // Override with ledger balance
                    locked: heldBalance.toString(), // Use ledger held amount
                    convertedBalance: liveConvertedBalance, // Override DB value with live value
                    buyRate: {
                        value: buyRate.toFixed(4),
                        referenceCurrency,
                    },
                    sellRate: {
                        value: sellRate.toFixed(4),
                        referenceCurrency,
                    },
                    liveRate: {
                        buy: ticker?.buy ?? null,
                        sell: ticker?.sell ?? null,
                        last: ticker?.last ?? null,
                        percentChange: percentChange,
                        referenceCurrency,
                    },
                };
            }),
        };

        this.logger.log(
            `[PERF] TOTAL getUserWallets for user ${userId}: ${Date.now() - startTime}ms`,
        );
        return {
            message: "Assets successfully retrieved",
            data: responseData,
        };
    }

    calculatePercentageChange(ticker: Ticker): number | null {
        if (!ticker?.open || !ticker?.last) return null;

        const open = Number.parseFloat(ticker.open);
        const last = Number.parseFloat(ticker.last);

        if (Number.isNaN(open) || open === 0 || Number.isNaN(last)) {
            return null;
        }

        const change = ((last - open) / open) * 100;
        return Number.parseFloat(change.toFixed(2));
    }

    async updateProfilePassword(options: UpdateProfilePasswordDto, user: User) {
        const isMatched = await this.authService.comparePassword(
            options.oldPassword,
            user.password,
        );

        if (!isMatched) {
            throw new IncorrectPasswordException(
                "The old password you entered does not match with your existing password",
                HttpStatus.BAD_REQUEST,
            );
        }

        // Check that new password is different from old password
        if (options.newPassword === options.oldPassword) {
            throw new IncorrectPasswordException(
                "Your new password must be different from your current password",
                HttpStatus.BAD_REQUEST,
            );
        }

        const newHashedPassword = await this.authService.hashPassword(
            options.newPassword,
        );

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                password: newHashedPassword,
                passwordChangedAt: new Date(),
            },
        });

        return {
            message: "Password successfully updated",
        };
    }

    async sendRecoveryEmailOtp(
        dto: SendRecoveryEmailOtpDto,
        user: User,
    ): Promise<{ message: string }> {
        // Generate 6-digit OTP
        const verificationCode = customAlphabet("1234567890", 6)();

        // Normalize email
        const email = dto.email.toLowerCase().trim();

        // Upsert the recovery email verification request
        await this.prisma.recoveryEmailVerificationRequest.upsert({
            where: {
                userId: user.id,
            },
            update: {
                email: email,
                code: verificationCode,
            },
            create: {
                userId: user.id,
                email: email,
                code: verificationCode,
            },
        });

        // Prepare email data
        const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User";
        const team = COMPANY_NAME;

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: emailTemplateConfig.recovery_pin,
                merge_info: {
                    name,
                    otp: verificationCode,
                    expiry_minutes: "30",
                    team,
                },
            });
        } catch (error) {
            console.error(`Failed to send recovery email OTP: ${error}`);
            throw new AuthGenericException(
                "Failed to send recovery email OTP",
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }

        return {
            message: `A verification code has been sent to ${user.email}`,
        };
    }

    async verifyRecoveryEmailOtp(
        dto: VerifyRecoveryEmailOtpDto,
        user: User,
    ): Promise<{ message: string }> {
        const verificationData =
            await this.prisma.recoveryEmailVerificationRequest.findFirst({
                where: {
                    userId: user.id,
                    code: dto.otp,
                },
            });

        if (!verificationData) {
            throw new InvalidVerificationCodeException(
                "Invalid verification code",
                HttpStatus.BAD_REQUEST,
            );
        }

        if (verificationData.isVerified) {
            throw new DuplicateVerificationException(
                "Recovery email already verified",
                HttpStatus.BAD_REQUEST,
            );
        }

        const timeDifference =
            Date.now() - verificationData.updatedAt.getTime();
        const timeDiffInMin = timeDifference / (1000 * 60);

        if (timeDiffInMin > 30) {
            throw new VerificationCodeExpiredException(
                "Your verification code has expired. Kindly request a new one",
                HttpStatus.BAD_REQUEST,
            );
        }

        // Update user with verified recovery email and delete the verification request
        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: user.id },
                data: { recoveryEmail: verificationData.email },
            }),
            this.prisma.recoveryEmailVerificationRequest.delete({
                where: { id: verificationData.id },
            }),
        ]);

        return {
            message: "Recovery email verified successfully",
        };
    }

    /**
     * Update user's notification token for push notifications (FCM)
     * Now stores in DeviceToken table for multi-device support.
     */
    async updateNotificationToken(
        user: User,
        token: string | null,
        deviceName?: string,
        platform?: string,
    ): Promise<{ message: string }> {
        const safeUserId = this.getValidatedUserId(user.id);

        if (token) {
            // Upsert into DeviceToken table (best-effort).
            // If this fails (e.g. migration drift), we still keep legacy token flow working.
            try {
                await this.prisma.deviceToken.upsert({
                    where: {
                        userId_token: { userId: safeUserId, token },
                    },
                    update: {
                        deviceName: deviceName ?? undefined,
                        platform: platform ?? undefined,
                    },
                    create: {
                        userId: safeUserId,
                        token,
                        deviceName: deviceName ?? null,
                        platform: platform ?? "web",
                    },
                });
            } catch (error) {
                this.logger.warn(
                    `DeviceToken upsert failed for user ${safeUserId}, falling back to legacy notificationToken: ${this.getErrorMessage(error)}`,
                );
            }

            // Also keep legacy field in sync for backward compatibility
            await this.prisma.user.update({
                where: { id: safeUserId },
                data: { notificationToken: token },
            });
        } else {
            // Disable: remove all device tokens for this user (best-effort)
            try {
                const deviceTokenCleanupUserId = Number.parseInt(
                    String(safeUserId),
                    10,
                );
                await this.prisma.deviceToken.deleteMany({
                    where: { userId: deviceTokenCleanupUserId },
                });
            } catch (error) {
                this.logger.warn(
                    `DeviceToken cleanup failed for user ${safeUserId}, continuing with legacy notificationToken cleanup: ${this.getErrorMessage(error)}`,
                );
            }

            await this.prisma.user.update({
                where: { id: safeUserId },
                data: { notificationToken: null },
            });
        }

        // Invalidate profile cache
        try {
            await this.redisCacheService.del(
                this.getProfileCacheKey(safeUserId),
            );
        } catch (error) {
            this.logger.warn(
                `Failed to invalidate profile cache for user ${safeUserId}: ${this.getErrorMessage(error)}`,
            );
        }
        return {
            message: token
                ? "Push notifications enabled"
                : "Push notifications disabled",
        };
    }

    async getUserByEmail(email: string) {
        const normalizedEmail = email.toLowerCase().trim();
        const user = await this.prisma.user.findUnique({
            where: { email: normalizedEmail },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                photo: true,
                status: true,
            },
        });

        if (!user) {
            throw new UserNotFoundException(
                "User not found",
                HttpStatus.NOT_FOUND,
            );
        }

        return {
            message: "User found",
            data: user,
        };
    }

    async getIntercomHash(user: User) {
        const secretKey = process.env.INTERCOM_SECRET_KEY;
        if (!secretKey) {
            this.logger.error("SECURITY: INTERCOM_SECRET_KEY not configured");
            return buildResponse({
                success: false,
                message: "Intercom identity verification is not configured",
            });
        }

        const userHash = createHmac("sha256", secretKey)
            .update(String(user.id))
            .digest("hex");

        return buildResponse({
            message: "Intercom hash generated",
            data: { userHash },
        });
    }
}
