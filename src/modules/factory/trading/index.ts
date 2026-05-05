import { Module, Provider } from "@nestjs/common";
import { TradingFactory } from "./factory";
import { TradingInjectionToken } from "./types";
import { tradingConfig } from "@/config";
import { QuidaxGlobalLimiterService } from "./providers/quidax/services/quidax-global-limiter.service";

/**
 * Legacy Quidax service provider for backward compatibility.
 * Prefer using TRADING_PROVIDER token for new code.
 */
const quidaxService: Provider = {
    provide: TradingInjectionToken.QUIDAX,
    inject: [QuidaxGlobalLimiterService],
    useFactory(quidaxGlobalLimiter: QuidaxGlobalLimiterService) {
        const tradingFactory = new TradingFactory(
            tradingConfig,
            quidaxGlobalLimiter,
        );
        return tradingFactory.buildQuidaxService();
    },
};

/**
 * Provider-agnostic trading provider
 * Use this for new code to allow easy switching between providers
 */
const tradingProvider: Provider = {
    provide: TradingInjectionToken.TRADING_PROVIDER,
    inject: [QuidaxGlobalLimiterService],
    useFactory(quidaxGlobalLimiter: QuidaxGlobalLimiterService) {
        const tradingFactory = new TradingFactory(
            tradingConfig,
            quidaxGlobalLimiter,
        );
        return tradingFactory.buildProvider({ provider: "quidax" });
    },
};

@Module({
    providers: [QuidaxGlobalLimiterService, quidaxService, tradingProvider],
    exports: [QuidaxGlobalLimiterService, quidaxService, tradingProvider],
})
export class TradingFactoryModule {}

// Re-export types and interfaces
export * from "./types";
export * from "./interfaces/trading-provider.interface";
