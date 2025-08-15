import { Global, Module, forwardRef } from "@nestjs/common";
import { RedisCacheService } from "./services/redis-cache.service";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { QuidaxCacheService } from "./services/quidax-cache.service";
import { CoinGeckoCacheService } from "./services/coingecko-cache.service";
import { CoinGeckoService } from "@/modules/factory/trading/providers/coingecko/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { PrismaModule } from "@/modules/core/prisma";
import { EmailModule } from "@/modules/core/email";

@Global()
@Module({
    imports: [
        forwardRef(() => TradingFactoryModule),
        PrismaModule,
        EmailModule,
    ],
    providers: [
        RedisCacheService,
        QuidaxCacheService,
        CoinGeckoCacheService,
        {
            provide: TradingInjectionToken.COINGECKO,
            useClass: CoinGeckoService,
        },
    ],
    exports: [
        RedisCacheService,
        QuidaxCacheService,
        CoinGeckoCacheService,
        TradingInjectionToken.COINGECKO,
    ],
})
export class CachingModule {}