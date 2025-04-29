import * as t from "../types";
import { QuidaxService } from "../providers/quidax/services";
import { QuidaxLib } from "@/libs/quidax";
import { TradingConfig } from "@/config";

export class TradingFactory implements t.ITradingFactory {
    constructor(private readonly tradingConfig: TradingConfig) {}

    build<T extends t.Provider>(options: t.BuildOptions<T>): QuidaxService {
        switch (options.provider) {
            case "quidax": {
                const quidaxConfig = this.tradingConfig.quidax;
                const quidax = new QuidaxLib({
                    api_public: quidaxConfig.api_public,
                    api_secret: quidaxConfig.api_secret,
                    baseURL: quidaxConfig.baseUrl,
                    rampBaseURL: quidaxConfig.rampBaseUrl,
                });

                return new QuidaxService(quidax);
            }

            //add other providers
            default:
                break;
        }
    }
}
