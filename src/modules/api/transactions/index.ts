import { Module, forwardRef } from "@nestjs/common";
import { TransactionService } from "./services";
import { AdminTransactionService } from "./services/admin-transaction.service";
import { TransactionController } from "./controllers/v1";
import { AdminTransactionController } from "./controllers/v1/admin";
import { TradingModule } from "../trade";
import { SettingModule } from "../settings";
import { SessionModule } from "../session";

@Module({
    imports: [forwardRef(() => TradingModule), SettingModule, SessionModule],
    providers: [TransactionService, AdminTransactionService],
    controllers: [TransactionController, AdminTransactionController],
    exports: [TransactionService, AdminTransactionService],
})
export class TransactionModule { }
