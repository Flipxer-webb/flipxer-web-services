import { Inject, Injectable } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";

@Injectable()
export class QuidaxCacheService {
    private readonly CACHE_KEY = "quidax:market:tickers";
    private readonly CACHE_TTL = 10; // seconds

    constructor(
        private readonly redisCacheService: RedisCacheService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) {}

    async getMarketTickers(): Promise<Record<string, any>> {
        const cached = await this.redisCacheService.get(this.CACHE_KEY);
        if (cached) return cached;

        try {
            const response = await this.quidaxService.getMarketTickers();

            const data = response.data ?? {};
            // Save to Redis
            await this.redisCacheService.set(
                this.CACHE_KEY,
                data,
                this.CACHE_TTL
            );
            return data;
        } catch (err) {
            console.error(
                "Error fetching market tickers from Quidax:",
                err.message
            );
            return {};
        }
    }
}
