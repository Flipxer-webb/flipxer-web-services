import { Module } from "@nestjs/common";
import { TransactionService } from "./services";
import { AdminTransactionService } from "./services/admin-transaction.service";
import { TransactionController } from "./controllers/v1";
import { AdminTransactionController } from "./controllers/v1/admin";

@Module({
    providers: [TransactionService, AdminTransactionService],
    controllers: [TransactionController, AdminTransactionController],
    exports: [TransactionService, AdminTransactionService],
})
export class TransactionModule {}
