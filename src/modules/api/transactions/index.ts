import { Module } from "@nestjs/common";
import { TransactionService } from "./services";
import { TransactionController } from "./controllers/v1";

@Module({
    providers: [TransactionService],
    controllers: [TransactionController],
})
export class TransactionModule {}
