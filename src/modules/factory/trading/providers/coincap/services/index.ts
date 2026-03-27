import { Injectable, HttpStatus, Logger } from "@nestjs/common";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import axios, { AxiosInstance } from "axios";
import { setTimeout } from "node:timers/promises";

interface CoinCapAsset {
    id: string;
    rank: string;
    symbol: string;
    name: string;
    supply: string;
    maxSupply: string | null;
    marketCapUsd: string;
    volumeUsd24Hr: string;
    priceUsd: string;
    changePercent24Hr: string;
    vwap24Hr: string;
}

interface CoinCapHistoryPoint {
    priceUsd: string;
    time: number;
    date: string;
}

/**
 * CoinCap API Service
 * 
 * Free tier: 200 requests/minute (no API key required)
 * Docs: https://docs.coincap.io/
 */
@Injectable()
export class CoinCapService {
    private readonly logger = new Logger(CoinCapService.name);
    private readonly apiClient: AxiosInstance;
    private readonly baseUrl = "https://api.coincap.io/v2";

    // Map symbols to CoinCap IDs (lowercase)
    private readonly symbolToId: { [key: string]: string } = {
        btc: "bitcoin",
        eth: "ethereum",
        usdt: "tether",
        usdc: "usd-coin",
        bnb: "binance-coin",
        sol: "solana",
        xrp: "xrp",
        ada: "cardano",
        doge: "dogecoin",
        shib: "shiba-inu",
        trx: "tron",
        ltc: "litecoin",
        dot: "polkadot",
        matic: "polygon",
        link: "chainlink",
        bch: "bitcoin-cash",
        xlm: "stellar",
        algo: "algorand",
        aave: "aave",
        fil: "filecoin",
    };

    constructor(private readonly redisCacheService: RedisCacheService) {
        this.apiClient = axios.create({
            baseURL: this.baseUrl,
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
        });
    }

    /**
     * Get current price for a single asset
     */
    async getPriceInUSD(asset: string, retries = 3, delay = 1000): Promise<number> {
        this.logger.debug(`Fetching price for: ${asset}`);

        const cacheKey = `coincap:price:${asset.toLowerCase()}:usd`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) {
            this.logger.debug(`Cache hit for ${asset}: $${cachedPrice}`);
            return cachedPrice;
        }

        const coinId = this.symbolToId[asset.toLowerCase()] || asset.toLowerCase();

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await this.apiClient.get(`/assets/${coinId}`);
                const rate = Number.parseFloat(response.data?.data?.priceUsd);

                if (!rate || Number.isNaN(rate)) throw new Error(`No price data for ${asset}`);

                await this.redisCacheService.set(cacheKey, rate, 300); // Cache 5 min
                this.logger.debug(`Price for ${asset}: $${rate}`);
                return rate;
            } catch (error) {
                this.logger.error(`Attempt ${attempt} failed: ${error.message}`);
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
     * Get batch market data for multiple assets
     */
    async getBatchMarketData(
        assets: string[]
    ): Promise<Record<string, { price: number; change24h: number } | null>> {
        this.logger.debug(`Batch fetching market data for: ${assets.join(", ")}`);

        const result: Record<string, { price: number; change24h: number } | null> = {};

        try {
            const ids = assets
                .map(a => this.symbolToId[a.toLowerCase()] || a.toLowerCase())
                .join(",");

            const response = await this.apiClient.get(`/assets?ids=${ids}`);
            const coins = response.data?.data as CoinCapAsset[];

            coins?.forEach(coin => {
                const assetKey = assets.find(
                    a => (this.symbolToId[a.toLowerCase()] || a.toLowerCase()) === coin.id
                );

                if (assetKey) {
                    result[assetKey.toLowerCase()] = {
                        price: Number.parseFloat(coin.priceUsd) || 0,
                        change24h: Number.parseFloat(coin.changePercent24Hr) || 0,
                    };
                }
            });

            // Fill nulls for missing
            assets.forEach(a => {
                if (!result[a.toLowerCase()]) {
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
     * Get historical price data for charts
     */
    async getHistoricalData(
        asset: string,
        days: number = 7,
        retries = 3,
        delay = 1000
    ): Promise<{ prices: [number, number][]; high24h: number; low24h: number }> {
        this.logger.debug(`Fetching ${days}d history for: ${asset}`);

        const cacheKey = `coincap:history:${asset.toLowerCase()}:${days}d`;
        const cachedData = await this.redisCacheService.get<{ prices: [number, number][]; high24h: number; low24h: number }>(cacheKey);
        if (cachedData) {
            this.logger.debug(`Cache hit for ${asset} ${days}d history`);
            return cachedData;
        }

        const coinId = this.symbolToId[asset.toLowerCase()] || asset.toLowerCase();
        const end = Date.now();
        const start = end - days * 24 * 60 * 60 * 1000;

        // Determine interval based on days
        let interval = "h1"; // 1 hour for most cases
        if (days <= 1) interval = "m15"; // 15 min for 1 day
        if (days >= 30) interval = "d1"; // daily for 30+ days

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await this.apiClient.get(
                    `/assets/${coinId}/history?interval=${interval}&start=${start}&end=${end}`
                );

                const history = response.data?.data as CoinCapHistoryPoint[];

                // Convert to [timestamp, price] format
                const prices: [number, number][] = history.map(point => [
                    point.time,
                    Number.parseFloat(point.priceUsd),
                ]);

                // Calculate 24h high/low
                const oneDayAgo = end - 24 * 60 * 60 * 1000;
                const last24h = history.filter(p => p.time >= oneDayAgo);
                const rates24h = last24h.map(p => Number.parseFloat(p.priceUsd));
                const high24h = rates24h.length > 0 ? Math.max(...rates24h) : null;
                const low24h = rates24h.length > 0 ? Math.min(...rates24h) : null;

                const result = { prices, high24h, low24h };

                // Cache for 30 min for short periods, 2 hours for longer
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
     * Get sparkline data for multiple assets
     */
    async getBatchSparklines(assets: string[]): Promise<Record<string, number[]>> {
        this.logger.debug(`Fetching sparklines for: ${assets.join(", ")}`);

        const sortedAssets = [...assets].sort((a, b) => a.localeCompare(b));
        const cacheKey = `coincap:sparklines:${sortedAssets.join(",")}`;
        const cachedData = await this.redisCacheService.get<Record<string, number[]>>(cacheKey);
        if (cachedData) {
            this.logger.debug(`Cache hit for sparklines`);
            return cachedData;
        }

        const result: Record<string, number[]> = {};

        // Fetch history for each asset (with rate limiting)
        for (const asset of assets) {
            try {
                const history = await this.getHistoricalData(asset, 7);
                result[asset.toLowerCase()] = history.prices.map(p => p[1]);
            } catch (error) {
                this.logger.warn(`Failed to get sparkline for ${asset}: ${error.message}`);
                result[asset.toLowerCase()] = [];
            }
            // Small delay between requests to avoid rate limiting
            await setTimeout(50);
        }

        await this.redisCacheService.set(cacheKey, result, 30 * 60); // Cache 30 min
        return result;
    }
}
