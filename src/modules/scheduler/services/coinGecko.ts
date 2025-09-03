import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Mutex } from "async-mutex";
import { CoinGeckoCacheService } from "@/modules/core/redisCache/services/coingecko-cache.service";
import { getTriggeredTime } from "@/modules/scheduler/services/utils";

@Injectable()
export class CoinGeckoCacheSchedulerService implements OnModuleInit {
    private readonly logger = new Logger(CoinGeckoCacheSchedulerService.name);
    private mutex = new Mutex();
    private readonly coins = [
        "btc", "eth", "usdt", "usdc", "bnb", "sol", "xrp", "ada", "dot", "doge",
        "shib", "matic", "link", "ltc", "bch", "xlm", "algo", "aave", "fil", "cake",
        "mana", "sand", "ftm", "xtz", "ape", "ens", "arb", "op", "icp", "sui"
    ];

    constructor(
        private readonly coinGeckoCacheService: CoinGeckoCacheService
    ) {}

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

            // Fetch prices for all 30 coins in one batch
            const prices = await this.coinGeckoCacheService.getBatchPriceInUSD(this.coins);

            for (const coin of this.coins) {
                if (prices[coin] !== undefined && prices[coin] !== null) {
                    this.logger.debug(`Successfully cached price for ${coin}: $${prices[coin]}`);
                } else {
                    this.logger.warn(`Failed to fetch price for ${coin}`);
                }
            }

            this.logger.debug(`Completed price updates for ${this.coins.length} coins`);
        } catch (error: any) {
            this.logger.error("Error in running coin prices update cron job:", error);
            if (error?.message?.includes("429")) {
                this.logger.warn(
                    "Rate limit exceeded. Consider increasing cron interval or reducing coin count."
                );
            }
        } finally {
            release();
            this.logger.debug("Lock released: Job completed");
        }
    }
}
