import { Injectable, HttpStatus, Logger } from "@nestjs/common";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import axios, { AxiosInstance } from "axios";
import { setTimeout } from "timers/promises";

interface BinanceTickerPrice {
    symbol: string;
    price: string;
}

/**
 * Binance API Service
 *
 * Public endpoints - no API key required
 * Rate limit: 1200 requests/minute for /api/v3 endpoints
 * Docs: https://binance-docs.github.io/apidocs/spot/en/
 */
@Injectable()
export class BinanceService {
    private readonly logger = new Logger(BinanceService.name);
    private readonly apiClient: AxiosInstance;
    private readonly baseUrl = "https://api.binance.com";

    // Symbol mapping for edge cases (rebrands, different names)
    private readonly symbolMap: { [key: string]: string } = {
        matic: "POL", // Polygon rebrand from MATIC to POL
        pol: "POL",
        // Add more mappings as needed
    };

    // Symbols that trade against USDT with different pair format
    private readonly specialPairs: { [key: string]: string } = {
        usdc: "USDCUSDT", // USDC/USDT pair
        tusd: "TUSDUSDT",
        busd: "BUSDUSDT",
        dai: "DAIUSDT",
    };

    constructor(private readonly redisCacheService: RedisCacheService) {
        this.apiClient = axios.create({
            baseURL: this.baseUrl,
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
        });
    }

    /**
     * Get the Binance trading symbol for an asset paired with USDT
     */
    private getBinanceSymbol(asset: string): string {
        const lowerAsset = asset.toLowerCase();

        // Check special pairs first
        if (this.specialPairs[lowerAsset]) {
            return this.specialPairs[lowerAsset];
        }

        // Map symbol if needed (e.g., MATIC → POL)
        const mappedSymbol = this.symbolMap[lowerAsset] || asset.toUpperCase();

        return `${mappedSymbol}USDT`;
    }

    /**
     * Get current price for a single asset in USDT
     *
     * @param asset - The asset symbol (e.g., 'BTC', 'ETH')
     * @param retries - Number of retry attempts
     * @param delay - Delay between retries in ms
     * @returns Price in USDT
     */
    async getPriceInUSDT(asset: string, retries = 3, delay = 1000): Promise<number> {
        const normalizedAsset = asset.toUpperCase();

        // USDT itself is always 1:1
        if (normalizedAsset === "USDT") {
            return 1.0;
        }

        this.logger.debug(`Fetching USDT price for: ${asset}`);

        const cacheKey = `binance:price:${asset.toLowerCase()}:usdt`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) {
            this.logger.debug(`Cache hit for ${asset}: ${cachedPrice} USDT`);
            return cachedPrice;
        }

        const symbol = this.getBinanceSymbol(asset);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                this.logger.debug(
                    `Requesting price for ${asset} (symbol: ${symbol}), attempt ${attempt}`
                );

                const response = await this.apiClient.get<BinanceTickerPrice>(
                    `/api/v3/ticker/price`,
                    { params: { symbol } }
                );

                const price = parseFloat(response.data?.price);

                if (!price || isNaN(price)) {
                    throw new Error(`Invalid price data for ${asset}`);
                }

                // Cache for 60 seconds (dynamic rate requirement)
                await this.redisCacheService.set(cacheKey, price, 60);
                this.logger.debug(`Price for ${asset}: ${price} USDT`);
                return price;
            } catch (error) {
                this.logger.error(`Attempt ${attempt} failed for ${asset}: ${error.message}`);

                // If symbol not found on Binance, don't retry
                if (error.response?.status === 400) {
                    this.logger.warn(`Symbol ${symbol} not found on Binance`);
                    throw new GeneralTransactionException(
                        `Asset ${asset} not available on Binance`,
                        HttpStatus.BAD_REQUEST
                    );
                }

                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch USDT price for ${asset}: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
        }
    }

    /**
     * Get current prices for multiple assets in USDT (batch request)
     *
     * @param assets - Array of asset symbols (e.g., ['BTC', 'ETH', 'SOL'])
     * @returns Map of asset symbol to USDT price
     */
    async getBatchPricesInUSDT(
        assets: string[]
    ): Promise<Map<string, number>> {
        this.logger.debug(`Fetching batch USDT prices for: ${assets.join(", ")}`);

        const { cached: result, toFetch: assetsToFetch } = await this.checkPriceCache(assets);

        if (assetsToFetch.length === 0) {
            return result;
        }

        try {
            const response = await this.apiClient.get<BinanceTickerPrice[]>(
                `/api/v3/ticker/price`
            );

            const priceMap = new Map<string, number>();
            for (const ticker of response.data) {
                if (ticker.symbol.endsWith("USDT")) {
                    priceMap.set(ticker.symbol.replace("USDT", ""), Number.parseFloat(ticker.price));
                }
            }

            for (const asset of assetsToFetch) {
                const symbol = this.getBinanceSymbol(asset);
                const baseAsset = symbol.replace("USDT", "");
                const price = priceMap.get(baseAsset);

                if (price && !isNaN(price)) {
                    result.set(asset.toUpperCase(), price);
                    const cacheKey = `binance:price:${asset.toLowerCase()}:usdt`;
                    await this.redisCacheService.set(cacheKey, price, 60);
                    this.logger.debug(`Price for ${asset}: ${price} USDT`);
                } else {
                    this.logger.warn(`No USDT price found for ${asset} on Binance`);
                }
            }

            return result;
        } catch (error) {
            this.logger.error(`Batch price fetch failed: ${error.message}`);
            await this.fetchIndividualPrices(assetsToFetch, result);
            return result;
        }
    }

    private async checkPriceCache(assets: string[]): Promise<{ cached: Map<string, number>; toFetch: string[] }> {
        const cached = new Map<string, number>();
        const toFetch: string[] = [];

        for (const asset of assets) {
            const normalizedAsset = asset.toUpperCase();

            if (normalizedAsset === "USDT") {
                cached.set(normalizedAsset, 1);
                continue;
            }

            const cacheKey = `binance:price:${asset.toLowerCase()}:usdt`;
            const cachedPrice = await this.redisCacheService.get<number>(cacheKey);

            if (cachedPrice) {
                cached.set(normalizedAsset, cachedPrice);
                this.logger.debug(`Cache hit for ${asset}: ${cachedPrice} USDT`);
            } else {
                toFetch.push(asset);
            }
        }

        return { cached, toFetch };
    }

    private async fetchIndividualPrices(assets: string[], result: Map<string, number>): Promise<void> {
        for (const asset of assets) {
            try {
                const price = await this.getPriceInUSDT(asset);
                result.set(asset.toUpperCase(), price);
            } catch (err) {
                this.logger.warn(`Skipping ${asset}: ${err.message}`);
            }
        }
    }

    /**
     * Get all available USDT trading pairs from Binance
     *
     * @returns Array of asset symbols that have USDT pairs
     */
    async getAvailableUSDTPairs(): Promise<string[]> {
        const cacheKey = "binance:usdt_pairs";
        const cached = await this.redisCacheService.get<string[]>(cacheKey);

        if (cached) {
            return cached;
        }

        try {
            const response = await this.apiClient.get<BinanceTickerPrice[]>(
                `/api/v3/ticker/price`
            );

            const usdtPairs = response.data
                .filter((ticker) => ticker.symbol.endsWith("USDT"))
                .map((ticker) => ticker.symbol.replace("USDT", ""));

            // Cache for 1 hour (pairs don't change often)
            await this.redisCacheService.set(cacheKey, usdtPairs, 3600);

            this.logger.log(`Found ${usdtPairs.length} USDT trading pairs on Binance`);
            return usdtPairs;
        } catch (error) {
            this.logger.error(`Failed to fetch USDT pairs: ${error.message}`);
            throw new GeneralTransactionException(
                `Failed to fetch Binance USDT pairs: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    /**
     * Check if an asset has a USDT trading pair on Binance
     */
    async hasUSDTPair(asset: string): Promise<boolean> {
        const pairs = await this.getAvailableUSDTPairs();
        const symbol = this.symbolMap[asset.toLowerCase()] || asset.toUpperCase();
        return pairs.includes(symbol);
    }

    /**
     * Get the last cached price without making API call
     * Returns null if not in cache
     */
    async getCachedPrice(asset: string): Promise<number | null> {
        const cacheKey = `binance:price:${asset.toLowerCase()}:usdt`;
        return this.redisCacheService.get<number>(cacheKey);
    }
}
