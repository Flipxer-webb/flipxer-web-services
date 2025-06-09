import { forwardRef, Module } from "@nestjs/common";
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { TradingModule } from "../api/trade";
import { ManageOrdersSchedulerService } from "./services/manageOrder";
import { BankModule } from "../api/banks";

@Module({
    imports: [forwardRef(() => TradingModule), BankModule], // <-- IMPORTANT
    providers: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
    ],
    exports: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
    ],
})
export class SchedulerModule {}
