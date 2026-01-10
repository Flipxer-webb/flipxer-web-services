import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";

@Injectable()
export class VolatilityMonitorService {
    private readonly logger = new Logger(VolatilityMonitorService.name);
    private readonly VOLATILITY_THRESHOLD = 0.05; // 5% drop
    private readonly REDIS_PREFIX = "risk:volatile:";
    private readonly MONITORED_ASSETS = ["BTC", "ETH", "USDT", "USDC", "BNB", "SOL", "XRP", "ADA", "DOGE", "SHIB", "TRX", "LTC"]; // Major assets + those we support

    constructor(
        private readonly lcwService: LiveCoinWatchService,
        private readonly redisService: RedisCacheService
    ) { }

    /**
     * Periodic check for volatility
     * Runs every minute
     */
    @Cron("*/1 * * * *")
    async checkMarketVolatility() {
        this.logger.debug("Running volatility check...");
        try {
            // Get batch data which includes 24h change. 
            // Wait, LCW `getBatchMarketData` returns price and change24h, but we need 1-hour change.
            // `getMarketData` returns the full delta object.
            // To be efficient, we might need a new method in LCW service or just iterate.
            // Since our list is small (10-20 coins), iterating `getMarketData` is acceptable but slower.
            // Or we use `getBatchMarketData` if we accept 24h change? 
            // Plan says 1-hour or 4-hour.
            // Let's use `getMarketData` for each asset for accuracy.

            // To avoid rate limits, we'll do them sequentially with a small delay or use the LCW service's built-in handling.

            for (const asset of this.MONITORED_ASSETS) {
                if (asset === 'USDT' || asset === 'USDC') continue; // Stablecoins

                try {
                    const data = await this.lcwService.getMarketData(asset);
                    if (!data || !data.delta) continue;

                    // delta.hour is a multiplier (e.g. 1.05 = +5%, 0.95 = -5%)
                    // We care about drops > 5% (i.e., < 0.95)
                    const hourDelta = data.delta.hour;

                    if (hourDelta < (1 - this.VOLATILITY_THRESHOLD)) {
                        this.logger.warn(`HIGH VOLATILITY DETECTED: ${asset} dropped ${(1 - hourDelta) * 100}% in 1h`);
                        await this.setVolatile(asset, true, `1h drop of ${((1 - hourDelta) * 100).toFixed(2)}%`);
                    } else {
                        // If previously volatile, we might want to clear it, or let it expire.
                        // We will let it expire to be safe (min 5 mins lock).
                    }
                } catch (e) {
                    this.logger.warn(`Failed to check volatility for ${asset}: ${e.message}`);
                }
            }

        } catch (error) {
            this.logger.error(`Volatility check failed: ${error.message}`);
        }
    }

    async setVolatile(asset: string, customStatus: boolean, reason?: string) {
        const key = `${this.REDIS_PREFIX}${asset.toUpperCase()}`;
        if (customStatus) {
            await this.redisService.set(key, { isVolatile: true, reason, timestamp: Date.now() }, 300); // 5 mins
        } else {
            await this.redisService.del(key);
        }
    }

    async isVolatile(asset: string): Promise<{ isVolatile: boolean; reason?: string } | null> {
        const key = `${this.REDIS_PREFIX}${asset.toUpperCase()}`;
        const data = await this.redisService.get<{ isVolatile: boolean; reason?: string; timestamp: number }>(key);
        return data || null;
    }
}
