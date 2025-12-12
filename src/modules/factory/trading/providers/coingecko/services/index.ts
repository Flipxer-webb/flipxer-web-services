import { Injectable, HttpStatus } from "@nestjs/common";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import axios from "axios";
import { setTimeout } from "timers/promises";

@Injectable()
export class CoinGeckoService {
    constructor(private readonly redisCacheService: RedisCacheService) {}

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
                
                // Fetch chart data
                const chartResponse = await axios.get(
                    `https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart`,
                    {
                        params: {
                            vs_currency: "usd",
                            days: days,
                            interval: days <= 1 ? undefined : "daily",
                        },
                    }
                );

                // Fetch additional market data
                const marketResponse = await axios.get(
                    `https://api.coingecko.com/api/v3/coins/${coinGeckoId}`,
                    {
                        params: {
                            localization: false,
                            tickers: false,
                            community_data: false,
                            developer_data: false,
                        },
                    }
                );

                const result = {
                    prices: chartResponse.data.prices as [number, number][],
                    market_data: {
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
                    },
                };

                // Cache for 5 minutes for short periods, 30 minutes for longer periods
                const cacheDuration = days <= 1 ? 2 * 60 : 30 * 60;
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
}
