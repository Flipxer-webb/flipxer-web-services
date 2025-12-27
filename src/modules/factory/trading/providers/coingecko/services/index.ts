import { Injectable, HttpStatus } from "@nestjs/common";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import axios from "axios";
import { setTimeout } from "timers/promises";

@Injectable()
export class CoinGeckoService {
    constructor(private readonly redisCacheService: RedisCacheService) { }

    private readonly coinGeckoIdMap: { [key: string]: string } = {
        btc: "bitcoin",
        eth: "ethereum",
        usdt: "tether",
        usdc: "usd-coin",
        bnb: "binancecoin",
        sol: "solana",
        xrp: "ripple",
        ada: "cardano",
        dot: "polkadot",
        doge: "dogecoin",
        shib: "shiba-inu",
        trx: "tron",
        matic: "matic-network",
        link: "chainlink",
        ltc: "litecoin",
        bch: "bitcoin-cash",
        xlm: "stellar",
        algo: "algorand",
        aave: "aave",
        fil: "filecoin",
        cake: "pancakeswap-token",
        mana: "decentraland",
        sand: "the-sandbox",
        ftm: "fantom",
        xtz: "tezos",
        ape: "apecoin",
        ens: "ethereum-name-service",
        arb: "arbitrum",
        op: "optimism",
        icp: "internet-computer",
        sui: "sui",
    };

    async getPriceInUSD(asset: string, retries = 3, delay = 1000): Promise<number> {
        console.log(`🔍 Fetching price for asset: ${asset}`);

        const cacheKey = `coingecko:price:${asset.toLowerCase()}:usd`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) {
            console.log(`✅ Cache hit for ${asset}: $${cachedPrice}`);
            return cachedPrice;
        }

        const coinGeckoId = this.coinGeckoIdMap[asset.toLowerCase()];
        if (!coinGeckoId) {
            throw new GeneralTransactionException(
                `No CoinGecko ID mapping for ${asset}`,
                HttpStatus.BAD_REQUEST
            );
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`🌍 Requesting CoinGecko API for ${asset} (ID: ${coinGeckoId}), attempt ${attempt}`);
                const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                    params: { ids: coinGeckoId, vs_currencies: "usd" },
                });
                const rate = response.data[coinGeckoId]?.usd;
                if (!rate) throw new Error(`No price data for ${asset} (ID: ${coinGeckoId})`);
                await this.redisCacheService.set(cacheKey, rate, 5 * 60); // Cache for 5 minutes
                console.log(`💰 Price for ${asset}: $${rate}`);
                return rate;
            } catch (error) {
                console.error(`❌ Attempt ${attempt} failed for ${asset}:`, {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data,
                });
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch USD rate for ${asset} after ${retries} attempts: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }
    }

    async getBatchPriceInUSD(assets: string[], retries = 3, delay = 1000): Promise<Record<string, number | null>> {
        console.log(`🔍 Batch fetching prices for: ${assets.join(", ")}`);

        const result: Record<string, number | null> = {};
        assets.forEach(asset => {
            result[asset.toLowerCase()] = null;
        });

        const coinGeckoIds = assets
            .map(asset => this.coinGeckoIdMap[asset.toLowerCase()])
            .filter(id => id);

        if (coinGeckoIds.length === 0) {
            throw new GeneralTransactionException(
                "No valid CoinGecko IDs provided",
                HttpStatus.BAD_REQUEST
            );
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`🌍 Requesting CoinGecko API for batch [${coinGeckoIds.join(", ")}], attempt ${attempt}`);
                const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                    params: {
                        ids: coinGeckoIds.join(","),
                        vs_currencies: "usd",
                    },
                });

                assets.forEach(asset => {
                    const coinGeckoId = this.coinGeckoIdMap[asset.toLowerCase()];
                    if (coinGeckoId) {
                        const price = response.data[coinGeckoId]?.usd;
                        if (price !== undefined) {
                            const cacheKey = `coingecko:price:${asset.toLowerCase()}:usd`;
                            this.redisCacheService.set(cacheKey, price, 5 * 60);
                            result[asset.toLowerCase()] = price;
                            console.log(`💰 Price for ${asset}: $${price}`);
                        } else {
                            console.warn(`⚠️ No price data returned for ${asset} (ID: ${coinGeckoId})`);
                        }
                    }
                });

                return result;
            } catch (error) {
                console.error(`❌ Batch fetch attempt ${attempt} failed:`, {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data,
                });
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch batch USD rates after ${retries} attempts: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }

        return result;
    }

    async getBatchMarketData(
        assets: string[],
        retries = 3,
        delay = 1000
    ): Promise<Record<string, { price: number; change24h: number } | null>> {
        console.log(`🔍 Batch fetching market data (price + 24h change) for: ${assets.join(", ")}`);

        const result: Record<string, { price: number; change24h: number } | null> = {};
        assets.forEach((asset) => {
            result[asset.toLowerCase()] = null;
        });

        const coinGeckoIds = assets
            .map((asset) => this.coinGeckoIdMap[asset.toLowerCase()])
            .filter((id) => id);

        if (coinGeckoIds.length === 0) {
            // No valid IDs to fetch, return nulls
            return result;
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(
                    `🌍 Requesting CoinGecko API for batch market data [${coinGeckoIds.join(
                        ", "
                    )}], attempt ${attempt}`
                );
                const response = await axios.get(
                    "https://api.coingecko.com/api/v3/simple/price",
                    {
                        params: {
                            ids: coinGeckoIds.join(","),
                            vs_currencies: "usd",
                            include_24hr_change: true,
                        },
                    }
                );

                assets.forEach((asset) => {
                    const coinGeckoId = this.coinGeckoIdMap[asset.toLowerCase()];
                    if (coinGeckoId) {
                        const data = response.data[coinGeckoId];
                        if (data && data.usd !== undefined) {
                            const price = data.usd;
                            const change24h = data.usd_24h_change ?? 0;

                            const marketData = { price, change24h };
                            result[asset.toLowerCase()] = marketData;

                            // Also cache individual price components if needed by other services
                            // (Optional: We could update the simple price cache here too, but let's keep concerns separate for now 
                            // or do it if we want to be efficient)
                            const cacheKey = `coingecko:price:${asset.toLowerCase()}:usd`;
                            this.redisCacheService.set(cacheKey, price, 5 * 60);

                            console.log(`💰 Market Data for ${asset}: $${price} (${change24h.toFixed(2)}%)`);
                        } else {
                            console.warn(
                                `⚠️ No market data returned for ${asset} (ID: ${coinGeckoId})`
                            );
                        }
                    }
                });

                return result;
            } catch (error) {
                console.error(`❌ Batch market data fetch attempt ${attempt} failed:`, {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data,
                });
                if (attempt === retries) {
                    // Log error but don't throw - return partial/empty results so main flow doesn't break
                    console.error(`Failed to fetch batch market data after ${retries} attempts`);
                }
                await setTimeout(delay * attempt);
            }
        }

        return result;
    }

    /**
     * Get market chart data for an asset (price history)
     * @param asset Asset symbol (e.g., 'btc', 'eth')
     * @param days Number of days of data (1, 7, 30, 90, 365)
     * @returns Array of [timestamp, price] data points
     */
    async getMarketChart(
        asset: string,
        days: number = 7,
        retries = 3,
        delay = 1000
    ): Promise<{ prices: [number, number][]; market_data?: any }> {
        console.log(`📊 Fetching market chart for ${asset} (${days} days)`);

        const cacheKey = `coingecko:chart:${asset.toLowerCase()}:${days}d`;
        const cachedData = await this.redisCacheService.get<{ prices: [number, number][]; market_data?: any }>(cacheKey);
        if (cachedData) {
            console.log(`✅ Cache hit for ${asset} chart data`);
            return cachedData;
        }

        const coinGeckoId = this.coinGeckoIdMap[asset.toLowerCase()];
        if (!coinGeckoId) {
            throw new GeneralTransactionException(
                `No CoinGecko ID mapping for ${asset}`,
                HttpStatus.BAD_REQUEST
            );
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`🌍 Requesting CoinGecko market chart for ${asset} (ID: ${coinGeckoId}), attempt ${attempt}`);

                // Fetch chart data and market data in parallel to reduce wait time
                const [chartResponse, marketResponse] = await Promise.all([
                    axios.get(
                        `https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart`,
                        {
                            params: {
                                vs_currency: "usd",
                                days: days,
                                interval: days <= 1 ? undefined : "daily",
                            },
                            timeout: 10000, // 10 second timeout
                        }
                    ),
                    axios.get(
                        `https://api.coingecko.com/api/v3/coins/${coinGeckoId}`,
                        {
                            params: {
                                localization: false,
                                tickers: false,
                                community_data: false,
                                developer_data: false,
                            },
                            timeout: 10000, // 10 second timeout
                        }
                    ).catch(err => {
                        // If market data fails, continue with just chart data
                        console.warn(`⚠️ Market data fetch failed for ${asset}, continuing with chart only:`, err.message);
                        return null;
                    })
                ]);

                const result = {
                    prices: chartResponse.data.prices as [number, number][],
                    market_data: marketResponse ? {
                        current_price: marketResponse.data.market_data?.current_price?.usd,
                        market_cap: marketResponse.data.market_data?.market_cap?.usd,
                        total_volume: marketResponse.data.market_data?.total_volume?.usd,
                        high_24h: marketResponse.data.market_data?.high_24h?.usd,
                        low_24h: marketResponse.data.market_data?.low_24h?.usd,
                        price_change_24h: marketResponse.data.market_data?.price_change_24h,
                        price_change_percentage_24h: marketResponse.data.market_data?.price_change_percentage_24h,
                        price_change_percentage_7d: marketResponse.data.market_data?.price_change_percentage_7d_in_currency?.usd,
                        price_change_percentage_30d: marketResponse.data.market_data?.price_change_percentage_30d_in_currency?.usd,
                        circulating_supply: marketResponse.data.market_data?.circulating_supply,
                        max_supply: marketResponse.data.market_data?.max_supply,
                        ath: marketResponse.data.market_data?.ath?.usd,
                        ath_date: marketResponse.data.market_data?.ath_date?.usd,
                        atl: marketResponse.data.market_data?.atl?.usd,
                        atl_date: marketResponse.data.market_data?.atl_date?.usd,
                    } : {
                        // Fallback: calculate current price from last price point
                        current_price: chartResponse.data.prices?.length > 0
                            ? chartResponse.data.prices[chartResponse.data.prices.length - 1][1]
                            : null,
                        market_cap: null,
                        total_volume: null,
                        high_24h: null,
                        low_24h: null,
                        price_change_24h: null,
                        price_change_percentage_24h: chartResponse.data.prices?.length >= 2
                            ? ((chartResponse.data.prices[chartResponse.data.prices.length - 1][1] -
                                chartResponse.data.prices[0][1]) / chartResponse.data.prices[0][1]) * 100
                            : null,
                        price_change_percentage_7d: null,
                        price_change_percentage_30d: null,
                        circulating_supply: null,
                        max_supply: null,
                        ath: null,
                        ath_date: null,
                        atl: null,
                        atl_date: null,
                    },
                };

                // Cache for 10 minutes for short periods, 1 hour for longer periods (increased from 5/30 min)
                const cacheDuration = days <= 1 ? 10 * 60 : 60 * 60;
                await this.redisCacheService.set(cacheKey, result, cacheDuration);

                console.log(`📊 Chart data for ${asset}: ${result.prices.length} data points`);
                return result;
            } catch (error) {
                console.error(`❌ Chart fetch attempt ${attempt} failed for ${asset}:`, {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data,
                });
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch market chart for ${asset} after ${retries} attempts: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }
    }

    /**
     * Get sparkline data (7 day mini chart) for multiple assets
     * @param assets Array of asset symbols
     * @returns Object mapping asset symbols to sparkline arrays
     */
    async getBatchSparklines(
        assets: string[],
        retries = 3,
        delay = 1000
    ): Promise<Record<string, number[]>> {
        console.log(`✨ Fetching sparklines for: ${assets.join(", ")}`);

        const result: Record<string, number[]> = {};
        const uncachedAssets: string[] = [];

        // Check cache first
        for (const asset of assets) {
            const cacheKey = `coingecko:sparkline:${asset.toLowerCase()}`;
            const cached = await this.redisCacheService.get<number[]>(cacheKey);
            if (cached) {
                result[asset.toLowerCase()] = cached;
            } else {
                uncachedAssets.push(asset);
            }
        }

        if (uncachedAssets.length === 0) {
            console.log(`✅ All sparklines from cache`);
            return result;
        }

        const coinGeckoIds = uncachedAssets
            .map((asset) => this.coinGeckoIdMap[asset.toLowerCase()])
            .filter((id) => id);

        if (coinGeckoIds.length === 0) {
            return result;
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`🌍 Requesting CoinGecko markets for sparklines, attempt ${attempt}`);
                const response = await axios.get(
                    "https://api.coingecko.com/api/v3/coins/markets",
                    {
                        params: {
                            vs_currency: "usd",
                            ids: coinGeckoIds.join(","),
                            sparkline: true,
                        },
                    }
                );

                for (const coin of response.data) {
                    const assetSymbol = Object.entries(this.coinGeckoIdMap).find(
                        ([, id]) => id === coin.id
                    )?.[0];

                    if (assetSymbol && coin.sparkline_in_7d?.price) {
                        const sparkline = coin.sparkline_in_7d.price;
                        result[assetSymbol] = sparkline;

                        const cacheKey = `coingecko:sparkline:${assetSymbol}`;
                        await this.redisCacheService.set(cacheKey, sparkline, 30 * 60);
                    }
                }

                console.log(`✨ Sparklines fetched for ${Object.keys(result).length} assets`);
                return result;
            } catch (error) {
                console.error(`❌ Sparkline fetch attempt ${attempt} failed:`, {
                    message: error.message,
                    status: error.response?.status,
                });
                if (attempt === retries) {
                    console.warn(`⚠️ Failed to fetch sparklines, returning partial data`);
                    return result;
                }
                await setTimeout(delay * attempt);
            }
        }

        return result;
    }

    /**
     * Get ATH/ATL data ONLY - heavily cached for 7 days
     * This is used in the hybrid approach where LiveCoinWatch provides most data
     * @param asset Asset symbol (e.g., 'btc', 'eth')
     * @returns ATH/ATL data
     */
    async getAthAtl(
        asset: string,
        retries = 2,  // Reduced from 3
        delay = 500   // Reduced from 1000ms
    ): Promise<{
        ath: number | null;
        ath_date: string | null;
        atl: number | null;
        atl_date: string | null;
    }> {
        const startTime = Date.now();
        console.log(`🏆 [CG] Fetching ATH/ATL for ${asset}`);

        const cacheKey = `coingecko:ath_atl:${asset.toLowerCase()}`;
        const staleCacheKey = `coingecko:ath_atl:stale:${asset.toLowerCase()}`;

        // Check fresh cache first
        const cachedData = await this.redisCacheService.get<{
            ath: number | null;
            ath_date: string | null;
            atl: number | null;
            atl_date: string | null;
        }>(cacheKey);

        if (cachedData) {
            console.log(`✅ [CG] Cache HIT for ${asset} ATH/ATL in ${Date.now() - startTime}ms`);
            return cachedData;
        }

        const coinGeckoId = this.coinGeckoIdMap[asset.toLowerCase()];
        if (!coinGeckoId) {
            console.warn(`⚠️ [CG] No CoinGecko ID mapping for ${asset}`);
            return { ath: null, ath_date: null, atl: null, atl_date: null };
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`🌍 [CG] Requesting ATH/ATL for ${asset}, attempt ${attempt}`);

                const response = await axios.get(
                    `https://api.coingecko.com/api/v3/coins/${coinGeckoId}`,
                    {
                        params: {
                            localization: false,
                            tickers: false,
                            community_data: false,
                            developer_data: false,
                            sparkline: false,
                        },
                        timeout: 5000, // Reduced from 10s to 5s
                    }
                );

                const marketData = response.data.market_data;
                const result = {
                    ath: marketData?.ath?.usd || null,
                    ath_date: marketData?.ath_date?.usd || null,
                    atl: marketData?.atl?.usd || null,
                    atl_date: marketData?.atl_date?.usd || null,
                };

                // Cache for 7 days (604800 seconds)
                const SEVEN_DAYS = 7 * 24 * 60 * 60;
                await Promise.all([
                    this.redisCacheService.set(cacheKey, result, SEVEN_DAYS),
                    this.redisCacheService.set(staleCacheKey, result, 30 * 24 * 60 * 60), // Stale cache for 30 days
                ]);

                console.log(`🏆 [CG] ATH/ATL for ${asset} fetched in ${Date.now() - startTime}ms`);
                return result;
            } catch (error) {
                const status = error.response?.status;
                console.error(`❌ [CG] ATH/ATL attempt ${attempt} failed for ${asset}: status=${status}`);

                // FAST FAIL: Don't retry on rate limit (429) or client errors (4xx)
                if (status === 429 || (status >= 400 && status < 500)) {
                    console.warn(`⚠️ [CG] Rate limited or client error, returning stale cache for ${asset}`);
                    break; // Exit retry loop immediately
                }

                if (attempt === retries) {
                    break; // Last attempt, exit loop
                }
                await setTimeout(delay * attempt);
            }
        }

        // Fallback to stale cache if available
        const staleData = await this.redisCacheService.get<{
            ath: number | null;
            ath_date: string | null;
            atl: number | null;
            atl_date: string | null;
        }>(staleCacheKey);

        if (staleData) {
            console.log(`📦 [CG] Using stale cache for ${asset} ATH/ATL (${Date.now() - startTime}ms)`);
            return staleData;
        }

        console.warn(`⚠️ [CG] No data for ${asset} ATH/ATL, returning nulls (${Date.now() - startTime}ms)`);
        return { ath: null, ath_date: null, atl: null, atl_date: null };
    }
}
