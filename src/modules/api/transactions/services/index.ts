import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { OrderCategory, Prisma, User } from "@prisma/client";
import { GeneralReportDownloadDto, GetUserTransactionListDto } from "../dtos";
import {
    buildPaginationMeta,
    defaultPagination,
    groupTransactionsByDate,
} from "@/utils";
import {
    GeneralReportCSVField,
    GeneralReportDownload,
    shapeTransaction,
    TransactionIncludeOptions,
} from "../types";
import { format, endOfDay, startOfDay } from "date-fns";
import { TransactionNotFoundException } from "../errors";
import { createObjectCsvStringifier } from "csv-writer";

@Injectable()
export class TransactionService {
    private readonly logger = new Logger("TransactionService");
    constructor(private readonly prisma: PrismaService) {}

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
        const { sortBy } = query;
        const { resolvedPageNumber, resolvedPageSize } = this.resolvePagination(query);
        const whereClause = this.buildTransactionWhereClause(query, user);

        const dbQuery: Prisma.OrderFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where: whereClause,
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

        return buildResponse({
            message: "Transactions retrieved",
            data: this.buildTransactionResponse(query, transactions, count, resolvedPageNumber, resolvedPageSize, user),
        });
    }

    private buildTransactionResponse(
        query: GetUserTransactionListDto,
        transactions: any[],
        count: number,
        pageNumber: number,
        pageSize: number,
        user?: User
    ): DataWithPagination<any> {
        const isStatusFilter = !!query.status;
        return {
            ...(query.paginated === "true" && {
                meta: buildPaginationMeta(pageNumber, pageSize, count, transactions.length),
            }),
            records: user
                ? groupTransactionsByDate(transactions, isStatusFilter)
                : transactions.map((t) =>
                      shapeTransaction(t as TransactionIncludeOptions, isStatusFilter)
                  ),
        };
    }

    private resolvePagination(query: GetUserTransactionListDto) {
        const resolvedPageNumber: number =
            !query.pageNumber || query.pageNumber <= 1
                ? defaultPagination.pageNumber
                : query.pageNumber;

        const resolvedPageSize: number =
            !query.pageSize || query.pageSize <= 0
                ? defaultPagination.pageSize
                : query.pageSize;

        return { resolvedPageNumber, resolvedPageSize };
    }

    private buildTransactionWhereClause(query: GetUserTransactionListDto, user?: User): Prisma.OrderWhereInput {
        const normalizedSource = (query.source ?? "").toLowerCase();
        const adminSwapMatcher: Prisma.OrderWhereInput = {
            OR: [
                { orderReference: { startsWith: "admin-swap-", mode: "insensitive" } },
                { transactionId: { startsWith: "admin-swap-", mode: "insensitive" } },
            ],
        };

        return {
            ...(user && { userId: user.id }),
            ...(query.type && { orderCategory: query.type }),
            ...(query.status && { streamlinedStatus: query.status }),
            ...(query.startDate || query.endDate
                ? {
                      createdAt: {
                          ...(query.startDate && {
                              gte: new Date(query.startDate),
                          }),
                          ...(query.endDate && {
                              lte: endOfDay(new Date(query.endDate)),
                          }),
                      },
                  }
                : {}),
            AND: [
                ...(query.asset
                    ? [{
                        OR: [
                            { currency: { contains: query.asset, mode: "insensitive" as const } },
                            { fromCurrency: { contains: query.asset, mode: "insensitive" as const } },
                            { toCurrency: { contains: query.asset, mode: "insensitive" as const } },
                        ],
                    }]
                    : []),
                ...(query.searchText
                    ? [{
                        OR: [
                            { transactionId: { contains: query.searchText, mode: "insensitive" as const } },
                            { user: { firstName: { contains: query.searchText, mode: "insensitive" as const } } },
                            { user: { lastName: { contains: query.searchText, mode: "insensitive" as const } } },
                            { user: { email: { contains: query.searchText, mode: "insensitive" as const } } },
                        ],
                    }]
                    : []),
                ...(normalizedSource === "admin"
                    ? [{ orderCategory: OrderCategory.SWAP }, adminSwapMatcher]
                    : []),
                ...(normalizedSource === "user"
                    ? [{ NOT: adminSwapMatcher }]
                    : []),
            ],
        };
    }

    async getTransactionDetail(transactionId: string, userId?: number) {
        const transDetail = await this.prisma.order.findUnique({
            where: { transactionId: transactionId },
            include: {
                user: { select: { firstName: true, lastName: true, email: true } },
            },
        });

        if (transDetail && userId && transDetail.userId !== userId) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

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

    async downloadGeneralReport(user: User, options: GeneralReportDownloadDto) {
        const startDate = startOfDay(new Date(options.startDate));
        const endDate = endOfDay(new Date(options.endDate));

        const transactions = await this.prisma.order.findMany({
            orderBy: { createdAt: "desc" },
            where: {
                userId: user.id,
                ...(options.type && { orderCategory: options.type }),
                updatedAt: {
                    gte: startDate,
                    lte: endDate,
                },
            },
            select: {
                id: true,
                orderCategory: true,
                transactionId: true,
                status: true,
                paymentStatus: true,
                amount: true,
                total: true,
                fee: true,
                fromCurrency: true,
                toCurrency: true,
                fromAmount: true,
                toAmount: true,
                quoted_currency: true,
                currency: true,
                narration: true,
                recipient: true,
                reason: true,
                user: {
                    select: {
                        firstName: true,
                        lastName: true,
                        email: true,
                        userType: true,
                    },
                },
                destinationBankName: true,
                destinationBankAccountNumber: true,
                destinationBankAccountName: true,
                totalToReceiveInFiat: true,
                updatedAt: true,
            },
        });

        const data: GeneralReportDownload[] = transactions.map((t) => {
            const name = `${t.user?.firstName} ${t.user?.lastName}`;
            const email = t.user?.email;
            let fromCurrency = "N/A";
            let toCurrency = "N/A";
            let fromAmount = "N/A";
            let toAmount = "N/A";
            let quotedCurrency = "N/A";
            let currency = "N/A";
            let destinationBankName = "N/A";
            let destinationBankAccountNumber = "N/A";
            let destinationBankAccountName = "N/A";
            let totalReceiveInFiat = "N/A";
            switch (t.orderCategory) {
                case OrderCategory.SWAP: {
                    fromCurrency = t.fromCurrency;
                    toCurrency = t.toCurrency;
                    fromAmount = t.fromAmount.toString();
                    toAmount = t.toAmount.toString();
                    quotedCurrency = t.quoted_currency;
                    currency = t.quoted_currency;
                    break;
                }
                case OrderCategory.RECEIVE:
                case OrderCategory.SEND: {
                    currency = t.currency;
                    break;
                }
                case OrderCategory.SELL: {
                    currency = t.currency;
                    destinationBankName = t.destinationBankName ?? "N/A";
                    destinationBankAccountNumber = t.destinationBankAccountNumber ?? "N/A";
                    destinationBankAccountName = t.destinationBankAccountName ?? "N/A";
                    totalReceiveInFiat = t.totalToReceiveInFiat?.toString() ?? "N/A";
                    break;
                }

                case OrderCategory.BUY: {
                    currency = t.currency;
                    break;
                }
                default:
                    break;
            }

            const data: GeneralReportDownload = {
                transactionId: t.transactionId,
                type: t.orderCategory,
                userType: t.user.userType,
                name: name,
                email: email,
                amount: t.amount ?? fromAmount,
                currency: currency,
                transactionStatus: t.status,
                paymentStatus: t.paymentStatus,
                recipient: t.recipient,
                fee: t.fee ?? "0.0",
                date: format(t.updatedAt, "yyyy-MM-dd HH:mm:ss"),
                destinationBankName: destinationBankName,
                destinationBankAccountNumber: destinationBankAccountNumber,
                destinationBankAccountName: destinationBankAccountName,
                totalReceiveInFiat: totalReceiveInFiat,
                fromCurrency: fromCurrency,
                toCurrency: toCurrency,
                toAmount: toAmount,
                quotedCurrency: quotedCurrency,
            };
            return data;
        });

        return this.buildGeneralReportCsv(data);
    }

    private buildGeneralReportCsv(dbData: GeneralReportDownload[]) {
        const csvHeader: GeneralReportCSVField[] = [
            { id: "userType", title: "User Type" },
            { id: "transactionId", title: "Transaction ID" },
            { id: "type", title: "Transaction Type" },
            { id: "name", title: "User Name" },
            { id: "recipient", title: "Recipient Address" },
            { id: "email", title: "User Email" },
            { id: "date", title: "Date" },
            { id: "amount", title: "Amount" },
            { id: "currency", title: "Currency" },
            { id: "transactionStatus", title: "Transaction Status" },
            { id: "paymentStatus", title: "Payment Status" },
            { id: "fee", title: "Service Charge" },
            { id: "fromCurrency", title: "From currency" },
            { id: "toCurrency", title: "To currency" },
            { id: "toAmount", title: "To Amount" },
            { id: "quotedCurrency", title: "Quoted Currency" },
            { id: "totalReceiveInFiat", title: "Fiat Amount" },
            { id: "destinationBankName", title: "Destination BankName" },
            {
                id: "destinationBankAccountNumber",
                title: "Destination BankAccount Number",
            },
            {
                id: "destinationBankAccountName",
                title: "Destination BankAccount Name",
            },
        ];

        const csvStringifier = createObjectCsvStringifier({
            header: csvHeader,
        });

        return (
            csvStringifier.getHeaderString() +
            csvStringifier.stringifyRecords(dbData as unknown as Record<string, unknown>[])
        );
    }
}
