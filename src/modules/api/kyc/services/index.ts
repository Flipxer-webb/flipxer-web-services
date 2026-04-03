import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse, ApiResponse } from "@/utils/api-response-util";
import { buildPaginationMeta } from "@/utils";
import { IdentityIdType, Prisma, UserType } from "@prisma/client";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay, startOfQuarter, endOfQuarter, startOfYear, endOfYear } from "date-fns";
import {
    GetKycQueueDto,
    KycDecisionDto,
    UpdateUserTierDto,
    UpdateUserVerificationDto,
    GetKycStatsDto,
    ApproveDocumentDto,
    RejectDocumentDto,
} from "../dtos";
import { TierService } from "@/modules/api/auth/services/tier.service";
import { KycStateMachineService } from "@/modules/api/auth/services/kyc-state-machine.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { EmailService } from "@/modules/core/email/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { IdentityResolutionService } from "@/modules/api/auth/services/identity-resolution.service";
import { emailTemplateConfig, mailConfig, COMPANY_NAME } from "@/config";

@Injectable()
export class KycService {
    private readonly logger = new Logger(KycService.name);
    private readonly getProfileCacheKey = (userId: number) => `user:profile:${userId}`;

    constructor(
        private readonly prisma: PrismaService,
        private readonly tierService: TierService,
        private readonly kycStateMachine: KycStateMachineService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly emailService: EmailService,
        private readonly redisCacheService: RedisCacheService,
        private readonly wsGateway: WsGateway,
        private readonly identityResolution: IdentityResolutionService,
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
        } else if (status === "APPROVED") {
            // Users who have completed all core verifications
            verificationFilter = {
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
            };
        } else if (status === "REJECTED") {
            // Users who have any active rejected KycVerification record
            verificationFilter = {
                kycVerifications: {
                    some: {
                        status: "REJECTED",
                        isActive: true,
                    } as any,
                },
            };
        } else if (status === "ESCALATED") {
            // Users who have any active escalated KycVerification record
            verificationFilter = {
                kycVerifications: {
                    some: {
                        status: "ESCALATED",
                        isActive: true,
                    } as any,
                },
            };
        }

        // Build verification type specific filter — keep separate to avoid OR key collisions
        const typeConditions: Prisma.UserWhereInput[] = [];
        if (verificationType && verificationType !== "all") {
            const typeMap: Record<string, Prisma.UserWhereInput> = {
                BVN: { isBvnVerified: false, bvn: { not: null } },
                NIN: { isNinVerified: false, nin: { not: null } },
                DOCUMENT: { isDocumentVerified: false, userDocument: { isNot: null } },
                ADDRESS: { isAddressVerified: false },
                INCOME: { isIncomeVerified: false },
                BUSINESS_DOCUMENT: { businessDocumentsUploaded: true, businessDocumentVerificationStatus: { not: "VERIFIED" } },
            };
            if (typeMap[verificationType]) typeConditions.push(typeMap[verificationType]);
        }

        // AND-compose all filters so OR clauses in different sub-filters never overwrite each other
        const andConditions: Prisma.UserWhereInput[] = [];
        if (Object.keys(verificationFilter).length > 0) andConditions.push(verificationFilter);
        if (typeConditions.length > 0) andConditions.push(...typeConditions);
        if (tier !== undefined) andConditions.push({ tier });
        if (searchText) {
            andConditions.push({
                OR: [
                    { firstName: { contains: searchText, mode: "insensitive" } },
                    { lastName: { contains: searchText, mode: "insensitive" } },
                    { email: { contains: searchText, mode: "insensitive" } },
                    { phone: { contains: searchText, mode: "insensitive" } },
                ],
            });
        }

        const where: Prisma.UserWhereInput = {
            userType: { not: UserType.ADMIN },
            ...(andConditions.length > 0 ? { AND: andConditions } : {}),
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
                DOCUMENT: { documentVerificationStatus: "DECLINED" },
                ADDRESS: { addressVerificationStatus: "DECLINED", addressDocumentUrl: null },
                INCOME: { incomeVerificationStatus: "DECLINED", incomeDocumentUrl: null },
                BUSINESS_DOCUMENT: { businessDocumentVerificationStatus: "DECLINED", businessDocumentsUploaded: false },
            };
            return rejectionMap[verificationType] || {};
        }

        return {};
    }

    async processKycDecision(dto: KycDecisionDto, adminId?: number): Promise<ApiResponse> {
        const { userId, action, note, verificationType } = dto;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        // Validate/record transition first so illegal transitions do not mutate user flags.
        if (verificationType) {
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
                        reviewerId: adminId,
                        reviewNote: note,
                    },
                );
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

        // Identity graph: link BVN/NIN to identity subject when admin marks verified
        await this.resolveIdentityForAdmin(dto, user, userId);

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
            pendingKyc,
            bvnVerified,
            ninVerified,
            documentVerified,
            newUsersInPeriod,
            usersUpdatedInPeriod,
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
                    OR: [
                        { isBvnVerified: false },
                        { isNinVerified: false },
                        { isDocumentVerified: false },
                    ],
                },
            }),

            this.prisma.user.count({ where: { ...nonAdminWhere, isBvnVerified: true } }),
            this.prisma.user.count({ where: { ...nonAdminWhere, isNinVerified: true } }),
            this.prisma.user.count({ where: { ...nonAdminWhere, isDocumentVerified: true } }),

            this.prisma.user.count({
                where: { ...nonAdminWhere, createdAt: { gte: startDate, lte: endDate } },
            }),

            this.prisma.user.count({
                where: {
                    ...nonAdminWhere,
                    tier: { gte: 2 },
                    updatedAt: { gte: startDate, lte: endDate },
                },
            }),
        ]);

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
                    pendingKyc,
                    kycCompletionRate: totalUsers > 0
                        ? (((totalUsers - pendingKyc) / totalUsers) * 100).toFixed(2)
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

}
