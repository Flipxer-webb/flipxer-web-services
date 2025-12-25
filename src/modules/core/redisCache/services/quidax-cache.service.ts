import { Inject, Injectable, Logger } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";

@Injectable()
export class QuidaxCacheService {
    private readonly CACHE_KEY = "quidax:market:tickers";
    private readonly STALE_CACHE_KEY = "quidax:market:tickers:stale";
    private readonly CACHE_TTL = 60; // 60 seconds for fresh cache
    private readonly STALE_TTL = 300; // 5 minutes for stale fallback
    private readonly API_TIMEOUT_MS = 5000; // 5 second timeout for Quidax API
    private readonly logger = new Logger(QuidaxCacheService.name);

    constructor(
        private readonly redisCacheService: RedisCacheService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) { }

    async getMarketTickers(): Promise<Record<string, any>> {
        const startTime = Date.now();

        // Try fresh cache first
        const cached = await this.redisCacheService.get(this.CACHE_KEY);
        if (cached) {
            this.logger.debug(`[PERF] Quidax cache HIT in ${Date.now() - startTime}ms`);
            return cached;
        }

        this.logger.debug(`[PERF] Quidax cache MISS, fetching from API`);

        try {
            // Fetch with timeout to prevent slow API from blocking
            const response = await this.fetchWithTimeout(
                () => this.quidaxService.getMarketTickers(),
                this.API_TIMEOUT_MS
            );

            const data = response.data ?? {};

            // Save to both fresh and stale caches
            await Promise.all([
                this.redisCacheService.set(this.CACHE_KEY, data, this.CACHE_TTL),
                this.redisCacheService.set(this.STALE_CACHE_KEY, data, this.STALE_TTL),
            ]);

            this.logger.log(`[PERF] Quidax API fetch: ${Date.now() - startTime}ms`);
            return data;
        } catch (err) {
            this.logger.error(`[PERF] Quidax API error after ${Date.now() - startTime}ms: ${err.message}`);

            // Fallback to stale cache if available
            const staleData = await this.redisCacheService.get(this.STALE_CACHE_KEY);
            if (staleData) {
                this.logger.warn(`[PERF] Using stale Quidax cache as fallback`);
                return staleData;
            }

            return {};
        }
    }

    /**
     * Execute a promise with a timeout
     * If the promise takes longer than timeoutMs, it will be rejected
     */
    private async fetchWithTimeout<T>(
        fetcher: () => Promise<T>,
        timeoutMs: number
    ): Promise<T> {
        return Promise.race([
            fetcher(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Quidax API timeout after ${timeoutMs}ms`)), timeoutMs)
            ),
        ]);
    }
}
