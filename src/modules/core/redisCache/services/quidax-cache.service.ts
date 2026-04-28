import { Inject, Injectable, Logger } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";
import { DistributedLockService } from "./distributed-lock.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { isQuidaxThrottleError } from "@/libs/quidax";

type SharedMarketTickerState = {
    inFlightMarketTickersRequest: Promise<Record<string, any>> | null;
    marketTickersThrottleUntil: number;
    consecutiveThrottleCount: number;
    lastSuccessfulMarketTickers: Record<string, any> | null;
    lastSuccessfulMarketTickersAt: number;
};

const sharedMarketTickerState: SharedMarketTickerState = {
    inFlightMarketTickersRequest: null,
    marketTickersThrottleUntil: 0,
    consecutiveThrottleCount: 0,
    lastSuccessfulMarketTickers: null,
    lastSuccessfulMarketTickersAt: 0,
};

@Injectable()
export class QuidaxCacheService {
    private readonly CACHE_KEY = "quidax:market:tickers";
    private readonly STALE_CACHE_KEY = "quidax:market:tickers:stale";
    private readonly FETCH_LOCK_KEY = "quidax:market:tickers:refresh";
    private readonly CACHE_TTL = 60; // 60 seconds for fresh cache
    private readonly STALE_TTL = 300; // 5 minutes for stale fallback
    private readonly API_TIMEOUT_MS = 5000; // 5 second timeout for Quidax API
    private readonly FETCH_LOCK_TTL_MS = this.API_TIMEOUT_MS + 1000;
    private readonly FETCH_LOCK_WAIT_MS = 1000;
    private readonly FETCH_LOCK_RETRY_INTERVAL_MS = 100;
    private readonly BASE_THROTTLE_COOLDOWN_MS = 30_000;
    private readonly MAX_THROTTLE_COOLDOWN_MS = this.STALE_TTL * 1000;
    private readonly LAST_SUCCESSFUL_FALLBACK_TTL_MS = 15 * 60_000;
    private readonly logger = new Logger(QuidaxCacheService.name);

    constructor(
        private readonly redisCacheService: RedisCacheService,
        private readonly distributedLockService: DistributedLockService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) { }

    private get inFlightMarketTickersRequest(): Promise<Record<string, any>> | null {
        return sharedMarketTickerState.inFlightMarketTickersRequest;
    }

    private set inFlightMarketTickersRequest(value: Promise<Record<string, any>> | null) {
        sharedMarketTickerState.inFlightMarketTickersRequest = value;
    }

    private get marketTickersThrottleUntil(): number {
        return sharedMarketTickerState.marketTickersThrottleUntil;
    }

    private set marketTickersThrottleUntil(value: number) {
        sharedMarketTickerState.marketTickersThrottleUntil = value;
    }

    private get consecutiveThrottleCount(): number {
        return sharedMarketTickerState.consecutiveThrottleCount;
    }

    private set consecutiveThrottleCount(value: number) {
        sharedMarketTickerState.consecutiveThrottleCount = value;
    }

    private get lastSuccessfulMarketTickers(): Record<string, any> | null {
        return sharedMarketTickerState.lastSuccessfulMarketTickers;
    }

    private set lastSuccessfulMarketTickers(value: Record<string, any> | null) {
        sharedMarketTickerState.lastSuccessfulMarketTickers = value;
    }

    private get lastSuccessfulMarketTickersAt(): number {
        return sharedMarketTickerState.lastSuccessfulMarketTickersAt;
    }

    private set lastSuccessfulMarketTickersAt(value: number) {
        sharedMarketTickerState.lastSuccessfulMarketTickersAt = value;
    }

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

        this.inFlightMarketTickersRequest = this.fetchMarketTickersWithDistributedLock(startTime);
        return this.inFlightMarketTickersRequest;
    }

    private async fetchMarketTickersWithDistributedLock(
        startTime: number,
    ): Promise<Record<string, any>> {
        const lockToken = await this.distributedLockService.acquireLock(
            this.FETCH_LOCK_KEY,
            {
                ttlMs: this.FETCH_LOCK_TTL_MS,
                maxWaitMs: this.FETCH_LOCK_WAIT_MS,
                retryIntervalMs: this.FETCH_LOCK_RETRY_INTERVAL_MS,
            },
        );

        try {
            if (!lockToken) {
                return this.getStaleMarketTickers(
                    `[PERF] Another instance is refreshing Quidax market tickers; using stale cache while waiting for Redis refresh`,
                );
            }

            const refreshedCache = await this.redisCacheService.get(this.CACHE_KEY);
            if (refreshedCache) {
                this.logger.debug(
                    `[PERF] Quidax cache refreshed by another instance in ${Date.now() - startTime}ms`,
                );
                return refreshedCache;
            }

            this.logger.debug(`[PERF] Quidax cache MISS, fetching from API`);
            return await this.fetchAndCacheMarketTickers(startTime);
        } finally {
            this.inFlightMarketTickersRequest = null;

            if (lockToken) {
                await this.distributedLockService.releaseLock(this.FETCH_LOCK_KEY, lockToken);
            }
        }
    }

    private async fetchAndCacheMarketTickers(startTime: number): Promise<Record<string, any>> {
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
            this.lastSuccessfulMarketTickers = data;
            this.lastSuccessfulMarketTickersAt = Date.now();
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

    private async getStaleMarketTickers(logMessage: string): Promise<Record<string, any>> {
        const staleData = await this.redisCacheService.get(this.STALE_CACHE_KEY);

        if (staleData) {
            this.logger.warn(logMessage);
            return staleData;
        }

        const lastSuccessfulMarketTickers = this.lastSuccessfulMarketTickers;
        const hasRecentSuccessfulFallback =
            lastSuccessfulMarketTickers !== null &&
            Date.now() - this.lastSuccessfulMarketTickersAt <= this.LAST_SUCCESSFUL_FALLBACK_TTL_MS;

        if (hasRecentSuccessfulFallback) {
            this.logger.warn(
                `${logMessage}; stale cache expired, using last successful in-memory Quidax cache as fallback`,
            );
            return lastSuccessfulMarketTickers;
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
