type Currency = "NGN" | "ZAR" | "USD" | "GHS";
type Country = "nigeria" | "ghana";

export interface BankListResponseData {
    id: number;
    name: string;
    slug: string;
    code: string;
    longcode: string;
    pay_with_bank: boolean;
    active: boolean;
    country: Country;
    currency: Currency;
    type: string;
    is_deleted: boolean;
}

export interface BankListOptions {
    country?: Country;
    use_cursor?: boolean;
    perPage?: number;
    pay_with_bank_transfer?: boolean;
    pay_with_bank?: boolean;
    next?: string;
    gateway?: string;
    currency?: Currency;
    type?: string;
}

export interface ResolveBankAccountOptions {
    account_number: string;
    bank_code: string;
}

export interface ResolveBankAccountResponse {
    account_number: string;
    account_name: string;
}

export enum SupportedBank {
    WEMA_BANK = "wema_bank",
    ACCESS_BANK = "access_bank",
}
