import { Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { Order, Prisma, User } from "@prisma/client";
import { GetUserTransactionListDto } from "../dtos";
import { buildPaginationMeta, defaultPagination } from "@/utils";

@Injectable()
export class TransactionService {
    private readonly logger = new Logger("TransactionService");
    constructor(private prisma: PrismaService) {}

    async getUserTransactionHistory(
        user: User,
        query: GetUserTransactionListDto
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
                userId: user.id,
                // ...(query.searchText && {
                //     OR: [
                //         { assetName: { contains: query.searchText } },
                //         { assetCurrency: { contains: query.searchText } },
                //     ],
                // }),
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

        const responseData: DataWithPagination<Order> = {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    transactions.length
                ),
            }),
            records: transactions,
        };

        return buildResponse({
            message: "Transactions retrieved",
            data: responseData,
        });
    }
}
