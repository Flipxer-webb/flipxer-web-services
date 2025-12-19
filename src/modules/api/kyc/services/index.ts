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
import { TierVerificationService } from "@/modules/api/auth/services/tier-verification.service";

@Injectable()
export class KycService {
    private readonly logger = new Logger(KycService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly tierService: TierService,
        private readonly tierVerificationService: TierVerificationService,
    ) {}

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
                BIOMETRIC: { isBiometricVerified: false },
                INCOME: { isIncomeVerified: false },
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
                    isBiometricVerified: true,
                    isIncomeVerified: true,
                    isEmailVerified: true,
                    isPhoneVerified: true,
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

        // Enrich with verification status summary and calculate tier dynamically
        const enrichedUsers = users.map((user) => ({
            ...user,
            // Calculate tier dynamically based on verification status
            tier: this.tierService.calculateTier(user),
            verificationSummary: {
                email: user.isEmailVerified,
                phone: user.isPhoneVerified,
                bvn: user.isBvnVerified,
                nin: user.isNinVerified,
                document: user.isDocumentVerified,
                address: user.isAddressVerified,
                biometric: user.isBiometricVerified,
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
                    tier: this.tierService.calculateTier(user),
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
                    biometric: { verified: user.isBiometricVerified },
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
        const { userId, action, note, newTier, verificationType } = dto;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user) {
            return buildResponse({ message: "User not found", data: null });
        }

        let updateData: Prisma.UserUpdateInput = {};

        if (action === "APPROVE") {
            // Update verification status based on type or all pending
            if (verificationType) {
                const verificationMap: Record<string, Prisma.UserUpdateInput> = {
                    BVN: { isBvnVerified: true },
                    NIN: { isNinVerified: true },
                    DOCUMENT: { isDocumentVerified: true },
                    ADDRESS: { isAddressVerified: true },
                    BIOMETRIC: { isBiometricVerified: true },
                    INCOME: { isIncomeVerified: true },
                };
                updateData = verificationMap[verificationType] || {};
            }

            // Update tier if specified
            if (newTier !== undefined) {
                updateData.tier = newTier;
            }
        } else if (action === "REJECT") {
            // For rejection, we might want to clear the submitted data
            // But typically we just note the rejection
        } else if (action === "ESCALATE") {
            // Mark for senior review - could add a flag
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
            },
        });

        // Create audit log
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: `KYC_${action}`,
                resource: "kyc",
                resourceId: userId.toString(),
                details: {
                    previousTier: user.tier,
                    newTier: updatedUser.tier,
                    verificationType,
                    note,
                },
            },
        });

        // TODO: Send notification to user about KYC status

        return buildResponse({
            message: `KYC ${action.toLowerCase()} processed successfully`,
            data: updatedUser,
        });
    }

    async processBulkKycDecision(dto: BulkKycDecisionDto, adminId?: number): Promise<ApiResponse> {
        const { userIds, action, note, newTier } = dto;

        const results = await Promise.allSettled(
            userIds.map((userId) =>
                this.processKycDecision(
                    { userId, action, note, newTier },
                    adminId
                )
            )
        );

        const successful = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected").length;

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

        const updatedUser = await this.prisma.user.update({
            where: { id: userId },
            data: { tier: dto.tier },
            select: {
                id: true,
                email: true,
                tier: true,
            },
        });

        // Update account limits based on tier
        await this.updateAccountLimits(userId, dto.tier);

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
        if (dto.isBiometricVerified !== undefined) {
            updateData.isBiometricVerified = dto.isBiometricVerified;
            changes.biometric = { from: user.isBiometricVerified, to: dto.isBiometricVerified };
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
                isBiometricVerified: true,
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

        return buildResponse({
            message: "User verification status updated successfully",
            data: updatedUser,
        });
    }

    // ==================== KYC STATISTICS ====================

    async getKycStats(query: GetKycStatsDto): Promise<ApiResponse> {
        const { startDate, endDate } = this.getDateRange(query.period || "month");

        // Fetch all non-admin users to calculate tiers dynamically
        const allUsers = await this.prisma.user.findMany({
            where: { userType: { not: UserType.ADMIN } },
            select: {
                id: true,
                userType: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isBiometricVerified: true,
                isIncomeVerified: true,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        const totalUsers = allUsers.length;

        // Calculate tier distribution dynamically
        let tier0Count = 0;
        let tier1Count = 0;
        let tier2Count = 0;
        let tier3Count = 0;

        for (const user of allUsers) {
            const calculatedTier = this.tierService.calculateTier(user);
            switch (calculatedTier) {
                case 0: tier0Count++; break;
                case 1: tier1Count++; break;
                case 2: tier2Count++; break;
                case 3: tier3Count++; break;
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
            (u) => u.updatedAt >= startDate && u.updatedAt <= endDate && this.tierService.calculateTier(u) >= 2
        ).length;

        return buildResponse({
            message: "KYC statistics retrieved successfully",
            data: {
                overview: {
                    totalUsers,
                    pendingKyc,
                    kycCompletionRate: totalUsers > 0
                        ? (((totalUsers - pendingKyc) / totalUsers) * 100).toFixed(2)
                        : 0,
                },
                tierDistribution: {
                    tier0: { count: tier0Count, percentage: ((tier0Count / totalUsers) * 100).toFixed(2) },
                    tier1: { count: tier1Count, percentage: ((tier1Count / totalUsers) * 100).toFixed(2) },
                    tier2: { count: tier2Count, percentage: ((tier2Count / totalUsers) * 100).toFixed(2) },
                    tier3: { count: tier3Count, percentage: ((tier3Count / totalUsers) * 100).toFixed(2) },
                },
                verificationBreakdown: {
                    bvn: { verified: bvnVerified, rate: ((bvnVerified / totalUsers) * 100).toFixed(2) },
                    nin: { verified: ninVerified, rate: ((ninVerified / totalUsers) * 100).toFixed(2) },
                    document: { verified: documentVerified, rate: ((documentVerified / totalUsers) * 100).toFixed(2) },
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
        return pending;
    }

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
        return await this.tierVerificationService.approveDocument(dto.userId, dto.documentType);
    }

    async rejectDocument(dto: RejectDocumentDto, adminId: number): Promise<ApiResponse> {
        this.logger.log(`Admin ${adminId} rejecting ${dto.documentType} document for user ${dto.userId}: ${dto.reason}`);
        return await this.tierVerificationService.rejectDocument(dto.userId, dto.documentType, dto.reason);
    }
}
