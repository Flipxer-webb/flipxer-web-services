import { Injectable, Logger, Inject } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { BinanceService } from "@/modules/factory/trading/providers/binance/services";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import { HttpStatus } from "@nestjs/common";

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
        @Inject(TradingInjectionToken.BINANCE)
        private readonly binanceService: BinanceService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService
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
            // TODO: Send Slack alert here
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
     * Get the X/USDT price from cache or external providers
     * Uses Binance as primary, LiveCoinWatch as fallback
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

        // Try Binance first (may fail with 451 in certain regions)
        try {
            const price = await this.binanceService.getPriceInUSDT(currency);
            return price;
        } catch (binanceError) {
            this.logger.warn(
                `Binance failed for ${currency}: ${binanceError.message}, trying LiveCoinWatch...`
            );

            // Fallback to LiveCoinWatch
            try {
                const price = await this.liveCoinWatchService.getPriceInUSDT(currency);
                this.logger.log(`LiveCoinWatch fallback succeeded for ${currency}: ${price} USDT`);
                return price;
            } catch (lcwError) {
                this.logger.error(
                    `Both Binance and LiveCoinWatch failed for ${currency}: ${lcwError.message}`
                );
                throw new GeneralTransactionException(
                    `Unable to fetch current rate for ${currency}`,
                    HttpStatus.SERVICE_UNAVAILABLE
                );
            }
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

        // Check for DB override (admin can set specific rates for any asset)
        const dbOverride = await this.getDbOverride(normalizedCurrency);
        if (dbOverride) {
            return dbOverride;
        }

        // Calculate dynamic rate
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
     * Check for database override (when admin wants to set a specific rate)
     */
    private async getDbOverride(currency: string): Promise<AssetRate | null> {
        const rate = await this.prisma.cryptoRate.findUnique({
            where: { currency },
        });

        // If rate exists AND has non-zero values, use it as override
        if (rate && (rate.buyRate > 0 || rate.sellRate > 0)) {
            this.logger.debug(`Using DB override for ${currency}`);
            return {
                currency,
                buyRate: rate.buyRate,
                sellRate: rate.sellRate,
                source: "database",
                lastUpdated: rate.updatedAt,
            };
        }

        return null;
    }

    /**
     * Calculate dynamic rate from USDT base rate and Binance price
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

        // Dynamic mode: Calculate all rates
        const rates: AssetRate[] = [];

        for (const dbRate of dbRates) {
            try {
                const rate = await this.getAssetRate(dbRate.currency);
                rates.push(rate);
            } catch (error) {
                this.logger.warn(
                    `Failed to get rate for ${dbRate.currency}: ${error.message}`
                );
                // Include DB rate as fallback
                rates.push({
                    currency: dbRate.currency,
                    buyRate: dbRate.buyRate,
                    sellRate: dbRate.sellRate,
                    source: "database",
                    lastUpdated: dbRate.updatedAt,
                });
            }
        }

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
