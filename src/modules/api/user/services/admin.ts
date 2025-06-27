import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildPaginationMeta, defaultPagination } from "@/utils";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { ImagekitService } from "@/modules/core/upload/services/imagekit";
import { endOfMonth, startOfMonth } from "date-fns";
import { GetUserListDto } from "../dtos";
import { Prisma, User } from "@prisma/client";
import { UserNotFoundException } from "../errors";
import { GetUserTransactionListDto } from "../../transactions/dtos";
import {
    shapeTransaction,
    TransactionIncludeOptions,
} from "../../transactions/types";

const logger = new Logger();

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
            this.prisma.user.count(),
            this.prisma.user.count({
                where: {
                    createdAt: {
                        gte: startOfCurrentMonth,
                        lte: endOfCurrentMonth,
                    },
                },
            }),
        ]);

        //todo: completed the logic
        const [totalTransactionVolume, transactionsThisMonth] =
            await Promise.all([
                this.prisma.order.count(),
                this.prisma.order.count({
                    where: {
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
                totalTransactionVolume,
                transactionsThisMonth,
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
                createdAt: true,
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
                accountLimit: true,
                businessDocument: true,
                userDocument: true,
                businessRecord: true,
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
}
