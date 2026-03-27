import * as t from "../types";
import { QuidaxService } from "../providers/quidax/services";
import { QuidaxTradingProvider } from "../providers/quidax/quidax-trading-provider";
import { QuidaxLib } from "@/libs/quidax";
import { TradingConfig } from "@/config";
import { Logger } from "@nestjs/common";
import { ITradingProvider } from "../interfaces/trading-provider.interface";

const logger = new Logger("TradingFactory");

export class TradingFactory implements t.ITradingFactory {
    constructor(private readonly tradingConfig: TradingConfig) {}

    buildQuidaxService(): QuidaxService {
        return this.createQuidaxService();
    }

    /**
     * Build the raw provider service (legacy - for backward compatibility)
     * @deprecated Use buildProvider() instead for provider-agnostic code
     */
    build<T extends t.Provider>(options: t.BuildOptions<T>): QuidaxService {
        if (options.provider === "quidax") {
            return this.createQuidaxService();
        }

        throw new Error(`Unknown provider: ${options.provider}`);
    }

    /**
     * Build the provider-agnostic trading provider
     * This returns an ITradingProvider instance that can be used
     * interchangeably with any trading provider implementation
     */
    buildProvider<T extends t.Provider>(options: t.BuildOptions<T>): ITradingProvider {
        if (options.provider === "quidax") {
            const quidaxService = this.createQuidaxService();
            return new QuidaxTradingProvider(quidaxService);
        }

        throw new Error(`Unknown provider: ${options.provider}`);
    }

    /**
     * Create and configure the Quidax service instance
     */
    private createQuidaxService(): QuidaxService {
        const quidaxConfig = this.tradingConfig.quidax;
        
        // Debug: Log if Quidax config is properly loaded
        const hasBaseUrl = !!quidaxConfig.baseUrl;
        const hasApiSecret = !!quidaxConfig.api_secret;
        const hasApiPublic = !!quidaxConfig.api_public;
        logger.log(`Quidax config check - baseUrl: ${hasBaseUrl}, api_secret: ${hasApiSecret}, api_public: ${hasApiPublic}`);
        
        if (!hasBaseUrl || !hasApiSecret) {
            logger.error(`MISSING QUIDAX CONFIG! baseUrl=${quidaxConfig.baseUrl?.substring(0, 20) || 'EMPTY'}, api_secret=${hasApiSecret ? 'SET' : 'MISSING'}`);
        }
        
        const quidax = new QuidaxLib({
            api_public: quidaxConfig.api_public,
            api_secret: quidaxConfig.api_secret,
            baseURL: quidaxConfig.baseUrl,
            rampBaseURL: quidaxConfig.rampBaseUrl,
        });

        return new QuidaxService(quidax);
    }
}
