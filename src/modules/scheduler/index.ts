import { forwardRef, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule"; // Import ScheduleModule
import { AccountSchedulerService } from "./services/manageAccounts";
import { AssetBalanceSchedulerService } from "./services/manageBalance";
import { ManageOrdersSchedulerService } from "./services/manageOrder";
import { PriceCacheSchedulerService } from "./services/coinGecko"; // Renamed, now uses LCW+CoinCap
import { SweepWorkerService } from "./services/sweep-worker.service";
import { TradingModule } from "../api/trade";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { BankModule } from "../api/banks";
import { CachingModule } from "@/modules/core/redisCache";

@Module({
    imports: [
        ScheduleModule.forRoot(), // Required for cron jobs
        forwardRef(() => TradingModule),
        TradingFactoryModule,
        BankModule,
        CachingModule,
    ],
    providers: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
        PriceCacheSchedulerService, // Uses LiveCoinWatch + CoinCap (not CoinGecko)
        SweepWorkerService,
    ],
    exports: [
        AccountSchedulerService,
        AssetBalanceSchedulerService,
        ManageOrdersSchedulerService,
        SweepWorkerService,
    ],
})
export class SchedulerModule { }

