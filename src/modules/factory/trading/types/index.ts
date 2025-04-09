import { QuidaxService } from "../providers/quidax/services";

export type Provider = "quidax";

export type BuildOptions<T extends Provider> = {
    provider: T;
};

export enum TradingInjectionToken {
    QUIDAX = "QUIDAX",
}

export interface ITradingFactory {
    build<T extends Provider>(options: BuildOptions<T>): QuidaxService;
}
