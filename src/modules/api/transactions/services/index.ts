import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { Order, OrderCategory, Prisma, User } from "@prisma/client";
import { GetUserTransactionListDto } from "../dtos";
import {
    buildPaginationMeta,
    defaultPagination,
    groupTransactionsByDate,
} from "@/utils";
import { isToday, isYesterday, format } from "date-fns";
import { shapeTransaction, TransactionIncludeOptions } from "../types";
import { TransactionNotFoundException } from "../errors";

@Injectable()
export class TransactionService {
    private readonly logger = new Logger("TransactionService");
    constructor(private prisma: PrismaService) {}

    async getRecentTransactionList() {
        const transactions = await this.prisma.order.findMany({
            include: {
                user: { select: { firstName: true, lastName: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 10,
        });
        const responseData = transactions.map((t) => shapeTransaction(t));
        return buildResponse({
            message: "Recent Transactions retrieved",
            data: responseData,
        });
    }

    async getUserTransactionHistory(
        query: GetUserTransactionListDto,
        user?: User
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
                ...(user && { userId: user.id }),
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
            records: user
                ? groupTransactionsByDate(transactions)
                : transactions.map((t) =>
                      shapeTransaction(t as TransactionIncludeOptions)
                  ),
        };

        return buildResponse({
            message: "Transactions retrieved",
            data: responseData,
        });
    }

    async getTransactionDetail(transactionId: number) {
        const transDetail = await this.prisma.order.findUnique({
            where: { id: transactionId },
            include: {
                user: { select: { firstName: true, lastName: true } },
            },
        });

        if (!transDetail) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }
        return buildResponse({
            message: "Transaction detail retrieved",
            data: shapeTransaction(transDetail),
        });
    }
}
