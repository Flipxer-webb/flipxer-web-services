import { Injectable, Logger, BadRequestException, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta } from "@/utils";
import { DocumentVerificationStatus, IdentityIdType, KycAttemptEventType, KycAttemptStatus, KycStage, KycStatus, Prisma, UserType } from "@prisma/client";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay, startOfQuarter, endOfQuarter, startOfYear, endOfYear } from "date-fns";
import {
    GetKycQueueDto,
    KycDecisionDto,
    AdminKycAttemptDecisionDto,
    UpdateUserTierDto,
    UpdateUserVerificationDto,
    GetKycStatsDto,
    ApproveDocumentDto,
    RejectDocumentDto,
    RunKycAttemptRecheckDto,
    RunKycProviderLookupDto,
} from "../dtos";
import type { AdminKycProviderLookupType } from "../dtos";
import { TierService } from "@/modules/api/auth/services/tier.service";
import { KycStateMachineService } from "@/modules/api/auth/services/kyc-state-machine.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { EmailService } from "@/modules/core/email/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { IdentityResolutionService } from "@/modules/api/auth/services/identity-resolution.service";
import { AuditLogService } from "@/modules/api/audit-log";
import { cloudinaryConfig, emailTemplateConfig, imagekitConfig, mailConfig, COMPANY_NAME } from "@/config";
import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { DojahService } from "@/modules/factory/identityCompliance/providers/dojah/services";
import { validateAddressDocument, validateIncomeDocument } from "@/libs/ocr";
import { request as httpsRequest } from "node:https";
import {
    buildIndividualVerificationSnapshot,
    getCurrentIndividualStageAttempt,
} from "@/modules/api/auth/utils/individual-kyc-stage-state.util";

type KycQueueView = "ACTIONABLE" | "AWAITING_USER" | "RESOLVED" | "ALL";
type KycDecisionAction = "APPROVE" | "REJECT" | "ESCALATE";
type AdminKycAttemptAction = KycDecisionAction | "RECHECK";
type AdminKycRecommendedDecision = "APPROVE" | "REVIEW" | "REJECT";
type AdminLookupStatus = "SUCCESS" | "FAILED";
type AdminLookupOutcome = "SUCCESS" | "PARTIAL_FAILURE" | "FAILED";
type AdminLookupProvider = "DOJAH" | "OCR";
type AdminKycTimestamp = Date | string;
type AdminKycNullableTimestamp = AdminKycTimestamp | null;

interface AdminKycAttemptSummary {
    attemptId: number;
    verificationType: string;
    stage: string;
    method: string | null;
    status: string;
    providerStatus: string | null;
    attemptNo: number | null;
    version: number | null;
    submittedAt: AdminKycTimestamp;
    reviewedAt: AdminKycNullableTimestamp;
    reviewerId: number | null;
    reviewNote: string | null;
    providerRef?: string | null;
    documentUrl?: string | null;
    isActive?: boolean;
    latestActivityAt?: AdminKycNullableTimestamp;
    latestActivityType?: string | null;
    latestActivityNote?: string | null;
    latestActivityAdminId?: number | null;
    queueReason: string | null;
    recommendedDecision: AdminKycRecommendedDecision | null;
    allowedActions: AdminKycAttemptAction[];
}

interface AdminKycAttemptEvidenceItem {
    id: number;
    kind: string;
    label: string;
    url: string;
    mimeType: string | null;
}

interface AdminKycAttemptLookupHistoryItem {
    historyRecordId: number;
    outcome: AdminLookupOutcome;
    lookedUpAt: string;
    requestedByAdminId: number | null;
    note: string | null;
    results: AdminKycLookupResult[];
}

interface AdminKycAttemptDecisionHistoryItem {
    action: string;
    note: string | null;
    adminId: number | null;
    createdAt: AdminKycTimestamp;
}

interface AdminKycAuditHistoryItem {
    source: "ATTEMPT_EVENT" | "AUDIT_LOG";
    action: string;
    verificationType: string | null;
    eventType: string | null;
    attemptId: number | null;
    adminId: number | null;
    note: string | null;
    createdAt: AdminKycTimestamp;
}

interface AdminKycAttemptDetail {
    attempt: AdminKycAttemptSummary | null;
    extractedFields: Record<string, any> | null;
    comparisonSummary: Record<string, any> | null;
    evidenceSummary: Record<string, any> | null;
    rawProviderResponse: any;
    rawEvidence: AdminKycAttemptEvidenceItem[];
    lookupHistory: AdminKycAttemptLookupHistoryItem[];
    decisionHistory: AdminKycAttemptDecisionHistoryItem[];
}

const stageAttemptLookupSelect = Prisma.validator<Prisma.KycStageAttemptSelect>()({
    id: true,
    userId: true,
    stage: true,
    method: true,
    attemptNo: true,
    isCurrent: true,
    status: true,
    providerStatus: true,
    reasonMessage: true,
    evidenceSummary: true,
    reviewNote: true,
    reviewerId: true,
    providerRef: true,
    submittedAt: true,
    reviewedAt: true,
    version: true,
    evidenceAssets: {
        select: {
            storageUrl: true,
        },
    },
});

type StageAttemptLookupRecord = Prisma.KycStageAttemptGetPayload<{
    select: typeof stageAttemptLookupSelect;
}>;

type DecisionShadowAttempt = {
    id: number;
    journeyType: string;
    stage: string;
    status?: string | null;
    providerRef?: string | null;
    reviewerId?: number | null;
    reviewNote?: string | null;
    reviewedAt?: Date | null;
    version?: number | null;
};

type AttemptEventLookupRecord = {
    attemptId?: number | null;
    stage?: string | null;
    eventType?: string | null;
    payload?: unknown;
    providerRef?: string | null;
};

interface AdminKycLookupResult {
    key: string;
    label: string;
    status: AdminLookupStatus;
    provider: AdminLookupProvider;
    providerRef: string | null;
    summary: Record<string, any>;
    rawResponse: any;
    documentUrl?: string | null;
    lookedUpAt: string;
}

interface PersistedAdminLookupHistoryPayload {
    source: "ADMIN_PROVIDER_LOOKUP";
    lookupType: AdminKycProviderLookupType;
    outcome: AdminLookupOutcome;
    lookedUpAt: string;
    requestedByAdminId?: number;
    attemptId?: number | null;
    legacyHistoryRecordId?: number | null;
    results: AdminKycLookupResult[];
}

interface PersistedAdminDecisionEventPayload {
    source: "ADMIN_DECISION";
    verificationType: string;
    action: KycDecisionAction;
    auditAction: string;
    note?: string | null;
    attemptId?: number | null;
    attemptVersion?: number | null;
}

type DojahLookupEntity = Record<string, any>;
type DojahParsedDocument = Record<string, any>;

@Injectable()
export class KycService {
    private readonly logger = new Logger(KycService.name);
    private readonly getProfileCacheKey = (userId: number) => `user:profile:${userId}`;

    private readonly actionableStatuses = new Set(["PENDING", "ESCALATED"]);

    constructor(
        private readonly prisma: PrismaService,
        private readonly tierService: TierService,
        private readonly kycStateMachine: KycStateMachineService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly emailService: EmailService,
        private readonly redisCacheService: RedisCacheService,
        private readonly wsGateway: WsGateway,
        private readonly identityResolution: IdentityResolutionService,
        private readonly auditLogService: AuditLogService,
        @Inject(IdentityComplianceInjectionToken.DOJAH)
        private readonly dojahService: DojahService,
    ) { }

    // ==================== KYC QUEUE ====================

    async getKycQueue(query: GetKycQueueDto): Promise<ApiResponse> {
        const {
            pageNumber = 1,
            pageSize = 20,
            queueView,
            status,
            verificationType,
            searchText,
            tier,
            sortBy = "desc",
        } = query;

        const resolvedQueueView = this.resolveQueueView(queueView, status);
        const where = this.buildKycQueueWhere({
            resolvedQueueView,
            status,
            verificationType,
            searchText,
            tier,
        });

        const [users, count] = await this.prisma.$transaction([
            this.prisma.user.findMany({
                where,
                select: {
                    id: true,
                    identifier: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                    photo: true,
                    userType: true,
                    tier: true,
                    status: true,
                    bvn: true,
                    nin: true,
                    isDocumentVerified: true,
                    isEmailVerified: true,
                    isPhoneVerified: true,
                    businessDocumentsUploaded: true,
                    businessDocumentVerificationStatus: true,
                    userDocument: {
                        select: {
                            id: true,
                            type: true,
                            documentNumber: true,
                            documentImageUrl: true,
                            documentImageUrl2: true,
                        },
                    },
                    businessDocument: true,
                    businessRecord: true,
                    addressDocumentUrl: true,
                    incomeDocumentUrl: true,
                    kycStageAttempts: {
                        where: {
                            isCurrent: true,
                            OR: [
                                {
                                    journeyType: "INDIVIDUAL",
                                    stage: {
                                        in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"],
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
                            stage: true,
                            method: true,
                            attemptNo: true,
                            isCurrent: true,
                            status: true,
                            providerStatus: true,
                            providerRef: true,
                            reviewNote: true,
                            reviewerId: true,
                            submittedAt: true,
                            reviewedAt: true,
                            version: true,
                        },
                    },
                    kycAttemptEvents: {
                        orderBy: { createdAt: "desc" },
                        take: 10,
                        select: {
                            id: true,
                            attemptId: true,
                            stage: true,
                            eventType: true,
                            actorType: true,
                            actorId: true,
                            note: true,
                            payload: true,
                            createdAt: true,
                        },
                    },
                    createdAt: true,
                    updatedAt: true,
                },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
                orderBy: this.getKycQueueOrderBy(resolvedQueueView, sortBy),
            }),
            this.prisma.user.count({ where }),
        ]);

        // Enrich with verification status summary - use stored tier from database
        const enrichedUsers = users.map((user) => {
            const {
                isDocumentVerified,
                isEmailVerified,
                isPhoneVerified,
                ...queueUser
            } = user;
            const normalizedUser = this.normalizeVerificationState(user);
            const { verificationSnapshot } = normalizedUser;
            const queueMetadata = this.buildQueueMetadata(normalizedUser, resolvedQueueView);

            return {
                ...queueUser,
                emailVerified: normalizedUser.emailVerified,
                phoneVerified: normalizedUser.phoneVerified,
                documentVerified: normalizedUser.documentVerified,
                // Use stored tier from database (not calculated) so admin resets persist
                tier: user.tier ?? 0,
                verificationSummary: {
                    email: normalizedUser.emailVerified,
                    phone: normalizedUser.phoneVerified,
                    bvn: verificationSnapshot.bvnVerified,
                    nin: verificationSnapshot.ninVerified,
                    document: normalizedUser.documentVerified,
                    address: verificationSnapshot.addressVerified,
                    income: verificationSnapshot.incomeVerified,
                },
                needsReview: queueMetadata.needsReview,
                queueView: resolvedQueueView,
                queueReason: queueMetadata.queueReason,
                blockingVerificationTypes: queueMetadata.blockingVerificationTypes,
                oldestSubmittedAt: queueMetadata.oldestSubmittedAt,
                latestReviewAt: queueMetadata.latestReviewAt,
                queueSortAt: queueMetadata.queueSortAt,
                activeAttempt: queueMetadata.activeAttempt,
                latestAttempt: queueMetadata.latestAttempt,
                actionableAttempts: queueMetadata.actionableAttempts,
            };
        });

        return buildResponse({
            message: "KYC queue retrieved successfully",
            data: {
                meta: buildPaginationMeta(pageNumber, pageSize, count, users.length),
                records: enrichedUsers,
            },
        });
    }

    async getKycUserDetail(userId: number): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: {
                userDocument: true,
                businessDocument: {
                    include: {
                        directors: true,
                        shareholders: true,
                    },
                },
                businessRecord: true,
                accountLimit: true,
                kycStageAttempts: {
                    where: {
                        OR: [
                            {
                                journeyType: "INDIVIDUAL",
                                stage: {
                                    in: ["GOVERNMENT_ID", "IDENTITY_DOCUMENT", "ADDRESS", "INCOME"],
                                },
                            },
                            {
                                journeyType: "BUSINESS",
                                stage: "BUSINESS_DOCUMENT",
                            },
                        ],
                    },
                    orderBy: { submittedAt: "desc" },
                    select: {
                        id: true,
                        stage: true,
                        method: true,
                        attemptNo: true,
                        isCurrent: true,
                        status: true,
                        providerStatus: true,
                        providerRef: true,
                        reasonCode: true,
                        reasonMessage: true,
                        reasonDetails: true,
                        extractedFields: true,
                        comparisonSummary: true,
                        evidenceSummary: true,
                        reviewNote: true,
                        reviewerId: true,
                        submittedAt: true,
                        reviewedAt: true,
                        version: true,
                        evidenceAssets: {
                            select: {
                                id: true,
                                kind: true,
                                storageUrl: true,
                                originalName: true,
                                mimeType: true,
                                side: true,
                            },
                        },
                    },
                },
                kycAttemptEvents: {
                    orderBy: { createdAt: "desc" },
                    select: {
                        id: true,
                        attemptId: true,
                        journeyType: true,
                        stage: true,
                        eventType: true,
                        actorType: true,
                        actorId: true,
                        providerName: true,
                        providerStatus: true,
                        providerRef: true,
                        note: true,
                        payload: true,
                        createdAt: true,
                    },
                },
                order: {
                    take: 5,
                    orderBy: { createdAt: "desc" },
                    select: {
                        id: true,
                        orderCategory: true,
                        amount: true,
                        currency: true,
                        streamlinedStatus: true,
                        createdAt: true,
                    },
                },
            },
        });

        if (!user) {
            return buildResponse({
                message: "User not found",
                data: null,
            });
        }

        // Get verification history/audit logs for this user
        const auditLogs = await this.prisma.auditLog.findMany({
            where: {
                resource: "kyc",
                resourceId: userId.toString(),
            },
            orderBy: { createdAt: "desc" },
            take: 20,
        });
        const auditHistory = this.buildAdminAuditHistory(user.kycAttemptEvents ?? [], auditLogs);

        const attemptHistory = this.buildAttemptHistory(user);
        const activeAttempts = this.buildCurrentAttemptSummaries(user);
        const currentAttemptByVerificationType = activeAttempts.reduce<Record<string, AdminKycAttemptSummary>>((accumulator, attempt) => {
            accumulator[attempt.verificationType] = attempt;
            return accumulator;
        }, {});
        const attemptDetailsByVerificationType = this.buildAttemptDetailsByVerificationType({
            user,
            attemptHistory,
            currentAttemptByVerificationType,
            attemptRecordByVerificationType: this.buildAttemptRecordByVerificationType(user),
            auditLogs,
        });
        const currentBusinessAttempt = currentAttemptByVerificationType.BUSINESS_DOCUMENT;

        return buildResponse({
            message: "KYC user detail retrieved successfully",
            data: {
                user: {
                    id: user.id,
                    identifier: user.identifier,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    phone: user.phone,
                    photo: user.photo,
                    userType: user.userType,
                    tier: user.tier ?? 0,
                    status: user.status,
                    createdAt: user.createdAt,
                },
                identityInfo: {
                    bvn: user.bvn ? `****${user.bvn.slice(-4)}` : null,
                    nin: user.nin ? `****${user.nin.slice(-4)}` : null,
                    dateOfBirth: user.dateOfBirth,
                    gender: user.gender,
                },
                businessInfo: user.userType === "BUSINESS" ? {
                    record: user.businessRecord,
                    documents: user.businessDocument,
                    submitted: Boolean(currentBusinessAttempt || user.businessDocument),
                    status: currentBusinessAttempt?.status ?? null,
                } : null,
                activeAttempts,
                attemptHistory,
                currentAttemptByVerificationType,
                attemptDetailsByVerificationType,
                limits: user.accountLimit,
                recentTransactions: user.order,
                auditHistory,
            },
        });
    }

    async processAttemptDecision(
        attemptId: number,
        dto: AdminKycAttemptDecisionDto,
        adminId?: number,
    ): Promise<ApiResponse> {
        const attempt = await this.resolveAttemptContext(attemptId, dto.verificationType);

        if (!attempt) {
            return buildResponse({
                message: "KYC attempt not found",
                data: null,
            });
        }

        const response = await this.processKycDecision(
            {
                userId: attempt.userId,
                action: dto.action,
                verificationType: attempt.verificationType,
                version: dto.expectedVersion,
                note: dto.note,
            },
            adminId,
        );

        if (!response?.data) {
            return response;
        }

        const updatedAttempt = await this.getAttemptSummaryById(attempt.attemptId, attempt.verificationType);
        const stage = updatedAttempt?.stage ?? attempt.stage;
        const status = updatedAttempt?.status ?? response?.data?.status ?? null;

        return buildResponse({
            message: response.message,
            data: {
                attemptId: updatedAttempt?.attemptId ?? attempt.attemptId,
                userId: attempt.userId,
                verificationType: attempt.verificationType,
                stage,
                status,
                reviewerId: updatedAttempt?.reviewerId ?? adminId ?? null,
                reviewedAt: updatedAttempt?.reviewedAt ?? new Date().toISOString(),
                version: updatedAttempt?.version ?? dto.expectedVersion,
                nextAction: this.buildAdminAttemptNextAction(status, stage),
                attempt: updatedAttempt,
            },
        });
    }

    async runAttemptVerificationLookup(
        attemptId: number,
        dto: RunKycAttemptRecheckDto,
        adminId?: number,
    ): Promise<ApiResponse> {
        const attempt = await this.resolveAttemptContext(attemptId, dto.verificationType);

        if (!attempt) {
            return buildResponse({
                message: "KYC attempt not found",
                data: null,
            });
        }

        this.ensureLookupProviderSupported(dto.provider, attempt.verificationType);

        const response = await this.runProviderLookup(
            {
                userId: attempt.userId,
                verificationType: attempt.verificationType as AdminKycProviderLookupType,
            },
            adminId,
        );

        if (!response?.data) {
            return response;
        }

        const results = response.data.results ?? [];
        const stage = attempt.stage;

        return buildResponse({
            message: response.message,
            data: {
            attemptId: attempt.attemptId,
                userId: attempt.userId,
                verificationType: attempt.verificationType,
                stage,
                provider: dto.provider,
                providerStatus: this.resolveLookupOutcomeFromResults(results),
                lookedUpAt: response.data.lookedUpAt,
                historyRecordId: response.data.historyRecordId ?? null,
                extractedFields: this.buildAttemptExtractedFieldsFromLookupResults(results),
                comparisonSummary: this.buildAttemptComparisonSummaryFromLookupResults(results),
                evidenceSummary: this.buildAttemptEvidenceSummaryFromLookupResults(attempt.verificationType, results),
                nextAction: {
                    type: "WAIT",
                    stage,
                    label: "Await admin review",
                    message: `${attempt.verificationType} lookup saved to attempt history`,
                },
                results,
            },
        });
    }

    async runProviderLookup(dto: RunKycProviderLookupDto, adminId?: number): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: dto.userId },
            include: {
                userDocument: true,
                businessDocument: true,
                businessRecord: true,
                kycStageAttempts: {
                    where: { isCurrent: true },
                    select: {
                        id: true,
                        journeyType: true,
                        stage: true,
                        method: true,
                        isCurrent: true,
                        status: true,
                        providerRef: true,
                        version: true,
                    },
                },
                kycAttemptEvents: {
                    orderBy: { createdAt: "desc" },
                    take: 25,
                    select: {
                        id: true,
                        stage: true,
                        eventType: true,
                        providerRef: true,
                        payload: true,
                        createdAt: true,
                    },
                },
            },
        });

        if (!user) {
            return buildResponse({
                message: "User not found",
                data: null,
            });
        }

        const lookedUpAt = new Date().toISOString();
        let results: AdminKycLookupResult[] = [];

        switch (dto.verificationType) {
            case "BVN":
                results = [await this.runBvnLookup(user, lookedUpAt)];
                break;
            case "NIN":
                results = [await this.runNinLookup(user, lookedUpAt)];
                break;
            case "DOCUMENT":
                results = [await this.runDocumentLookup(user, lookedUpAt)];
                break;
            case "ADDRESS":
                results = [await this.runAddressLookup(user, lookedUpAt)];
                break;
            case "INCOME":
                results = [await this.runIncomeLookup(user, lookedUpAt)];
                break;
            case "BUSINESS_DOCUMENT":
                results = await this.runBusinessDocumentLookup(user, lookedUpAt);
                break;
            default:
                throw new BadRequestException(`Unsupported lookup type: ${dto.verificationType}`);
        }

        const hasSuccess = results.some((result) => result.status === "SUCCESS");
        const allSuccessful = results.every((result) => result.status === "SUCCESS");
        let outcome: AdminLookupOutcome = "FAILED";
        if (allSuccessful) {
            outcome = "SUCCESS";
        } else if (hasSuccess) {
            outcome = "PARTIAL_FAILURE";
        }

        let message = `${dto.verificationType} lookup failed`;
        if (allSuccessful) {
            message = `${dto.verificationType} lookup completed successfully`;
        } else if (hasSuccess) {
            message = `${dto.verificationType} lookup completed with partial failures`;
        }

        const persistedLookupRecord = await this.persistVerificationLookupHistory(
            user,
            dto.verificationType,
            results,
            outcome,
            lookedUpAt,
            adminId,
        );

        await this.auditLogService.log({
            adminId,
            action: "KYC_PROVIDER_LOOKUP",
            resource: "kyc",
            resourceId: user.id.toString(),
            details: {
                verificationType: dto.verificationType,
                outcome,
                resultKeys: results.map((result) => result.key),
                providerRefs: results.map((result) => result.providerRef).filter(Boolean),
                kycLookupHistoryId: persistedLookupRecord.id,
            },
        });

        return buildResponse({
            message,
            data: {
                userId: user.id,
                verificationType: dto.verificationType,
                lookedUpAt,
                results,
                historyRecordId: persistedLookupRecord.id,
            },
        });
    }

    private async persistVerificationLookupHistory(
        user: any,
        verificationType: AdminKycProviderLookupType,
        results: AdminKycLookupResult[],
        outcome: AdminLookupOutcome,
        lookedUpAt: string,
        adminId?: number,
    ): Promise<{ id: number }> {
        const lookupMetadata = this.resolveLookupHistoryAttemptMetadata(user, verificationType);
        const note = this.buildLookupHistoryNote(verificationType, outcome, results);
        const providerRef = results.find((result) => result.providerRef)?.providerRef ?? lookupMetadata.providerRef;

        const payload: PersistedAdminLookupHistoryPayload = {
            source: "ADMIN_PROVIDER_LOOKUP",
            lookupType: verificationType,
            outcome,
            lookedUpAt,
            requestedByAdminId: adminId,
            attemptId: lookupMetadata.attemptId,
            results,
        };

        return await this.shadowWriteLookupAttemptEvent({
            userId: user.id,
            verificationType,
            adminId,
            outcome,
            results,
            note,
            payload,
            attemptId: lookupMetadata.attemptId,
            currentStatus: lookupMetadata.currentStatus,
            currentVersion: lookupMetadata.currentVersion,
            providerRef,
            lookedUpAt,
        });
    }

    private resolveLookupHistoryAttemptMetadata(
        user: any,
        verificationType: AdminKycProviderLookupType,
    ): {
        attemptId: number | null;
        currentStatus: KycStatus;
        currentVersion: number;
        providerRef: string | null;
    } {
        const currentAttempt = this.getCurrentStageAttemptForVerificationType(user, verificationType);
        const latestEvent = this.getLatestAttemptEventForVerificationType(user?.kycAttemptEvents, verificationType);
        const structuredPayload = this.getAttemptStructuredRecord(latestEvent?.payload);
        const lookupPayload = this.getPersistedLookupHistoryPayload(latestEvent?.payload);
        let eventVersion: number | null = null;
        if (typeof structuredPayload?.attemptVersion === "number") {
            eventVersion = structuredPayload.attemptVersion;
        }

        return {
            attemptId: currentAttempt?.id
                ?? latestEvent?.attemptId
                ?? lookupPayload?.attemptId
                ?? (typeof structuredPayload?.attemptId === "number" ? structuredPayload.attemptId : null),
            currentStatus: currentAttempt?.status
                ? this.mapStageAttemptStatusToKycStatus(currentAttempt.status)
                : this.resolveLookupHistoryStatus(user, verificationType),
            currentVersion: typeof currentAttempt?.version === "number"
                ? currentAttempt.version
                : eventVersion ?? 1,
            providerRef: currentAttempt?.providerRef ?? latestEvent?.providerRef ?? null,
        };
    }

    private getLatestAttemptEventForVerificationType(
        attemptEvents: AttemptEventLookupRecord[] | undefined,
        verificationType: AdminKycProviderLookupType,
    ): AttemptEventLookupRecord | null {
        return (attemptEvents ?? []).find((event) => this.doesAttemptEventMatchVerificationType(event, verificationType)) ?? null;
    }

    private doesAttemptEventMatchVerificationType(event: AttemptEventLookupRecord, verificationType: string): boolean {
        const lookupPayload = this.getPersistedLookupHistoryPayload(event?.payload);
        if (lookupPayload?.lookupType === verificationType) {
            return true;
        }

        const structuredPayload = this.getAttemptStructuredRecord(event?.payload);
        if (structuredPayload?.verificationType === verificationType) {
            return true;
        }

        if (event?.stage !== this.mapVerificationTypeToAttemptStage(verificationType)) {
            return false;
        }

        return verificationType !== "BVN" && verificationType !== "NIN";
    }

    private async shadowWriteLookupAttemptEvent(params: {
        userId: number;
        verificationType: AdminKycProviderLookupType;
        adminId?: number;
        outcome: AdminLookupOutcome;
        results: AdminKycLookupResult[];
        note: string;
        payload: PersistedAdminLookupHistoryPayload;
        attemptId?: number | null;
        currentStatus: KycStatus;
        currentVersion: number;
        providerRef?: string | null;
        lookedUpAt: string;
    }): Promise<{ id: number }> {
        const attempt = await this.resolveOrCreateLookupShadowAttempt({
            userId: params.userId,
            verificationType: params.verificationType,
            attemptId: params.attemptId,
            currentStatus: params.currentStatus,
            currentVersion: params.currentVersion,
            providerRef: params.providerRef,
            lookedUpAt: params.lookedUpAt,
        });

        const providerName = this.resolveLookupEventProviderName(params.results);
        const providerRef = this.resolveLookupEventProviderRef(params.results);
        const actorType = typeof params.adminId === "number" ? "ADMIN" : "SYSTEM";
        return await (this.prisma as any).kycAttemptEvent.create({
            data: {
                attemptId: attempt.id,
                userId: params.userId,
                journeyType: attempt.journeyType,
                stage: attempt.stage,
                eventType: "ADMIN_RECHECK",
                actorType,
                actorId: params.adminId ?? null,
                providerName: providerName ?? undefined,
                providerStatus: this.mapLookupOutcomeToProviderStatus(params.outcome),
                providerRef: providerRef ?? undefined,
                note: params.note,
                payload: params.payload as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
        });
    }

    private async resolveOrCreateLookupShadowAttempt(params: {
        userId: number;
        verificationType: AdminKycProviderLookupType;
        attemptId?: number | null;
        currentStatus: KycStatus;
        currentVersion: number;
        providerRef?: string | null;
        lookedUpAt: string;
    }): Promise<DecisionShadowAttempt> {
        const existingAttempt = await this.resolveShadowAttemptForVerification(
            params.userId,
            params.verificationType,
            params.attemptId,
        );
        if (existingAttempt) {
            return existingAttempt;
        }

        const stage = this.mapVerificationTypeToAttemptStage(params.verificationType) as KycStage;
        const journeyType = this.mapVerificationTypeToJourneyType(params.verificationType) as any;
        const method = this.mapVerificationTypeToAttemptMethod(params.verificationType) as any;
        const submittedAt = new Date(params.lookedUpAt);
        const nextAttemptAggregate = await this.prisma.kycStageAttempt.aggregate({
            where: {
                userId: params.userId,
                stage,
            },
            _max: { attemptNo: true },
        });

        return await this.prisma.kycStageAttempt.create({
            data: {
                userId: params.userId,
                journeyType,
                stage,
                method,
                attemptNo: (nextAttemptAggregate._max.attemptNo ?? 0) + 1,
                isCurrent: true,
                status: this.mapKycStatusToStageAttemptStatus(params.currentStatus),
                providerStatus: this.mapKycStatusToStageProviderStatus(params.currentStatus),
                providerRef: params.providerRef ?? null,
                version: params.currentVersion,
                submittedAt: Number.isNaN(submittedAt.getTime()) ? undefined : submittedAt,
            } as Prisma.KycStageAttemptUncheckedCreateInput,
            select: {
                id: true,
                journeyType: true,
                stage: true,
                status: true,
                providerRef: true,
                reviewerId: true,
                reviewNote: true,
                reviewedAt: true,
                version: true,
            },
        });
    }

    private async resolveShadowAttemptForVerification(
        userId: number,
        verificationType: string,
        attemptId?: number | null,
    ): Promise<DecisionShadowAttempt | null> {
        if (typeof attemptId === "number") {
            const method = this.mapVerificationTypeToAttemptMethod(verificationType) as any;
            const linkedAttempt = await this.prisma.kycStageAttempt.findFirst({
                where: {
                    id: attemptId,
                    userId,
                    journeyType: this.mapVerificationTypeToJourneyType(verificationType) as any,
                    stage: this.mapVerificationTypeToAttemptStage(verificationType) as any,
                    ...(method ? { method } : {}),
                },
                select: {
                    id: true,
                    journeyType: true,
                    stage: true,
                    status: true,
                    providerRef: true,
                    reviewerId: true,
                    reviewNote: true,
                    reviewedAt: true,
                    version: true,
                },
            });

            if (linkedAttempt) {
                return linkedAttempt;
            }
        }

        const stage = this.mapVerificationTypeToAttemptStage(verificationType);
        const attemptWhere: any = {
            userId,
            journeyType: this.mapVerificationTypeToJourneyType(verificationType),
            stage,
            isCurrent: true,
        };

        if (verificationType === "BVN" || verificationType === "NIN") {
            attemptWhere.method = verificationType as any;
        }

        return await this.prisma.kycStageAttempt.findFirst({
            where: attemptWhere,
            orderBy: [{ attemptNo: "desc" }, { id: "desc" }],
            select: {
                id: true,
                journeyType: true,
                stage: true,
                status: true,
                providerRef: true,
                reviewerId: true,
                reviewNote: true,
                reviewedAt: true,
                version: true,
            },
        });
    }

    private async resolveDecisionBridgeContext(
        userId: number,
        verificationType: string,
    ): Promise<DecisionShadowAttempt | null> {
        if (!this.isAttemptOwnedDecisionVerificationType(verificationType)) {
            return null;
        }

        return await this.resolveShadowAttemptForVerification(userId, verificationType);
    }

    private resolveLookupEventProviderName(results: AdminKycLookupResult[]): string | null {
        const providerNames = [...new Set(results.map((result) => result.provider).filter(Boolean))];
        if (providerNames.length !== 1) {
            return null;
        }

        if (providerNames[0] === "OCR") {
            return "OCR";
        }

        if (providerNames[0] === "DOJAH") {
            return "DOJAH";
        }

        return null;
    }

    private resolveLookupEventProviderRef(results: AdminKycLookupResult[]): string | null {
        const providerRefs = [...new Set(results.map((result) => result.providerRef).filter((value): value is string => typeof value === "string" && value.length > 0))];
        return providerRefs[0] ?? null;
    }

    private mapLookupOutcomeToProviderStatus(outcome: AdminLookupOutcome): string {
        switch (outcome) {
            case "SUCCESS":
                return "PASSED";
            case "PARTIAL_FAILURE":
                return "INCONCLUSIVE";
            case "FAILED":
            default:
                return "FAILED";
        }
    }

    private resolveLookupHistoryStatus(
        user: any,
        verificationType: AdminKycProviderLookupType,
        activeStatus?: KycStatus,
    ): KycStatus {
        if (activeStatus) {
            return activeStatus;
        }

        const normalizedUser = this.normalizeVerificationState(user);
        const { verificationSnapshot } = normalizedUser;
        const currentBusinessAttempt = this.getCurrentStageAttemptForVerificationType(normalizedUser, "BUSINESS_DOCUMENT");
        const fallbackStatusByVerificationType: Record<AdminKycProviderLookupType, KycStatus> = {
            BVN: this.resolveStageManagedLookupStatus(normalizedUser, "BVN", verificationSnapshot.bvnVerified),
            NIN: this.resolveStageManagedLookupStatus(normalizedUser, "NIN", verificationSnapshot.ninVerified),
            DOCUMENT: this.resolveDocumentLookupStatus(normalizedUser.documentVerificationStatus, normalizedUser.documentVerified),
            ADDRESS: this.resolveStageManagedLookupStatus(normalizedUser, "ADDRESS", verificationSnapshot.addressVerified, verificationSnapshot.addressStatus),
            INCOME: this.resolveStageManagedLookupStatus(normalizedUser, "INCOME", verificationSnapshot.incomeVerified, verificationSnapshot.incomeStatus),
            BUSINESS_DOCUMENT: currentBusinessAttempt?.status
                ? this.mapStageAttemptStatusToKycStatus(currentBusinessAttempt.status)
                : KycStatus.PENDING,
        };

        return fallbackStatusByVerificationType[verificationType] ?? KycStatus.PENDING;
    }

    private resolveDocumentLookupStatus(
        verificationStatus?: DocumentVerificationStatus | null,
        isVerified = false,
    ): KycStatus {
        if (isVerified || verificationStatus === DocumentVerificationStatus.VERIFIED) {
            return KycStatus.APPROVED;
        }

        if (verificationStatus === DocumentVerificationStatus.DECLINED) {
            return KycStatus.REJECTED;
        }

        return KycStatus.PENDING;
    }

    private buildLookupHistoryNote(
        verificationType: AdminKycProviderLookupType,
        outcome: AdminLookupOutcome,
        results: AdminKycLookupResult[],
    ): string {
        if (outcome === "SUCCESS") {
            return `${verificationType} investigative lookup captured from Dojah`;
        }

        const failedCount = results.filter((result) => result.status === "FAILED").length;
        if (outcome === "PARTIAL_FAILURE") {
            return `${verificationType} investigative lookup captured with ${failedCount} provider issue${failedCount === 1 ? "" : "s"}`;
        }

        return `${verificationType} investigative lookup failed at provider`;
    }

    // ==================== KYC DECISIONS ====================

    private buildIdentityLookupResult(
        user: any,
        key: "BVN" | "NIN",
        label: string,
        response: any,
        lookedUpAt: string,
    ): AdminKycLookupResult {
        const entity = (response?.data?.entity ?? {}) as DojahLookupEntity;
        const comparisonSummary = this.buildIdentityLookupSummary(user, entity);

        return {
            key,
            label,
            status: "SUCCESS",
            provider: "DOJAH",
            providerRef: entity.reference_id ?? null,
            summary: {
                verified: true,
                firstName: entity.first_name ?? null,
                lastName: entity.last_name ?? null,
                dateOfBirth: entity.date_of_birth ?? null,
                phoneNumber: entity.phone_number1 ?? entity.phone_number ?? null,
                gender: entity.gender ?? null,
                ...comparisonSummary,
            },
            rawResponse: response?.data ?? null,
            lookedUpAt,
        };
    }

    private async runIdentityLookup(params: {
        user: any;
        identifier?: string | null;
        missingIdentifierMessage: string;
        request: () => Promise<any>;
        key: "BVN" | "NIN";
        label: string;
        lookedUpAt: string;
    }): Promise<AdminKycLookupResult> {
        const { user, identifier, missingIdentifierMessage, request, key, label, lookedUpAt } = params;

        if (!identifier) {
            throw new BadRequestException(missingIdentifierMessage);
        }

        try {
            const response = await request();
            return this.buildIdentityLookupResult(user, key, label, response, lookedUpAt);
        } catch (error) {
            return this.buildLookupErrorResult(key, label, lookedUpAt, error);
        }
    }

    private async runBusinessRegistryLookup(params: {
        identifier: string;
        businessName: string;
        expectedName: string;
        lookedUpAt: string;
        key: "CAC" | "TIN";
        label: string;
        request: () => Promise<any>;
        providerNameField: "company_name" | "taxpayer_name";
        extraSummary?: (entity: DojahLookupEntity) => Record<string, unknown>;
    }): Promise<AdminKycLookupResult> {
        const {
            identifier,
            businessName,
            expectedName,
            lookedUpAt,
            key,
            label,
            request,
            providerNameField,
            extraSummary,
        } = params;

        if (!identifier) {
            throw new BadRequestException(`Missing ${key} identifier for business lookup`);
        }

        try {
            const response = await request();
            const entity = (response?.data?.entity ?? {}) as DojahLookupEntity;
            const providerName = (entity[providerNameField] as string | null | undefined) ?? null;
            const normalizedProviderName = this.normalizeLookupText(providerName);
            const nameMatches = expectedName && normalizedProviderName
                ? normalizedProviderName.includes(expectedName) || expectedName.includes(normalizedProviderName)
                : null;
            const providerNameSummary = providerNameField === "company_name"
                ? { providerCompanyName: providerName, companyName: providerName }
                : { providerTaxpayerName: providerName, taxpayerName: providerName };
            const additionalSummary = extraSummary?.(entity);
            const summary: Record<string, unknown> = {
                verified: true,
                expectedCompanyName: businessName || null,
                nameMatches,
                ...providerNameSummary,
            };

            if (additionalSummary) {
                Object.assign(summary, additionalSummary);
            }

            return {
                key,
                label,
                status: "SUCCESS",
                provider: "DOJAH",
                providerRef: entity.reference_id ?? null,
                summary,
                rawResponse: response?.data ?? null,
                lookedUpAt,
            };
        } catch (error) {
            return this.buildLookupErrorResult(key, label, lookedUpAt, error);
        }
    }

    private async runBvnLookup(user: any, lookedUpAt: string): Promise<AdminKycLookupResult> {
        return this.runIdentityLookup({
            user,
            identifier: user.bvn,
            missingIdentifierMessage: "This user does not have a BVN on record",
            request: () => this.dojahService.verifyBvn({
                bvn: user.bvn,
                first_name: user.firstName ?? undefined,
                last_name: user.lastName ?? undefined,
                dob: user.dateOfBirth ?? undefined,
            }),
            key: "BVN",
            label: "BVN lookup",
            lookedUpAt,
        });
    }

    private async runNinLookup(user: any, lookedUpAt: string): Promise<AdminKycLookupResult> {
        return this.runIdentityLookup({
            user,
            identifier: user.nin,
            missingIdentifierMessage: "This user does not have a NIN on record",
            request: () => this.dojahService.verifyNin({
                nin: user.nin,
                first_name: user.firstName ?? undefined,
                last_name: user.lastName ?? undefined,
                dob: user.dateOfBirth ?? undefined,
            }),
            key: "NIN",
            label: "NIN lookup",
            lookedUpAt,
        });
    }

    private async runDocumentLookup(user: any, lookedUpAt: string): Promise<AdminKycLookupResult> {
        if (!user.userDocument?.documentImageUrl) {
            throw new BadRequestException("This user does not have a submitted identity document to recheck");
        }

        try {
            const analysis = await this.dojahService.analyzeDocument({
                imageFrontSide: user.userDocument.documentImageUrl,
                imageBackSide: user.userDocument.documentImageUrl2 ?? undefined,
                inputType: "url",
            });

            const parsed = (analysis?.parsed ?? {}) as DojahParsedDocument;
            const analysisEntity = (analysis?.response?.data?.entity ?? {}) as DojahLookupEntity;
            const extractedName = [parsed.firstName, parsed.lastName].filter(Boolean).join(" ").trim() || null;
            const expectedName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
            const nameMatches = expectedName && extractedName
                ? this.normalizeLookupText(extractedName) === this.normalizeLookupText(expectedName)
                : null;
            const expectedDateOfBirth = user.dateOfBirth ?? null;
            const providerDateOfBirth = parsed.dateOfBirth ?? null;
            const dobMatches = expectedDateOfBirth && providerDateOfBirth
                ? this.normalizeLookupDate(providerDateOfBirth) === this.normalizeLookupDate(expectedDateOfBirth)
                : null;
            const expectedDocumentType = user.userDocument.type ?? null;
            const providerDocumentType = parsed.documentType ?? null;
            const documentTypeMatches = expectedDocumentType && providerDocumentType
                ? this.normalizeLookupText(providerDocumentType) === this.normalizeLookupText(expectedDocumentType)
                : null;
            const expectedDocumentNumber = user.userDocument.documentNumber ?? null;
            const providerDocumentNumber = parsed.documentNumber ?? null;
            const documentNumberMatches = expectedDocumentNumber && providerDocumentNumber
                ? this.normalizeLookupText(providerDocumentNumber) === this.normalizeLookupText(expectedDocumentNumber)
                : null;

            return {
                key: "DOCUMENT",
                label: "Document OCR lookup",
                status: parsed.isValid ? "SUCCESS" : "FAILED",
                provider: "DOJAH",
                providerRef: analysisEntity.reference_id ?? null,
                summary: {
                    verified: parsed.isValid ?? false,
                    documentType: parsed.documentType ?? user.userDocument.type ?? null,
                    extractedName,
                    nameMatches,
                    expectedName,
                    providerName: extractedName,
                    expectedDateOfBirth,
                    providerDateOfBirth,
                    dobMatches,
                    expectedDocumentType,
                    providerDocumentType,
                    documentTypeMatches,
                    expectedDocumentNumber,
                    providerDocumentNumber,
                    documentNumberMatches,
                    extractedDateOfBirth: parsed.dateOfBirth ?? null,
                    extractedDocumentNumber: parsed.documentNumber ?? null,
                    extractedExpiryDate: parsed.expiryDate ?? null,
                },
                rawResponse: analysis?.response?.data ?? analysis ?? null,
                documentUrl: user.userDocument.documentImageUrl,
                lookedUpAt,
            };
        } catch (error) {
            return this.buildLookupErrorResult("DOCUMENT", "Document OCR lookup", lookedUpAt, error, user.userDocument.documentImageUrl);
        }
    }

    private async runAddressLookup(user: any, lookedUpAt: string): Promise<AdminKycLookupResult> {
        if (!user.addressDocumentUrl) {
            throw new BadRequestException("This user does not have a submitted address document to recheck");
        }

        try {
            const { buffer, mimeType } = await this.downloadLookupDocument(user.addressDocumentUrl);
            const validation = await validateAddressDocument(
                buffer,
                user.firstName ?? "",
                user.lastName ?? "",
                user.residentialAddress ?? null,
                mimeType,
            );

            return {
                key: "ADDRESS",
                label: "Address OCR lookup",
                status: validation.isValid ? "SUCCESS" : "FAILED",
                provider: "OCR",
                providerRef: null,
                summary: {
                    verified: validation.isValid,
                    confidence: validation.confidence ?? null,
                    expectedName: [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null,
                    nameMatches: validation.matchedName ?? null,
                    expectedAddress: user.residentialAddress ?? null,
                    addressMatches: validation.matchedResidentialAddress ?? null,
                    addressIndicatorsFound: validation.matchedAddress ?? null,
                    requiresManualReview: validation.requiresManualReview ?? null,
                    documentDate: validation.documentDate ?? null,
                    isRecent: validation.isRecent ?? null,
                    textExcerpt: this.buildLookupTextExcerpt(validation.extractedText),
                    reason: validation.reason ?? null,
                },
                rawResponse: validation,
                documentUrl: user.addressDocumentUrl,
                lookedUpAt,
            };
        } catch (error) {
            return this.buildLookupErrorResult("ADDRESS", "Address OCR lookup", lookedUpAt, error, user.addressDocumentUrl, "OCR");
        }
    }

    private async runIncomeLookup(user: any, lookedUpAt: string): Promise<AdminKycLookupResult> {
        if (!user.incomeDocumentUrl) {
            throw new BadRequestException("This user does not have a submitted income document to recheck");
        }

        try {
            const { buffer, mimeType } = await this.downloadLookupDocument(user.incomeDocumentUrl);
            const validation = await validateIncomeDocument(
                buffer,
                user.firstName ?? "",
                user.lastName ?? "",
                mimeType,
            );
            const isVerified = validation.isValid && !validation.requiresManualReview;

            return {
                key: "INCOME",
                label: "Income OCR lookup",
                status: isVerified ? "SUCCESS" : "FAILED",
                provider: "OCR",
                providerRef: null,
                summary: {
                    verified: isVerified,
                    confidence: validation.confidence ?? null,
                    expectedName: [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null,
                    nameMatches: validation.matchedName ?? null,
                    requiresManualReview: validation.requiresManualReview ?? null,
                    documentDate: validation.documentDate ?? null,
                    isRecent: validation.isRecent ?? null,
                    textExcerpt: this.buildLookupTextExcerpt(validation.extractedText),
                    reason: validation.reason ?? null,
                },
                rawResponse: validation,
                documentUrl: user.incomeDocumentUrl,
                lookedUpAt,
            };
        } catch (error) {
            return this.buildLookupErrorResult("INCOME", "Income OCR lookup", lookedUpAt, error, user.incomeDocumentUrl, "OCR");
        }
    }

    private async runBusinessDocumentLookup(user: any, lookedUpAt: string): Promise<AdminKycLookupResult[]> {
        const businessName = user.businessRecord?.businessName ?? "";
        const expectedName = this.normalizeLookupText(businessName);
        const businessDocument = user.businessDocument;
        const businessResults: AdminKycLookupResult[] = [];

        if (businessDocument?.cacDocumentNumber) {
            businessResults.push(await this.lookupBusinessCacResult(businessDocument.cacDocumentNumber, businessName, expectedName, lookedUpAt));
        }

        if (user.businessRecord?.taxIdentificationNumber) {
            businessResults.push(await this.lookupBusinessTinResult(user.businessRecord.taxIdentificationNumber, businessName, expectedName, lookedUpAt));
        }

        if (businessDocument?.cacImageUrl) {
            businessResults.push(
                await this.lookupBusinessOcrResult(
                    businessDocument.cacImageUrl,
                    businessDocument.cacDocumentNumber,
                    lookedUpAt,
                ),
            );
        }

        if (businessResults.length === 0) {
            throw new BadRequestException("This business user does not have stored business verification artifacts to recheck");
        }

        return businessResults;
    }

    private async lookupBusinessCacResult(
        cacDocumentNumber: string,
        businessName: string,
        expectedName: string,
        lookedUpAt: string,
    ): Promise<AdminKycLookupResult> {
        return this.runBusinessRegistryLookup({
            identifier: cacDocumentNumber,
            businessName,
            expectedName,
            lookedUpAt,
            key: "CAC",
            label: "CAC lookup",
            request: () => this.dojahService.lookupCAC(cacDocumentNumber),
            providerNameField: "company_name",
            extraSummary: (entity) => ({
                companyStatus: entity.company_status ?? null,
                registrationDate: entity.registration_date ?? null,
            }),
        });
    }

    private async lookupBusinessTinResult(
        taxIdentificationNumber: string,
        businessName: string,
        expectedName: string,
        lookedUpAt: string,
    ): Promise<AdminKycLookupResult> {
        return this.runBusinessRegistryLookup({
            identifier: taxIdentificationNumber,
            businessName,
            expectedName,
            lookedUpAt,
            key: "TIN",
            label: "TIN verification",
            request: () => this.dojahService.verifyTIN(taxIdentificationNumber),
            providerNameField: "taxpayer_name",
        });
    }

    private async lookupBusinessOcrResult(
        cacImageUrl: string,
        cacDocumentNumber: string | null | undefined,
        lookedUpAt: string,
    ): Promise<AdminKycLookupResult> {
        try {
            const analysis = await this.dojahService.analyzeDocument({
                imageFrontSide: cacImageUrl,
                inputType: "url",
            });

            const parsed = (analysis?.parsed ?? {}) as DojahParsedDocument;
            const analysisEntity = (analysis?.response?.data?.entity ?? {}) as DojahLookupEntity;
            const extractedName = [parsed.firstName, parsed.lastName].filter(Boolean).join(" ").trim() || null;
            const extractedNumber = parsed.documentNumber ?? null;
            const numberMatches = extractedNumber && cacDocumentNumber
                ? this.normalizeLookupText(extractedNumber) === this.normalizeLookupText(cacDocumentNumber)
                : null;

            return {
                key: "CAC_OCR",
                label: "CAC document OCR",
                status: parsed.isValid ? "SUCCESS" : "FAILED",
                provider: "DOJAH",
                providerRef: analysisEntity.reference_id ?? null,
                summary: {
                    verified: parsed.isValid ?? false,
                    expectedCacNumber: cacDocumentNumber ?? null,
                    providerCacNumber: extractedNumber,
                    providerName: extractedName,
                    extractedNumber,
                    extractedName,
                    numberMatches,
                },
                rawResponse: analysis?.response?.data ?? analysis ?? null,
                documentUrl: cacImageUrl,
                lookedUpAt,
            };
        } catch (error) {
            return this.buildLookupErrorResult("CAC_OCR", "CAC document OCR", lookedUpAt, error, cacImageUrl);
        }
    }

    private buildAttemptDetailsByVerificationType(params: {
        user: any;
        attemptHistory: AdminKycAttemptSummary[];
        currentAttemptByVerificationType: Record<string, AdminKycAttemptSummary>;
        attemptRecordByVerificationType: Record<string, any>;
        auditLogs: any[];
    }): Record<string, AdminKycAttemptDetail> {
        const { user, attemptHistory, currentAttemptByVerificationType, attemptRecordByVerificationType, auditLogs } = params;
        const details: Record<string, AdminKycAttemptDetail> = {};
        const attemptEvents = user.kycAttemptEvents ?? [];

        for (const verificationType of ["BVN", "NIN", "DOCUMENT", "ADDRESS", "INCOME", "BUSINESS_DOCUMENT"]) {
            const attempt = currentAttemptByVerificationType[verificationType]
                ?? attemptHistory.find((candidate) => candidate.verificationType === verificationType)
                ?? null;
            const lookupHistory = this.buildAttemptLookupHistory(attemptEvents, verificationType as AdminKycProviderLookupType);
            const decisionHistory = this.buildAttemptDecisionHistory(attemptEvents, auditLogs, verificationType);
            const detail = this.buildAttemptDetail({
                verificationType,
                user,
                attempt,
                attemptRecord: attemptRecordByVerificationType[verificationType] ?? null,
                attemptEvents,
                lookupHistory,
                decisionHistory,
            });

            if (detail) {
                details[verificationType] = detail;
            }
        }

        return details;
    }

    private mergeStructuredSummary(
        fallbackSummary: Record<string, any> | null,
        currentSummary: Record<string, any> | null,
    ): Record<string, any> | null {
        if (fallbackSummary && currentSummary) {
            return {
                ...fallbackSummary,
                ...currentSummary,
            };
        }

        return currentSummary ?? fallbackSummary;
    }

    private buildAttemptDetail(params: {
        verificationType: string;
        user: any;
        attempt: AdminKycAttemptSummary | null;
        attemptRecord: any;
        attemptEvents: any[];
        lookupHistory: AdminKycAttemptLookupHistoryItem[];
        decisionHistory: AdminKycAttemptDecisionHistoryItem[];
    }): AdminKycAttemptDetail | null {
        const { verificationType, user, attempt, attemptRecord, attemptEvents, lookupHistory, decisionHistory } = params;
        const hasLegacyEvidence = this.hasLegacyAttemptEvidence(verificationType, user);
        const useLegacyFallbackValues = !this.isStageManagedVerificationType(verificationType) || !this.isStageAttemptRecord(attemptRecord);

        if (!attempt && lookupHistory.length === 0 && !hasLegacyEvidence) {
            return null;
        }

        const latestLookupResults = lookupHistory[0]?.results ?? [];
        const attemptExtractedFields = this.getAttemptStructuredRecord(attemptRecord?.extractedFields);
        const attemptComparisonSummary = this.getAttemptStructuredRecord(attemptRecord?.comparisonSummary);
        const attemptEvidenceSummary = this.buildAttemptStructuredEvidenceSummary(verificationType, attemptRecord);
        const fallbackExtractedFields = useLegacyFallbackValues
            ? this.buildFallbackAttemptExtractedFields(verificationType, user)
            : null;
        const fallbackComparisonSummary = useLegacyFallbackValues
            ? this.buildFallbackAttemptComparisonSummary(verificationType, user)
            : null;
        const fallbackEvidenceSummary = this.buildFallbackAttemptEvidenceSummary(verificationType, user);

        return {
            attempt,
            extractedFields: this.buildAttemptExtractedFieldsFromLookupResults(latestLookupResults)
                ?? this.mergeStructuredSummary(fallbackExtractedFields, attemptExtractedFields),
            comparisonSummary: this.buildAttemptComparisonSummaryFromLookupResults(latestLookupResults)
                ?? this.mergeStructuredSummary(fallbackComparisonSummary, attemptComparisonSummary),
            evidenceSummary: this.buildAttemptEvidenceSummaryFromLookupResults(verificationType, latestLookupResults)
                ?? this.mergeStructuredSummary(fallbackEvidenceSummary, attemptEvidenceSummary),
            rawProviderResponse: this.resolveAttemptRawProviderResponse(
                verificationType,
                user,
                latestLookupResults,
                attemptRecord,
                attemptEvents,
                attempt?.attemptId ?? null,
            ),
            rawEvidence: this.buildAttemptRawEvidence(verificationType, user, attempt?.attemptId ?? 0, attemptRecord),
            lookupHistory,
            decisionHistory,
        };
    }

    private buildAttemptLookupHistory(
        attemptEvents: any[],
        verificationType: AdminKycProviderLookupType,
    ): AdminKycAttemptLookupHistoryItem[] {
        return this.buildAttemptLookupHistoryFromEvents(attemptEvents, verificationType);
    }

    private buildAttemptLookupHistoryFromEvents(
        attemptEvents: any[],
        verificationType: AdminKycProviderLookupType,
    ): AdminKycAttemptLookupHistoryItem[] {
        return attemptEvents
            .map((event) => ({
                event,
                payload: this.getPersistedLookupHistoryPayload(event.payload),
            }))
            .filter((entry) => entry.payload?.lookupType === verificationType)
            .map(({ event, payload }) => {
                if (!payload) {
                    return null;
                }

                let historyRecordId = event.id;
                if (typeof payload.legacyHistoryRecordId === "number") {
                    historyRecordId = payload.legacyHistoryRecordId;
                }

                return {
                    historyRecordId,
                    outcome: payload.outcome,
                    lookedUpAt: payload.lookedUpAt,
                    requestedByAdminId: payload.requestedByAdminId ?? (event.actorType === "ADMIN" ? event.actorId ?? null : null),
                    note: event.note ?? null,
                    results: payload.results,
                };
            })
            .filter((entry): entry is AdminKycAttemptLookupHistoryItem => Boolean(entry))
            .sort((left, right) => new Date(right.lookedUpAt).getTime() - new Date(left.lookedUpAt).getTime());
    }

    private buildAttemptDecisionHistory(
        attemptEvents: any[],
        auditLogs: any[],
        verificationType: string,
    ): AdminKycAttemptDecisionHistoryItem[] {
        const eventHistory = this.buildAttemptDecisionHistoryFromEvents(attemptEvents, verificationType);
        const auditHistory = auditLogs
            .filter((entry) => entry.details?.verificationType === verificationType && typeof entry.action === "string" && entry.action.startsWith("KYC_"))
            .map((entry) => ({
                action: entry.action,
                note: entry.details?.note ?? null,
                adminId: entry.adminId ?? null,
                createdAt: entry.createdAt,
            }));

        if (eventHistory.length === 0) {
            return auditHistory;
        }

        const mergedHistory = [...eventHistory];
        for (const auditEntry of auditHistory) {
            if (!eventHistory.some((eventEntry) => this.isDuplicateDecisionHistoryEntry(eventEntry, auditEntry))) {
                mergedHistory.push(auditEntry);
            }
        }

        return mergedHistory.sort(
            (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
        );
    }

    private buildAttemptDecisionHistoryFromEvents(
        attemptEvents: any[],
        verificationType: string,
    ): AdminKycAttemptDecisionHistoryItem[] {
        return attemptEvents
            .map((event) => ({
                event,
                payload: this.getPersistedDecisionEventPayload(event.payload),
                verificationType: this.resolveAttemptEventVerificationType(event),
            }))
            .filter((entry) => entry.verificationType === verificationType && this.isDecisionEventType(entry.event.eventType))
            .map(({ event, payload }) => ({
                action: payload?.auditAction ?? this.mapDecisionEventTypeToAuditAction(event.eventType),
                note: event.note ?? payload?.note ?? null,
                adminId: event.actorType === "ADMIN" ? event.actorId ?? null : null,
                createdAt: event.createdAt,
            }))
            .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    }

    private isDuplicateDecisionHistoryEntry(
        left: AdminKycAttemptDecisionHistoryItem,
        right: AdminKycAttemptDecisionHistoryItem,
    ): boolean {
        if (left.action !== right.action || left.note !== right.note) {
            return false;
        }

        const adminIdsMatch = left.adminId === right.adminId
            || left.adminId === null
            || right.adminId === null;

        if (!adminIdsMatch) {
            return false;
        }

        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();
        return Math.abs(leftTime - rightTime) < 5000;
    }

    private isDecisionEventType(eventType: string): boolean {
        return ["APPROVED", "REJECTED", "ESCALATED"].includes(eventType);
    }

    private mapDecisionEventTypeToAuditAction(eventType: string): string {
        switch (eventType) {
            case "APPROVED":
                return "KYC_APPROVE";
            case "REJECTED":
                return "KYC_REJECT";
            case "ESCALATED":
                return "KYC_ESCALATE";
            default:
                return `KYC_${eventType}`;
        }
    }

    private buildAdminAuditHistory(
        attemptEvents: any[],
        auditLogs: any[],
    ): AdminKycAuditHistoryItem[] {
        const eventHistory = attemptEvents
            .map((event) => this.mapAttemptEventToAuditHistoryItem(event))
            .filter((entry): entry is AdminKycAuditHistoryItem => Boolean(entry));
        const auditHistory = auditLogs.map((entry) => this.mapAuditLogToAdminHistoryItem(entry));

        if (eventHistory.length === 0) {
            return auditHistory;
        }

        const mergedHistory = [...eventHistory];
        for (const auditEntry of auditHistory) {
            if (!eventHistory.some((eventEntry) => this.isDuplicateAdminAuditHistoryEntry(eventEntry, auditEntry))) {
                mergedHistory.push(auditEntry);
            }
        }

        return mergedHistory.sort(
            (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
        );
    }

    private mapAttemptEventToAuditHistoryItem(event: any): AdminKycAuditHistoryItem | null {
        const lookupPayload = this.getPersistedLookupHistoryPayload(event?.payload);
        const decisionPayload = this.getPersistedDecisionEventPayload(event?.payload);
        let action: string | null = null;

        if (event?.eventType === "ADMIN_RECHECK" || lookupPayload) {
            action = "KYC_PROVIDER_LOOKUP";
        } else if (this.isDecisionEventType(event?.eventType)) {
            action = decisionPayload?.auditAction ?? this.mapDecisionEventTypeToAuditAction(event.eventType);
        }

        if (!action) {
            return null;
        }

        return {
            source: "ATTEMPT_EVENT",
            action,
            verificationType: this.resolveAttemptEventVerificationType(event),
            eventType: typeof event?.eventType === "string" ? event.eventType : null,
            attemptId: typeof event?.attemptId === "number" ? event.attemptId : null,
            adminId: event?.actorType === "ADMIN" ? event.actorId ?? null : null,
            note: event?.note ?? decisionPayload?.note ?? null,
            createdAt: event.createdAt,
        };
    }

    private mapAuditLogToAdminHistoryItem(entry: any): AdminKycAuditHistoryItem {
        return {
            source: "AUDIT_LOG",
            action: entry.action,
            verificationType: entry.details?.verificationType ?? null,
            eventType: null,
            attemptId: typeof entry.details?.attemptId === "number" ? entry.details.attemptId : null,
            adminId: entry.adminId ?? null,
            note: entry.details?.note ?? null,
            createdAt: entry.createdAt,
        };
    }

    private isDuplicateAdminAuditHistoryEntry(
        left: AdminKycAuditHistoryItem,
        right: AdminKycAuditHistoryItem,
    ): boolean {
        if (left.action !== right.action || left.verificationType !== right.verificationType) {
            return false;
        }

        const notesMatch = left.note === right.note || left.note === null || right.note === null;
        const adminIdsMatch = left.adminId === right.adminId || left.adminId === null || right.adminId === null;

        if (!notesMatch || !adminIdsMatch) {
            return false;
        }

        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();
        return Math.abs(leftTime - rightTime) < 5000;
    }

    private buildLatestAttemptActivityIndex(attemptEvents: any[]): Map<number, AdminKycAuditHistoryItem> {
        const latestActivityByAttemptId = new Map<number, AdminKycAuditHistoryItem>();

        for (const historyItem of this.buildAdminAuditHistory(attemptEvents, [])) {
            if (typeof historyItem.attemptId !== "number") {
                continue;
            }

            if (!latestActivityByAttemptId.has(historyItem.attemptId)) {
                latestActivityByAttemptId.set(historyItem.attemptId, historyItem);
            }
        }

        return latestActivityByAttemptId;
    }

    private attachLatestAttemptActivity(
        attempt: AdminKycAttemptSummary,
        latestActivityByAttemptId: Map<number, AdminKycAuditHistoryItem>,
    ): AdminKycAttemptSummary {
        const latestActivity = latestActivityByAttemptId.get(attempt.attemptId);
        if (!latestActivity) {
            return attempt;
        }

        return {
            ...attempt,
            latestActivityAt: latestActivity.createdAt,
            latestActivityType: latestActivity.eventType ?? latestActivity.action,
            latestActivityNote: latestActivity.note,
            latestActivityAdminId: latestActivity.adminId,
        };
    }

    private buildAttemptRawEvidence(
        verificationType: string,
        user: any,
        attemptId: number,
        attemptRecord?: any,
    ): AdminKycAttemptEvidenceItem[] {
        if (this.isStageAttemptRecord(attemptRecord) && Array.isArray(attemptRecord.evidenceAssets) && attemptRecord.evidenceAssets.length > 0) {
            return attemptRecord.evidenceAssets.map((asset: any, index: number) => ({
                id: asset.id ?? (attemptId * 10 + index + 1),
                kind: this.mapStageEvidenceKindToAdminKind(verificationType, asset.kind, asset.side),
                label: this.getStageEvidenceLabel(verificationType, asset.kind, asset.side),
                url: asset.storageUrl,
                mimeType: asset.mimeType ?? null,
            }));
        }

        switch (verificationType) {
            case "DOCUMENT":
                return [
                    user.userDocument?.documentImageUrl
                        ? {
                            id: attemptId * 10 + 1,
                            kind: "DOCUMENT_FRONT",
                            label: "Identity document front",
                            url: user.userDocument.documentImageUrl,
                            mimeType: null,
                        }
                        : null,
                    user.userDocument?.documentImageUrl2
                        ? {
                            id: attemptId * 10 + 2,
                            kind: "DOCUMENT_BACK",
                            label: "Identity document back",
                            url: user.userDocument.documentImageUrl2,
                            mimeType: null,
                        }
                        : null,
                ].filter(Boolean) as AdminKycAttemptEvidenceItem[];
            case "ADDRESS":
                return user.addressDocumentUrl
                    ? [{ id: attemptId * 10 + 1, kind: "ADDRESS_DOCUMENT", label: "Address document", url: user.addressDocumentUrl, mimeType: null }]
                    : [];
            case "INCOME":
                return user.incomeDocumentUrl
                    ? [{ id: attemptId * 10 + 1, kind: "INCOME_DOCUMENT", label: "Income document", url: user.incomeDocumentUrl, mimeType: null }]
                    : [];
            case "BUSINESS_DOCUMENT":
                return [
                    ["CAC_DOCUMENT", "CAC Certificate", user.businessDocument?.cacImageUrl],
                    ["AOA_DOCUMENT", "Articles of Association", user.businessDocument?.articleOfAssociationImageUrl],
                    ["BOARD_RESOLUTION", "Board Resolution", user.businessDocument?.boardResolutionAuthorizedAcctOpeningImageUrl],
                    ["BENEFICIAL_OWNER_ADDRESS", "Beneficial Owner Address", user.businessDocument?.proofOfAddressForBeneficialOwner],
                    ["BENEFICIAL_OWNER_ID", "Beneficial Owner ID", user.businessDocument?.meansOfIdentificationForBeneficialOwner],
                ]
                    .filter(([, , url]) => Boolean(url))
                    .map(([kind, label, url], index) => ({
                        id: attemptId * 10 + index + 1,
                        kind,
                        label,
                        url: url as string,
                        mimeType: null,
                    }));
            default:
                return [];
        }
    }

    private buildAttemptExtractedFieldsFromLookupResults(results: AdminKycLookupResult[]): Record<string, any> | null {
        if (results.length === 0) {
            return null;
        }

        if (results.length === 1) {
            return results[0].summary ?? null;
        }

        return results.reduce<Record<string, any>>((accumulator, result) => {
            accumulator[result.key] = result.summary;
            return accumulator;
        }, {});
    }

    private buildAttemptComparisonSummaryFromLookupResults(results: AdminKycLookupResult[]): Record<string, any> | null {
        if (results.length === 0) {
            return null;
        }

        if (results.length === 1) {
            return results[0].summary ?? null;
        }

        return results.reduce<Record<string, any>>((accumulator, result) => ({
            ...accumulator,
            ...result.summary,
            [`${result.key}Status`]: result.status,
        }), {
            verified: results.every((result) => result.status === "SUCCESS"),
            lookupCount: results.length,
        });
    }

    private buildAttemptEvidenceSummaryFromLookupResults(
        verificationType: string,
        results: AdminKycLookupResult[],
    ): Record<string, any> | null {
        if (results.length === 0) {
            return null;
        }

        if (results.length === 1) {
            return {
                verificationType,
                provider: results[0].provider,
                providerStatus: results[0].status,
                providerRef: results[0].providerRef ?? null,
                documentUrl: results[0].documentUrl ?? null,
                ...results[0].summary,
            };
        }

        return {
            verificationType,
            providerStatus: this.resolveLookupOutcomeFromResults(results),
            providerRefs: results.map((result) => result.providerRef).filter(Boolean),
            documentUrls: results.map((result) => result.documentUrl).filter(Boolean),
            lookupCount: results.length,
            ...this.buildAttemptComparisonSummaryFromLookupResults(results),
        };
    }

    private buildFallbackAttemptExtractedFields(
        verificationType: string,
        user: any,
    ): Record<string, any> | null {
        switch (verificationType) {
            case "DOCUMENT":
                return {
                    firstName: user.userDocument?.dojahExtractedFirstName ?? null,
                    lastName: user.userDocument?.dojahExtractedLastName ?? null,
                    dateOfBirth: user.userDocument?.dojahExtractedDob ?? null,
                    documentType: user.userDocument?.dojahDocumentType ?? user.userDocument?.type ?? null,
                    documentNumber: user.userDocument?.dojahExtractedDocNumber ?? null,
                    expiryDate: user.userDocument?.dojahExtractedExpiryDate ?? null,
                };
            case "BUSINESS_DOCUMENT":
                return {
                    cacCompanyName: user.businessDocument?.cacCompanyName ?? null,
                    tinTaxpayerName: user.businessDocument?.tinTaxpayerName ?? null,
                    cacOcrExtractedNumber: user.businessDocument?.cacOcrExtractedNumber ?? null,
                    cacOcrExtractedName: user.businessDocument?.cacOcrExtractedName ?? null,
                };
            case "ADDRESS":
                return user.residentialAddress ? { residentialAddress: user.residentialAddress } : null;
            default:
                return null;
        }
    }

    private buildFallbackAttemptComparisonSummary(
        verificationType: string,
        user: any,
    ): Record<string, any> | null {
        const expectedName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
        const extractedName = [user.userDocument?.dojahExtractedFirstName, user.userDocument?.dojahExtractedLastName]
            .filter(Boolean)
            .join(" ")
            .trim() || null;

        switch (verificationType) {
            case "DOCUMENT":
                return {
                    expectedName,
                    providerName: extractedName,
                    nameMatches: user.userDocument?.dojahNameMatches ?? null,
                    expectedDateOfBirth: user.dateOfBirth ?? null,
                    providerDateOfBirth: user.userDocument?.dojahExtractedDob ?? null,
                    expectedDocumentType: user.userDocument?.type ?? null,
                    providerDocumentType: user.userDocument?.dojahDocumentType ?? null,
                    expectedDocumentNumber: user.userDocument?.documentNumber ?? null,
                    providerDocumentNumber: user.userDocument?.dojahExtractedDocNumber ?? null,
                };
            case "ADDRESS":
                return {
                    expectedName,
                    expectedAddress: user.residentialAddress ?? null,
                };
            case "INCOME":
                return {
                    expectedName,
                };
            case "BUSINESS_DOCUMENT":
                return {
                    expectedCompanyName: user.businessRecord?.businessName ?? null,
                    providerCompanyName: user.businessDocument?.cacCompanyName ?? null,
                    providerTaxpayerName: user.businessDocument?.tinTaxpayerName ?? null,
                    nameMatches: user.businessDocument?.cacNameMatches ?? user.businessDocument?.tinNameMatches ?? null,
                    expectedCacNumber: user.businessDocument?.cacDocumentNumber ?? null,
                    providerCacNumber: user.businessDocument?.cacOcrExtractedNumber ?? null,
                    numberMatches: user.businessDocument?.cacOcrNumberMatches ?? null,
                };
            default:
                return null;
        }
    }

    private buildFallbackAttemptEvidenceSummary(
        verificationType: string,
        user: any,
    ): Record<string, any> | null {
        const normalizedUser = this.normalizeVerificationState(user);
        const { verificationSnapshot } = normalizedUser;

        switch (verificationType) {
            case "BVN":
                return { verified: verificationSnapshot.bvnVerified };
            case "NIN":
                return { verified: verificationSnapshot.ninVerified };
            case "DOCUMENT":
                return {
                    verified: normalizedUser.documentVerified,
                    documentType: normalizedUser.userDocument?.type ?? null,
                    documentNumber: normalizedUser.userDocument?.documentNumber ?? null,
                    countryCode: normalizedUser.userDocument?.dojahCountryCode ?? null,
                    extractedExpiryDate: normalizedUser.userDocument?.dojahExtractedExpiryDate ?? null,
                };
            case "ADDRESS":
                return {
                    verified: verificationSnapshot.addressVerified,
                    status: verificationSnapshot.addressStatus ?? null,
                    residentialAddress: user.residentialAddress ?? null,
                    documentUrl: user.addressDocumentUrl ?? null,
                };
            case "INCOME":
                return {
                    verified: verificationSnapshot.incomeVerified,
                    status: verificationSnapshot.incomeStatus ?? null,
                    documentUrl: user.incomeDocumentUrl ?? null,
                };
            case "BUSINESS_DOCUMENT":
                return {
                    verified: false,
                    status: null,
                    businessName: user.businessRecord?.businessName ?? null,
                    taxIdentificationNumber: user.businessRecord?.taxIdentificationNumber ?? null,
                    cacDocumentNumber: user.businessDocument?.cacDocumentNumber ?? null,
                };
            default:
                return null;
        }
    }

    private getAttemptStructuredRecord(value: unknown): Record<string, any> | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }

        return value as Record<string, any>;
    }

    private buildAttemptStructuredEvidenceSummary(
        verificationType: string,
        attemptRecord: any,
    ): Record<string, any> | null {
        if (!this.isStageAttemptRecord(attemptRecord)) {
            return null;
        }

        const summary = this.getAttemptStructuredRecord(attemptRecord.evidenceSummary);
        const documentUrls = Array.isArray(attemptRecord.evidenceAssets)
            ? attemptRecord.evidenceAssets.map((asset: any) => asset.storageUrl).filter(Boolean)
            : [];

        if (!summary && documentUrls.length === 0) {
            return null;
        }

        const structuredSummary: Record<string, any> = {
            verificationType,
            providerStatus: attemptRecord.providerStatus ?? null,
            reasonCode: attemptRecord.reasonCode ?? null,
            reasonMessage: attemptRecord.reasonMessage ?? null,
        };

        if (summary) {
            Object.assign(structuredSummary, summary);
        }

        if (documentUrls.length === 1) {
            structuredSummary.documentUrl = documentUrls[0];
        } else if (documentUrls.length > 1) {
            structuredSummary.documentUrls = documentUrls;
        }

        return structuredSummary;
    }

    private resolveAttemptRawProviderResponse(
        verificationType: string,
        user: any,
        latestLookupResults: AdminKycLookupResult[],
        attemptRecord: any,
        attemptEvents: any[],
        attemptId?: number | null,
    ): any {
        if (latestLookupResults.length === 1) {
            return latestLookupResults[0].rawResponse ?? null;
        }

        if (latestLookupResults.length > 1) {
            return latestLookupResults.map((result) => ({
                key: result.key,
                label: result.label,
                status: result.status,
                provider: result.provider,
                rawResponse: result.rawResponse,
            }));
        }

        const importedLegacyProviderResponse = this.getImportedLegacyProviderResponse(attemptEvents, attemptId);

        if (this.isStageAttemptRecord(attemptRecord)) {
            if (importedLegacyProviderResponse !== null && importedLegacyProviderResponse !== undefined) {
                return importedLegacyProviderResponse;
            }

            return this.getAttemptStructuredRecord(attemptRecord.reasonDetails)
                ?? this.getAttemptStructuredRecord(attemptRecord.comparisonSummary)
                ?? null;
        }

        switch (verificationType) {
            case "DOCUMENT":
                return user.userDocument?.dojahRawResponse ?? null;
            case "BUSINESS_DOCUMENT":
                return {
                    cac: user.businessDocument?.cacRawResponse ?? null,
                    tin: user.businessDocument?.tinRawResponse ?? null,
                    cacOcr: user.businessDocument?.cacOcrRawResponse ?? null,
                };
            default:
                return importedLegacyProviderResponse ?? null;
        }
    }

    private hasLegacyAttemptEvidence(verificationType: string, user: any): boolean {
        switch (verificationType) {
            case "BVN":
                return Boolean(user.bvn);
            case "NIN":
                return Boolean(user.nin);
            case "DOCUMENT":
                return Boolean(user.userDocument);
            case "ADDRESS":
                return Boolean(user.addressDocumentUrl);
            case "INCOME":
                return Boolean(user.incomeDocumentUrl);
            case "BUSINESS_DOCUMENT":
                return Boolean(user.businessDocument);
            default:
                return false;
        }
    }

    private getPersistedLookupHistoryPayload(payload: unknown): PersistedAdminLookupHistoryPayload | null {
        if (!payload) {
            return null;
        }

        let candidate = payload as any;
        if (typeof candidate === "string") {
            try {
                candidate = JSON.parse(candidate);
            } catch {
                return null;
            }
        }

        if (!candidate || typeof candidate !== "object") {
            return null;
        }

        if (candidate.source !== "ADMIN_PROVIDER_LOOKUP" || !candidate.lookupType || !Array.isArray(candidate.results)) {
            return null;
        }

        return candidate as PersistedAdminLookupHistoryPayload;
    }

    private getPersistedDecisionEventPayload(payload: unknown): PersistedAdminDecisionEventPayload | null {
        if (!payload) {
            return null;
        }

        let candidate = payload as any;
        if (typeof candidate === "string") {
            try {
                candidate = JSON.parse(candidate);
            } catch {
                return null;
            }
        }

        if (!candidate || typeof candidate !== "object") {
            return null;
        }

        if (candidate.source !== "ADMIN_DECISION" || !candidate.verificationType || !candidate.action || !candidate.auditAction) {
            return null;
        }

        return candidate as PersistedAdminDecisionEventPayload;
    }

    private resolveAttemptEventVerificationType(event: any): string | null {
        const lookupPayload = this.getPersistedLookupHistoryPayload(event?.payload);
        if (lookupPayload?.lookupType) {
            return lookupPayload.lookupType;
        }

        const decisionPayload = this.getPersistedDecisionEventPayload(event?.payload);
        if (decisionPayload?.verificationType) {
            return decisionPayload.verificationType;
        }

        if (typeof event?.stage === "string" && event.stage !== "GOVERNMENT_ID") {
            return this.mapStageAttemptToVerificationType(event.stage);
        }

        return null;
    }

    private resolveLookupOutcomeFromResults(results: AdminKycLookupResult[]): AdminLookupOutcome {
        if (results.length === 0) {
            return "FAILED";
        }

        const hasSuccess = results.some((result) => result.status === "SUCCESS");
        const allSuccessful = results.every((result) => result.status === "SUCCESS");

        if (allSuccessful) {
            return "SUCCESS";
        }

        if (hasSuccess) {
            return "PARTIAL_FAILURE";
        }

        return "FAILED";
    }

    private async getAttemptSummaryById(
        attemptId: number,
        verificationType?: string,
    ): Promise<AdminKycAttemptSummary | null> {
        const stagedAttempt = await this.findStageAttemptById(attemptId);
        if (stagedAttempt) {
            const resolvedVerificationType = this.mapStageAttemptToVerificationType(stagedAttempt.stage, stagedAttempt.method);
            if (!verificationType || verificationType === resolvedVerificationType) {
                return this.buildAdminAttemptSummary(stagedAttempt);
            }
        }

        return null;
    }

    private async resolveAttemptContext(
        attemptId: number,
        verificationType?: string,
    ): Promise<{
        attemptId: number;
        userId: number;
        verificationType: string;
        stage: string;
    } | null> {
        const stagedAttempt = await this.findStageAttemptById(attemptId);
        if (stagedAttempt) {
            const resolvedVerificationType = this.mapStageAttemptToVerificationType(stagedAttempt.stage, stagedAttempt.method);
            if (!verificationType || resolvedVerificationType === verificationType) {
                return {
                    attemptId: stagedAttempt.id,
                    userId: stagedAttempt.userId,
                    verificationType: resolvedVerificationType,
                    stage: stagedAttempt.stage,
                };
            }
        }

        return null;
    }

    private async findStageAttemptById(attemptId: number): Promise<StageAttemptLookupRecord | null> {
        return await this.prisma.kycStageAttempt.findUnique({
            where: { id: attemptId },
            select: stageAttemptLookupSelect,
        });
    }

    private buildAdminAttemptNextAction(status?: string | null, stage?: string | null): {
        type: "WAIT" | "COMPLETE" | "RESUBMIT";
        stage: string | null | undefined;
        label: string;
        message: string;
    } {
        if (status === "APPROVED") {
            return {
                type: "COMPLETE",
                stage,
                label: "Completed",
                message: "No further action is required.",
            };
        }

        if (status === "PENDING" || status === "ESCALATED") {
            return {
                type: "WAIT",
                stage,
                label: "Await review",
                message: "Awaiting an admin review decision.",
            };
        }

        return {
            type: "RESUBMIT",
            stage,
            label: "Resubmit",
            message: "Another submission is required before review can continue.",
        };
    }

    private ensureLookupProviderSupported(provider: AdminLookupProvider, verificationType: string): void {
        const supportedProviders: Record<string, AdminLookupProvider[]> = {
            BVN: ["DOJAH"],
            NIN: ["DOJAH"],
            DOCUMENT: ["DOJAH"],
            ADDRESS: ["OCR"],
            INCOME: ["OCR"],
            BUSINESS_DOCUMENT: ["DOJAH", "OCR"],
        };

        if (!supportedProviders[verificationType]?.includes(provider)) {
            throw new BadRequestException(`Provider ${provider} is not supported for ${verificationType} rechecks`);
        }
    }

    private buildLookupErrorResult(
        key: string,
        label: string,
        lookedUpAt: string,
        error: unknown,
        documentUrl?: string | null,
        provider: AdminLookupProvider = "DOJAH",
    ): AdminKycLookupResult {
        const message = error instanceof Error ? error.message : "Provider lookup failed";
        return {
            key,
            label,
            status: "FAILED",
            provider,
            providerRef: null,
            summary: {
                verified: false,
                error: message,
            },
            rawResponse: { error: message },
            documentUrl,
            lookedUpAt,
        };
    }

    private buildIdentityLookupSummary(user: any, entity: DojahLookupEntity): Record<string, string | boolean | null> {
        const expectedName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
        const providerName = [entity.first_name, entity.last_name].filter(Boolean).join(" ").trim() || null;
        const nameMatches = expectedName && providerName
            ? this.normalizeLookupText(providerName) === this.normalizeLookupText(expectedName)
            : null;
        const expectedDateOfBirth = user.dateOfBirth ?? null;
        const providerDateOfBirth = entity.date_of_birth ?? null;
        const dobMatches = expectedDateOfBirth && providerDateOfBirth
            ? this.normalizeLookupDate(providerDateOfBirth) === this.normalizeLookupDate(expectedDateOfBirth)
            : null;
        const expectedPhoneNumber = user.phone ?? null;
        const providerPhoneNumber = entity.phone_number1 ?? entity.phone_number ?? null;
        const phoneMatches = expectedPhoneNumber && providerPhoneNumber
            ? this.normalizeLookupPhone(providerPhoneNumber) === this.normalizeLookupPhone(expectedPhoneNumber)
            : null;

        return {
            expectedName,
            providerName,
            nameMatches,
            expectedDateOfBirth,
            providerDateOfBirth,
            dobMatches,
            expectedPhoneNumber,
            providerPhoneNumber,
            phoneMatches,
        };
    }

    private buildLookupTextExcerpt(value?: string | null, maxLength = 180): string | null {
        if (!value) {
            return null;
        }

        const normalized = value.replaceAll(/\s+/g, " ").trim();
        if (!normalized) {
            return null;
        }

        return normalized.length > maxLength
            ? `${normalized.slice(0, maxLength).trimEnd()}...`
            : normalized;
    }

    private normalizeLookupText(value?: string | null): string {
        return String(value ?? "")
            .toLowerCase()
            .replaceAll(/[^a-z0-9]/g, "");
    }

    private normalizeLookupDate(value?: string | null): string {
        if (!value) {
            return "";
        }

        const parsedDate = new Date(value);
        if (!Number.isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString().slice(0, 10);
        }

        return String(value).replaceAll(/\D/g, "").slice(0, 8);
    }

    private normalizeLookupPhone(value?: string | null): string {
        const digits = String(value ?? "").replaceAll(/\D/g, "");
        return digits.length > 10 ? digits.slice(-10) : digits;
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

        trustedOrigins.add("https://ik.imagekit.io");

        return trustedOrigins;
    }

    private resolveTrustedDocumentSource(trustedUrl: URL): { hostname: string; port?: number; pathPrefix?: string } | null {
        if (imagekitConfig.url) {
            try {
                const configuredImagekitUrl = new URL(imagekitConfig.url);
                const configuredPathPrefix = configuredImagekitUrl.pathname === "/"
                    ? undefined
                    : configuredImagekitUrl.pathname.replace(/\/+$/, "");

                if (
                    trustedUrl.origin === configuredImagekitUrl.origin
                    && (!configuredPathPrefix || trustedUrl.pathname === configuredPathPrefix || trustedUrl.pathname.startsWith(`${configuredPathPrefix}/`))
                ) {
                    return {
                        hostname: configuredImagekitUrl.hostname,
                        port: configuredImagekitUrl.port ? Number(configuredImagekitUrl.port) : undefined,
                        pathPrefix: configuredPathPrefix,
                    };
                }
            } catch {
                // The invalid config warning is emitted by getTrustedDocumentOrigins().
            }
        }

        if (
            cloudinaryConfig.cloud_name
            && trustedUrl.origin === "https://res.cloudinary.com"
            && trustedUrl.pathname.startsWith(`/${cloudinaryConfig.cloud_name}/`)
        ) {
            return {
                hostname: "res.cloudinary.com",
                pathPrefix: `/${cloudinaryConfig.cloud_name}`,
            };
        }

        if (trustedUrl.origin === "https://ik.imagekit.io") {
            return {
                hostname: "ik.imagekit.io",
            };
        }

        return null;
    }

    private resolveTrustedDocumentUrl(rawUrl: string): URL | null {
        try {
            const parsedUrl = new URL(rawUrl);
            if (parsedUrl.protocol !== "https:") {
                return null;
            }

            return this.resolveTrustedDocumentSource(parsedUrl)
                ? parsedUrl
                : null;
        } catch {
            return null;
        }
    }

    private buildTrustedDocumentRequest(trustedUrl: URL): { hostname: string; port?: number; requestPath: string } | null {
        if (trustedUrl.username || trustedUrl.password || trustedUrl.hash) {
            return null;
        }

        const trustedSource = this.resolveTrustedDocumentSource(trustedUrl);
        if (!trustedSource) {
            return null;
        }

        const requestPath = `${trustedUrl.pathname}${trustedUrl.search}`;
        if (!requestPath.startsWith("/") || requestPath.startsWith("//")) {
            return null;
        }

        return {
            hostname: trustedSource.hostname,
            port: trustedSource.port,
            requestPath,
        };
    }

    private getErrorMessage(error: unknown, fallback = "Unknown error"): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }

        if (typeof error === "string" && error.trim().length > 0) {
            return error;
        }

        try {
            const serialized = JSON.stringify(error);
            return serialized && serialized !== "{}"
                ? serialized
                : fallback;
        } catch {
            return fallback;
        }
    }

    private async downloadLookupDocument(rawUrl: string): Promise<{ buffer: Buffer; mimeType?: string }> {
        const trustedUrl = this.resolveTrustedDocumentUrl(rawUrl);
        if (!trustedUrl) {
            throw new BadRequestException("Stored document URL is not trusted for investigative lookup");
        }

        const trustedRequest = this.buildTrustedDocumentRequest(trustedUrl);
        if (!trustedRequest) {
            throw new BadRequestException("Stored document URL is not trusted for investigative lookup");
        }

        const response = await new Promise<{ buffer: Buffer; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
            const request = httpsRequest(
                {
                    hostname: trustedRequest.hostname,
                    port: trustedRequest.port,
                    path: trustedRequest.requestPath,
                    method: "GET",
                    timeout: 30000,
                },
                (downloadResponse) => {
                    const statusCode = downloadResponse.statusCode ?? 0;
                    if (statusCode < 200 || statusCode >= 300) {
                        downloadResponse.resume();
                        reject(new BadRequestException(`Trusted document download failed with status ${statusCode}`));
                        return;
                    }

                    const chunks: Buffer[] = [];
                    downloadResponse.on("data", (chunk) => {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    });
                    downloadResponse.on("end", () => {
                        resolve({
                            buffer: Buffer.concat(chunks),
                            headers: downloadResponse.headers as Record<string, string | string[] | undefined>,
                        });
                    });
                    downloadResponse.on("error", reject);
                },
            );

            request.on("timeout", () => {
                request.destroy(new Error("Timed out downloading investigative document"));
            });
            request.on("error", reject);
            request.end();
        });

        const contentType = Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"][0]
            : response.headers["content-type"];

        return {
            buffer: response.buffer,
            mimeType: typeof contentType === "string" ? contentType : undefined,
        };
    }

    private buildKycUpdateData(action: string, verificationType?: string): Prisma.UserUpdateInput {
        if (!verificationType) return {};

        if (action === "APPROVE") {
            const verificationMap: Record<string, Prisma.UserUpdateInput> = {
                DOCUMENT: { isDocumentVerified: true, documentVerificationStatus: "VERIFIED" },
                BUSINESS_DOCUMENT: { isDocumentVerified: true, businessDocumentVerificationStatus: "VERIFIED" },
            };
            return verificationMap[verificationType] || {};
        }

        if (action === "REJECT") {
            const rejectionMap: Record<string, Prisma.UserUpdateInput> = {
                DOCUMENT: { isDocumentVerified: false, documentVerificationStatus: "DECLINED" },
                ADDRESS: { addressDocumentUrl: null },
                INCOME: { incomeDocumentUrl: null },
                BUSINESS_DOCUMENT: { isDocumentVerified: false, businessDocumentVerificationStatus: "DECLINED", businessDocumentsUploaded: false },
            };
            return rejectionMap[verificationType] || {};
        }

        return {};
    }

    private normalizeManualVerificationStatuses(
        userType: UserType,
        updateData: Prisma.UserUpdateInput,
        dto: UpdateUserVerificationDto,
    ): void {
        if (dto.documentVerified !== undefined) {
            const documentStatus = dto.documentVerified ? DocumentVerificationStatus.VERIFIED : null;

            if (userType === UserType.BUSINESS) {
                updateData.businessDocumentVerificationStatus = documentStatus;
            } else {
                updateData.documentVerificationStatus = documentStatus;
            }
        }
    }

    async processKycDecision(dto: KycDecisionDto, adminId?: number): Promise<ApiResponse> {
        const { userId, action, note, verificationType, version } = dto;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        if (!verificationType) {
            throw new BadRequestException("Verification type is required for KYC decisions.");
        }

        if (!action) {
            throw new BadRequestException("Decision action is required for KYC decisions.");
        }

        // Validate/record transition first so illegal transitions do not mutate user flags.
        const transitionResult = await this.transitionKycDecision({
            userId,
            verificationType,
            action,
            note,
            version,
            adminId,
        });

        if (transitionResult) {
            return transitionResult;
        }

        let updateData: Prisma.UserUpdateInput = this.buildKycUpdateData(action, verificationType);

        const updatedUser = Object.keys(updateData).length > 0
            ? await this.prisma.user.update({
                where: { id: userId },
                data: updateData,
                select: this.buildAdminVerificationSelect(),
            })
            : await this.prisma.user.findUnique({
                where: { id: userId },
                select: this.buildAdminVerificationSelect(),
            });

        await this.syncLegacyDocumentStatusAfterDecision(userId, verificationType, action);

        const currentAttempt = await this.resolveDecisionBridgeContext(userId, verificationType);

        const updatedStageAttempt = await this.applyDecisionToCurrentStageAttempt({
            userId,
            verificationType,
            action,
            note,
            adminId,
            currentAttempt,
        });

        // Recalculate tier from verification flags and flush profile cache
        const syncedUser = await this.tierService.syncTierAndCache(userId);

        // Create audit log — use syncedUser.tier (post-recalculation) for accuracy
        await this.auditLogService.log({
            adminId,
            action: `KYC_${action}`,
            resource: "kyc",
            resourceId: userId.toString(),
            details: {
                previousTier: user.tier,
                newTier: syncedUser.tier,
                verificationType,
                note,
            },
        });

        await this.shadowWriteDecisionAttemptEvent({
            userId,
            verificationType,
            action,
            note,
            adminId,
            attempt: updatedStageAttempt,
        });

        // Send notification to user about KYC status
        const notificationType = `${verificationType.toLowerCase()} `;

        let title: string;
        if (action === "APPROVE") {
            title = "KYC Verification Approved";
        } else if (action === "REJECT") {
            title = "KYC Verification Rejected";
        } else {
            title = "KYC Verification Escalated";
        }

        let body: string;
        if (action === "APPROVE") {
            body = `Your ${notificationType}verification has been approved.`;
        } else if (action === "REJECT") {
            body = `Your ${notificationType}verification was rejected. Reason: ${note || "No reason provided."}`;
        } else {
            body = `Your ${notificationType}verification has been escalated for additional review.`;
        }

        // KC-002: fire-and-forget — notification/email failure should not
        // block the response after the KYC decision has been committed.
        this.notificationDispatcher.notify({
            userId,
            title,
            body,
            category: "security",
            enablePush: true,
        }).catch((e) => this.logger.error(`Failed to send KYC push notification to user ${userId}: ${e.message}`));

        // Send Email
        this.sendKycEmail(user, action, verificationType, note).catch((e) => this.logger.error(`Failed to send KYC email to user ${userId}: ${e.message}`));

        // Push real-time profile update to connected client
        this.wsGateway.notifyProfileUpdate(userId);

        return buildResponse({
            message: `KYC ${action.toLowerCase()} processed successfully`,
            data: updatedUser,
        });
    }

    private async syncLegacyDocumentStatusAfterDecision(
        userId: number,
        verificationType: string,
        action: KycDecisionAction,
    ): Promise<void> {
        if (verificationType !== "DOCUMENT") {
            return;
        }

        const statusByAction: Partial<Record<KycDecisionAction, DocumentVerificationStatus>> = {
            APPROVE: DocumentVerificationStatus.VERIFIED,
            REJECT: DocumentVerificationStatus.DECLINED,
            ESCALATE: DocumentVerificationStatus.PENDING,
        };
        const verificationStatus = statusByAction[action];

        if (!verificationStatus) {
            return;
        }

        const safeUserId = Number(userId);
        if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) {
            throw new BadRequestException("Invalid user id for document status sync");
        }

        await this.prisma.$executeRaw`
            UPDATE "UserDocuments"
            SET "verificationStatus" = ${verificationStatus}::"DocumentVerificationStatus",
                "updatedAt" = NOW()
            WHERE "userId" = ${safeUserId}
        `;
    }

    private async shadowWriteDecisionAttemptEvent(params: {
        userId: number;
        verificationType: string;
        action: KycDecisionAction;
        note?: string;
        adminId?: number;
        attempt?: {
            id: number;
            journeyType: string;
            stage: string;
            status?: string | null;
            providerRef?: string | null;
            reviewNote?: string | null;
            version?: number | null;
        } | null;
    }): Promise<void> {
        if (!this.isAttemptOwnedDecisionVerificationType(params.verificationType)) {
            return;
        }

        const attempt = params.attempt
            ?? await this.resolveShadowAttemptForVerification(
                params.userId,
                params.verificationType,
            );

        if (!attempt) {
            return;
        }

        const payload: PersistedAdminDecisionEventPayload = {
            source: "ADMIN_DECISION",
            verificationType: params.verificationType,
            action: params.action,
            auditAction: this.mapDecisionActionToAuditAction(params.action),
            note: params.note ?? params.attempt?.reviewNote ?? null,
            attemptId: attempt.id,
            attemptVersion: typeof (params.attempt?.version ?? attempt.version) === "number"
                ? (params.attempt?.version ?? attempt.version)
                : null,
        };

        try {
            await (this.prisma as any).kycAttemptEvent.create({
                data: {
                    attemptId: attempt.id,
                    userId: params.userId,
                    journeyType: attempt.journeyType,
                    stage: attempt.stage,
                    eventType: this.mapDecisionActionToEventType(params.action),
                    actorType: typeof params.adminId === "number" ? "ADMIN" : "SYSTEM",
                    actorId: params.adminId ?? null,
                    note: payload.note ?? undefined,
                    payload: payload as unknown as Prisma.InputJsonValue,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            this.logger.error(`Failed to shadow-write KYC decision event for user ${params.userId}: ${message}`);
        }
    }

    private async applyDecisionToCurrentStageAttempt(params: {
        userId: number;
        verificationType: string;
        action: KycDecisionAction;
        note?: string;
        adminId?: number;
        currentAttempt?: {
            id: number;
            journeyType: string;
            stage: string;
            status?: string | null;
            providerRef?: string | null;
            reviewerId?: number | null;
            reviewNote?: string | null;
            reviewedAt?: Date | null;
            version?: number | null;
        } | null;
    }): Promise<{ id: number; journeyType: string; stage: string; version?: number | null } | null> {
        if (!this.isAttemptOwnedDecisionVerificationType(params.verificationType)) {
            return null;
        }

        const attempt = params.currentAttempt ?? await this.resolveShadowAttemptForVerification(
            params.userId,
            params.verificationType,
        );

        if (!attempt) {
            return null;
        }

        const nextVersion = typeof attempt.version === "number"
            ? attempt.version + 1
            : null;
        const decisionNote = params.note ?? attempt.reviewNote ?? null;
        const stageUpdateData: any = {
            status: this.mapDecisionActionToStageAttemptStatus(params.action),
            providerStatus: this.mapDecisionActionToStageProviderStatus(params.action),
            decisionMode: "MANUAL",
            reviewerId: params.adminId ?? attempt.reviewerId ?? null,
            reviewNote: decisionNote,
            reviewedAt: params.action === "ESCALATE"
                ? attempt.reviewedAt ?? null
                : attempt.reviewedAt ?? new Date(),
            escalatedAt: params.action === "ESCALATE"
                ? attempt.reviewedAt ?? new Date()
                : null,
            providerRef: attempt.providerRef ?? null,
            reasonCode: null,
            reasonMessage: params.action === "APPROVE" ? null : decisionNote,
            reasonDetails: params.action === "APPROVE" || !decisionNote ? Prisma.DbNull : { reason: decisionNote },
        };

        if (typeof nextVersion === "number") {
            stageUpdateData.version = nextVersion;
        }

        await this.prisma.kycStageAttempt.update({
            where: { id: attempt.id },
            data: stageUpdateData,
        });

        return {
            ...attempt,
            version: nextVersion ?? attempt.version ?? null,
        };
    }

    private mapDecisionActionToStageAttemptStatus(action: KycDecisionAction): KycAttemptStatus {
        switch (action) {
            case "APPROVE":
                return KycAttemptStatus.APPROVED;
            case "REJECT":
                return KycAttemptStatus.REJECTED;
            case "ESCALATE":
                return KycAttemptStatus.ESCALATED;
        }
    }

    private mapDecisionActionToStageProviderStatus(action: KycDecisionAction): string {
        switch (action) {
            case "APPROVE":
                return "PASSED";
            case "REJECT":
                return "FAILED";
            case "ESCALATE":
                return "INCONCLUSIVE";
        }
    }

    private mapDecisionActionToAuditAction(action: KycDecisionAction): string {
        switch (action) {
            case "APPROVE":
                return "KYC_APPROVE";
            case "REJECT":
                return "KYC_REJECT";
            case "ESCALATE":
                return "KYC_ESCALATE";
        }
    }

    private mapDecisionActionToEventType(action: KycDecisionAction): string {
        switch (action) {
            case "APPROVE":
                return "APPROVED";
            case "REJECT":
                return "REJECTED";
            case "ESCALATE":
                return "ESCALATED";
        }
    }

    private async sendKycEmail(
        user: any,
        action: "APPROVE" | "REJECT" | "ESCALATE",
        verificationType?: string,
        reason?: string
    ): Promise<void> {
        if (!user.email) {
            this.logger.warn(`Cannot send KYC email: user ${user.id} has no email`);
            return;
        }

        // Escalation uses a separate template
        if (action === "ESCALATE") {
            const escalatedTemplateKey = emailTemplateConfig.document_escalated;
            if (!escalatedTemplateKey) {
                this.logger.warn(`Email template not configured for KYC escalation`);
                return;
            }

            const friendlyTypeMap: Record<string, string> = {
                BVN: "BVN",
                NIN: "NIN",
                DOCUMENT: "Identity Document",
                ADDRESS: "Address",
                INCOME: "Income",
                BUSINESS_DOCUMENT: "Business Documents",
            };
            const documentTypeFriendly = verificationType ? (friendlyTypeMap[verificationType] || verificationType) : "KYC Verification";

            try {
                await this.emailService.sendMailWithTemplate({
                    from: { address: mailConfig.senderMail },
                    to: [{ email_address: { address: user.email } }],
                    template_key: escalatedTemplateKey,
                    merge_info: {
                        name: user.firstName || "User",
                        document_type: documentTypeFriendly,
                        company_name: COMPANY_NAME,
                    },
                });
                this.logger.log(`KYC escalation email sent to ${user.email}`);
            } catch (error) {
                this.logger.error(`Failed to send KYC escalation email to ${user.email}: ${this.getErrorMessage(error)}`);
            }
            return;
        }

        const approved = action === "APPROVE";
        const templateKey = approved
            ? emailTemplateConfig.document_approved
            : emailTemplateConfig.document_rejected;

        if (!templateKey) {
            this.logger.warn(`Email template not configured for KYC ${approved ? "approval" : "rejection"}`);
            return;
        }

        const friendlyTypeMap: Record<string, string> = {
            BVN: "BVN",
            NIN: "NIN",
            DOCUMENT: "Identity Document",
            ADDRESS: "Address",
            INCOME: "Income",
            BUSINESS_DOCUMENT: "Business Documents",
        };
        const documentTypeFriendly = verificationType ? (friendlyTypeMap[verificationType] || verificationType) : "KYC Verification";

        try {
            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: templateKey,
                merge_info: {
                    first_name: user.firstName || "User",
                    document_type: documentTypeFriendly,
                    company_name: COMPANY_NAME,
                    rejection_reason: reason || "",
                    status: approved ? "Approved" : "Rejected",
                },
            });
            this.logger.log(`KYC email sent to ${user.email} (${action})`);
        } catch (error) {
            this.logger.error(`Failed to send KYC email to ${user.email}: ${this.getErrorMessage(error)}`);
        }
    }

    // ==================== USER TIER MANAGEMENT ====================

    async updateUserTier(userId: number, dto: UpdateUserTierDto, adminId?: number): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                tier: true,
                userType: true,
                bvn: true,
                nin: true,
                isEmailVerified: true,
                isDocumentVerified: true,
                businessDocumentVerificationStatus: true,
                kycStageAttempts: {
                    where: {
                        isCurrent: true,
                        journeyType: "INDIVIDUAL",
                        stage: { in: ["GOVERNMENT_ID", "ADDRESS", "INCOME"] },
                    },
                    select: {
                        stage: true,
                        method: true,
                        status: true,
                        isCurrent: true,
                    },
                },
            },
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        const previousTier = user.tier;

        // Security: Clamp tier to verification-derived ceiling
        const calculatedTier = this.tierService.calculateTier(user);
        if (dto.tier > calculatedTier) {
            this.logger.warn(
                `SECURITY: Admin ${adminId} requested tier ${dto.tier} above calculated tier ${calculatedTier} for user ${userId}. Clamped to ${calculatedTier}. Reason: ${dto.reason || 'none provided'}`
            );
            dto.tier = calculatedTier;
        }

        const updatedUser = await this.prisma.user.update({
            where: { id: userId },
            data: { tier: dto.tier },
            select: {
                id: true,
                email: true,
                tier: true,
            },
        });

        // Limits are derived from shared tier constants in tier logic.
        // Avoid writing per-user AccountLimit rows from KYC admin actions.

        // Flush profile cache so frontend sees override immediately
        await this.redisCacheService.del(this.getProfileCacheKey(userId));

        // Audit log
        await this.auditLogService.log({
            adminId,
            action: "UPDATE_USER_TIER",
            resource: "kyc",
            resourceId: userId.toString(),
            details: {
                previousTier,
                newTier: dto.tier,
                reason: dto.reason,
            },
        });

        return buildResponse({
            message: "User tier updated successfully",
            data: updatedUser,
        });
    }

    async updateUserVerification(
        userId: number,
        dto: UpdateUserVerificationDto,
        adminId?: number
    ): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                userType: true,
                email: true,
                firstName: true,
                lastName: true,
                dateOfBirth: true,
                bvn: true,
                nin: true,
                isDocumentVerified: true,
                documentVerificationStatus: true,
                businessDocumentVerificationStatus: true,
                addressDocumentUrl: true,
                incomeDocumentUrl: true,
                kycStageAttempts: {
                    where: {
                        isCurrent: true,
                        journeyType: "INDIVIDUAL",
                        stage: { in: ["GOVERNMENT_ID", "ADDRESS", "INCOME"] },
                    },
                    select: {
                        stage: true,
                        method: true,
                        status: true,
                        isCurrent: true,
                    },
                },
            },
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        const updateData: Prisma.UserUpdateInput = {};
        const changes: Record<string, any> = {};
        const normalizedUser = this.normalizeVerificationState(user);
        const { verificationSnapshot } = normalizedUser;

        // Guard: cannot mark BVN verified if user has no BVN on file
        if (dto.bvnVerified === true && !user.bvn) {
            throw new BadRequestException(
                "Cannot set BVN verified — user has no BVN on file. The user must complete BVN verification first.",
            );
        }
        // Guard: cannot mark NIN verified if user has no NIN on file
        if (dto.ninVerified === true && !user.nin) {
            throw new BadRequestException(
                "Cannot set NIN verified — user has no NIN on file. The user must complete NIN verification first.",
            );
        }

        if (dto.bvnVerified !== undefined) {
            changes.bvn = { from: verificationSnapshot.bvnVerified, to: dto.bvnVerified };
            await this.applyStageManagedManualVerificationDecision(userId, "BVN", dto.bvnVerified, adminId, dto.reason);
        }
        if (dto.ninVerified !== undefined) {
            changes.nin = { from: verificationSnapshot.ninVerified, to: dto.ninVerified };
            await this.applyStageManagedManualVerificationDecision(userId, "NIN", dto.ninVerified, adminId, dto.reason);
        }
        if (dto.documentVerified !== undefined) {
            updateData.isDocumentVerified = dto.documentVerified;
            changes.document = { from: normalizedUser.documentVerified, to: dto.documentVerified };
        }
        if (dto.addressVerified !== undefined) {
            changes.address = { from: verificationSnapshot.addressVerified, to: dto.addressVerified };
            if (dto.addressVerified === false) {
                updateData.addressDocumentUrl = null;
            }
            await this.applyStageManagedManualVerificationDecision(userId, "ADDRESS", dto.addressVerified, adminId, dto.reason);
        }
        if (dto.incomeVerified !== undefined) {
            changes.income = { from: verificationSnapshot.incomeVerified, to: dto.incomeVerified };
            if (dto.incomeVerified === false) {
                updateData.incomeDocumentUrl = null;
            }
            await this.applyStageManagedManualVerificationDecision(userId, "INCOME", dto.incomeVerified, adminId, dto.reason);
        }

        this.normalizeManualVerificationStatuses(user.userType, updateData, dto);

        const updatedUser = Object.keys(updateData).length > 0
            ? await this.prisma.user.update({
                where: { id: userId },
                data: updateData,
                select: this.buildAdminVerificationSelect(),
            })
            : await this.prisma.user.findUnique({
                where: { id: userId },
                select: this.buildAdminVerificationSelect(),
            });

        // Identity graph: link BVN/NIN to identity subject when admin marks verified
        await this.resolveIdentityForAdmin(dto, user, userId);

        // Audit log
        await this.auditLogService.log({
            adminId,
            action: "UPDATE_USER_VERIFICATION",
            resource: "kyc",
            resourceId: userId.toString(),
            details: {
                changes,
                reason: dto.reason,
            },
        });

        // Sync tier & flush cache after admin verification flag change
        await this.tierService.syncTierAndCache(userId);

        return buildResponse({
            message: "User verification status updated successfully",
            data: updatedUser,
        });
    }

    // ==================== IDENTITY GRAPH HELPERS ====================

    private async resolveIdentityForAdmin(
        dto: UpdateUserVerificationDto,
        user: { firstName: string | null; lastName: string | null; dateOfBirth: Date | null; bvn: string | null; nin: string | null },
        userId: number,
    ): Promise<void> {
        const biographic = user.firstName && user.lastName && user.dateOfBirth
            ? { firstName: user.firstName, lastName: user.lastName, dateOfBirth: user.dateOfBirth.toISOString().split("T")[0] }
            : undefined;

        if (dto.bvnVerified === true && user.bvn) {
            await this.identityResolution.resolveOrCreate(IdentityIdType.BVN, user.bvn, userId, biographic);
        }
        if (dto.ninVerified === true && user.nin) {
            await this.identityResolution.resolveOrCreate(IdentityIdType.NIN, user.nin, userId, biographic);
        }
    }

    // ==================== KYC STATISTICS ====================

    async getKycStats(query: GetKycStatsDto): Promise<ApiResponse> {
        const { startDate, endDate } = query.startDate && query.endDate
            ? { startDate: new Date(query.startDate), endDate: endOfDay(new Date(query.endDate)) }
            : this.getDateRange(query.period || "month");

        const nonAdminWhere = { userType: { not: UserType.ADMIN } } as const;

        // Run all aggregate queries in parallel — no findMany needed
        const [
            totalUsers,
            tierGroups,
            needsReviewCount,
            awaitingUserCount,
            escalatedCount,
            rejectedCount,
            resolvedInPeriod,
            bvnVerified,
            ninVerified,
            documentVerified,
            newUsersInPeriod,
        ] = await Promise.all([
            this.prisma.user.count({ where: nonAdminWhere }),

            this.prisma.user.groupBy({
                by: ["tier"],
                where: nonAdminWhere,
                _count: { _all: true },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    ...this.buildKycStatusFilter("ACTIONABLE"),
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    ...this.buildAwaitingUserFilter(),
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    ...this.buildKycStatusFilter("ALL", "ESCALATED"),
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    ...this.buildKycStatusFilter("ALL", "REJECTED"),
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    OR: [
                        {
                            kycStageAttempts: {
                                some: {
                                    isCurrent: true,
                                    journeyType: "INDIVIDUAL",
                                    stage: { in: this.getStageManagedJourneyStages() },
                                    status: { in: [KycAttemptStatus.APPROVED, KycAttemptStatus.REJECTED, KycAttemptStatus.EXPIRED] },
                                    reviewedAt: { gte: startDate, lte: endDate },
                                },
                            },
                        },
                        {
                            kycStageAttempts: {
                                some: {
                                    isCurrent: true,
                                    journeyType: "BUSINESS",
                                    stage: "BUSINESS_DOCUMENT",
                                    status: { in: [KycAttemptStatus.APPROVED, KycAttemptStatus.REJECTED, KycAttemptStatus.EXPIRED] },
                                    reviewedAt: { gte: startDate, lte: endDate },
                                },
                            },
                        },
                    ],
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    kycStageAttempts: {
                        some: {
                            isCurrent: true,
                            journeyType: "INDIVIDUAL",
                            stage: "GOVERNMENT_ID",
                            method: "BVN",
                            status: KycAttemptStatus.APPROVED,
                        },
                    },
                },
            }),
            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    kycStageAttempts: {
                        some: {
                            isCurrent: true,
                            journeyType: "INDIVIDUAL",
                            stage: "GOVERNMENT_ID",
                            method: "NIN",
                            status: KycAttemptStatus.APPROVED,
                        },
                    },
                },
            }),
            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    kycStageAttempts: {
                        some: {
                            isCurrent: true,
                            journeyType: "INDIVIDUAL",
                            stage: "IDENTITY_DOCUMENT",
                            status: KycAttemptStatus.APPROVED,
                        },
                    },
                },
            }),

            this.prisma.user.count({
                where: { ...nonAdminWhere, createdAt: { gte: startDate, lte: endDate } },
            }),
        ]);

        const openWorkCount = awaitingUserCount + needsReviewCount;

        // Build tier distribution from groupBy result
        const tierCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        for (const group of tierGroups) {
            const t = group.tier ?? 0;
            if (t in tierCounts) tierCounts[t] = group._count._all;
        }
        const { 0: tier0Count, 1: tier1Count, 2: tier2Count, 3: tier3Count, 4: tier4Count } = tierCounts;
        const percentage = (count: number): string =>
            totalUsers > 0 ? ((count / totalUsers) * 100).toFixed(2) : "0.00";

        return buildResponse({
            message: "KYC statistics retrieved successfully",
            data: {
                overview: {
                    totalUsers,
                    pendingKyc: awaitingUserCount,
                    needsReview: needsReviewCount,
                    awaitingUser: awaitingUserCount,
                    escalated: escalatedCount,
                    rejected: rejectedCount,
                    resolvedInPeriod,
                    kycCompletionRate: totalUsers > 0
                        ? (((totalUsers - openWorkCount) / totalUsers) * 100).toFixed(2)
                        : "0.00",
                },
                tierDistribution: {
                    tier0: { count: tier0Count, percentage: percentage(tier0Count) },
                    tier1: { count: tier1Count, percentage: percentage(tier1Count) },
                    tier2: { count: tier2Count, percentage: percentage(tier2Count) },
                    tier3: { count: tier3Count, percentage: percentage(tier3Count) },
                    tier4: { count: tier4Count, percentage: percentage(tier4Count) },
                },
                verificationBreakdown: {
                    bvn: { verified: bvnVerified, rate: percentage(bvnVerified) },
                    nin: { verified: ninVerified, rate: percentage(ninVerified) },
                    document: { verified: documentVerified, rate: percentage(documentVerified) },
                },
                periodMetrics: {
                    newUsers: newUsersInPeriod,
                    kycCompleted: resolvedInPeriod,
                    period: { start: startDate, end: endDate },
                },
            },
        });
    }

    // ==================== HELPERS ====================

    private getDateRange(period: string): { startDate: Date; endDate: Date } {
        const now = new Date();
        switch (period) {
            case "today":
                return { startDate: startOfDay(now), endDate: endOfDay(now) };
            case "week":
                return { startDate: startOfWeek(now), endDate: endOfWeek(now) };
            case "month":
                return { startDate: startOfMonth(now), endDate: endOfMonth(now) };
            case "quarter":
                return { startDate: startOfQuarter(now), endDate: endOfQuarter(now) };
            case "year":
                return { startDate: startOfYear(now), endDate: endOfYear(now) };
            case "all":
                return { startDate: new Date(0), endDate: now };
            default:
                return { startDate: startOfMonth(now), endDate: endOfMonth(now) };
        }
    }

    // ==================== DOCUMENT APPROVAL ====================

    async approveDocument(dto: ApproveDocumentDto, adminId: number): Promise<ApiResponse> {
        this.logger.log(`Admin ${adminId} approving ${dto.documentType} document for user ${dto.userId}`);
        return await this.processKycDecision(
            {
                userId: dto.userId,
                action: "APPROVE",
                verificationType: this.mapDocumentTypeToVerificationType(dto.documentType),
                version: dto.version,
            },
            adminId
        );
    }

    async rejectDocument(dto: RejectDocumentDto, adminId: number): Promise<ApiResponse> {
        this.logger.log(`Admin ${adminId} rejecting ${dto.documentType} document for user ${dto.userId}: ${dto.reason}`);
        return await this.processKycDecision(
            {
                userId: dto.userId,
                action: "REJECT",
                verificationType: this.mapDocumentTypeToVerificationType(dto.documentType),
                note: dto.reason,
                version: dto.version,
            },
            adminId
        );
    }

    private mapDocumentTypeToVerificationType(documentType: "address" | "income" | "business"): string {
        const map: Record<string, string> = {
            address: "ADDRESS",
            income: "INCOME",
            business: "BUSINESS_DOCUMENT",
        };
        return map[documentType] || "DOCUMENT";
    }

    private resolveQueueView(queueView?: string, status?: string): KycQueueView {
        if (queueView === "ACTIONABLE" || queueView === "AWAITING_USER" || queueView === "RESOLVED") {
            return queueView;
        }
        if (queueView === "all") {
            return "ALL";
        }
        if (status === "PENDING" || status === "NEEDS_REVIEW" || !status) {
            return "ACTIONABLE";
        }
        if (status === "APPROVED" || status === "REJECTED" || status === "ESCALATED") {
            return "RESOLVED";
        }
        return "ALL";
    }

    private isStageManagedVerificationType(verificationType: string): boolean {
        return ["BVN", "NIN", "DOCUMENT", "ADDRESS", "INCOME", "BUSINESS_DOCUMENT"].includes(verificationType);
    }

    private isAttemptOwnedDecisionVerificationType(verificationType: string): boolean {
        return this.isStageManagedVerificationType(verificationType)
            || verificationType === "BUSINESS_DOCUMENT";
    }

    private isStageAttemptRecord(record: any): boolean {
        return Boolean(record && typeof record === "object" && typeof record.stage === "string" && !record.verificationType);
    }

    private mapStageAttemptToVerificationType(stage: string, method?: string | null): string {
        if (stage === "IDENTITY_DOCUMENT") {
            return "DOCUMENT";
        }

        if (stage === "ADDRESS" || stage === "INCOME") {
            return stage;
        }

        if (stage === "GOVERNMENT_ID" && (method === "BVN" || method === "NIN")) {
            return method;
        }

        return stage;
    }

    private mapStageAttemptStatusToAdminStatus(status: string): string {
        switch (status) {
            case "APPROVED":
                return "APPROVED";
            case "REJECTED":
            case "EXPIRED":
                return "REJECTED";
            case "ESCALATED":
                return "ESCALATED";
            case "SUBMITTED":
            case "PENDING_REVIEW":
            default:
                return "PENDING";
        }
    }

    private getStageManagedJourneyStages(): KycStage[] {
        return [KycStage.GOVERNMENT_ID, KycStage.IDENTITY_DOCUMENT, KycStage.ADDRESS, KycStage.INCOME];
    }

    private mapAdminStatusToStageAttemptStatuses(status: string): KycAttemptStatus[] {
        switch (status) {
            case "APPROVED":
                return [KycAttemptStatus.APPROVED];
            case "REJECTED":
                return [KycAttemptStatus.REJECTED, KycAttemptStatus.EXPIRED];
            case "ESCALATED":
                return [KycAttemptStatus.ESCALATED];
            case "PENDING":
            default:
                return [KycAttemptStatus.SUBMITTED, KycAttemptStatus.PENDING_REVIEW];
        }
    }

    private resolveStageAttemptDocumentUrl(attempt: any): string | null {
        const evidenceAssetUrl = Array.isArray(attempt?.evidenceAssets)
            ? attempt.evidenceAssets.find((asset: any) => typeof asset?.storageUrl === "string")?.storageUrl ?? null
            : null;

        if (evidenceAssetUrl) {
            return evidenceAssetUrl;
        }

        const evidenceSummary = this.getAttemptStructuredRecord(attempt?.evidenceSummary);
        if (typeof evidenceSummary?.documentUrl === "string") {
            return evidenceSummary.documentUrl;
        }

        return null;
    }

    private buildCurrentAttemptSummaries(user: any): AdminKycAttemptSummary[] {
        return ((user.kycStageAttempts ?? []) as any[])
            .filter((attempt) => attempt.isCurrent !== false)
            .map((attempt) => this.buildAdminAttemptSummary(attempt));
    }

    private buildAttemptHistory(user: any): AdminKycAttemptSummary[] {
        return ((user.kycStageAttempts ?? []) as any[])
            .map((attempt) => this.buildAdminAttemptSummary(attempt))
            .sort((left, right) => {
            const leftTime = new Date(left.reviewedAt || left.submittedAt).getTime();
            const rightTime = new Date(right.reviewedAt || right.submittedAt).getTime();
            return rightTime - leftTime;
        });
    }

    private buildAttemptRecordByVerificationType(user: any): Record<string, any> {
        const records = [
            ...((user.kycStageAttempts ?? []).map((attempt: any) => ({
                verificationType: this.mapStageAttemptToVerificationType(attempt.stage, attempt.method),
                record: attempt,
                sortAt: new Date(attempt.reviewedAt || attempt.submittedAt).getTime(),
            }))),
        ].sort((left, right) => right.sortAt - left.sortAt);

        return records.reduce<Record<string, any>>((accumulator, entry) => {
            if (!accumulator[entry.verificationType]) {
                accumulator[entry.verificationType] = entry.record;
            }
            return accumulator;
        }, {});
    }

    private getImportedLegacyProviderResponse(attemptEvents: any[], attemptId?: number | null): unknown {
        if (typeof attemptId !== "number") {
            return null;
        }

        const importedEvent = attemptEvents.find((event) =>
            event?.attemptId === attemptId && event?.eventType === KycAttemptEventType.IMPORTED_LEGACY_HISTORY,
        );
        const payload = this.getAttemptStructuredRecord(importedEvent?.payload);
        return payload?.providerRawResponse ?? null;
    }

    private mapStageEvidenceKindToAdminKind(
        verificationType: string,
        evidenceKind: string,
        evidenceSide?: string | null,
    ): string {
        if (verificationType === "DOCUMENT") {
            if (evidenceKind === "BACK_IMAGE" || evidenceSide === "BACK") {
                return "DOCUMENT_BACK";
            }
            return "DOCUMENT_FRONT";
        }

        if (verificationType === "ADDRESS") {
            return "ADDRESS_DOCUMENT";
        }

        if (verificationType === "INCOME") {
            return "INCOME_DOCUMENT";
        }

        return evidenceKind;
    }

    private getStageEvidenceLabel(
        verificationType: string,
        evidenceKind: string,
        evidenceSide?: string | null,
    ): string {
        const kind = this.mapStageEvidenceKindToAdminKind(verificationType, evidenceKind, evidenceSide);
        const labels: Record<string, string> = {
            DOCUMENT_FRONT: "Identity document front",
            DOCUMENT_BACK: "Identity document back",
            ADDRESS_DOCUMENT: "Address document",
            INCOME_DOCUMENT: "Income document",
        };

        return labels[kind] ?? "Verification document";
    }

    private buildAdminAttemptSummary(
        attempt: any,
        options: { queueReason?: string | null; attemptNumbers?: Map<number, number> } = {},
    ): AdminKycAttemptSummary {
        const verificationType = this.mapStageAttemptToVerificationType(attempt.stage, attempt.method);
        const status = this.mapStageAttemptStatusToAdminStatus(attempt.status);

        return {
            attemptId: attempt.id,
            verificationType,
            stage: attempt.stage,
            method: attempt.method ?? null,
            status,
            providerStatus: attempt.providerStatus ?? null,
            attemptNo: attempt.attemptNo ?? options.attemptNumbers?.get(attempt.id) ?? null,
            version: this.resolveAdminAttemptVersion(attempt),
            submittedAt: attempt.submittedAt,
            reviewedAt: attempt.reviewedAt ?? null,
            reviewerId: attempt.reviewerId ?? null,
            reviewNote: attempt.reviewNote ?? attempt.reasonMessage ?? null,
            providerRef: attempt.providerRef ?? null,
            documentUrl: this.resolveStageAttemptDocumentUrl(attempt),
            isActive: attempt.isCurrent ?? true,
            queueReason: options.queueReason ?? null,
            recommendedDecision: this.getRecommendedDecisionForAttempt(status),
            allowedActions: this.getAllowedAttemptActions(verificationType, status),
        };
    }

    private mapVerificationTypeToAttemptStage(verificationType: string): string {
        const stageMap: Record<string, string> = {
            BVN: "GOVERNMENT_ID",
            NIN: "GOVERNMENT_ID",
            DOCUMENT: "IDENTITY_DOCUMENT",
            ADDRESS: "ADDRESS",
            INCOME: "INCOME",
            BUSINESS_DOCUMENT: "BUSINESS_DOCUMENT",
        };

        return stageMap[verificationType] ?? verificationType;
    }

    private mapVerificationTypeToJourneyType(verificationType: string): string {
        return verificationType === "BUSINESS_DOCUMENT"
            ? "BUSINESS"
            : "INDIVIDUAL";
    }

    private mapVerificationTypeToAttemptMethod(verificationType: string): string | null {
        if (verificationType === "BVN" || verificationType === "NIN") {
            return verificationType;
        }

        if (["DOCUMENT", "ADDRESS", "INCOME", "BUSINESS_DOCUMENT"].includes(verificationType)) {
            return "DOCUMENT";
        }

        return null;
    }

    private getRecommendedDecisionForAttempt(status: string): AdminKycRecommendedDecision | null {
        if (status === "APPROVED") return "APPROVE";
        if (status === "REJECTED") return "REJECT";
        if (this.actionableStatuses.has(status)) return "REVIEW";
        return null;
    }

    private resolveAdminAttemptVersion(verification: any): number | null {
        return typeof verification?.version === "number"
            ? verification.version
            : null;
    }

    private getAllowedAttemptActions(verificationType: string, status: string): AdminKycAttemptAction[] {
        const actions: AdminKycAttemptAction[] = [];

        if (this.actionableStatuses.has(status)) {
            actions.push("APPROVE", "REJECT", "ESCALATE");
        }

        if (this.canRecheckVerificationType(verificationType)) {
            actions.push("RECHECK");
        }

        return actions;
    }

    private canRecheckVerificationType(verificationType: string): boolean {
        return ["BVN", "NIN", "DOCUMENT", "ADDRESS", "INCOME", "BUSINESS_DOCUMENT"].includes(verificationType);
    }

    private buildQueueMetadata(user: any, queueView: KycQueueView) {
        const latestActivityByAttemptId = this.buildLatestAttemptActivityIndex(user.kycAttemptEvents ?? []);
        const activeVerifications = this.buildCurrentAttemptSummaries(user)
            .map((attempt) => this.attachLatestAttemptActivity(attempt, latestActivityByAttemptId))
            .sort(
            (left, right) => new Date(left.submittedAt).getTime() - new Date(right.submittedAt).getTime(),
            );
        const actionableVerifications = activeVerifications.filter((kv) => kv.status === "PENDING");
        const latestVerification = [...activeVerifications].sort(
            (left, right) => {
                const leftTime = new Date(left.latestActivityAt || left.reviewedAt || left.submittedAt).getTime();
                const rightTime = new Date(right.latestActivityAt || right.reviewedAt || right.submittedAt).getTime();
                return rightTime - leftTime;
            },
        )[0];
        const blockingVerificationTypes = this.getBlockingVerificationTypes(user);
        const queueReason = actionableVerifications.length > 0
            ? this.getSubmittedForReviewReason(actionableVerifications)
            : this.getAwaitingUserReason(blockingVerificationTypes, user.userType);
        const oldestSubmittedAt = actionableVerifications[0]?.submittedAt ?? null;
        const latestAttempt = latestVerification
            ? { ...latestVerification, queueReason }
            : null;
        const actionableAttempts = actionableVerifications.map((verification) => ({ ...verification, queueReason }));
        const activeAttempt = actionableAttempts[0] ?? latestAttempt;

        return {
            needsReview: actionableVerifications.length > 0,
            queueReason,
            blockingVerificationTypes,
            oldestSubmittedAt,
            latestReviewAt: latestVerification?.latestActivityAt ?? latestVerification?.reviewedAt ?? null,
            queueSortAt: oldestSubmittedAt || latestVerification?.latestActivityAt || latestVerification?.submittedAt || user.updatedAt || user.createdAt,
            queueView,
            activeAttempt,
            latestAttempt,
            actionableAttempts,
        };
    }

    private getBlockingVerificationTypes(user: any): string[] {
        const normalizedUser = this.normalizeVerificationState(user);
        const { verificationSnapshot } = normalizedUser;
        const currentGovernmentAttempt = this.getCurrentStageAttemptForVerificationType(normalizedUser, "BVN")
            ?? this.getCurrentStageAttemptForVerificationType(normalizedUser, "NIN");
        const currentDocumentAttempt = this.getCurrentStageAttemptForVerificationType(normalizedUser, "DOCUMENT");
        const currentAddressAttempt = this.getCurrentStageAttemptForVerificationType(normalizedUser, "ADDRESS");
        const currentIncomeAttempt = this.getCurrentStageAttemptForVerificationType(normalizedUser, "INCOME");
        const currentBusinessAttempt = this.getCurrentStageAttemptForVerificationType(normalizedUser, "BUSINESS_DOCUMENT");
        const pending: string[] = [];
        if (!normalizedUser.emailVerified) pending.push("EMAIL");
        if (!normalizedUser.phoneVerified) pending.push("PHONE");
        if (!verificationSnapshot.bvnVerified && !verificationSnapshot.ninVerified && !normalizedUser.bvn && !normalizedUser.nin && !currentGovernmentAttempt) pending.push("BVN");
        if (!normalizedUser.documentVerified && !normalizedUser.userDocument && !currentDocumentAttempt) pending.push("DOCUMENT");
        if (!verificationSnapshot.addressVerified && !normalizedUser.addressDocumentUrl && !currentAddressAttempt) pending.push("ADDRESS");
        if (!verificationSnapshot.incomeVerified && !normalizedUser.incomeDocumentUrl && !currentIncomeAttempt) pending.push("INCOME");
        if (normalizedUser.userType === UserType.BUSINESS && !normalizedUser.businessDocument && !currentBusinessAttempt) pending.push("BUSINESS_DOCUMENT");
        return pending;
    }

    private getAwaitingUserReason(blockingVerificationTypes: string[], userType: UserType): string {
        if (blockingVerificationTypes.length === 0) {
            return userType === UserType.BUSINESS
                ? "Awaiting additional business verification input"
                : "Awaiting additional user submission";
        }

        if (blockingVerificationTypes.length === 1) {
            return `Awaiting user submission for ${this.getVerificationLabel(blockingVerificationTypes[0])}`;
        }

        return `Awaiting user submission for ${blockingVerificationTypes.length} verification stages`;
    }

    private getSubmittedForReviewReason(actionableVerifications: Array<{ verificationType: string }>): string {
        const submittedTarget = actionableVerifications.length === 1
            ? this.getVerificationLabel(actionableVerifications[0].verificationType)
            : `${actionableVerifications.length} verifications`;

        return `Submitted ${submittedTarget} for review`;
    }

    private getVerificationLabel(verificationType: string): string {
        const map: Record<string, string> = {
            EMAIL: "email verification",
            PHONE: "phone verification",
            BVN: "BVN verification",
            NIN: "NIN verification",
            DOCUMENT: "identity document review",
            ADDRESS: "address review",
            INCOME: "income review",
            BUSINESS_DOCUMENT: "business document review",
        };
        return map[verificationType] || verificationType.toLowerCase();
    }

    private buildKycQueueWhere(params: {
        resolvedQueueView: KycQueueView;
        status?: string;
        verificationType?: string;
        searchText?: string;
        tier?: number;
    }): Prisma.UserWhereInput {
        const { resolvedQueueView, status, verificationType, searchText, tier } = params;
        const andConditions: Prisma.UserWhereInput[] = [];
        const verificationFilter = this.buildKycStatusFilter(resolvedQueueView, status);
        const typeConditions = this.buildKycTypeConditions(verificationType);
        const searchCondition = this.buildKycSearchCondition(searchText);

        if (Object.keys(verificationFilter).length > 0) andConditions.push(verificationFilter);
        if (typeConditions.length > 0) andConditions.push(...typeConditions);
        if (tier !== undefined) andConditions.push({ tier });
        if (searchCondition) andConditions.push(searchCondition);

        return {
            userType: { not: UserType.ADMIN },
            ...(andConditions.length > 0 ? { AND: andConditions } : {}),
        };
    }

    private buildKycStatusFilter(
        resolvedQueueView: KycQueueView,
        status?: string,
    ): Prisma.UserWhereInput {
        const stageManagedStages = this.getStageManagedJourneyStages();
        const buildBusinessStageCondition = (statuses: string[]): Prisma.UserWhereInput => ({
            kycStageAttempts: {
                some: {
                    isCurrent: true,
                    journeyType: "BUSINESS",
                    stage: "BUSINESS_DOCUMENT",
                    status: { in: statuses as any },
                },
            },
        });

        if (status === "APPROVED" || status === "REJECTED" || status === "ESCALATED") {
            return {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: stageManagedStages },
                                status: { in: this.mapAdminStatusToStageAttemptStatuses(status) },
                            },
                        },
                    },
                    buildBusinessStageCondition(this.mapAdminStatusToStageAttemptStatuses(status)),
                ],
            };
        }

        if (resolvedQueueView === "ACTIONABLE") {
            return {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: stageManagedStages },
                                status: { in: this.mapAdminStatusToStageAttemptStatuses("PENDING") },
                            },
                        },
                    },
                    buildBusinessStageCondition(this.mapAdminStatusToStageAttemptStatuses("PENDING")),
                ],
            };
        }

        if (resolvedQueueView === "AWAITING_USER") {
            return this.buildAwaitingUserFilter();
        }

        if (resolvedQueueView === "RESOLVED") {
            return {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: { in: stageManagedStages },
                                status: { in: ["APPROVED", "REJECTED", "ESCALATED", "EXPIRED"] },
                            },
                        },
                    },
                    buildBusinessStageCondition(["APPROVED", "REJECTED", "ESCALATED", "EXPIRED"]),
                ],
            };
        }

        return {};
    }

    private buildAwaitingUserFilter(): Prisma.UserWhereInput {
        return {
            AND: [
                {
                    OR: [
                        {
                            AND: [
                                { bvn: null },
                                { nin: null },
                                {
                                    kycStageAttempts: {
                                        none: {
                                            isCurrent: true,
                                            journeyType: "INDIVIDUAL",
                                            stage: "GOVERNMENT_ID",
                                        },
                                    },
                                },
                            ],
                        },
                        {
                            AND: [
                                { isDocumentVerified: false },
                                { userDocument: { is: null } },
                                {
                                    kycStageAttempts: {
                                        none: {
                                            isCurrent: true,
                                            journeyType: "INDIVIDUAL",
                                            stage: "IDENTITY_DOCUMENT",
                                        },
                                    },
                                },
                            ],
                        },
                        {
                            AND: [
                                { addressDocumentUrl: null },
                                {
                                    kycStageAttempts: {
                                        none: {
                                            isCurrent: true,
                                            journeyType: "INDIVIDUAL",
                                            stage: "ADDRESS",
                                        },
                                    },
                                },
                            ],
                        },
                        {
                            AND: [
                                { incomeDocumentUrl: null },
                                {
                                    kycStageAttempts: {
                                        none: {
                                            isCurrent: true,
                                            journeyType: "INDIVIDUAL",
                                            stage: "INCOME",
                                        },
                                    },
                                },
                            ],
                        },
                        {
                            AND: [
                                { userType: UserType.BUSINESS },
                                { businessDocument: { is: null } },
                                {
                                    kycStageAttempts: {
                                        none: {
                                            isCurrent: true,
                                            journeyType: "BUSINESS",
                                            stage: "BUSINESS_DOCUMENT",
                                        },
                                    },
                                },
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
                                        stage: { in: this.getStageManagedJourneyStages() },
                                        status: { in: this.mapAdminStatusToStageAttemptStatuses("PENDING") },
                                    },
                                },
                            },
                            {
                                kycStageAttempts: {
                                    some: {
                                        isCurrent: true,
                                        journeyType: "BUSINESS",
                                        stage: "BUSINESS_DOCUMENT",
                                        status: { in: this.mapAdminStatusToStageAttemptStatuses("PENDING") },
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        };
    }

    private buildKycTypeConditions(verificationType?: string): Prisma.UserWhereInput[] {
        if (!verificationType || verificationType === "all") {
            return [];
        }

        const typeMap: Record<string, Prisma.UserWhereInput> = {
            BVN: {
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
            NIN: {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: "GOVERNMENT_ID",
                                method: "NIN",
                            },
                        },
                    },
                    { nin: { not: null } },
                ],
            },
            DOCUMENT: {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: "IDENTITY_DOCUMENT",
                            },
                        },
                    },
                    { userDocument: { isNot: null } },
                ],
            },
            ADDRESS: {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: "ADDRESS",
                            },
                        },
                    },
                    { addressDocumentUrl: { not: null } },
                ],
            },
            INCOME: {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "INDIVIDUAL",
                                stage: "INCOME",
                            },
                        },
                    },
                    { incomeDocumentUrl: { not: null } },
                ],
            },
            BUSINESS_DOCUMENT: {
                OR: [
                    {
                        kycStageAttempts: {
                            some: {
                                isCurrent: true,
                                journeyType: "BUSINESS",
                                stage: "BUSINESS_DOCUMENT",
                            },
                        },
                    },
                    { businessDocument: { isNot: null } },
                ],
            },
        };

        return typeMap[verificationType] ? [typeMap[verificationType]] : [];
    }

    private buildKycSearchCondition(searchText?: string): Prisma.UserWhereInput | null {
        if (!searchText) {
            return null;
        }

        return {
            OR: [
                { firstName: { contains: searchText, mode: "insensitive" } },
                { lastName: { contains: searchText, mode: "insensitive" } },
                { email: { contains: searchText, mode: "insensitive" } },
                { phone: { contains: searchText, mode: "insensitive" } },
            ],
        };
    }

    private getKycQueueOrderBy(
        resolvedQueueView: KycQueueView,
        sortBy: "asc" | "desc",
    ) {
        if (resolvedQueueView === "ACTIONABLE") {
            return [{ updatedAt: sortBy }, { createdAt: sortBy }];
        }

        return [{ createdAt: sortBy }];
    }

    private buildVerificationSnapshot(user: any) {
        return buildIndividualVerificationSnapshot({
            userType: user?.userType,
            kycStageAttempts: user?.kycStageAttempts,
            bvn: user?.bvn,
            nin: user?.nin,
        });
    }

    private normalizeVerificationState(user: any) {
        const verificationSnapshot = this.buildVerificationSnapshot(user);

        return {
            ...user,
            emailVerified: user?.emailVerified ?? user?.isEmailVerified ?? false,
            phoneVerified: user?.phoneVerified ?? user?.isPhoneVerified ?? false,
            documentVerified: user?.documentVerified ?? user?.isDocumentVerified ?? false,
            verificationSnapshot,
        };
    }

    private getCurrentStageAttemptForVerificationType(user: any, verificationType: string) {
        switch (verificationType) {
            case "BVN":
                return getCurrentIndividualStageAttempt(user?.kycStageAttempts, "GOVERNMENT_ID", "BVN");
            case "NIN":
                return getCurrentIndividualStageAttempt(user?.kycStageAttempts, "GOVERNMENT_ID", "NIN");
            case "DOCUMENT":
                return getCurrentIndividualStageAttempt(user?.kycStageAttempts, "IDENTITY_DOCUMENT");
            case "ADDRESS":
                return getCurrentIndividualStageAttempt(user?.kycStageAttempts, "ADDRESS");
            case "INCOME":
                return getCurrentIndividualStageAttempt(user?.kycStageAttempts, "INCOME");
            case "BUSINESS_DOCUMENT":
                return (user?.kycStageAttempts ?? []).find(
                    (attempt: any) => attempt?.isCurrent !== false && attempt?.stage === "BUSINESS_DOCUMENT",
                ) ?? null;
            default:
                return null;
        }
    }

    private mapStageAttemptStatusToKycStatus(status?: string | null): KycStatus {
        switch (status) {
            case "APPROVED":
                return KycStatus.APPROVED;
            case "REJECTED":
            case "EXPIRED":
                return KycStatus.REJECTED;
            case "ESCALATED":
                return KycStatus.ESCALATED;
            case "SUBMITTED":
            case "PENDING_REVIEW":
            default:
                return KycStatus.PENDING;
        }
    }

    private mapKycStatusToStageAttemptStatus(status: KycStatus): KycAttemptStatus {
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

    private mapKycStatusToStageProviderStatus(status: KycStatus): string {
        switch (status) {
            case KycStatus.APPROVED:
                return "PASSED";
            case KycStatus.REJECTED:
                return "FAILED";
            case KycStatus.ESCALATED:
                return "INCONCLUSIVE";
            case KycStatus.PENDING:
            default:
                return "NOT_REQUESTED";
        }
    }

    private resolveStageManagedLookupStatus(
        user: any,
        verificationType: AdminKycProviderLookupType,
        isVerified: boolean,
        fallbackStatus?: DocumentVerificationStatus | null,
    ): KycStatus {
        const currentAttempt = this.getCurrentStageAttemptForVerificationType(user, verificationType);

        if (currentAttempt?.status) {
            return this.mapStageAttemptStatusToKycStatus(currentAttempt.status);
        }

        return this.resolveDocumentLookupStatus(fallbackStatus, isVerified);
    }

    private buildAdminVerificationSelect(): Prisma.UserSelect {
        return {
            id: true,
            email: true,
            tier: true,
            userType: true,
            bvn: true,
            nin: true,
            isDocumentVerified: true,
            documentVerificationStatus: true,
            businessDocumentVerificationStatus: true,
            addressDocumentUrl: true,
            incomeDocumentUrl: true,
            kycStageAttempts: {
                where: {
                    isCurrent: true,
                    journeyType: "INDIVIDUAL",
                    stage: { in: ["GOVERNMENT_ID", "ADDRESS", "INCOME"] },
                },
                select: {
                    stage: true,
                    method: true,
                    status: true,
                    isCurrent: true,
                },
            },
        };
    }

    private async applyStageManagedManualVerificationDecision(
        userId: number,
        verificationType: "BVN" | "NIN" | "ADDRESS" | "INCOME",
        isVerified: boolean,
        adminId?: number,
        note?: string,
    ): Promise<void> {
        const action: KycDecisionAction = isVerified ? "APPROVE" : "REJECT";
        const result = await this.transitionKycDecision({
            userId,
            verificationType,
            action,
            note,
            adminId,
        });

        if (result) {
            throw new BadRequestException(result.message);
        }
    }

    private async transitionKycDecision(params: {
        userId: number;
        verificationType: string;
        action: KycDecisionAction;
        note?: string;
        version?: number;
        adminId?: number;
    }): Promise<ApiResponse | null> {
        const { userId, verificationType, action, note, version, adminId } = params;
        const isAttemptOwnedDecision = this.isAttemptOwnedDecisionVerificationType(verificationType);
        const currentAttempt = await this.resolveDecisionBridgeContext(userId, verificationType);

        if (isAttemptOwnedDecision) {
            this.assertDecisionPreconditions({ activeVerification: null, currentAttempt, verificationType, action });
            return null;
        }

        const expectedVersion = this.resolveDecisionVersion(null, version);

        const kycStatusMap: Record<string, "APPROVED" | "REJECTED" | "ESCALATED"> = {
            APPROVE: "APPROVED",
            REJECT: "REJECTED",
            ESCALATE: "ESCALATED",
        };

        try {
            await this.kycStateMachine.transition(
                userId,
                verificationType,
                kycStatusMap[action],
                {
                    expectedVersion,
                    reviewerId: adminId,
                    reviewNote: note,
                },
            );
            return null;
        } catch (error) {
            if (error instanceof BadRequestException) {
                this.logger.warn(`KYC state transition rejected: ${error.message}`);
                return buildResponse({
                    message: error.message,
                    data: { userId, verificationType, action },
                });
            }
            throw error;
        }
    }

    private assertDecisionPreconditions(params: {
        activeVerification: { status: string } | null;
        currentAttempt?: { status?: string | null } | null;
        verificationType: string;
        action: KycDecisionAction;
    }): void {
        const { activeVerification, currentAttempt, verificationType, action } = params;
        const currentStatus = activeVerification?.status
            ?? (currentAttempt?.status ? this.mapStageAttemptStatusToAdminStatus(currentAttempt.status) : null);

        if (!currentStatus) {
            throw new BadRequestException(
                `No active ${verificationType} verification is awaiting admin action for this user.`,
            );
        }

        if (action === "ESCALATE" && currentStatus !== "PENDING") {
            throw new BadRequestException(
                `${verificationType} verification can only be escalated from PENDING state.`,
            );
        }

        if ((action === "APPROVE" || action === "REJECT") && !this.actionableStatuses.has(currentStatus)) {
            throw new BadRequestException(
                `${verificationType} verification is no longer actionable. Current status: ${currentStatus}.`,
            );
        }
    }

    private resolveDecisionVersion(
        activeVerification: { version?: number | null } | null,
        version?: number,
    ): number | undefined {
        if (typeof version === "number") {
            return version;
        }

        return typeof activeVerification?.version === "number"
            ? activeVerification.version
            : undefined;
    }

}
