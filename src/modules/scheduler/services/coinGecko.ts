import { Injectable, Logger, OnModuleInit, Inject } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Mutex } from "async-mutex";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { getTriggeredTime } from "@/modules/scheduler/services/utils";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { CoinCapService } from "@/modules/factory/trading/providers/coincap/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { WsGateway } from "@/modules/api/trade/gateway/v1";

/**
 * Price Cache Scheduler
 * Pre-fetches crypto prices using LiveCoinWatch with CoinCap fallback for USD prices.
 * Uses LiveCoinWatch for X/USDT prices (for dynamic rate calculation).
 * CoinGecko removed due to rate limiting issues.
 * Binance removed due to geo-blocking (HTTP 451) on Render servers.
 */
@Injectable()
export class PriceCacheSchedulerService implements OnModuleInit {
    private readonly logger = new Logger(PriceCacheSchedulerService.name);
    private readonly mutex = new Mutex();
    private readonly usdtPriceMutex = new Mutex();
    private readonly coins = [
        "btc", "eth", "usdt", "usdc", "bnb", "sol", "xrp", "ada", "dot", "doge",
        "shib", "matic", "link", "ltc", "bch", "xlm", "algo", "aave", "fil", "trx"
    ];

    constructor(
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        @Inject(TradingInjectionToken.COINCAP)
        private readonly coinCapService: CoinCapService,
        private readonly redisCacheService: RedisCacheService,
        private readonly wsGateway: WsGateway
    ) { }

    // Run immediately when the server starts
    async onModuleInit() {
        this.logger.debug("🚀 Running initial coin price update at startup");
        await Promise.all([
            this.updateCoinPrices(),
            this.updateUsdtPrices(),
        ]);
    }

    // Run every 10 minutes for USD prices (for portfolio display)
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

    /**
     * Update X/USDT prices from LiveCoinWatch for dynamic rate calculation
     * Runs every 60 seconds for accurate trading rates
     * Uses batch API to reduce from 19 individual calls to 1 batch call
     */
    @Cron("*/60 * * * * *", { timeZone: "Africa/Lagos" })
    async updateUsdtPrices() {
        this.logger.debug(`USDT prices cron job ${getTriggeredTime()}`);

        const release = await this.usdtPriceMutex.acquire();
        try {
            this.logger.debug("Acquired lock: Running USDT prices update job");

            // Use batch API call instead of individual calls (reduces 19 calls to 1)
            let usdtPrices: Record<string, number | null> = {};
            let batchSuccess = false;

            try {
                usdtPrices = await this.liveCoinWatchService.getBatchUsdtPrices(this.coins);
                batchSuccess = true;
                this.logger.debug("✅ [LCW] Batch USDT price fetch successful");
            } catch (batchError) {
                this.logger.warn(`⚠️ [LCW] Batch fetch failed, falling back to individual calls: ${batchError.message}`);
                usdtPrices = await this.fetchIndividualUsdtPrices();
            }

            this.logger.debug(`✅ [LiveCoinWatch] Fetched ${Object.keys(usdtPrices).length} USDT prices`);

            // Cache USDT prices (batch method already caches, but ensure consistency)
            let successCount = 0;
            const timestamp = Date.now();

            for (const [symbol, price] of Object.entries(usdtPrices)) {
                if (price && price > 0) {
                    // Only cache if batch method didn't already cache (fallback scenario)
                    if (!batchSuccess) {
                        await this.redisCacheService.set(
                            `price:${symbol.toLowerCase()}:usdt`,
                            price,
                            90 // 90s TTL (slightly longer than 60s cron)
                        );
                    }
                    successCount++;
                }
            }

            // Store metadata for admin/debugging
            await this.redisCacheService.set(
                "price:usdt:meta",
                { source: "livecoinwatch", timestamp, count: successCount, batchMode: batchSuccess },
                90
            );

            this.logger.debug(
                `[LiveCoinWatch] Completed USDT price updates: ${successCount}/${this.coins.length} coins (batch: ${batchSuccess})`
            );

            // Broadcast price update to connected clients via WebSocket
            if (successCount > 0) {
                const pricePayload: Record<string, { price: number; change24h?: number } | null> = {};
                for (const [symbol, price] of Object.entries(usdtPrices)) {
                    pricePayload[symbol] = price ? { price } : null;
                }
                this.wsGateway.broadcastPriceUpdate(pricePayload);
            }
        } catch (error: any) {
            this.logger.error("Error in running USDT prices update cron job:", error);
        } finally {
            release();
            this.logger.debug("USDT prices lock released");
        }
    }

    private async fetchIndividualUsdtPrices(): Promise<Record<string, number | null>> {
        const prices: Record<string, number | null> = {};

        for (const coin of this.coins) {
            if (coin.toLowerCase() === "usdt") {
                prices["usdt"] = 1;
                continue;
            }
            try {
                prices[coin.toLowerCase()] = await this.liveCoinWatchService.getPriceInUSDT(coin);
            } catch (err) {
                this.logger.warn(`Failed to get USDT price for ${coin}: ${err.message}`);
                prices[coin.toLowerCase()] = null;
            }
        }

        return prices;
    }
}

