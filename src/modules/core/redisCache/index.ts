import { Global, Module } from "@nestjs/common";
import { RedisCacheService } from "./services/redis-cache.service";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { QuidaxCacheService } from "./services/quidax-cache.service";

@Global()
@Module({
    imports: [TradingFactoryModule],
    providers: [RedisCacheService, QuidaxCacheService],
    exports: [RedisCacheService, QuidaxCacheService],
})
export class CachingModule {}
