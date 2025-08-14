import { Inject, Injectable } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { CoinGeckoService } from "@/modules/factory/trading/providers/coingecko/services";

@Injectable()
export class CoinGeckoCacheService {
    private readonly CACHE_TTL = 5 * 60;

    constructor(
        private readonly redisCacheService: RedisCacheService,
        @Inject(TradingInjectionToken.COINGECKO)
        private readonly coinGeckoService: CoinGeckoService
    ) {}

    async getPriceInUSD(asset: string): Promise<number | null> {
        const cacheKey = `coingecko:price:${asset.toLowerCase()}:usd`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) return cachedPrice;

        try {
            const price = await this.coinGeckoService.getPriceInUSD(asset);
            if (price !== null) {
                await this.redisCacheService.set(cacheKey, price, this.CACHE_TTL);
            }
            return price;
        } catch (error) {
            console.error(`Error fetching USD price for ${asset} from CoinGecko:`, error.message);
            if (error.message.includes("429")) {
                console.warn(
                    `Rate limit exceeded for ${asset}. Consider implementing batch fetching or increasing interval.`
                );
            }
            return null;
        }
    }

    async getBatchPriceInUSD(assets: string[]): Promise<Record<string, number | null>> {
        const cacheKeys = assets.map(asset => `coingecko:price:${asset.toLowerCase()}:usd`);
        const cachedPrices = await Promise.all(
            cacheKeys.map(key => this.redisCacheService.get<number>(key))
        );
        const result: Record<string, number | null> = {};
        const assetsToFetch: string[] = [];

        // Check cache for each asset
        assets.forEach((asset, index) => {
            if (cachedPrices[index] !== undefined && cachedPrices[index] !== null) {
                result[asset.toLowerCase()] = cachedPrices[index];
            } else {
                assetsToFetch.push(asset);
            }
        });

        // Fetch prices for uncached assets
        if (assetsToFetch.length > 0) {
            try {
                const fetchedPrices = await this.coinGeckoService.getBatchPriceInUSD(assetsToFetch);
                for (const asset of assetsToFetch) {
                    const price = fetchedPrices[asset.toLowerCase()];
                    result[asset.toLowerCase()] = price;
                    if (price !== null) {
                        const cacheKey = `coingecko:price:${asset.toLowerCase()}:usd`;
                        await this.redisCacheService.set(cacheKey, price, this.CACHE_TTL);
                    }
                }
            } catch (error) {
                console.error(`Error fetching batch USD prices from CoinGecko:`, error.message);
                if (error.message.includes("429")) {
                    console.warn(
                        `Rate limit exceeded for batch fetch. Consider increasing cron interval.`
                    );
                }
                assetsToFetch.forEach(asset => {
                    result[asset.toLowerCase()] = null;
                });
            }
        }

        return result;
    }
}