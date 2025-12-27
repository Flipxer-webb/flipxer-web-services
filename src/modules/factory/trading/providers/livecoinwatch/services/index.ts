import { Injectable, HttpStatus } from "@nestjs/common";
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
    private readonly apiClient: AxiosInstance;
    private readonly baseUrl = "https://api.livecoinwatch.com";

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

    /**
     * Get current price for a single asset
     */
    async getPriceInUSD(asset: string, retries = 3, delay = 1000): Promise<number> {
        console.log(`🔍 [LCW] Fetching price for asset: ${asset}`);

        const cacheKey = `lcw:price:${asset.toLowerCase()}:usd`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) {
            console.log(`✅ [LCW] Cache hit for ${asset}: $${cachedPrice}`);
            return cachedPrice;
        }

        const lcwCode = this.symbolMap[asset.toLowerCase()] || asset.toUpperCase();

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`🌍 [LCW] Requesting price for ${asset} (code: ${lcwCode}), attempt ${attempt}`);

                const response = await this.apiClient.post("/coins/single", {
                    currency: "USD",
                    code: lcwCode,
                    meta: false,
                });

                const rate = response.data?.rate;
                if (!rate) throw new Error(`No price data for ${asset}`);

                await this.redisCacheService.set(cacheKey, rate, 60); // Cache for 1 minute
                console.log(`💰 [LCW] Price for ${asset}: $${rate}`);
                return rate;
            } catch (error) {
                console.error(`❌ [LCW] Attempt ${attempt} failed for ${asset}:`, {
                    message: error.message,
                    status: error.response?.status,
                });
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
     * Get market data for a single asset (price, volume, market cap, % changes)
     */
    async getMarketData(asset: string, retries = 3, delay = 1000): Promise<LiveCoinWatchCoin> {
        console.log(`📊 [LCW] Fetching market data for: ${asset}`);

        const cacheKey = `lcw:market:${asset.toLowerCase()}`;
        const cachedData = await this.redisCacheService.get<LiveCoinWatchCoin>(cacheKey);
        if (cachedData) {
            console.log(`✅ [LCW] Cache hit for ${asset} market data`);
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
                await this.redisCacheService.set(cacheKey, data, 60); // Cache for 1 minute
                console.log(`📊 [LCW] Market data for ${asset}: $${data.rate}`);
                return data;
            } catch (error) {
                console.error(`❌ [LCW] Market data attempt ${attempt} failed:`, error.message);
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
        console.log(`📈 [LCW] Fetching ${days}d history for: ${asset}`);

        const cacheKey = `lcw:history:${asset.toLowerCase()}:${days}d`;
        const cachedData = await this.redisCacheService.get<{ prices: [number, number][]; high24h: number; low24h: number }>(cacheKey);
        if (cachedData) {
            console.log(`✅ [LCW] Cache hit for ${asset} ${days}d history`);
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

                // Cache for 10 minutes for short periods, 1 hour for longer
                const cacheDuration = days <= 1 ? 10 * 60 : 60 * 60;
                await this.redisCacheService.set(cacheKey, result, cacheDuration);

                console.log(`📈 [LCW] Got ${prices.length} data points for ${asset}`);
                return result;
            } catch (error) {
                console.error(`❌ [LCW] History attempt ${attempt} failed:`, error.message);
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
        console.log(`🔍 [LCW] Batch fetching prices for: ${assets.join(", ")}`);

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
            console.error(`❌ [LCW] Batch fetch failed:`, error.message);
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
        console.log(`📊 [LCW] Fetching sparklines for: ${assets.join(", ")}`);

        const cacheKey = `lcw:sparklines:${assets.sort().join(",")}`;
        const cachedData = await this.redisCacheService.get<Record<string, number[]>>(cacheKey);
        if (cachedData) {
            console.log(`✅ [LCW] Cache hit for sparklines`);
            return cachedData;
        }

        const result: Record<string, number[]> = {};

        // Fetch history for each asset in parallel
        const promises = assets.map(async (asset) => {
            try {
                const history = await this.getHistoricalData(asset, 7);
                result[asset.toLowerCase()] = history.prices.map(p => p[1]);
            } catch (error) {
                console.warn(`⚠️ [LCW] Failed to get sparkline for ${asset}`);
                result[asset.toLowerCase()] = [];
            }
        });

        await Promise.all(promises);
        await this.redisCacheService.set(cacheKey, result, 5 * 60); // Cache 5 minutes

        return result;
    }


    /**
     * Get batch market data (price + 24h change) for multiple assets
     */
    async getBatchMarketData(
        assets: string[]
    ): Promise<Record<string, { price: number; change24h: number } | null>> {
        console.log(`🔍 [LCW] Batch fetching market data for: ${assets.join(", ")}`);

        const result: Record<string, { price: number; change24h: number } | null> = {};

        try {
            const codes = assets
                .map(a => this.symbolMap[a.toLowerCase()] || a.toUpperCase())
                // Basic cleanup/mapping
                .filter(Boolean); // Ensure valid codes

            if (codes.length === 0) return result;

            const response = await this.apiClient.post("/coins/list", {
                currency: "USD",
                codes: codes,
                sort: "rank",
                order: "ascending",
                offset: 0,
                limit: codes.length,
                meta: true, // Need meta to get delta? No, delta is usually top level or in delta object. 
                // Interface says delta is in LiveCoinWatchCoin.
                // /coins/list returns array of objects with code, rate, volume, cap, delta.
            });

            const coins = response.data as LiveCoinWatchCoin[];

            coins.forEach(coin => {
                const assetKey = assets.find(
                    a => (this.symbolMap[a.toLowerCase()] || a.toUpperCase()) === coin.code
                );

                if (assetKey) {
                    const price = coin.rate;
                    // delta.day is a multiplier (e.g. 1.05 = +5%). 
                    // Calculate percentage change: (delta - 1) * 100
                    const rawDelta = coin.delta?.day ?? 1;
                    const change24h = (rawDelta - 1) * 100;

                    result[assetKey.toLowerCase()] = {
                        price,
                        change24h
                    };
                }
            });

            // Fill in nulls for missing
            assets.forEach(a => {
                if (!result[a.toLowerCase()]) {
                    result[a.toLowerCase()] = null;
                }
            });

            return result;
        } catch (error) {
            console.error(`❌ [LCW] Batch market data fetch failed:`, error.message);
            assets.forEach(a => {
                result[a.toLowerCase()] = null;
            });
            return result;
        }
    }
}
