export * as TFincra from "./fincra";
export * as TNomba from "./nomba";
export * from "./inbound-payment";
export * from "./refund-payment";

export type BankProvider = "fincra" | "nomba";

export type BankProviderMap = {
    fincra: IFincraBank;
    nomba: INombaBank;
};

export type TBankFactory<P extends BankProvider> =
    P extends keyof BankProviderMap ? BankProviderMap[P] : never;

export type FactoryBuilderOptions<T extends BankProvider> = {
    provider: T;
};

export enum BankInjectionToken {
    FINCRA = "FINCRA",
    NOMBA = "NOMBA",
}

//fincra
export interface IFincraBank {
    name?: string;
}

//nomba
export interface INombaBank {
    name?: string;
}

