import { Injectable, Logger, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import { HttpStatus } from "@nestjs/common";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";

export interface AssetRate {
    currency: string;
    buyRate: number;
    sellRate: number;
    source: "dynamic" | "database";
    usdtPrice?: number;
    lastUpdated?: Date;
}

export interface UsdtBaseRate {
    buyRate: number;
    sellRate: number;
}

const FEATURE_FLAG_KEY = "feature:dynamic_rates";
const USDT_RATE_CACHE_KEY = "rate:usdt:base";

/**
 * Centralized Rate Service
 *
 * Provides unified rate calculation for all trading operations.
 * Supports both legacy (database) and dynamic (calculated) rate modes.
 *
 * Dynamic Rate Formula:
 * - sellRate (user buys) = assetUsdtPrice × usdtRate.sellRate
 * - buyRate (user sells) = assetUsdtPrice × usdtRate.buyRate
 *
 * Rollback strategies:
 * 1. Feature Flag: Redis key 'feature:dynamic_rates' (true/false)
 * 2. DB Override: If CryptoRate entry has buyRate > 0 or sellRate > 0, use it
 */
@Injectable()
export class RateService {
    private readonly logger = new Logger(RateService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly redisCacheService: RedisCacheService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        private readonly slackWebhookService: SlackWebhookService
    ) {}

    /**
     * Check if dynamic rates feature is enabled
     * Defaults to ON (true) if not explicitly set
     */
    async isDynamicRatesEnabled(): Promise<boolean> {
        const flagValue = await this.redisCacheService.get<string>(FEATURE_FLAG_KEY);
        // Default to true (ON) if flag is not set
        return flagValue !== "false";
    }

    /**
     * Toggle the dynamic rates feature flag
     */
    async setDynamicRatesEnabled(enabled: boolean): Promise<void> {
        await this.redisCacheService.set(
            FEATURE_FLAG_KEY,
            enabled ? "true" : "false",
            0 // No expiry
        );
        this.logger.log(`Dynamic rates feature flag set to: ${enabled}`);
    }

    /**
     * Get the admin-managed USDT/NGN base rate
     * This is the foundation for all dynamic calculations
     */
    async getUsdtBaseRate(): Promise<UsdtBaseRate> {
        // Check cache first
        const cached = await this.redisCacheService.get<UsdtBaseRate>(USDT_RATE_CACHE_KEY);
        if (cached) {
            return cached;
        }

        const usdtRate = await this.prisma.cryptoRate.findUnique({
            where: { currency: "USDT" },
        });

        if (!usdtRate || usdtRate.buyRate <= 0 || usdtRate.sellRate <= 0) {
            this.logger.error("CRITICAL: USDT rate not configured or invalid");
            this.slackWebhookService.sendSystemAlert(
                "rate-service",
                "USDT Rate Missing/Invalid",
                "CRITICAL: USDT base rate is not configured or invalid. All dynamic rate calculations are broken. Please update the USDT rate in the admin panel immediately.",
                {
                    buyRate: usdtRate?.buyRate ?? null,
                    sellRate: usdtRate?.sellRate ?? null,
                    timestamp: new Date().toISOString(),
                },
                "error"
            ).catch((e) => this.logger.error(`Failed to send Slack alert: ${e.message}`));
            throw new GeneralTransactionException(
                "USDT rate not configured. Please contact support.",
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        const baseRate: UsdtBaseRate = {
            buyRate: usdtRate.buyRate,
            sellRate: usdtRate.sellRate,
        };

        // Cache for 5 minutes (admin might update it)
        await this.redisCacheService.set(USDT_RATE_CACHE_KEY, baseRate, 300);

        return baseRate;
    }

    /**
     * Get the X/USDT price from cache or LiveCoinWatch
     */
    async getAssetUsdtPrice(currency: string): Promise<number> {
        const normalizedCurrency = currency.toUpperCase();

        // USDT is always 1:1
        if (normalizedCurrency === "USDT") {
            return 1.0;
        }

        // Check scheduler cache first (updated every 60s)
        const cachedPrice = await this.redisCacheService.get<number>(
            `price:${currency.toLowerCase()}:usdt`
        );

        if (cachedPrice && cachedPrice > 0) {
            return cachedPrice;
        }

        // Fetch from LiveCoinWatch
        try {
            const price = await this.liveCoinWatchService.getPriceInUSDT(currency);
            this.logger.debug(`LiveCoinWatch price for ${currency}: ${price} USDT`);
            return price;
        } catch (error) {
            this.logger.error(`Failed to get USDT price for ${currency}: ${error.message}`);
            throw new GeneralTransactionException(
                `Unable to fetch current rate for ${currency}`,
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }
    }

    /**
     * Get rate for a single asset
     *
     * @param currency - The asset symbol (e.g., 'BTC', 'ETH')
     * @returns Asset rate with buy/sell rates in NGN
     */
    async getAssetRate(currency: string): Promise<AssetRate> {
        const normalizedCurrency = currency.toUpperCase();
        this.logger.debug(`Getting rate for ${normalizedCurrency}`);

        // Check if dynamic rates are enabled
        const isDynamic = await this.isDynamicRatesEnabled();

        if (!isDynamic) {
            // Legacy mode: Use database rates
            return this.getLegacyRate(normalizedCurrency);
        }

        // Dynamic mode: Calculate rate

        // Special case: USDT uses database rate directly (admin-managed)
        if (normalizedCurrency === "USDT") {
            const usdtRate = await this.getUsdtBaseRate();
            return {
                currency: "USDT",
                buyRate: usdtRate.buyRate,
                sellRate: usdtRate.sellRate,
                source: "database",
                usdtPrice: 1.0,
                lastUpdated: new Date(),
            };
        }

        // Calculate dynamic rate for all other assets
        return this.calculateDynamicRate(normalizedCurrency);
    }

    /**
     * Get legacy rate from database (feature flag OFF mode)
     */
    private async getLegacyRate(currency: string): Promise<AssetRate> {
        const rate = await this.prisma.cryptoRate.findUnique({
            where: { currency },
        });

        if (!rate) {
            throw new GeneralTransactionException(
                `Rate not configured for ${currency}`,
                HttpStatus.BAD_REQUEST
            );
        }

        return {
            currency,
            buyRate: rate.buyRate,
            sellRate: rate.sellRate,
            source: "database",
            lastUpdated: rate.updatedAt,
        };
    }

    /**
     * Calculate dynamic rate from USDT base rate and LiveCoinWatch price
     *
     * Formula:
     * - sellRate = assetUsdtPrice × usdtBaseRate.sellRate
     * - buyRate = assetUsdtPrice × usdtBaseRate.buyRate
     */
    private async calculateDynamicRate(currency: string): Promise<AssetRate> {
        const [usdtBaseRate, assetUsdtPrice] = await Promise.all([
            this.getUsdtBaseRate(),
            this.getAssetUsdtPrice(currency),
        ]);

        // For BUY orders (user buys crypto, we sell): Use sellRate
        // For SELL orders (user sells crypto, we buy): Use buyRate
        const sellRate = assetUsdtPrice * usdtBaseRate.sellRate;
        const buyRate = assetUsdtPrice * usdtBaseRate.buyRate;

        this.logger.debug(
            `Calculated ${currency} rates: buy=${buyRate.toFixed(2)}, sell=${sellRate.toFixed(2)} ` +
            `(USDT price: ${assetUsdtPrice}, base: ${usdtBaseRate.buyRate}/${usdtBaseRate.sellRate})`
        );

        return {
            currency,
            buyRate,
            sellRate,
            source: "dynamic",
            usdtPrice: assetUsdtPrice,
            lastUpdated: new Date(),
        };
    }

    /**
     * Get rates for all supported assets
     * Optimized: Fetches USDT base rate and all prices once for consistency
     *
     * @returns Array of asset rates
     */
    async getAllRates(): Promise<AssetRate[]> {
        // Get all currencies from database
        const dbRates = await this.prisma.cryptoRate.findMany({
            orderBy: { currency: "asc" },
        });

        const isDynamic = await this.isDynamicRatesEnabled();

        if (!isDynamic) {
            // Legacy mode: Return database rates as-is
            return dbRates.map((rate) => ({
                currency: rate.currency,
                buyRate: rate.buyRate,
                sellRate: rate.sellRate,
                source: "database" as const,
                lastUpdated: rate.updatedAt,
            }));
        }

        // Dynamic mode: Fetch all data upfront for consistency
        // This ensures all rates use the same USDT base rate and price snapshot
        const usdtBaseRate = await this.getUsdtBaseRate();

        const currencies = dbRates.map((r) => r.currency);
        const batchPrices = await this.liveCoinWatchService.getBatchUsdtPrices(currencies);
        const priceMap = new Map(
            currencies.map((currency) => {
                if (currency === "USDT") {
                    return [currency, 1.0] as const;
                }

                return [currency, batchPrices[currency.toLowerCase()] ?? null] as const;
            })
        );

        // Calculate all rates using the same base rate and prices
        const rates: AssetRate[] = dbRates.map((dbRate) => {
            const currency = dbRate.currency;
            const assetUsdtPrice = priceMap.get(currency);

            // USDT uses database rate directly (admin-managed)
            if (currency === "USDT") {
                return {
                    currency: "USDT",
                    buyRate: usdtBaseRate.buyRate,
                    sellRate: usdtBaseRate.sellRate,
                    source: "database" as const,
                    usdtPrice: 1.0,
                    lastUpdated: new Date(),
                };
            }

            // If price fetch failed, fallback to DB rate
            if (assetUsdtPrice === null || assetUsdtPrice === undefined) {
                return {
                    currency,
                    buyRate: dbRate.buyRate,
                    sellRate: dbRate.sellRate,
                    source: "database" as const,
                    lastUpdated: dbRate.updatedAt,
                };
            }

            // Calculate dynamic rate
            const buyRate = assetUsdtPrice * usdtBaseRate.buyRate;
            const sellRate = assetUsdtPrice * usdtBaseRate.sellRate;

            return {
                currency,
                buyRate,
                sellRate,
                source: "dynamic" as const,
                usdtPrice: assetUsdtPrice,
                lastUpdated: new Date(),
            };
        });

        return rates;
    }

    /**
     * Invalidate USDT rate cache (call when admin updates USDT rate)
     */
    async invalidateUsdtCache(): Promise<void> {
        await this.redisCacheService.del(USDT_RATE_CACHE_KEY);
        this.logger.log("USDT rate cache invalidated");
    }

    /**
     * Get current feature flag status and system info
     */
    async getStatus(): Promise<{
        isDynamic: boolean;
        usdtRate: UsdtBaseRate | null;
        priceSource: string;
        lastPriceUpdate: { source: string; timestamp: number; count: number } | null;
    }> {
        const isDynamic = await this.isDynamicRatesEnabled();

        let usdtRate: UsdtBaseRate | null = null;
        try {
            usdtRate = await this.getUsdtBaseRate();
        } catch {
            // USDT not configured
        }

        const priceMeta = await this.redisCacheService.get<{
            source: string;
            timestamp: number;
            count: number;
        }>("price:usdt:meta");

        return {
            isDynamic,
            usdtRate,
            priceSource: "binance",
            lastPriceUpdate: priceMeta,
        };
    }
}
