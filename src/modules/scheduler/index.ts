import { forwardRef, Module } from "@nestjs/common";
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { TradingModule } from "../api/trade";

@Module({
    imports: [forwardRef(() => TradingModule)], // <-- IMPORTANT
    providers: [AccountSchedulerService, AssetBalanceSchedulerService],
    exports: [AccountSchedulerService, AssetBalanceSchedulerService],
})
export class SchedulerModule {}
