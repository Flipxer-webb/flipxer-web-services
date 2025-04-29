import { forwardRef, Module } from "@nestjs/common";
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { TradingModule } from "../api/trade";
import { ManageOrdersSchedulerService } from "./services/manageOrder";

@Module({
    imports: [forwardRef(() => TradingModule)], // <-- IMPORTANT
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
