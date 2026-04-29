import * as t from "../types";
import { QuidaxService } from "../providers/quidax/services";
import { QuidaxTradingProvider } from "../providers/quidax/quidax-trading-provider";
import { MockQuidaxTradingProvider } from "../providers/mock/mock-trading-provider";
import { SafeQuidaxTradingProvider } from "../providers/safe/safe-trading-provider";
import { QuidaxLib } from "@/libs/quidax";
import type { QuidaxRequestBudget } from "@/libs/quidax";
import { TradingConfig } from "@/config";
import { Logger } from "@nestjs/common";
import { ITradingProvider } from "../interfaces/trading-provider.interface";

const logger = new Logger("TradingFactory");

export class TradingFactory implements t.ITradingFactory {
    constructor(
        private readonly tradingConfig: TradingConfig,
        private readonly requestBudget?: QuidaxRequestBudget,
    ) {}

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
            const isMockEnabled = String(process.env.QUIDAX_MOCK).toLowerCase() === "true";
            if (isMockEnabled) {
                logger.warn("QUIDAX_MOCK=true detected — using MockQuidaxTradingProvider");
                return new MockQuidaxTradingProvider();
            }

            const quidaxService = this.createQuidaxService();
            const provider = new QuidaxTradingProvider(quidaxService);
            const environment = process.env.NODE_ENV || "development";

            if (environment !== "production") {
                return new SafeQuidaxTradingProvider(provider, environment);
            }

            return provider;
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
            const errorMessage = `Missing Quidax configuration: baseUrl and api_secret are required (baseUrl=${hasBaseUrl ? "SET" : "MISSING"}, api_secret=${hasApiSecret ? "SET" : "MISSING"})`;

            logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const quidax = new QuidaxLib({
            api_public: quidaxConfig.api_public,
            api_secret: quidaxConfig.api_secret,
            baseURL: quidaxConfig.baseUrl,
            rampBaseURL: quidaxConfig.rampBaseUrl,
            ...(this.requestBudget ? { requestBudget: this.requestBudget } : {}),
        });

        return new QuidaxService(quidax);
    }
}
