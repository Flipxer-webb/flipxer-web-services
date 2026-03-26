import { Injectable, HttpStatus, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import axios, { AxiosInstance } from "axios";
import { setTimeout } from "timers/promises";

interface LiveCoinWatchCoin {
    code: string;
    rate: number;
    volume: number;
    cap: number;
    circulatingSupply: number;
    totalSupply: number;
    maxSupply: number;
    delta: {
        hour: number;
        day: number;
        week: number;
        month: number;
        quarter: number;
        year: number;
    };
}

interface LiveCoinWatchHistoryPoint {
    date: number;
    rate: number;
    volume: number;
    cap: number;
}

@Injectable()
export class LiveCoinWatchService {
    private readonly logger = new Logger(LiveCoinWatchService.name);
    private readonly apiClient: AxiosInstance;
    private readonly baseUrl = "https://api.livecoinwatch.com";
    private readonly inFlightUsdtPriceRequests = new Map<string, Promise<number>>();
    private readonly inFlightBatchUsdtRequests = new Map<string, Promise<Record<string, number | null>>>();
    private readonly inFlightBatchMarketRequests = new Map<string, Promise<Record<string, { price: number; change24h: number } | null>>>();

    // Map symbols to LiveCoinWatch codes (usually uppercase)
    private readonly symbolMap: { [key: string]: string } = {
        btc: "BTC",
        eth: "ETH",
        usdt: "USDT",
        usdc: "USDC",
        bnb: "BNB",
        sol: "SOL",
        xrp: "XRP",
        ada: "ADA",
        doge: "DOGE",
        shib: "SHIB",
        trx: "TRX",
        ltc: "LTC",
        dot: "DOT",
        matic: "MATIC",
        link: "LINK",
        bch: "BCH",
        xlm: "XLM",
        algo: "ALGO",
        aave: "AAVE",
        fil: "FIL",
    };

    constructor(
        private readonly redisCacheService: RedisCacheService,
        private readonly configService: ConfigService
    ) {
        this.apiClient = axios.create({
            baseURL: this.baseUrl,
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.configService.get<string>("LIVECOINWATCH_API_KEY") || "",
            },
            timeout: 10000,
        });
    }

    private getHttpStatusFromError(error: unknown): number | undefined {
        if (axios.isAxiosError(error)) {
            return error.response?.status;
        }

        return undefined;
    }

    private getNormalizedAssets(assets: string[]): string[] {
        return [...new Set(
            assets
                .map((asset) => asset?.trim())
                .filter(Boolean)
                .map((asset) => asset.toUpperCase())
        )];
    }

    /**
     * Get current price for a single asset
     */
    async getPriceInUSD(asset: string, retries = 3, delay = 1000): Promise<number> {
        this.logger.debug(`Fetching price for asset: ${asset}`);

        const cacheKey = `lcw:price:${asset.toLowerCase()}:usd`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) {
            this.logger.debug(`Cache hit for ${asset}: $${cachedPrice}`);
            return cachedPrice;
        }

        const lcwCode = this.symbolMap[asset.toLowerCase()] || asset.toUpperCase();

        // FIX: Handle NGN explicit check to avoid 400 from LiveCoinWatch (Fiat not supported in this endpoint)
        if (lcwCode === 'NGN') {
            this.logger.debug('Asset is NGN, returning static USD approx rate to avoid API error');
            return 0.00065; // Approx 1/1540
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                this.logger.debug(`Requesting price for ${asset} (code: ${lcwCode}), attempt ${attempt}`);

                const response = await this.apiClient.post("/coins/single", {
                    currency: "USD",
                    code: lcwCode,
                    meta: false,
                });

                const rate = response.data?.rate;
                if (!rate) throw new Error(`No price data for ${asset}`);

                await this.redisCacheService.set(cacheKey, rate, 300); // Cache for 5 minutes
                this.logger.debug(`Price for ${asset}: $${rate}`);
                return rate;
            } catch (error) {
                this.logger.error(`Attempt ${attempt} failed for ${asset}: ${error.message}`);
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch price for ${asset}: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }
    }

    /**
     * Get current price for a single asset in USDT
     * Used for dynamic rate calculation fallback when Binance is unavailable
     */
    async getPriceInUSDT(asset: string, retries = 3, delay = 1000): Promise<number> {
        const normalizedAsset = asset.toUpperCase();

        // USDT itself is always 1:1
        if (normalizedAsset === "USDT") {
            return 1;
        }

        this.logger.debug(`Fetching USDT price for asset: ${asset}`);

        const cacheKey = `lcw:price:${asset.toLowerCase()}:usdt`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) {
            this.logger.debug(`Cache hit for ${asset}: ${cachedPrice} USDT`);
            return cachedPrice;
        }

        const inflightUsdt = this.inFlightUsdtPriceRequests.get(normalizedAsset);
        if (inflightUsdt !== undefined) {
            return inflightUsdt;
        }

        const requestPromise = (async () => {
            const lcwCode = this.symbolMap[asset.toLowerCase()] || asset.toUpperCase();

            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    this.logger.debug(`Requesting USDT price for ${asset} (code: ${lcwCode}), attempt ${attempt}`);

                    const response = await this.apiClient.post("/coins/single", {
                        currency: "USDT",
                        code: lcwCode,
                        meta: false,
                    });

                    const rate = response.data?.rate;
                    if (!rate) throw new Error(`No USDT price data for ${asset}`);

                    await this.redisCacheService.set(cacheKey, rate, 60);
                    this.logger.debug(`USDT price for ${asset}: ${rate}`);
                    return rate;
                } catch (error) {
                    const statusCode = this.getHttpStatusFromError(error);
                    this.logger.error(`USDT price attempt ${attempt} failed for ${asset}: ${error.message}`);

                    // 403 usually indicates key/plan/permission issue; avoid noisy retries.
                    if (statusCode === 403 || attempt === retries) {
                        throw new GeneralTransactionException(
                            `Failed to fetch USDT price for ${asset}: ${error.message}`,
                            HttpStatus.INTERNAL_SERVER_ERROR
                        );
                    }

                    // On rate limits, use stronger linear backoff.
                    const waitMs = statusCode === 429 ? delay * attempt * 2 : delay * attempt;
                    await setTimeout(waitMs);
                }
            }

            throw new GeneralTransactionException(
                `Failed to fetch USDT price for ${asset}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        })();

        this.inFlightUsdtPriceRequests.set(normalizedAsset, requestPromise);

        try {
            return await requestPromise;
        } finally {
            this.inFlightUsdtPriceRequests.delete(normalizedAsset);
        }
    }

    /**
     * Get batch USDT prices for multiple assets in a single API call
     * Used by cron job to avoid rate limiting (1 call instead of N calls)
     * @returns Map of asset symbol (lowercase) to USDT price
     */
    async getBatchUsdtPrices(assets: string[]): Promise<Record<string, number | null>> {
        const normalizedAssets = this.getNormalizedAssets(assets);
        this.logger.debug(`Batch fetching USDT prices for: ${normalizedAssets.join(", ")}`);

        const batchKey = `lcw:batch-usdt:inflight:${[...normalizedAssets].sort((a, b) => a.localeCompare(b)).join(",")}`;
        const inflightBatchUsdt = this.inFlightBatchUsdtRequests.get(batchKey);
        if (inflightBatchUsdt) {
            return inflightBatchUsdt;
        }

        const requestPromise = (async () => {
            const result: Record<string, number | null> = {};

            // Handle USDT immediately - it's always 1:1
            if (normalizedAssets.some(a => a.toUpperCase() === "USDT")) {
                result["usdt"] = 1;
            }

            // Filter out USDT for the API call
            const assetsToFetch = normalizedAssets.filter(a => a.toUpperCase() !== "USDT");

            if (assetsToFetch.length === 0) {
                return result;
            }

            // Check cache first for all assets
            const { cached: cachedResults, uncached: uncachedAssets } =
                await this.partitionCachedAssets(assetsToFetch);

            // If all cached, return early
            if (uncachedAssets.length === 0) {
                this.logger.debug(`All ${assetsToFetch.length} USDT prices served from cache`);
                return { ...result, ...cachedResults };
            }

            const fetchedResults = await this.fetchUncachedPrices(uncachedAssets);
            Object.assign(result, fetchedResults);

            return { ...result, ...cachedResults };
        })();

        this.inFlightBatchUsdtRequests.set(batchKey, requestPromise);

        try {
            return await requestPromise;
        } finally {
            this.inFlightBatchUsdtRequests.delete(batchKey);
        }
    }

    /**
     * Partitions assets into cached (with prices) and uncached lists.
     */
    private async partitionCachedAssets(
        assets: string[]
    ): Promise<{ cached: Record<string, number | null>; uncached: string[] }> {
        const cached: Record<string, number | null> = {};
        const uncached: string[] = [];

        for (const asset of assets) {
            const cacheKey = `lcw:price:${asset.toLowerCase()}:usdt`;
            const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
            if (cachedPrice) {
                cached[asset.toLowerCase()] = cachedPrice;
            } else {
                uncached.push(asset);
            }
        }

        return { cached, uncached };
    }

    /**
     * Fetches prices for uncached assets from the LiveCoinWatch API,
     * caches them, and returns a result map (null for missing/failed).
     */
    private async fetchUncachedPrices(
        uncachedAssets: string[]
    ): Promise<Record<string, number | null>> {
        const result: Record<string, number | null> = {};

        try {
            const codes = uncachedAssets.map(a => this.symbolMap[a.toLowerCase()] || a.toUpperCase());

            this.logger.debug(`Making batch API call for ${codes.length} uncached assets: ${codes.join(", ")}`);

            const response = await this.apiClient.post("/coins/list", {
                currency: "USDT",
                codes: codes,
                sort: "rank",
                order: "ascending",
                offset: 0,
                limit: codes.length,
                meta: false,
            });

            const coins = response.data as LiveCoinWatchCoin[];

            for (const coin of coins) {
                const assetKey = uncachedAssets.find(
                    a => (this.symbolMap[a.toLowerCase()] || a.toUpperCase()) === coin.code
                );

                if (assetKey && coin.rate) {
                    const key = assetKey.toLowerCase();
                    result[key] = coin.rate;
                    const cacheKey = `lcw:price:${key}:usdt`;
                    await this.redisCacheService.set(cacheKey, coin.rate, 90);
                }
            }

            // Mark any missing assets as null
            for (const asset of uncachedAssets) {
                if (result[asset.toLowerCase()] === undefined) {
                    result[asset.toLowerCase()] = null;
                }
            }

            this.logger.debug(`✅ Batch fetched ${coins.length} USDT prices in 1 API call`);
        } catch (error) {
            this.logger.error(`Batch USDT price fetch failed: ${error.message}`);

            for (const asset of uncachedAssets) {
                result[asset.toLowerCase()] = null;
            }
        }

        return result;
    }

    /**
     * Get market data for a single asset (price, volume, market cap, % changes)
     */
    async getMarketData(asset: string, retries = 3, delay = 1000): Promise<LiveCoinWatchCoin> {
        this.logger.debug(`Fetching market data for: ${asset}`);

        const cacheKey = `lcw:market:${asset.toLowerCase()}`;
        const cachedData = await this.redisCacheService.get<LiveCoinWatchCoin>(cacheKey);
        if (cachedData) {
            this.logger.debug(`Cache hit for ${asset} market data`);
            return cachedData;
        }

        const lcwCode = this.symbolMap[asset.toLowerCase()] || asset.toUpperCase();

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await this.apiClient.post("/coins/single", {
                    currency: "USD",
                    code: lcwCode,
                    meta: true,
                });

                const data = response.data as LiveCoinWatchCoin;
                await this.redisCacheService.set(cacheKey, data, 300); // Cache for 5 minutes
                this.logger.debug(`Market data for ${asset}: $${data.rate}`);
                return data;
            } catch (error) {
                this.logger.error(`Market data attempt ${attempt} failed: ${error.message}`);
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch market data for ${asset}: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }
    }

    /**
     * Get historical price data for charts
     * @param asset Asset symbol
     * @param days Number of days (1, 7, 30, 90, 365)
     */
    async getHistoricalData(
        asset: string,
        days: number = 7,
        retries = 3,
        delay = 1000
    ): Promise<{ prices: [number, number][]; high24h: number; low24h: number }> {
        this.logger.debug(`Fetching ${days}d history for: ${asset}`);

        const cacheKey = `lcw:history:${asset.toLowerCase()}:${days}d`;
        const cachedData = await this.redisCacheService.get<{ prices: [number, number][]; high24h: number; low24h: number }>(cacheKey);
        if (cachedData) {
            this.logger.debug(`Cache hit for ${asset} ${days}d history`);
            return cachedData;
        }

        const lcwCode = this.symbolMap[asset.toLowerCase()] || asset.toUpperCase();
        const end = Date.now();
        const start = end - days * 24 * 60 * 60 * 1000;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await this.apiClient.post("/coins/single/history", {
                    currency: "USD",
                    code: lcwCode,
                    start: start,
                    end: end,
                    meta: false,
                });

                const history = response.data.history as LiveCoinWatchHistoryPoint[];

                // Convert to [timestamp, price] format
                const prices: [number, number][] = history.map(point => [point.date, point.rate]);

                // Calculate 24h high/low from last 24 hours of data
                const oneDayAgo = end - 24 * 60 * 60 * 1000;
                const last24h = history.filter(p => p.date >= oneDayAgo);
                const rates24h = last24h.map(p => p.rate);
                const high24h = rates24h.length > 0 ? Math.max(...rates24h) : null;
                const low24h = rates24h.length > 0 ? Math.min(...rates24h) : null;

                const result = { prices, high24h, low24h };

                // Cache for 30 minutes for short periods, 2 hours for longer
                const cacheDuration = days <= 1 ? 30 * 60 : 2 * 60 * 60;
                await this.redisCacheService.set(cacheKey, result, cacheDuration);

                this.logger.debug(`Got ${prices.length} data points for ${asset}`);
                return result;
            } catch (error) {
                this.logger.error(`History attempt ${attempt} failed: ${error.message}`);
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch history for ${asset}: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }
    }

    /**
     * Get batch prices for multiple assets (for sparklines)
     */
    async getBatchPrices(assets: string[]): Promise<Record<string, number | null>> {
        this.logger.debug(`Batch fetching prices for: ${assets.join(", ")}`);

        const result: Record<string, number | null> = {};

        try {
            const codes = assets.map(a => this.symbolMap[a.toLowerCase()] || a.toUpperCase());

            const response = await this.apiClient.post("/coins/list", {
                currency: "USD",
                codes: codes,
                sort: "rank",
                order: "ascending",
                offset: 0,
                limit: codes.length,
                meta: false,
            });

            const coins = response.data as LiveCoinWatchCoin[];

            coins.forEach(coin => {
                const assetKey = assets.find(
                    a => (this.symbolMap[a.toLowerCase()] || a.toUpperCase()) === coin.code
                );
                if (assetKey) {
                    result[assetKey.toLowerCase()] = coin.rate;
                }
            });

            // Fill in nulls for any missing assets
            assets.forEach(a => {
                if (result[a.toLowerCase()] === undefined) {
                    result[a.toLowerCase()] = null;
                }
            });

            return result;
        } catch (error) {
            this.logger.error(`Batch fetch failed: ${error.message}`);
            assets.forEach(a => {
                result[a.toLowerCase()] = null;
            });
            return result;
        }
    }

    /**
     * Get sparkline data (7-day mini charts) for multiple assets
     */
    async getBatchSparklines(assets: string[]): Promise<Record<string, number[]>> {
        this.logger.debug(`Fetching sparklines for: ${assets.join(", ")}`);

        const cacheKey = `lcw:sparklines:${[...assets].sort((a, b) => a.localeCompare(b)).join(",")}`;
        const cachedData = await this.redisCacheService.get<Record<string, number[]>>(cacheKey);
        if (cachedData) {
            this.logger.debug(`Cache hit for sparklines`);
            return cachedData;
        }

        const result: Record<string, number[]> = {};

        // Fetch history for each asset in parallel
        const promises = assets.map(async (asset) => {
            try {
                const history = await this.getHistoricalData(asset, 7);
                result[asset.toLowerCase()] = history.prices.map(p => p[1]);
            } catch (error) {
                this.logger.warn(`Failed to get sparkline for ${asset}`);
                result[asset.toLowerCase()] = [];
            }
        });

        await Promise.all(promises);
        await this.redisCacheService.set(cacheKey, result, 30 * 60); // Cache 30 minutes

        return result;
    }


    /**
     * Get batch market data (price + 24h change) for multiple assets
     */
    async getBatchMarketData(
        assets: string[],
        timeoutMs?: number
    ): Promise<Record<string, { price: number; change24h: number } | null>> {
        const normalizedAssets = this.getNormalizedAssets(assets);
        this.logger.debug(`Batch fetching market data for: ${normalizedAssets.join(", ")}`);

        const batchKey = `lcw:batch-market:inflight:${[...normalizedAssets].sort((a, b) => a.localeCompare(b)).join(",")}`;
        const inflightBatchMarket = this.inFlightBatchMarketRequests.get(batchKey);
        if (inflightBatchMarket) {
            return inflightBatchMarket;
        }

        const requestPromise = (async () => {
            // Check cache first to prevent rate limiting
            const cacheKey = `lcw:batch-market:${[...normalizedAssets].sort((a, b) => a.localeCompare(b)).join(",")}`;
            const cachedData = await this.redisCacheService.get<Record<string, { price: number; change24h: number } | null>>(cacheKey);
            if (cachedData) {
                this.logger.debug(`Cache hit for batch market data`);
                return cachedData;
            }

            const result: Record<string, { price: number; change24h: number } | null> = {};

            try {
                const codes = normalizedAssets
                    .map(a => this.symbolMap[a.toLowerCase()] || a.toUpperCase())
                    .filter(Boolean);

                if (codes.length === 0) return result;

                const response = await this.apiClient.post("/coins/list", {
                    currency: "USD",
                    codes: codes,
                    sort: "rank",
                    order: "ascending",
                    offset: 0,
                    limit: codes.length,
                    meta: true,
                }, {
                    timeout: timeoutMs
                });

                const coins = response.data as LiveCoinWatchCoin[];

                coins.forEach(coin => {
                    const assetKey = normalizedAssets.find(
                        a => (this.symbolMap[a.toLowerCase()] || a.toUpperCase()) === coin.code
                    );

                    if (assetKey) {
                        const price = coin.rate;
                        const rawDelta = coin.delta?.day ?? 1;
                        const change24h = (rawDelta - 1) * 100;

                        result[assetKey.toLowerCase()] = {
                            price,
                            change24h
                        };
                    }
                });

                normalizedAssets.forEach(a => {
                    if (!result[a.toLowerCase()]) {
                        result[a.toLowerCase()] = null;
                    }
                });

                if (Object.values(result).some(v => v !== null)) {
                    await this.redisCacheService.set(cacheKey, result, 120);
                    this.logger.debug(`Cached batch market data for 2 minutes`);
                }

                return result;
            } catch (error) {
                this.logger.error(`Batch market data fetch failed: ${error.message}`);
                normalizedAssets.forEach(a => {
                    result[a.toLowerCase()] = null;
                });
                return result;
            }
        })();

        this.inFlightBatchMarketRequests.set(batchKey, requestPromise);

        try {
            return await requestPromise;
        } finally {
            this.inFlightBatchMarketRequests.delete(batchKey);
        }
    }
}
