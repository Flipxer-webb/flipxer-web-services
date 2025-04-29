import { Module, Provider } from "@nestjs/common";
import { TradingFactory } from "./factory";
import { TradingInjectionToken } from "./types";
import { tradingConfig } from "@/config";

const quidaxService: Provider = {
    provide: TradingInjectionToken.QUIDAX,
    useFactory() {
        const tradingFactory = new TradingFactory(tradingConfig);
        return tradingFactory.build({ provider: "quidax" });
    },
};

@Module({
    providers: [quidaxService],
    exports: [quidaxService],
})
export class TradingFactoryModule {}
