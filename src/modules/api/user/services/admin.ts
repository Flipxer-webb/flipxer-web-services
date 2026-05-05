// admin-user.service.ts
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { HttpStatus, Injectable } from "@nestjs/common";
import {
    startOfDay,
    endOfDay,
    startOfWeek,
    endOfWeek,
    startOfMonth,
    endOfMonth,
    startOfQuarter,
    endOfQuarter,
    startOfYear,
    endOfYear,
} from "date-fns";
import {
    GetUserListDto,
    UnflagUserDto,
    FlagUserDto,
    SetLimitOverrideDto,
    RemoveLimitOverrideDto,
} from "../dtos";
import { Prisma, User, UserType, EntryStatus } from "@prisma/client";
import { UserNotFoundException } from "../errors";
import {
    shapeTransaction,
    TransactionIncludeOptions,
} from "../../transactions/types";
import { GetUserTransactionListDto } from "../../transactions/dtos";
import {
    TIER_WITHDRAWAL_LIMITS,
    TierLevel,
} from "@/modules/shared/tier-limits";
import { AuditLogService } from "@/modules/api/audit-log";
import { UserService } from ".";

const EXCLUDED_ADMIN_USER_TYPES: UserType[] = [
    UserType.ADMIN,
    UserType.SUPER_ADMIN,
];
const CUSTOMER_USER_TYPES = new Set<UserType>([
    UserType.INDIVIDUAL,
    UserType.BUSINESS,
]);

@Injectable()
export class AdminUserService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly emailService: EmailService,
        private readonly auditLogService: AuditLogService,
        private readonly userService: UserService,
    ) {}

    private buildUserInfoSelect(): Prisma.UserSelect {
        return {
            id: true,
            userType: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            bvn: true,
            nin: true,
            gender: true,
            country: true,
            dateOfBirth: true,
            status: true,
            tier: true,
            createdAt: true,
            recoveryEmail: true,
            isEmailVerified: true,
            isPhoneVerified: true,
            businessDocumentVerificationStatus: true,
            businessRecordCompleted: true,
            businessDocument: true,
            userDocument: true,
            businessRecord: true,
            kycStageAttempts: {
                where: {
                    isCurrent: true,
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
                select: {
                    id: true,
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
            flaggedRecord: {
                select: {
                    flagged: true,
                    reason: true,
                },
            },
        };
    }

    async getAnalyticsOverview(
        period?: string,
        startDateStr?: string,
        endDateStr?: string,
    ): Promise<ApiResponse> {
        const { startDate, endDate } =
            startDateStr && endDateStr
                ? {
                      startDate: new Date(startDateStr),
                      endDate: endOfDay(new Date(endDateStr)),
                  }
                : this.getDateRange(period || "month");

        const [totalUsers, usersInPeriod] = await Promise.all([
            // Exclude admin users from total count
            this.prisma.user.count({
                where: { userType: { notIn: EXCLUDED_ADMIN_USER_TYPES } },
            }),
            this.prisma.user.count({
                where: {
                    userType: { notIn: EXCLUDED_ADMIN_USER_TYPES },
                    createdAt: {
                        gte: startDate,
                        lte: endDate,
                    },
                },
            }),
        ]);

        const [totalTransactionVolume, transactionsInPeriod] =
            await Promise.all([
                this.prisma.order.aggregate({
                    _sum: { amountInFiat: true },
                    where: {
                        streamlinedStatus: "completed",
                    },
                }),
                this.prisma.order.aggregate({
                    _sum: { amountInFiat: true },
                    where: {
                        streamlinedStatus: "completed",
                        createdAt: {
                            gte: startDate,
                            lte: endDate,
                        },
                    },
                }),
            ]);
        return buildResponse({
            message: "Analytics Overview successfully retrieved",
            data: {
                totalUsers,
                usersInPeriod,
                totalTransactionVolume:
                    totalTransactionVolume?._sum.amountInFiat || 0,
                transactionsInPeriod:
                    transactionsInPeriod?._sum.amountInFiat || 0,
            },
        });
    }

    private buildUserListWhere(query: GetUserListDto): Prisma.UserWhereInput {
        const where: Prisma.UserWhereInput = {
            userType: { notIn: EXCLUDED_ADMIN_USER_TYPES },
        };
        if (query.status) where.status = query.status;
        if (query.accountType && CUSTOMER_USER_TYPES.has(query.accountType)) {
            where.userType = query.accountType;
        }
        if (query.searchText) {
            where.OR = [
                {
                    firstName: {
                        contains: query.searchText,
                        mode: "insensitive",
                    },
                },
                {
                    lastName: {
                        contains: query.searchText,
                        mode: "insensitive",
                    },
                },
                { email: { contains: query.searchText, mode: "insensitive" } },
                { phone: { contains: query.searchText, mode: "insensitive" } },
            ];
        }
        if (query.startDate || query.endDate) {
            where.createdAt = {
                ...(query.startDate && { gte: new Date(query.startDate) }),
                ...(query.endDate && { lte: new Date(query.endDate) }),
            };
        }
        if (query.tier !== undefined && query.tier !== "") {
            where.tier = Number.parseInt(query.tier as any, 10);
        }
        return where;
    }

    /** Aggregate user balances from ledger, returning a userId→totalBalance map. */
    private async getUserBalanceMap(): Promise<Map<number, number>> {
        const usersWithBalance = await this.prisma.ledgerEntry.findMany({
            where: {
                userId: { gt: 0 },
                status: { in: [EntryStatus.SETTLED, EntryStatus.HOLD] },
            },
            select: { userId: true, balanceAfter: true },
            orderBy: { sequenceNumber: "desc" },
            distinct: ["userId", "currency"],
        });
        const map = new Map<number, number>();
        for (const entry of usersWithBalance) {
            const current = map.get(entry.userId) || 0;
            map.set(entry.userId, current + Number(entry.balanceAfter));
        }
        return map;
    }

    /** Mutates dbQuery.where to filter by has_balance / zero_balance. */
    private async applyBalanceFilter(
        dbQuery: Prisma.UserFindManyArgs,
        filter: "has_balance" | "zero_balance",
    ): Promise<void> {
        const balanceMap = await this.getUserBalanceMap();
        const userIdsWithBalance = Array.from(balanceMap.entries())
            .filter(([, total]) => total > 0)
            .map(([id]) => id);

        dbQuery.where = {
            ...dbQuery.where,
            id:
                filter === "has_balance"
                    ? { in: userIdsWithBalance }
                    : { notIn: userIdsWithBalance },
        };
    }

    /** Return paginated user list sorted by ledger balance. */
    private async getUserListSortedByBalance(
        dbQuery: Prisma.UserFindManyArgs,
        query: GetUserListDto,
        pageNumber: number,
        pageSize: number,
    ) {
        const balanceMap = await this.getUserBalanceMap();

        const allFilteredUsers = await this.prisma.user.findMany({
            where: dbQuery.where,
            select: { id: true },
        });

        const sortedUserIds = allFilteredUsers
            .map((u) => ({ id: u.id, balance: balanceMap.get(u.id) || 0 }))
            .sort((a, b) =>
                query.balanceFilter === "highest_first"
                    ? b.balance - a.balance
                    : a.balance - b.balance,
            )
            .map((u) => u.id);

        const count = sortedUserIds.length;

        const paginatedIds =
            query.paginated === "true"
                ? sortedUserIds.slice(
                      (pageNumber - 1) * pageSize,
                      pageNumber * pageSize,
                  )
                : sortedUserIds;

        const usersRaw = await this.prisma.user.findMany({
            where: { ...dbQuery.where, id: { in: paginatedIds } },
            select: dbQuery.select,
        });

        const userMap = new Map(usersRaw.map((u) => [u.id, u]));
        const users = paginatedIds
            .map((id) => userMap.get(id))
            .filter(Boolean) as User[];

        const responseData: DataWithPagination<User> = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    pageNumber,
                    pageSize,
                    count,
                    users.length,
                ),
            }),
            records: users,
        };

        return buildResponse({
            message: "Users list retrieved",
            data: responseData,
        });
    }

    async getUserList(query: GetUserListDto) {
        const { pageNumber, pageSize, sortBy } = query;

        const resolvedPageNumber: number =
            !pageNumber || pageNumber <= 1
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize: number =
            !pageSize || pageSize <= 0
                ? defaultPagination.pageSize
                : query.pageSize;

        const where = this.buildUserListWhere(query);

        const dbQuery: Prisma.UserFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                photo: true,
                status: true,
                userType: true,
                tier: true,
                createdAt: true,
                flaggedRecord: {
                    select: {
                        flagged: true,
                        reason: true,
                    },
                },
            },
        };

        // Handle balance-based filtering/sorting
        if (
            query.balanceFilter === "has_balance" ||
            query.balanceFilter === "zero_balance"
        ) {
            await this.applyBalanceFilter(dbQuery, query.balanceFilter);
        }

        if (
            query.balanceFilter === "highest_first" ||
            query.balanceFilter === "lowest_first"
        ) {
            return this.getUserListSortedByBalance(
                dbQuery,
                query,
                resolvedPageNumber,
                resolvedPageSize,
            );
        }

        const [users, count] = await this.prisma.$transaction([
            this.prisma.user.findMany({
                ...dbQuery,
                ...(query.paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
            this.prisma.user.count({ where: dbQuery.where }),
        ]);

        const responseData: DataWithPagination<User> = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    users.length,
                ),
            }),
            records: users,
        };

        return buildResponse({
            message: "Users list retrieved",
            data: responseData,
        });
    }

    async getUserFilteredStats(query: GetUserListDto): Promise<ApiResponse> {
        const baseWhere = this.buildUserListWhere(query);

        const total = await this.prisma.user.count({ where: baseWhere });
        const active = await this.countActive(query, baseWhere, total);
        const { verified, pendingKyc } = await this.countKycStats(
            query,
            baseWhere,
            total,
        );

        return buildResponse({
            message: "User filtered stats retrieved",
            data: { total, active, verified, pendingKyc },
        });
    }

    private async countActive(
        query: GetUserListDto,
        baseWhere: Prisma.UserWhereInput,
        total: number,
    ): Promise<number> {
        if (query.status) {
            return query.status === "ACTIVE" ? total : 0;
        }
        return this.prisma.user.count({
            where: { ...baseWhere, status: "ACTIVE" },
        });
    }

    private async countKycStats(
        query: GetUserListDto,
        baseWhere: Prisma.UserWhereInput,
        total: number,
    ): Promise<{ verified: number; pendingKyc: number }> {
        if (query.tier !== undefined && query.tier !== "") {
            const tierNum = Number.parseInt(query.tier as any, 10);
            return {
                verified: tierNum >= 1 ? total : 0,
                pendingKyc: tierNum === 0 ? total : 0,
            };
        }
        const [verified, pendingKyc] = await Promise.all([
            this.prisma.user.count({
                where: { ...baseWhere, tier: { gte: 1 } },
            }),
            this.prisma.user.count({ where: { ...baseWhere, tier: 0 } }),
        ]);
        return { verified, pendingKyc };
    }

    async getUserInfo(userId: number): Promise<ApiResponse> {
        const userInfoSelect = this.buildUserInfoSelect();

        let userDetail = await this.prisma.user.findUnique({
            where: { id: userId },
            select: userInfoSelect,
        });

        if (!userDetail) {
            throw new UserNotFoundException(
                "User not found",
                HttpStatus.NOT_FOUND,
            );
        }

        const {
            identifier: _identifier,
            photo: _photo,
            accountLimit: _accountLimit,
            isEmailVerified,
            isPhoneVerified,
            isDocumentVerified: _isDocumentVerified,
            isPasswordCreated: _isPasswordCreated,
            documentVerificationStatus: _documentVerificationStatus,
            businessDocumentsUploaded: _businessDocumentsUploaded,
            businessDocumentVerificationStatus,
            businessRecordCompleted,
            kycStageAttempts: _kycStageAttempts,
            ...resolvedUserDetail
        } = userDetail;
        const {
            bvn: _bvn,
            nin: _nin,
            ...sanitizedUserDetail
        } = resolvedUserDetail;
        const kycJourney =
            userDetail.userType === UserType.INDIVIDUAL
                ? this.userService.buildKycReadModel(userDetail).kycJourney
                : null;

        const withdrawalLimit =
            TIER_WITHDRAWAL_LIMITS[userDetail.tier as TierLevel] ?? 0;

        return buildResponse({
            message: "User personal info retrieved",
            data: {
                ...sanitizedUserDetail,
                emailVerified: Boolean(isEmailVerified),
                phoneVerified: Boolean(isPhoneVerified),
                businessDocumentVerificationStatus,
                businessRecordCompleted,
                kycJourney,
                withdrawalLimit,
            },
        });
    }

    async getUserTransactionList(
        query: GetUserTransactionListDto,
        userId: number,
    ) {
        const { pageNumber, pageSize, sortBy } = query;

        const resolvedPageNumber: number =
            !pageNumber || pageNumber <= 1
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize: number =
            !pageSize || pageSize <= 0
                ? defaultPagination.pageSize
                : query.pageSize;

        const dbQuery: Prisma.OrderFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where: {
                userId: userId,
                ...(query.type && { orderCategory: query.type }),
                ...(query.asset && {
                    OR: [
                        {
                            currency: {
                                contains: query.asset,
                                mode: "insensitive",
                            },
                        },
                        {
                            fromCurrency: {
                                contains: query.asset,
                                mode: "insensitive",
                            },
                        },
                        {
                            toCurrency: {
                                contains: query.asset,
                                mode: "insensitive",
                            },
                        },
                    ],
                }),
                ...(query.startDate || query.endDate
                    ? {
                          createdAt: {
                              ...(query.startDate && {
                                  gte: new Date(query.startDate),
                              }),
                              ...(query.endDate && {
                                  lte: new Date(query.endDate),
                              }),
                          },
                      }
                    : {}),
                ...(query.searchText && { id: Number(query.searchText) }),
            },
            include: {
                user: { select: { firstName: true, lastName: true } },
            },
        };

        const [transactions, count] = await this.prisma.$transaction([
            this.prisma.order.findMany({
                ...dbQuery,
                ...(query.paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
            this.prisma.order.count({ where: dbQuery.where }),
        ]);

        const responseData: DataWithPagination<any> = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    transactions.length,
                ),
            }),
            records: transactions.map((t) =>
                shapeTransaction(t as TransactionIncludeOptions),
            ),
        };

        return buildResponse({
            message: "Transactions retrieved",
            data: responseData,
        });
    }

    async unflagUser(
        dto: UnflagUserDto,
        adminId?: number,
    ): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: dto.id },
            select: {
                id: true,
                flaggedRecord: {
                    select: {
                        flagged: true,
                        reason: true,
                    },
                },
                flaggedId: true,
            },
        });

        if (!user) {
            throw new UserNotFoundException(
                "Account with ID not found.",
                HttpStatus.BAD_REQUEST,
            );
        }

        if (!user.flaggedRecord?.flagged) {
            return buildResponse({
                message: "Account is not flagged.",
                data: { flaggedRecord: { flagged: false, reason: "" } },
            });
        }

        await this.prisma.$transaction(async (tx) => {
            if (user.flaggedId) {
                // Update existing Flagged record
                await tx.flagged.update({
                    where: { id: user.flaggedId },
                    data: {
                        flagged: false,
                        reason: "",
                        updatedAt: new Date(),
                    },
                });
            } else {
                // Create new Flagged record if none exists
                const flaggedRecord = await tx.flagged.create({
                    data: {
                        userId: user.id,
                        flagged: false,
                        reason: "",
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                });
                // Update user with new flaggedId
                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        flaggedId: flaggedRecord.id,
                        loginCount: 0,
                        updatedAt: new Date(),
                    },
                });
            }
        });

        await this.auditLogService.log({
            action: "UNFLAG_USER",
            resource: "user",
            resourceId: dto.id.toString(),
            details: { userId: dto.id },
            adminId,
        });

        return buildResponse({
            message: "Account unflagged successfully.",
            data: { flaggedRecord: { flagged: false, reason: "" } },
        });
    }

    async flagUser(dto: FlagUserDto, adminId?: number): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: dto.id },
            select: {
                id: true,
                flaggedRecord: {
                    select: {
                        flagged: true,
                        reason: true,
                    },
                },
                flaggedId: true,
            },
        });

        if (!user) {
            throw new UserNotFoundException(
                "Account with ID not found.",
                HttpStatus.BAD_REQUEST,
            );
        }

        if (user.flaggedRecord?.flagged) {
            return buildResponse({
                message: "Account is already flagged.",
                data: {
                    flaggedRecord: {
                        flagged: true,
                        reason: user.flaggedRecord.reason,
                    },
                },
            });
        }

        await this.prisma.$transaction(async (tx) => {
            if (user.flaggedId) {
                // Update existing Flagged record
                await tx.flagged.update({
                    where: { id: user.flaggedId },
                    data: {
                        flagged: true,
                        reason: dto.reason,
                        updatedAt: new Date(),
                    },
                });
            } else {
                // Create new Flagged record
                const flaggedRecord = await tx.flagged.create({
                    data: {
                        userId: user.id,
                        flagged: true,
                        reason: dto.reason,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    },
                });
                // Update user with new flaggedId
                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        flaggedId: flaggedRecord.id,
                        updatedAt: new Date(),
                    },
                });
            }
        });

        await this.auditLogService.log({
            action: "FLAG_USER",
            resource: "user",
            resourceId: dto.id.toString(),
            details: { userId: dto.id, reason: dto.reason },
            adminId,
        });

        return buildResponse({
            message: "Account flagged successfully.",
            data: { flaggedRecord: { flagged: true, reason: dto.reason } },
        });
    }

    async setLimitOverride(
        dto: SetLimitOverrideDto,
        adminUserId: number,
    ): Promise<ApiResponse> {
        const user = await this.prisma.user.findUnique({
            where: { id: dto.userId },
        });
        if (!user) {
            throw new UserNotFoundException(
                "Account with ID not found.",
                HttpStatus.BAD_REQUEST,
            );
        }

        const override = await this.prisma.limitOverride.upsert({
            where: { userId: dto.userId },
            create: {
                userId: dto.userId,
                dailyLimitUSD: dto.dailyLimitUSD ?? null,
                reason: dto.reason,
                grantedBy: adminUserId,
                expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            },
            update: {
                dailyLimitUSD: dto.dailyLimitUSD ?? null,
                reason: dto.reason,
                grantedBy: adminUserId,
                expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
                updatedAt: new Date(),
            },
        });

        await this.auditLogService.log({
            action: "SET_LIMIT_OVERRIDE",
            resource: "user",
            resourceId: dto.userId.toString(),
            details: {
                dailyLimitUSD: dto.dailyLimitUSD,
                reason: dto.reason,
                expiresAt: dto.expiresAt,
            },
            adminId: adminUserId,
        });

        return buildResponse({
            message: "Limit override set successfully.",
            data: {
                userId: override.userId,
                dailyLimitUSD: override.dailyLimitUSD,
                reason: override.reason,
                expiresAt: override.expiresAt,
            },
        });
    }

    async removeLimitOverride(
        dto: RemoveLimitOverrideDto,
        adminId?: number,
    ): Promise<ApiResponse> {
        const override = await this.prisma.limitOverride.findUnique({
            where: { userId: dto.userId },
        });
        if (!override) {
            return buildResponse({
                message: "No limit override found for this user.",
                data: null,
            });
        }

        await this.prisma.limitOverride.delete({
            where: { userId: dto.userId },
        });

        await this.auditLogService.log({
            action: "REMOVE_LIMIT_OVERRIDE",
            resource: "user",
            resourceId: dto.userId.toString(),
            details: { userId: dto.userId },
            adminId,
        });

        return buildResponse({
            message: "Limit override removed successfully.",
            data: { userId: dto.userId },
        });
    }

    async getLimitOverride(userId: number): Promise<ApiResponse> {
        const override = await this.prisma.limitOverride.findUnique({
            where: { userId },
        });
        return buildResponse({
            message: override
                ? "Limit override found."
                : "No limit override for this user.",
            data: override ?? null,
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
                return {
                    startDate: startOfMonth(now),
                    endDate: endOfMonth(now),
                };
            case "quarter":
                return {
                    startDate: startOfQuarter(now),
                    endDate: endOfQuarter(now),
                };
            case "year":
                return { startDate: startOfYear(now), endDate: endOfYear(now) };
            case "all":
                return { startDate: new Date(0), endDate: now };
            default:
                return {
                    startDate: startOfMonth(now),
                    endDate: endOfMonth(now),
                };
        }
    }
}
