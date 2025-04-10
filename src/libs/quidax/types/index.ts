export interface QuidaxOptions {
    baseURL: string;
    api_public: string;
    api_secret: string;
}

export interface InstantOrdersRequeryOptions {
    instant_order_id: string;
    user_id?: string;
}

interface Market {
    id: string;
    base_unit: string;
    quote_unit: string;
}

interface CurrencyAmount {
    unit: string;
    amount: string;
}

interface IAccount {
    id: string;
    sn: string;
    email: string;
    reference: string | null;
    first_name: string;
    last_name: string;
    display_name: string | null;
    created_at: string;
    updated_at: string;
}

export interface InstantOrderResponse {
    id: string;
    reference: string | null;
    market: Market;
    side: "buy" | "sell";
    price: CurrencyAmount;
    volume: CurrencyAmount;
    total: CurrencyAmount;
    fee: CurrencyAmount;
    receive: CurrencyAmount;
    status: string;
    created_at: string;
    updated_at: string;
    user: IAccount;
}

export interface VerifyAddressOptions {
    currency: string;
    address: string;
}

export interface VerifyAddressResponse {
    currency: string;
    address: string;
    valid: boolean;
}

export interface CreateSubAccountOptions {
    email: string;
    first_name: string;
    last_name: string;
}

export type CreateSubAccountResponse = IAccount;

export interface GetAccountDetailOptions {
    user_id: string;
}

export type GetAccountDetailResponse = IAccount;

export interface GetUserWalletListOptions {
    user_id: string;
}

interface ICryptoWalletData {
    id: string;
    name: string;
    currency: string;
    balance: string;
    locked: string;
    staked: string;
    user: IAccount;
    converted_balance: string;
    reference_currency: string;
    is_crypto: boolean;
    created_at: string; // ISO timestamp
    updated_at: string; // ISO timestamp
    blockchain_enabled: boolean;
    default_network: string;
    networks: {
        id: string;
        name: string;
        deposits_enabled: boolean;
        withdraws_enabled: boolean;
    }[];
    deposit_address: string | null;
    destination_tag: string | null;
}

export type GetUserWalletListResponse = ICryptoWalletData[];

export interface GetUserWalletOptions {
    user_id: string;
    currency: string;
}

export type GetUserWalletResponse = ICryptoWalletData;

export type GetPaymentAddressOptions = GetUserWalletOptions;

interface IPaymentAddress {
    id: string;
    reference: string | null;
    currency: string;
    address: string;
    destination_tag: string | null;
    total_payments: string;
    created_at: string;
    updated_at: string;
}

export type GetPaymentAddressResponse = IPaymentAddress;

export type GetPaymentAddressListOptions = GetUserWalletOptions;

export type GetPaymentAddressListResponse = IPaymentAddress[];

export interface GetPaymentAddressByIdOptions {
    user_id: string;
    currency: string;
    address_id: string;
}

export type GetPaymentAddressByIdResponse = IPaymentAddress;

export interface CreatePaymentAddressOptions {
    user_id: string;
    currency: string;
}

export interface CreatePaymentAddressResponse {
    id: string;
    reference: string;
    currency: string;
    address: string;
    network: string;
    user: IAccount;
    destination_tag: string | null;
    total_payments: string | null;
    created_at: string;
    updated_at: string;
}

export interface QuidaxResponse<
    D extends Record<string, any> = Record<string, any>
> {
    status: string;
    message: string;
    data: D;
}
