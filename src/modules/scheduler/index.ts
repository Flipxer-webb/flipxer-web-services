import { forwardRef, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule"; // Import ScheduleModule
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { ManageOrdersSchedulerService } from "./services/manageOrder";
import { CoinGeckoCacheSchedulerService } from "./services/coinGecko"
import { TradingModule } from "../api/trade";
import { BankModule } from "../api/banks";

@Module({
    imports: [
        ScheduleModule.forRoot(), // Required for cron jobs
        forwardRef(() => TradingModule),
        BankModule,
    ],
    providers: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
        CoinGeckoCacheSchedulerService,
    ],
    exports: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
        CoinGeckoCacheSchedulerService,
    ],
})
export class SchedulerModule {}