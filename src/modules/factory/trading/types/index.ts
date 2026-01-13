import { QuidaxService } from "../providers/quidax/services";
import { ITradingProvider } from "../interfaces/trading-provider.interface";

export type Provider = "quidax";

export type BuildOptions<T extends Provider> = {
    provider: T;
};

export enum TradingInjectionToken {
    QUIDAX = "QUIDAX",
    TRADING_PROVIDER = "TRADING_PROVIDER", // Provider-agnostic token
    COINGECKO = "COINGECKO",
    LIVECOINWATCH = "LIVECOINWATCH",
    COINCAP = "COINCAP",
    BINANCE = "BINANCE",
}

export interface ITradingFactory {
    /**
     * Build the raw provider service (legacy - for backward compatibility)
     * @deprecated Use buildProvider() instead for provider-agnostic code
     */
    build<T extends Provider>(options: BuildOptions<T>): QuidaxService;

    /**
     * Build the provider-agnostic trading provider
     */
    buildProvider<T extends Provider>(options: BuildOptions<T>): ITradingProvider;
}

// Re-export the interface for convenience
export type { ITradingProvider } from "../interfaces/trading-provider.interface";
