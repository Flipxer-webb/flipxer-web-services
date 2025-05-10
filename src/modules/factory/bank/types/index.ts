export * as TPaystack from "./paystack";

export type BankProvider = "paystack";

export type BankProviderMap = {
    paystack: IPaystackBank;
};

export type TBankFactory<P extends BankProvider> =
    P extends keyof BankProviderMap ? BankProviderMap[P] : never;

export type FactoryBuilderOptions<T extends BankProvider> = {
    provider: T;
};

export enum BankInjectionToken {
    PAYSTACK = "PAYSTACK",
}

//paystack
export interface IPaystackBank {
    name?: string;
}
