import { forwardRef, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule"; // Import ScheduleModule
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { ManageOrdersSchedulerService } from "./services/manageOrder";
// CoinGeckoCacheSchedulerService removed - no longer using CoinGecko
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
        // CoinGeckoCacheSchedulerService removed - was causing 429 rate limit errors
    ],
    exports: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
    ],
})
export class SchedulerModule { }
