import { Module, Global } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CachingModule } from '@/modules/core/redisCache';
import { TradingFactoryModule } from '@/modules/factory/trading';
import { OperationsModule } from '@/modules/api/operations';
import { VolatilityMonitorService } from './services/volatility-monitor.service';
import { WithdrawalGuardService } from './services/withdrawal-guard.service';
import { ExposureCapService } from './services/exposure-cap.service';

// Global module so it can be used easily in TradingModule
@Global()
@Module({
    imports: [
        ScheduleModule.forRoot(),
        CachingModule,
        TradingFactoryModule,
        OperationsModule // For WalletManagementService
    ],
    providers: [
        VolatilityMonitorService,
        WithdrawalGuardService,
        ExposureCapService
    ],
    exports: [
        VolatilityMonitorService,
        WithdrawalGuardService,
        ExposureCapService
    ],
})
export class RiskModule { }
