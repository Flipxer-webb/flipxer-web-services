export * as TFincra from "./fincra";

export type BankProvider = "fincra";

export type BankProviderMap = {
    fincra: IFincraBank;
};

export type TBankFactory<P extends BankProvider> =
    P extends keyof BankProviderMap ? BankProviderMap[P] : never;

export type FactoryBuilderOptions<T extends BankProvider> = {
    provider: T;
};

export enum BankInjectionToken {
    FINCRA = "FINCRA",
}

//fincra
export interface IFincraBank {
    name?: string;
}
