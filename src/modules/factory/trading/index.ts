import { Module, Provider } from "@nestjs/common";
import { TradingFactory } from "./factory";
import { TradingInjectionToken } from "./types";
import { tradingConfig } from "@/config";

/**
 * Legacy Quidax service provider for backward compatibility.
 * Prefer using TRADING_PROVIDER token for new code.
 */
const quidaxService: Provider = {
    provide: TradingInjectionToken.QUIDAX,
    useFactory() {
        const tradingFactory = new TradingFactory(tradingConfig);
        return tradingFactory.buildQuidaxService();
    },
};

/**
 * Provider-agnostic trading provider
 * Use this for new code to allow easy switching between providers
 */
const tradingProvider: Provider = {
    provide: TradingInjectionToken.TRADING_PROVIDER,
    useFactory() {
        const tradingFactory = new TradingFactory(tradingConfig);
        return tradingFactory.buildProvider({ provider: "quidax" });
    },
};

@Module({
    providers: [quidaxService, tradingProvider],
    exports: [quidaxService, tradingProvider],
})
export class TradingFactoryModule {}

// Re-export types and interfaces
export * from "./types";
export * from "./interfaces/trading-provider.interface";
