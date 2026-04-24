import { Injectable, Logger, BadRequestException, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta } from "@/utils";
import { DocumentVerificationStatus, IdentityIdType, KycStatus, KycVerificationType, Prisma, UserType } from "@prisma/client";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay, startOfQuarter, endOfQuarter, startOfYear, endOfYear } from "date-fns";
import {
    GetKycQueueDto,
    KycDecisionDto,
    UpdateUserTierDto,
    UpdateUserVerificationDto,
    GetKycStatsDto,
    ApproveDocumentDto,
    RejectDocumentDto,
    RunKycVerificationLookupDto,
} from "../dtos";
import type { AdminKycVerificationLookupType } from "../dtos";
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
import axios from "axios";

type KycQueueView = "ACTIONABLE" | "AWAITING_USER" | "RESOLVED" | "ALL";
type KycDecisionAction = "APPROVE" | "REJECT" | "ESCALATE";
type AdminLookupStatus = "SUCCESS" | "FAILED";
type AdminLookupOutcome = "SUCCESS" | "PARTIAL_FAILURE" | "FAILED";
type AdminLookupProvider = "DOJAH" | "OCR";

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
    lookupType: AdminKycVerificationLookupType;
    outcome: AdminLookupOutcome;
    lookedUpAt: string;
    requestedByAdminId?: number;
    activeVerificationId?: number | null;
    results: AdminKycLookupResult[];
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
                    isBvnVerified: true,
                    isNinVerified: true,
                    isDocumentVerified: true,
                    isAddressVerified: true,
                    isIncomeVerified: true,
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
                    addressVerificationStatus: true,
                    incomeDocumentUrl: true,
                    incomeVerificationStatus: true,
                    kycVerifications: {
                        where: { isActive: true },
                        select: {
                            id: true,
                            verificationType: true,
                            status: true,
                            submittedAt: true,
                            reviewedAt: true,
                            reviewNote: true,
                            reviewerId: true,
                            version: true,
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
            const queueMetadata = this.buildQueueMetadata(user, resolvedQueueView);

            return {
                ...user,
                // Use stored tier from database (not calculated) so admin resets persist
                tier: user.tier ?? 0,
                verificationSummary: {
                    email: user.isEmailVerified,
                    phone: user.isPhoneVerified,
                    bvn: user.isBvnVerified,
                    nin: user.isNinVerified,
                    document: user.isDocumentVerified,
                    address: user.isAddressVerified,
                    income: user.isIncomeVerified,
                },
                pendingVerifications: queueMetadata.pendingVerifications,
                needsReview: queueMetadata.needsReview,
                kycVerificationStatuses: queueMetadata.kycVerificationStatuses,
                queueView: resolvedQueueView,
                queueReason: queueMetadata.queueReason,
                actionableVerificationTypes: queueMetadata.actionableVerificationTypes,
                blockingVerificationTypes: queueMetadata.blockingVerificationTypes,
                oldestSubmittedAt: queueMetadata.oldestSubmittedAt,
                latestReviewState: queueMetadata.latestReviewState,
                latestReviewAt: queueMetadata.latestReviewAt,
                currentVerificationVersion: queueMetadata.currentVerificationVersion,
                queueSortAt: queueMetadata.queueSortAt,
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
                kycVerifications: {
                    orderBy: { submittedAt: "desc" },
                    select: {
                        id: true,
                        verificationType: true,
                        status: true,
                        reviewNote: true,
                        reviewedAt: true,
                        reviewerId: true,
                        providerRef: true,
                        providerRawResponse: true,
                        documentUrl: true,
                        submittedAt: true,
                        version: true,
                        isActive: true,
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
                verificationStatus: {
                    email: { verified: user.isEmailVerified },
                    phone: { verified: user.isPhoneVerified },
                    bvn: { verified: user.isBvnVerified, submitted: !!user.bvn },
                    nin: { verified: user.isNinVerified, submitted: !!user.nin },
                    document: {
                        verified: user.isDocumentVerified,
                        submitted: !!user.userDocument,
                        status: user.documentVerificationStatus,
                        details: user.userDocument,
                    },
                    address: {
                        verified: user.isAddressVerified,
                        submitted: !!user.addressDocumentUrl,
                        status: user.addressVerificationStatus,
                        details: {
                            documentUrl: user.addressDocumentUrl,
                            residentialAddress: user.residentialAddress,
                        },
                    },
                    income: {
                        verified: user.isIncomeVerified,
                        submitted: !!user.incomeDocumentUrl,
                        status: user.incomeVerificationStatus,
                        details: {
                            documentUrl: user.incomeDocumentUrl,
                        },
                    },
                    businessDocument: {
                        verified: user.businessDocumentVerificationStatus === DocumentVerificationStatus.VERIFIED,
                        submitted: user.businessDocumentsUploaded,
                        status: user.businessDocumentVerificationStatus,
                        details: user.businessDocument,
                    },
                },
                businessInfo: user.userType === "BUSINESS" ? {
                    record: user.businessRecord,
                    documents: user.businessDocument,
                    submitted: user.businessDocumentsUploaded,
                    status: user.businessDocumentVerificationStatus,
                } : null,
                kycVerifications: user.kycVerifications.filter((record) => record.isActive),
                kycVerificationHistory: user.kycVerifications,
                limits: user.accountLimit,
                recentTransactions: user.order,
                auditHistory: auditLogs,
            },
        });
    }

    async runVerificationLookup(dto: RunKycVerificationLookupDto, adminId?: number): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: dto.userId },
            include: {
                userDocument: true,
                businessDocument: true,
                businessRecord: true,
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
                kycVerificationHistoryId: persistedLookupRecord.id,
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
        verificationType: AdminKycVerificationLookupType,
        results: AdminKycLookupResult[],
        outcome: AdminLookupOutcome,
        lookedUpAt: string,
        adminId?: number,
    ): Promise<{ id: number }> {
        const activeRecord = await this.prisma.kycVerification.findFirst({
            where: {
                userId: user.id,
                verificationType: verificationType as KycVerificationType,
                isActive: true,
            },
            orderBy: { version: "desc" },
            select: {
                id: true,
                status: true,
                version: true,
                documentUrl: true,
                providerRef: true,
            },
        });

        const payload: PersistedAdminLookupHistoryPayload = {
            source: "ADMIN_PROVIDER_LOOKUP",
            lookupType: verificationType,
            outcome,
            lookedUpAt,
            requestedByAdminId: adminId,
            activeVerificationId: activeRecord?.id ?? null,
            results,
        };

        return await this.prisma.kycVerification.create({
            data: {
                userId: user.id,
                verificationType: verificationType as KycVerificationType,
                status: this.resolveLookupHistoryStatus(user, verificationType, activeRecord?.status),
                version: activeRecord?.version ?? 1,
                isActive: false,
                reviewerId: adminId,
                reviewNote: this.buildLookupHistoryNote(verificationType, outcome, results),
                documentUrl: results.find((result) => result.documentUrl)?.documentUrl ?? activeRecord?.documentUrl ?? undefined,
                providerRef: results.find((result) => result.providerRef)?.providerRef ?? activeRecord?.providerRef ?? undefined,
                providerRawResponse: payload,
                reviewedAt: new Date(),
            } as any,
            select: { id: true },
        });
    }

    private resolveLookupHistoryStatus(
        user: any,
        verificationType: AdminKycVerificationLookupType,
        activeStatus?: KycStatus,
    ): KycStatus {
        if (activeStatus) {
            return activeStatus;
        }

        const fallbackStatusByVerificationType: Record<AdminKycVerificationLookupType, KycStatus> = {
            BVN: user.isBvnVerified ? KycStatus.APPROVED : KycStatus.PENDING,
            NIN: user.isNinVerified ? KycStatus.APPROVED : KycStatus.PENDING,
            DOCUMENT: this.resolveDocumentLookupStatus(user.documentVerificationStatus, user.isDocumentVerified),
            ADDRESS: this.resolveDocumentLookupStatus(user.addressVerificationStatus, user.isAddressVerified),
            INCOME: this.resolveDocumentLookupStatus(user.incomeVerificationStatus, user.isIncomeVerified),
            BUSINESS_DOCUMENT: this.resolveDocumentLookupStatus(user.businessDocumentVerificationStatus),
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
        verificationType: AdminKycVerificationLookupType,
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

            return {
                key: "INCOME",
                label: "Income OCR lookup",
                status: validation.isValid ? "SUCCESS" : "FAILED",
                provider: "OCR",
                providerRef: null,
                summary: {
                    verified: validation.isValid,
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

    private async downloadLookupDocument(rawUrl: string): Promise<{ buffer: Buffer; mimeType?: string }> {
        const trustedUrl = this.resolveTrustedDocumentUrl(rawUrl);
        if (!trustedUrl) {
            throw new BadRequestException("Stored document URL is not trusted for investigative lookup");
        }

        const response = await axios.get<ArrayBuffer>(trustedUrl.toString(), {
            responseType: "arraybuffer",
            timeout: 30000,
            maxRedirects: 0,
        });

        const contentType = Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"][0]
            : response.headers["content-type"];

        return {
            buffer: Buffer.from(response.data),
            mimeType: typeof contentType === "string" ? contentType : undefined,
        };
    }

    private buildKycUpdateData(action: string, verificationType?: string): Prisma.UserUpdateInput {
        if (!verificationType) return {};

        if (action === "APPROVE") {
            const verificationMap: Record<string, Prisma.UserUpdateInput> = {
                BVN: { isBvnVerified: true },
                NIN: { isNinVerified: true },
                DOCUMENT: { isDocumentVerified: true, documentVerificationStatus: "VERIFIED" },
                ADDRESS: { isAddressVerified: true, addressVerificationStatus: "VERIFIED" },
                INCOME: { isIncomeVerified: true, incomeVerificationStatus: "VERIFIED" },
                BUSINESS_DOCUMENT: { isDocumentVerified: true, businessDocumentVerificationStatus: "VERIFIED" },
            };
            return verificationMap[verificationType] || {};
        }

        if (action === "REJECT") {
            const rejectionMap: Record<string, Prisma.UserUpdateInput> = {
                BVN: { isBvnVerified: false },
                NIN: { isNinVerified: false },
                DOCUMENT: { isDocumentVerified: false, documentVerificationStatus: "DECLINED" },
                ADDRESS: { isAddressVerified: false, addressVerificationStatus: "DECLINED", addressDocumentUrl: null },
                INCOME: { isIncomeVerified: false, incomeVerificationStatus: "DECLINED", incomeDocumentUrl: null },
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
        if (dto.isDocumentVerified !== undefined) {
            const documentStatus = dto.isDocumentVerified ? DocumentVerificationStatus.VERIFIED : null;

            if (userType === UserType.BUSINESS) {
                updateData.businessDocumentVerificationStatus = documentStatus;
            } else {
                updateData.documentVerificationStatus = documentStatus;
            }
        }

        if (dto.isAddressVerified !== undefined) {
            updateData.addressVerificationStatus = dto.isAddressVerified
                ? DocumentVerificationStatus.VERIFIED
                : null;
        }

        if (dto.isIncomeVerified !== undefined) {
            updateData.incomeVerificationStatus = dto.isIncomeVerified
                ? DocumentVerificationStatus.VERIFIED
                : null;
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

        const updatedUser = await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                email: true,
                tier: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
                addressVerificationStatus: true,
                incomeVerificationStatus: true,
                documentVerificationStatus: true,
            },
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

        // Send notification to user about KYC status
        const notificationType = verificationType ? `${verificationType.toLowerCase()} ` : "";

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
                this.logger.error(`Failed to send KYC escalation email to ${user.email}: ${error.message}`);
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
            this.logger.error(`Failed to send KYC email to ${user.email}: ${error.message}`);
        }
    }

    // ==================== USER TIER MANAGEMENT ====================

    async updateUserTier(userId: number, dto: UpdateUserTierDto, adminId?: number): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
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
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        const updateData: Prisma.UserUpdateInput = {};
        const changes: Record<string, any> = {};

        // Guard: cannot mark BVN verified if user has no BVN on file
        if (dto.isBvnVerified === true && !user.bvn) {
            throw new BadRequestException(
                "Cannot set BVN verified — user has no BVN on file. The user must complete BVN verification first.",
            );
        }
        // Guard: cannot mark NIN verified if user has no NIN on file
        if (dto.isNinVerified === true && !user.nin) {
            throw new BadRequestException(
                "Cannot set NIN verified — user has no NIN on file. The user must complete NIN verification first.",
            );
        }

        if (dto.isBvnVerified !== undefined) {
            updateData.isBvnVerified = dto.isBvnVerified;
            changes.bvn = { from: user.isBvnVerified, to: dto.isBvnVerified };
        }
        if (dto.isNinVerified !== undefined) {
            updateData.isNinVerified = dto.isNinVerified;
            changes.nin = { from: user.isNinVerified, to: dto.isNinVerified };
        }
        if (dto.isDocumentVerified !== undefined) {
            updateData.isDocumentVerified = dto.isDocumentVerified;
            changes.document = { from: user.isDocumentVerified, to: dto.isDocumentVerified };
        }
        if (dto.isAddressVerified !== undefined) {
            updateData.isAddressVerified = dto.isAddressVerified;
            changes.address = { from: user.isAddressVerified, to: dto.isAddressVerified };
        }
        if (dto.isIncomeVerified !== undefined) {
            updateData.isIncomeVerified = dto.isIncomeVerified;
            changes.income = { from: user.isIncomeVerified, to: dto.isIncomeVerified };
        }

        this.normalizeManualVerificationStatuses(user.userType, updateData, dto);

        const updatedUser = await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                email: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
                documentVerificationStatus: true,
                addressVerificationStatus: true,
                incomeVerificationStatus: true,
                businessDocumentVerificationStatus: true,
            },
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

        if (dto.isBvnVerified === true && user.bvn) {
            await this.identityResolution.resolveOrCreate(IdentityIdType.BVN, user.bvn, userId, biographic);
        }
        if (dto.isNinVerified === true && user.nin) {
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
                    kycVerifications: {
                        some: { status: "PENDING", isActive: true } as any,
                    },
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
                    kycVerifications: {
                        some: { status: "ESCALATED", isActive: true } as any,
                    },
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    kycVerifications: {
                        some: { status: "REJECTED", isActive: true } as any,
                    },
                },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    kycVerifications: {
                        some: {
                            status: { in: ["APPROVED", "REJECTED"] },
                            isActive: true,
                            reviewedAt: { gte: startDate, lte: endDate },
                        } as any,
                    },
                },
            }),

            this.prisma.user.count({ where: { ...nonAdminWhere, isBvnVerified: true } }),
            this.prisma.user.count({ where: { ...nonAdminWhere, isNinVerified: true } }),
            this.prisma.user.count({ where: { ...nonAdminWhere, isDocumentVerified: true } }),

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

    private getPendingVerifications(user: any): string[] {
        const pending: string[] = [];
        if (!user.isEmailVerified) pending.push("email");
        if (!user.isPhoneVerified) pending.push("phone");
        if (!user.isBvnVerified && user.bvn) pending.push("bvn");
        if (!user.isNinVerified && user.nin) pending.push("nin");
        if (!user.isDocumentVerified && user.userDocument) pending.push("document");
        if (!user.isAddressVerified) pending.push("address");
        if (!user.isIncomeVerified) pending.push("income");
        if (user.userType === "BUSINESS" && user.businessDocumentsUploaded && user.businessDocumentVerificationStatus !== "VERIFIED") {
            pending.push("businessDocument");
        }
        return pending;
    }

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

    private buildQueueMetadata(user: any, queueView: KycQueueView) {
        const activeVerifications = [...(user.kycVerifications || [])].sort(
            (left, right) => new Date(left.submittedAt).getTime() - new Date(right.submittedAt).getTime(),
        );
        const kycVerificationStatuses: Record<string, string> = {};
        for (const kv of activeVerifications) {
            kycVerificationStatuses[kv.verificationType] = kv.status;
        }

        const actionableVerifications = activeVerifications.filter((kv) => kv.status === "PENDING");
        const latestVerification = [...activeVerifications].sort(
            (left, right) => {
                const leftTime = new Date(left.reviewedAt || left.submittedAt).getTime();
                const rightTime = new Date(right.reviewedAt || right.submittedAt).getTime();
                return rightTime - leftTime;
            },
        )[0];
        const blockingVerificationTypes = this.getBlockingVerificationTypes(user);
        const pendingVerifications = actionableVerifications.length > 0
            ? actionableVerifications.map((kv) => this.mapVerificationTypeToPendingKey(kv.verificationType))
            : blockingVerificationTypes;
        const queueReason = actionableVerifications.length > 0
            ? this.getSubmittedForReviewReason(actionableVerifications)
            : this.getAwaitingUserReason(blockingVerificationTypes, user.userType);
        const oldestSubmittedAt = actionableVerifications[0]?.submittedAt ?? null;

        return {
            pendingVerifications,
            needsReview: actionableVerifications.length > 0,
            kycVerificationStatuses,
            queueReason,
            actionableVerificationTypes: actionableVerifications.map((kv) => kv.verificationType),
            blockingVerificationTypes,
            oldestSubmittedAt,
            latestReviewState: latestVerification?.status ?? null,
            latestReviewAt: latestVerification?.reviewedAt ?? null,
            currentVerificationVersion: actionableVerifications[0]?.version ?? latestVerification?.version ?? null,
            queueSortAt: oldestSubmittedAt || latestVerification?.submittedAt || user.updatedAt || user.createdAt,
            queueView,
        };
    }

    private getBlockingVerificationTypes(user: any): string[] {
        const pending: string[] = [];
        if (!user.isEmailVerified) pending.push("EMAIL");
        if (!user.isPhoneVerified) pending.push("PHONE");
        if (!user.isBvnVerified && !user.bvn) pending.push("BVN");
        if (!user.isNinVerified && !user.nin) pending.push("NIN");
        if (!user.isDocumentVerified && !user.userDocument) pending.push("DOCUMENT");
        if (!user.isAddressVerified && !user.addressDocumentUrl) pending.push("ADDRESS");
        if (!user.isIncomeVerified && !user.incomeDocumentUrl) pending.push("INCOME");
        if (user.userType === UserType.BUSINESS && !user.businessDocumentsUploaded) pending.push("BUSINESS_DOCUMENT");
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

    private mapVerificationTypeToPendingKey(verificationType: string): string {
        const map: Record<string, string> = {
            EMAIL: "email",
            PHONE: "phone",
            BVN: "bvn",
            NIN: "nin",
            DOCUMENT: "document",
            ADDRESS: "address",
            INCOME: "income",
            BUSINESS_DOCUMENT: "businessDocument",
        };
        return map[verificationType] || verificationType.toLowerCase();
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
        if (status === "APPROVED" || status === "REJECTED" || status === "ESCALATED") {
            return {
                kycVerifications: {
                    some: {
                        status,
                        isActive: true,
                    } as any,
                },
            };
        }

        if (resolvedQueueView === "ACTIONABLE") {
            return {
                kycVerifications: {
                    some: {
                        status: "PENDING",
                        isActive: true,
                    } as any,
                },
            };
        }

        if (resolvedQueueView === "AWAITING_USER") {
            return this.buildAwaitingUserFilter();
        }

        if (resolvedQueueView === "RESOLVED") {
            return {
                kycVerifications: {
                    some: {
                        status: { in: ["APPROVED", "REJECTED", "ESCALATED"] },
                        isActive: true,
                    } as any,
                },
            };
        }

        return {};
    }

    private buildAwaitingUserFilter(): Prisma.UserWhereInput {
        return {
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
                            } as any,
                        },
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
            BVN: { isBvnVerified: false, bvn: { not: null } },
            NIN: { isNinVerified: false, nin: { not: null } },
            DOCUMENT: { isDocumentVerified: false, userDocument: { isNot: null } },
            ADDRESS: { isAddressVerified: false },
            INCOME: { isIncomeVerified: false },
            BUSINESS_DOCUMENT: { businessDocumentsUploaded: true, businessDocumentVerificationStatus: { not: "VERIFIED" } },
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

    private async transitionKycDecision(params: {
        userId: number;
        verificationType: string;
        action: KycDecisionAction;
        note?: string;
        version?: number;
        adminId?: number;
    }): Promise<ApiResponse | null> {
        const { userId, verificationType, action, note, version, adminId } = params;
        const activeVerification = await this.prisma.kycVerification.findFirst({
            where: {
                userId,
                verificationType: verificationType as any,
                isActive: true,
            },
            orderBy: { version: "desc" },
        });

        this.assertDecisionPreconditions({ activeVerification, verificationType, action });
        const expectedVersion = this.resolveDecisionVersion(activeVerification, version);

        const kycStatusMap: Record<string, "APPROVED" | "REJECTED" | "ESCALATED"> = {
            APPROVE: "APPROVED",
            REJECT: "REJECTED",
            ESCALATE: "ESCALATED",
        };

        try {
            await this.kycStateMachine.transition(
                userId,
                verificationType as any,
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
        verificationType: string;
        action: KycDecisionAction;
    }): void {
        const { activeVerification, verificationType, action } = params;

        if (!activeVerification) {
            throw new BadRequestException(
                `No active ${verificationType} verification is awaiting admin action for this user.`,
            );
        }

        if (action === "ESCALATE" && activeVerification.status !== "PENDING") {
            throw new BadRequestException(
                `${verificationType} verification can only be escalated from PENDING state.`,
            );
        }

        if ((action === "APPROVE" || action === "REJECT") && !this.actionableStatuses.has(activeVerification.status)) {
            throw new BadRequestException(
                `${verificationType} verification is no longer actionable. Current status: ${activeVerification.status}.`,
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
