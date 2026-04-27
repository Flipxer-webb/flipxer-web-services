import { Inject, Injectable, Logger } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { isQuidaxThrottleError } from "@/libs/quidax";

@Injectable()
export class QuidaxCacheService {
    private readonly CACHE_KEY = "quidax:market:tickers";
    private readonly STALE_CACHE_KEY = "quidax:market:tickers:stale";
    private readonly CACHE_TTL = 60; // 60 seconds for fresh cache
    private readonly STALE_TTL = 300; // 5 minutes for stale fallback
    private readonly API_TIMEOUT_MS = 5000; // 5 second timeout for Quidax API
    private readonly BASE_THROTTLE_COOLDOWN_MS = 30_000;
    private readonly MAX_THROTTLE_COOLDOWN_MS = this.STALE_TTL * 1000;
    private readonly logger = new Logger(QuidaxCacheService.name);
    private inFlightMarketTickersRequest: Promise<Record<string, any>> | null = null;
    private marketTickersThrottleUntil = 0;
    private consecutiveThrottleCount = 0;

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

        const remainingThrottleMs = this.marketTickersThrottleUntil - Date.now();
        if (remainingThrottleMs > 0) {
            return this.getStaleMarketTickers(
                `[PERF] Quidax market ticker cooldown active for ${remainingThrottleMs}ms`,
            );
        }

        if (this.inFlightMarketTickersRequest !== null) {
            this.logger.debug(`[PERF] Quidax cache MISS, awaiting in-flight API request`);
            return this.inFlightMarketTickersRequest;
        }

        this.logger.debug(`[PERF] Quidax cache MISS, fetching from API`);

        this.inFlightMarketTickersRequest = (async () => {
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

                this.marketTickersThrottleUntil = 0;
                this.consecutiveThrottleCount = 0;
                this.logger.log(`[PERF] Quidax API fetch: ${Date.now() - startTime}ms`);
                return data;
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                this.logger.error(`[PERF] Quidax API error after ${Date.now() - startTime}ms: ${errorMessage}`);

                if (isQuidaxThrottleError(err)) {
                    this.consecutiveThrottleCount += 1;
                    const cooldownMs = this.getThrottleCooldownMs();
                    this.marketTickersThrottleUntil = Date.now() + cooldownMs;
                    this.logger.warn(
                        `[PERF] Entering Quidax market ticker cooldown for ${cooldownMs}ms after ${this.consecutiveThrottleCount} consecutive throttling response(s)`,
                    );
                }

                return this.getStaleMarketTickers(`[PERF] Using stale Quidax cache as fallback`);
            } finally {
                this.inFlightMarketTickersRequest = null;
            }
        })();

        return this.inFlightMarketTickersRequest;
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

    private async getStaleMarketTickers(logMessage: string): Promise<Record<string, any>> {
        const staleData = await this.redisCacheService.get(this.STALE_CACHE_KEY);

        if (staleData) {
            this.logger.warn(logMessage);
            return staleData;
        }

        this.logger.warn(`${logMessage}; no stale cache available`);
        return {};
    }

    private getThrottleCooldownMs(): number {
        const backoffMultiplier = Math.max(0, this.consecutiveThrottleCount - 1);
        return Math.min(
            this.BASE_THROTTLE_COOLDOWN_MS * 2 ** backoffMultiplier,
            this.MAX_THROTTLE_COOLDOWN_MS,
        );
    }
}
