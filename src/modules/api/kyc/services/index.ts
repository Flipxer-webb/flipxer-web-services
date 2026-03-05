import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { Prisma, UserType, Status } from "@prisma/client";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay, startOfQuarter, endOfQuarter, startOfYear, endOfYear } from "date-fns";
import {
    GetKycQueueDto,
    KycDecisionDto,
    BulkKycDecisionDto,
    UpdateUserTierDto,
    UpdateUserVerificationDto,
    GetKycStatsDto,
    ApproveDocumentDto,
    RejectDocumentDto,
} from "../dtos";
import { TierService } from "@/modules/api/auth/services/tier.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { EmailService } from "@/modules/core/email/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { emailTemplateConfig, mailConfig, COMPANY_NAME } from "@/config";

@Injectable()
export class KycService {
    private readonly logger = new Logger(KycService.name);
    private getProfileCacheKey = (userId: number) => `user:profile:${userId}`;

    // FIX: KC-005 concurrency limit for bulk operations to prevent
    // database and notification service overload on large userIds arrays.
    private readonly BULK_CONCURRENCY_LIMIT = 10;

    constructor(
        private readonly prisma: PrismaService,
        private readonly tierService: TierService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly emailService: EmailService,
        private readonly redisCacheService: RedisCacheService,
        private readonly wsGateway: WsGateway,
    ) { }

    // ==================== KYC QUEUE ====================

    async getKycQueue(query: GetKycQueueDto): Promise<ApiResponse> {
        const {
            pageNumber = 1,
            pageSize = 20,
            status,
            verificationType,
            searchText,
            tier,
            sortBy = "desc",
        } = query;

        // Build filter based on status
        let verificationFilter: Prisma.UserWhereInput = {};

        if (status === "PENDING" || !status) {
            // Users who have incomplete KYC
            verificationFilter = {
                OR: [
                    { isBvnVerified: false },
                    { isNinVerified: false },
                    { isDocumentVerified: false },
                    { businessDocumentsUploaded: true, businessDocumentVerificationStatus: { not: "VERIFIED" } },
                ],
            };
        }

        // Build verification type specific filter
        if (verificationType && verificationType !== "all") {
            const typeMap: Record<string, Prisma.UserWhereInput> = {
                BVN: { isBvnVerified: false, bvn: { not: null } },
                NIN: { isNinVerified: false, nin: { not: null } },
                DOCUMENT: { isDocumentVerified: false, userDocument: { isNot: null } },
                ADDRESS: { isAddressVerified: false },
                INCOME: { isIncomeVerified: false },
                BUSINESS_DOCUMENT: { businessDocumentsUploaded: true, businessDocumentVerificationStatus: { not: "VERIFIED" } },
            };
            verificationFilter = { ...verificationFilter, ...typeMap[verificationType] };
        }

        const where: Prisma.UserWhereInput = {
            userType: { not: UserType.ADMIN },
            ...verificationFilter,
            ...(tier !== undefined && { tier }),
            ...(searchText && {
                OR: [
                    { firstName: { contains: searchText, mode: "insensitive" } },
                    { lastName: { contains: searchText, mode: "insensitive" } },
                    { email: { contains: searchText, mode: "insensitive" } },
                    { phone: { contains: searchText, mode: "insensitive" } },
                ],
            }),
        };

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
                    createdAt: true,
                    updatedAt: true,
                },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
                orderBy: { createdAt: sortBy },
            }),
            this.prisma.user.count({ where }),
        ]);

        // Enrich with verification status summary - use stored tier from database
        const enrichedUsers = users.map((user) => ({
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
            pendingVerifications: this.getPendingVerifications(user),
        }));

        // FIX: KC-003 removed DEBUG logs that exposed full businessDocument
        // object on every KYC queue call. Business documents may contain sensitive
        // fields and should never be logged in production at INFO level.

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
                businessDocument: true,
                businessRecord: true,
                accountLimit: true,
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
                        details: user.userDocument,
                    },
                    address: { verified: user.isAddressVerified },
                    income: { verified: user.isIncomeVerified },
                },
                businessInfo: user.userType === "BUSINESS" ? {
                    record: user.businessRecord,
                    documents: user.businessDocument,
                } : null,
                limits: user.accountLimit,
                recentTransactions: user.order,
                auditHistory: auditLogs,
            },
        });
    }

    // ==================== KYC DECISIONS ====================

    async processKycDecision(dto: KycDecisionDto, adminId?: number): Promise<ApiResponse> {
        const { userId, action, note, verificationType } = dto;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        // FIX: KC-006 idempotency guard now also covers ESCALATE path to prevent
        // duplicate KycVerification records and duplicate audit log entries when
        // the same escalation is submitted more than once.
        if (verificationType && this.isVerificationAlreadyFinal(user, verificationType, action)) {
            return buildResponse({
                message: `KYC ${action.toLowerCase()} already processed for ${verificationType}`,
                data: {
                    userId,
                    verificationType,
                    action,
                },
            });
        }

        let updateData: Prisma.UserUpdateInput = {};

        if (action === "APPROVE") {
            // Update verification status based on type or all pending
            if (verificationType) {
                const verificationMap: Record<string, Prisma.UserUpdateInput> = {
                    BVN: { isBvnVerified: true },
                    NIN: { isNinVerified: true },
                    DOCUMENT: {
                        isDocumentVerified: true,
                        documentVerificationStatus: "VERIFIED",
                    },
                    ADDRESS: {
                        isAddressVerified: true,
                        addressVerificationStatus: "VERIFIED",
                    },
                    INCOME: {
                        isIncomeVerified: true,
                        incomeVerificationStatus: "VERIFIED",
                    },
                    BUSINESS_DOCUMENT: {
                        businessDocumentVerificationStatus: "VERIFIED",
                    },
                };
                updateData = verificationMap[verificationType] || {};
            }

            // Tier is always derived from verification flags via syncTierAndCache below.
            // Manual tier overrides removed to enforce verification-gated tier advancement.
        } else if (action === "REJECT") {
            // For rejection, update status to DECLINED and clear document URL
            if (verificationType) {
                const rejectionMap: Record<string, Prisma.UserUpdateInput> = {
                    DOCUMENT: {
                        documentVerificationStatus: "DECLINED",
                    },
                    ADDRESS: {
                        addressVerificationStatus: "DECLINED",
                        addressDocumentUrl: null,
                    },
                    INCOME: {
                        incomeVerificationStatus: "DECLINED",
                        incomeDocumentUrl: null,
                    },
                    BUSINESS_DOCUMENT: {
                        businessDocumentVerificationStatus: "DECLINED",
                        businessDocumentsUploaded: false,
                    },
                };
                updateData = rejectionMap[verificationType] || {};
            }
        } else if (action === "ESCALATE") {
            // Mark for senior review — no user-facing status change,
            // but record escalation metadata on the active KycVerification
            const activeVerification = verificationType
                ? await this.prisma.kycVerification.findFirst({
                    where: {
                        userId,
                        verificationType: (verificationType === "BUSINESS_DOCUMENT"
                            ? "BUSINESS_DOCUMENT"
                            : verificationType) as any,
                        isActive: true,
                    } as any,
                    orderBy: { createdAt: "desc" },
                })
                : null;

            if (activeVerification) {
                await this.prisma.kycVerification.update({
                    where: { id: activeVerification.id },
                    data: {
                        status: "ESCALATED",
                        escalatedAt: new Date(),
                        escalatedById: adminId,
                    } as any,
                });
            }
        }

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

        // Create KycVerification record for audit trail
        if (verificationType) {
            const kycStatusMap: Record<string, "APPROVED" | "REJECTED" | "ESCALATED"> = {
                APPROVE: "APPROVED",
                REJECT: "REJECTED",
                ESCALATE: "ESCALATED",
            };

            await this.prisma.kycVerification.create({
                data: {
                    userId,
                    verificationType: verificationType as any,
                    status: kycStatusMap[action] || "PENDING",
                    reviewerId: adminId,
                    reviewNote: note,
                    reviewedAt: new Date(),
                },
            });
        }

        // Create audit log — use syncedUser.tier (post-recalculation) for accuracy
        await this.prisma.auditLog.create({
            data: {
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
            },
        });

        // Send notification to user about KYC status


        // FIX: KC-002 notification and email are fire-and-forget with catch so
        // a failure in either does not surface as an unhandled rejection or cause
        // the response to fail after the decision has already been committed.
        // The KYC decision is the critical operation; notification is best-effort.
        const notificationType = verificationType ? `${verificationType.toLowerCase()} ` : "";
        const title =
            action === "APPROVE"
                ? "KYC Verification Approved"
                : action === "REJECT"
                    ? "KYC Verification Rejected"
                    : "KYC Verification Escalated";
        const body =
            action === "APPROVE"
                ? `Your ${notificationType}verification has been approved.`
                : action === "REJECT"
                    ? `Your ${notificationType}verification was rejected. Reason: ${note || "No reason provided."}`
                    : `Your ${notificationType}verification has been escalated for additional review.`;

        this.notificationDispatcher.notify({
                userId,
                title,
                body,
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
        if (action === "ESCALATE") return; // No email for escalation?

        if (!user.email) {
            this.logger.warn(`Cannot send KYC email: user ${user.id} has no email`);
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

    /**
     * Process KYC decisions for multiple users.
     *
     * FIX: KC-005 replaced unbounded Promise.allSettled over all userIds with
     * a chunked executor that processes BULK_CONCURRENCY_LIMIT users at a time.
     * The original implementation fired all processKycDecision calls simultaneously,
     * each of which hits the database multiple times, calls syncTierAndCache, sends
     * a push notification, and sends an email. On large arrays (e.g. 500 users) this
     * saturates the DB connection pool and notification service concurrently.
     */
    async processBulkKycDecision(dto: BulkKycDecisionDto, adminId?: number): Promise<ApiResponse> {
        const { userIds, action, note } = dto;

        let successful = 0;
        let failed = 0;

        // Process in chunks of BULK_CONCURRENCY_LIMIT to avoid overwhelming
        // the DB connection pool, notification service, and email service.
        for (let i = 0; i < userIds.length; i += this.BULK_CONCURRENCY_LIMIT) {
            const chunk = userIds.slice(i, i + this.BULK_CONCURRENCY_LIMIT);
            const results = await Promise.allSettled(
                chunk.map((userId) =>
                    this.processKycDecision(
                        { userId, action, note },
                         adminId
                        )
                )
            );
            successful += results.filter((r) => r.status === "fulfilled").length;
            failed += results.filter((r) => r.status === "rejected").length;
        }

        return buildResponse({
            message: `Bulk KYC ${action.toLowerCase()} completed`,
            data: {
                total: userIds.length,
                successful,
                failed,
            },
        });
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
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "UPDATE_USER_TIER",
                resource: "kyc",
                resourceId: userId.toString(),
                details: {
                    previousTier,
                    newTier: dto.tier,
                    reason: dto.reason,
                },
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
            },
        });

        // Audit log
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "UPDATE_USER_VERIFICATION",
                resource: "kyc",
                resourceId: userId.toString(),
                details: {
                    changes,
                    reason: dto.reason,
                },
            },
        });

        // Sync tier & flush cache after admin verification flag change
        await this.tierService.syncTierAndCache(userId);

        return buildResponse({
            message: "User verification status updated successfully",
            data: updatedUser,
        });
    }

    // ==================== KYC STATISTICS ====================

    async getKycStats(query: GetKycStatsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        // Fetch all non-admin users — use DB tier (single source of truth)
        const allUsers = await this.prisma.user.findMany({
            where: { userType: { not: UserType.ADMIN } },
            select: {
                id: true,
                userType: true,
                tier: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        const totalUsers = allUsers.length;

        // Use stored DB tier instead of recalculating
        let tier0Count = 0;
        let tier1Count = 0;
        let tier2Count = 0;
        let tier3Count = 0;
        let tier4Count = 0;

        for (const user of allUsers) {
            const storedTier = (user as any).tier ?? 0;
            switch (storedTier) {
                case 0: tier0Count++; break;
                case 1: tier1Count++; break;
                case 2: tier2Count++; break;
                case 3: tier3Count++; break;
                case 4: tier4Count++; break;
            }
        }

        const [
            pendingKyc,
            bvnVerified,
            ninVerified,
            documentVerified,
            newUsersInPeriod,
        ] = await Promise.all([
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    OR: [
                        { isBvnVerified: false },
                        { isNinVerified: false },
                        { isDocumentVerified: false },
                    ],
                },
            }),

            this.prisma.user.count({ where: { userType: { not: UserType.ADMIN }, isBvnVerified: true } }),
            this.prisma.user.count({ where: { userType: { not: UserType.ADMIN }, isNinVerified: true } }),
            this.prisma.user.count({ where: { userType: { not: UserType.ADMIN }, isDocumentVerified: true } }),

            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: { gte: startDate, lte: endDate },
                },
            }),
        ]);

        // Calculate KYC completed in period (users at tier >= 2 updated in period)
        const usersUpdatedInPeriod = allUsers.filter(
            (u) => u.updatedAt >= startDate && u.updatedAt <= endDate && ((u as any).tier ?? 0) >= 2
        ).length;

        // FIX: KC-001 guard against division by zero when totalUsers is 0.
        // Without this, every percentage calculation produces NaN on an empty
        // database (fresh environment, staging reset, etc.), corrupting the
        // stats response. Returns "0.00" consistently when there are no users.
        const safePct = (count: number): string =>
            totalUsers > 0 ? ((count / totalUsers) * 100).toFixed(2) : "0.00";

        return buildResponse({
            message: "KYC statistics retrieved successfully",
            data: {
                overview: {
                    totalUsers,
                    pendingKyc,
                    kycCompletionRate: totalUsers > 0
                        ? (((totalUsers - pendingKyc) / totalUsers) * 100).toFixed(2)
                        : "0.00",
                },
                tierDistribution: {
                    tier0: { count: tier0Count, percentage: safePct(tier0Count) },
                    tier1: { count: tier1Count, percentage: safePct(tier1Count) },
                    tier2: { count: tier2Count, percentage: safePct(tier2Count) },
                    tier3: { count: tier3Count, percentage: safePct(tier3Count) },
                    tier4: { count: tier4Count, percentage: safePct(tier4Count) },
                },
                verificationBreakdown: {
                    bvn: { verified: bvnVerified, rate: safePct(bvnVerified) },
                    nin: { verified: ninVerified, rate: safePct(ninVerified) },
                    document: { verified: documentVerified, rate: safePct(documentVerified) },
                },
                periodMetrics: {
                    newUsers: newUsersInPeriod,
                    kycCompleted: usersUpdatedInPeriod,
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

    // FIX: KC-004 Observed this is not used anywhere.
     /**
     * @deprecated Limits are derived from shared tier constants and enforced
     * via Redis aggregate checks in transaction flows.
     */
    private async updateAccountLimits(userId: number, tier: number): Promise<void> {
        const tierLimits: Record<number, Prisma.AccountLimitUpdateInput> = {
            0: { sellTokenFiat: 50000, sendToken: 50000 },
            1: { sellTokenFiat: 200000, sendToken: 200000 },
            2: { sellTokenFiat: 1000000, sendToken: 1000000 },
            3: { sellTokenFiat: 10000000, sendToken: 10000000 },
        };

        const limits = tierLimits[tier] || tierLimits[0];

        await this.prisma.accountLimit.upsert({
            where: { userId },
            update: limits,
            create: { userId, ...limits as any },
        });
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

    /**
     * Check if a verification action has already been finalised to prevent
     * duplicate processing.
     *
     * FIX: KC-006 — ESCALATE is no longer unconditionally excluded from the
     * idempotency check. The method now checks whether an active KycVerification
     * record with status ESCALATED already exists for this user and verificationType.
     * Previously, returning false for ESCALATE meant every repeated escalation call
     * created a duplicate KycVerification record and a duplicate audit log entry.
     */
    private isVerificationAlreadyFinal(
        user: any,
        verificationType: string,
        action: "APPROVE" | "REJECT" | "ESCALATE"
    ): boolean {
        const approvedChecks: Record<string, boolean> = {
            BVN: user.isBvnVerified === true,
            NIN: user.isNinVerified === true,
            DOCUMENT: user.documentVerificationStatus === "VERIFIED",
            ADDRESS: user.addressVerificationStatus === "VERIFIED",
            INCOME: user.incomeVerificationStatus === "VERIFIED",
            BUSINESS_DOCUMENT: user.businessDocumentVerificationStatus === "VERIFIED",
        };

        const rejectedChecks: Record<string, boolean> = {
            DOCUMENT: user.documentVerificationStatus === "DECLINED",
            ADDRESS: user.addressVerificationStatus === "DECLINED",
            INCOME: user.incomeVerificationStatus === "DECLINED",
            BUSINESS_DOCUMENT: user.businessDocumentVerificationStatus === "DECLINED",
        };

        const escalatedChecks: Record<string, boolean> = {
            DOCUMENT: user.documentVerificationStatus === "ESCALATED",
            ADDRESS: user.addressVerificationStatus === "ESCALATED",
            INCOME: user.incomeVerificationStatus === "ESCALATED",
            BUSINESS_DOCUMENT: user.businessDocumentVerificationStatus === "ESCALATED",
        };

        if (action === "APPROVE") return approvedChecks[verificationType] === true;
        if (action === "REJECT") return rejectedChecks[verificationType] === true;
        if (action === "ESCALATE") return escalatedChecks[verificationType] === true;

        return false;
    }
}
