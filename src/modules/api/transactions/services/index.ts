import { Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { Order, Prisma, User } from "@prisma/client";
import { GetUserTransactionListDto } from "../dtos";
import {
    buildPaginationMeta,
    defaultPagination,
    groupTransactionsByDate,
} from "@/utils";
import { shapeTransaction, TransactionIncludeOptions } from "../types";

@Injectable()
export class TransactionService {
    private readonly logger = new Logger("TransactionService");
    constructor(private prisma: PrismaService) {}

    async getUserTransactionHistory(
        query: GetUserTransactionListDto,
        user: User
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
}
