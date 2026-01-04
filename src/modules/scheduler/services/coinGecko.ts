import { Injectable, Logger, OnModuleInit, Inject } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Mutex } from "async-mutex";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { getTriggeredTime } from "@/modules/scheduler/services/utils";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { CoinCapService } from "@/modules/factory/trading/providers/coincap/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";

/**
 * Price Cache Scheduler
 * Pre-fetches crypto prices using LiveCoinWatch with CoinCap fallback.
 * CoinGecko removed due to rate limiting issues.
 */
@Injectable()
export class PriceCacheSchedulerService implements OnModuleInit {
    private readonly logger = new Logger(PriceCacheSchedulerService.name);
    private mutex = new Mutex();
    private readonly coins = [
        "btc", "eth", "usdt", "usdc", "bnb", "sol", "xrp", "ada", "dot", "doge",
        "shib", "matic", "link", "ltc", "bch", "xlm", "algo", "aave", "fil", "trx"
    ];

    constructor(
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        @Inject(TradingInjectionToken.COINCAP)
        private readonly coinCapService: CoinCapService,
        private readonly redisCacheService: RedisCacheService
    ) { }

    // Run immediately when the server starts
    async onModuleInit() {
        this.logger.debug("🚀 Running initial coin price update at startup");
        await this.updateCoinPrices();
    }

    // Then run every 10 minutes
    @Cron("0 */10 * * * *", { timeZone: "Africa/Lagos" })
    async updateCoinPrices() {
        this.logger.debug(`Cron job for updating coin prices ${getTriggeredTime()}`);

        const release = await this.mutex.acquire();
        try {
            this.logger.debug("Acquired lock: Running coin prices update job");

            // Try LiveCoinWatch first
            let prices: Record<string, { price: number; change24h: number } | null> = {};

            try {
                prices = await this.liveCoinWatchService.getBatchMarketData(this.coins);
                this.logger.debug("✅ [LCW] Successfully fetched batch prices");
            } catch (lcwError) {
                this.logger.warn(`⚠️ [LCW] Failed, trying CoinCap: ${lcwError.message}`);
                try {
                    prices = await this.coinCapService.getBatchMarketData(this.coins);
                    this.logger.debug("✅ [CoinCap] Successfully fetched batch prices");
                } catch (ccError) {
                    this.logger.error(`❌ Both LCW and CoinCap failed: ${ccError.message}`);
                    return;
                }
            }

            // Cache the prices
            let successCount = 0;
            for (const coin of this.coins) {
                if (prices[coin]?.price) {
                    // Cache price with 10 min TTL (scheduler runs every 10 min)
                    await this.redisCacheService.set(
                        `price:${coin}:usd`,
                        prices[coin].price,
                        600
                    );
                    successCount++;
                }
            }

            this.logger.debug(`Completed price updates: ${successCount}/${this.coins.length} coins`);
        } catch (error: any) {
            this.logger.error("Error in running coin prices update cron job:", error);
        } finally {
            release();
            this.logger.debug("Lock released: Job completed");
        }
    }
}

