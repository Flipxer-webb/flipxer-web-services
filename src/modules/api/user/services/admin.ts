// admin-user.service.ts
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { endOfMonth, startOfMonth } from "date-fns";
import { GetUserListDto, UnflagUserDto, FlagUserDto } from "../dtos"; // Added FlagUserDto
import { Prisma, User, UserType } from "@prisma/client";
import { UserNotFoundException } from "../errors";
import {
    shapeTransaction,
    TransactionIncludeOptions,
} from "../../transactions/types";
import { GetUserTransactionListDto } from "../../transactions/dtos";

@Injectable()
export class AdminUserService {
    constructor(
        private prisma: PrismaService,
        private emailService: EmailService
    ) {}

    async getAnalyticsOverview(): Promise<ApiResponse> {
        const now = new Date();
        const startOfCurrentMonth = startOfMonth(now);
        const endOfCurrentMonth = endOfMonth(now);

        const [totalUsers, usersThisMonth] = await Promise.all([
            // Exclude admin users from total count
            this.prisma.user.count({
                where: { userType: { not: UserType.ADMIN } },
            }),
            this.prisma.user.count({
                where: {
                    userType: { not: UserType.ADMIN },
                    createdAt: {
                        gte: startOfCurrentMonth,
                        lte: endOfCurrentMonth,
                    },
                },
            }),
        ]);

        const [totalTransactionVolume, transactionsThisMonth] =
            await Promise.all([
                this.prisma.order.aggregate({
                    _sum: { amountInFiat: true },
                    where: {
                        streamlinedStatus: 'completed',
                    },
                }),
                this.prisma.order.aggregate({
                    _sum: { amountInFiat: true },
                    where: {
                        streamlinedStatus: 'completed',
                        createdAt: {
                            gte: startOfCurrentMonth,
                            lte: endOfCurrentMonth,
                        },
                    },
                }),
            ]);
        return buildResponse({
            message: "Analytics Overview successfully retrieved",
            data: {
                totalUsers,
                usersThisMonth,
                totalTransactionVolume:
                    totalTransactionVolume?._sum.amountInFiat || 0,
                transactionsThisMonth:
                    transactionsThisMonth?._sum.amountInFiat || 0,
            },
        });
    }

    async getUserList(query: GetUserListDto) {
        const { pageNumber, pageSize, sortBy } = query;

        const resolvedPageNumber: number =
            !pageNumber || (pageNumber && pageNumber <= 1)
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize: number =
            !pageSize || (pageSize && pageSize <= 0)
                ? defaultPagination.pageSize
                : query.pageSize;

        const dbQuery: Prisma.UserFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where: {
                userType: { not: UserType.ADMIN },
                ...(query.status && { status: query.status }),
                ...(query.accountType && { userType: query.accountType }),
                ...(query.searchText && {
                    OR: [
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
                        {
                            email: {
                                contains: query.searchText,
                                mode: "insensitive",
                            },
                        },
                        {
                            phone: {
                                contains: query.searchText,
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
                ...(query.tier !== undefined && query.tier !== '' && {
                    tier: parseInt(query.tier as any, 10),
                }),
            },
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
                    users.length
                ),
            }),
            records: users,
        };

        return buildResponse({
            message: "Users list retrieved",
            data: responseData,
        });
    }

    async getUserInfo(userId: number) {
        const userDetail = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                identifier: true,
                userType: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                photo: true,
                bvn: true,
                accountLimit: true,
                businessDocument: true,
                userDocument: true,
                businessRecord: true,
                flaggedRecord: {
                    select: {
                        flagged: true,
                        reason: true,
                    },
                },
            },
        });

        if (!userDetail) {
            throw new UserNotFoundException(
                "User not found",
                HttpStatus.NOT_FOUND
            );
        }
        return buildResponse({
            message: "User personal info retrieved",
            data: userDetail,
        });
    }

    async getUserTransactionList(
        query: GetUserTransactionListDto,
        userId: number
    ) {
        const { pageNumber, pageSize, sortBy } = query;

        const resolvedPageNumber: number =
            !pageNumber || (pageNumber && pageNumber <= 1)
                ? defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize: number =
            !pageSize || (pageSize && pageSize <= 0)
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
                    transactions.length
                ),
            }),
            records: transactions.map((t) =>
                shapeTransaction(t as TransactionIncludeOptions)
            ),
        };

        return buildResponse({
            message: "Transactions retrieved",
            data: responseData,
        });
    }

    async unflagUser(dto: UnflagUserDto): Promise<ApiResponse> {
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
                HttpStatus.BAD_REQUEST
            );
        }

        if (!user.flaggedRecord || !user.flaggedRecord.flagged) {
            return buildResponse({
                message: "Account is not flagged.",
                data: { flaggedRecord: { flagged: false, reason: "" } },
            });
        }

        await this.prisma.$transaction(async (tx) => {
            let flaggedRecord;
            if (user.flaggedId) {
                // Update existing Flagged record
                flaggedRecord = await tx.flagged.update({
                    where: { id: user.flaggedId },
                    data: {
                        flagged: false,
                        reason: "",
                        updatedAt: new Date(),
                    },
                });
            } else {
                // Create new Flagged record if none exists
                flaggedRecord = await tx.flagged.create({
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

        return buildResponse({
            message: "Account unflagged successfully.",
            data: { flaggedRecord: { flagged: false, reason: "" } },
        });
    }

    async flagUser(dto: FlagUserDto): Promise<ApiResponse> {
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
                HttpStatus.BAD_REQUEST
            );
        }

        if (user.flaggedRecord && user.flaggedRecord.flagged) {
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
            let flaggedRecord;
            if (user.flaggedId) {
                // Update existing Flagged record
                flaggedRecord = await tx.flagged.update({
                    where: { id: user.flaggedId },
                    data: {
                        flagged: true,
                        reason: dto.reason,
                        updatedAt: new Date(),
                    },
                });
            } else {
                // Create new Flagged record
                flaggedRecord = await tx.flagged.create({
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

        return buildResponse({
            message: "Account flagged successfully.",
            data: { flaggedRecord: { flagged: true, reason: dto.reason } },
        });
    }
}
