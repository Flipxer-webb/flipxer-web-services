import { forwardRef, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule"; // Import ScheduleModule
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { ManageOrdersSchedulerService } from "./services/manageOrder";
import { PriceCacheSchedulerService } from "./services/coinGecko"; // Renamed, now uses LCW+CoinCap
import { AuthSchedulerService } from "./services/manageAuth";
import { TradingModule } from "../api/trade";
import { BankModule } from "../api/banks";
import { CachingModule } from "@/modules/core/redisCache";

@Module({
    imports: [
        ScheduleModule.forRoot(), // Required for cron jobs
        forwardRef(() => TradingModule),
        BankModule,
        CachingModule,
    ],
    providers: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
        PriceCacheSchedulerService, // Uses LiveCoinWatch + CoinCap (not CoinGecko)
        AuthSchedulerService,
    ],
    exports: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
    ],
})
export class SchedulerModule { }

