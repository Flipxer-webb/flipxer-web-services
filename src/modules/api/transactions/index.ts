import { Module } from "@nestjs/common";
import { TransactionService } from "./services";
import { TransactionController } from "./controllers/v1";
import { AdminTransactionController } from "./controllers/v1/admin";

@Module({
    providers: [TransactionService],
    controllers: [TransactionController, AdminTransactionController],
})
export class TransactionModule {}
