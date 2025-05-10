import { Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { User } from "@prisma/client";
import { GetUserTransactionListDto } from "../dtos";

@Injectable()
export class TransactionService {
    private readonly logger = new Logger("TransactionService");
    constructor(private prisma: PrismaService) {}

    getUserTransactionHistory(user: User, query: GetUserTransactionListDto) {
        return buildResponse({
            message: "Transactions retrieved",
            data: {},
        });
    }
}
