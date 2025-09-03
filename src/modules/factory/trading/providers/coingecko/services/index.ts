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
}
