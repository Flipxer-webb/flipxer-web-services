import {
    CryptoMarketTicker,
    CurrencyName,
    IMarket,
    IOrder,
    MarketTickerData,
    OrderBookResponse,
    OrderStatus,
    SwapTransaction,
    TradingPair,
} from "./trade";

export interface QuidaxOptions {
    baseURL: string;
    rampBaseURL: string;
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

export interface IAccount {
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

export interface IPaymentAddress {
    id: string;
    reference: string | null;
    currency: string;
    address: string;
    destination_tag: string | null;
    total_payments: string;
    created_at: string;
    updated_at: string;
    network: string;
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
    network?: string;
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

export interface CreateWithdrawerRequestOptions {
    user_id: string;
    currency: string;
    amount: string;
    transaction_note: string;
    narration: string;
    fund_uid: string; // wallet address
    fund_uid2?: string; //destination tag
    reference: string; //<your_unique_reference>
    network?: string;
}

export interface Recipient {
    type: "coin_address";
    details: {
        address: string;
        destination_tag: string | null;
        name: string | null;
    };
}

export interface Wallet {
    id: string;
    currency: string;
    balance: string;
    locked: string;
    staked: string;
    converted_balance: string;
    reference_currency: string;
    is_crypto: boolean;
    created_at: string;
    updated_at: string;
    deposit_address: string;
    destination_tag: string | null;
}

export interface IQuidaxTransaction {
    id: string;
    reference: string | null;
    type: "coin_address" | string;
    currency: string;
    amount: string;
    fee: string;
    total: string;
    txid: string | null;
    transaction_note: string;
    narration: string;
    status: "Processing" | "Done" | "Rejected";
    reason: string | null;
    created_at: string;
    done_at: string | null;
    recipient: Recipient;
    wallet: Wallet;
    user: IAccount;
}

export type CreateWithdrawerRequestResponse = IQuidaxTransaction;

export type WithdrawalState = "processing" | "done" | "rejected" | "submitted";

export interface WithdrawalListOptions {
    currency: CurrencyName;
    state: WithdrawalState;
    order_by?: "asc" | "desc";
}

export type WithdrawalListResponse = IQuidaxTransaction[];

export interface CancelWithdrawerRequestOptions {
    user_id: string;
    withdrawal_id: string;
}

export type CancelWithdrawerRequestResponse = Record<string, string>;

export interface WithdrawerDetailOptions {
    user_id: string;
    withdrawal_id: string;
}

export type WithdrawerDetailResponse = IQuidaxTransaction;

export interface WithdrawerRecordByReferenceOptions {
    user_id: string;
    reference: string;
}

export type WithdrawerRecordByReferenceResponse = IQuidaxTransaction;

export type NetworkTypes = "trc20" | "erc20" | "bep20" | string;
export interface WithdrawerFeesOptions {
    currency: string;
    network?: NetworkTypes;
}

export interface WithdrawerFeeRange {
    min: number;
    max: number;
    type: "flat" | "percentage";
    value: number;
}

export interface WithdrawerFeesResponse {
    fee: WithdrawerFeeRange[];
    type: "range" | "flat";
}

export interface SellOrBuyOrderRequestOptions {
    market: TradingPair;
    side: "buy" | "sell"; //Defaults to buy
    ord_type: "limit" | "market"; //Defaults to limit
    price?: number; //Required if ord_type is limit. It should be left blank for market ord_type. default: 68000
    volume: number; //Defaults to 0.1
}

export type SellOrBuyOrderRequestResponse = IOrder;

export interface CancelSellOrBuyOrderRequestOptions {
    user_id: string;
    order_id: string;
}

export type OrderBy = "asc" | "desc";

export interface GetOrderListOptions {
    market: TradingPair;
    state: OrderStatus;
    order_by?: OrderBy;
}

export type GetOrderListResponse = IOrder[];

export interface GetOrderRecordOptions {
    user_id: string;
    order_id: string;
}

export type GetOrderRecordResponse = IOrder;

export interface CreateInstantSwapRequestOptions {
    from_currency: string; //the currency you are swapping from
    to_currency: string; //the currency you are swapping to.
    from_amount?: string; //the amount you want to swap.
    to_amount?: string; //the amount you want to swap to.
}

export interface InstantSwapQuote {
    id: string;
    from_currency: string;
    to_currency: string;
    quoted_price: string;
    quoted_currency: string;
    from_amount: string;
    to_amount: string;
    confirmed: boolean;
    expires_at: string;
    created_at: string;
    updated_at: string;
    user: IAccount;
}

export type CreateInstantSwapRequestResponse = InstantSwapQuote;

export interface ConfirmInstantSwapOptions {
    user_id: string;
    quotation_id: string;
}

export type ConfirmInstantSwapRequestResponse = SwapTransaction;

export interface RefreshInstantSwapOptions {
    from_currency: string; //the currency you are swapping from
    to_currency: string; //the currency you are swapping to.
    from_amount: string; //the amount you want to swap.
    to_amount: string; //the amount you want to swap to.
}

export type RefreshInstantSwapResponse = SwapTransaction;

export interface GetSwapTransactionOptions {
    user_id: string;
    swap_transaction_id: string;
}

export type GetSwapTransactionResponse = SwapTransaction;

export type GetSwapTransactionListResponse = SwapTransaction[];

export type GetMarketListResponse = IMarket[];

export type GetMarketTickersResponse = CryptoMarketTicker;

export type GetMarketTickerResponse = MarketTickerData;

export interface GetOrderBookItemsForAMarketOptions {
    currency: string;
    ask_limit: number; //Limit the number of returned sell orders. Type: Integer, Allowed values: 1..200
    bids_limit: number; //Limit the number of returned buy orders. Type: Integer, Allowed values: 1..200. Default to 20.
}

export interface PaymentMethodsOptions {
    currency: string;
    side: string;
}
export type GetOrderBookItemsForAMarketResponse = OrderBookResponse;

export interface PurchaseLimitBuyOptions {
    currency_symbol: string;
}

export interface PurchaseLimitSellOptions {
    token_symbol: string;
}

export interface PurchaseQuoteBuyOptions {
    currency: string; //Fiat currency
    token: string; //Token currency:
    fiat_amount: string;
    token_network: string;
}

export interface PurchaseQuoteSellOptions {
    currency: string; //Fiat currency
    token: string; //Token currency:
    token_amount: string;
    token_network: string;
}

export interface QuidaxResponse<
    D extends Record<string, any> = Record<string, any>
> {
    status: string;
    message: string;
    data: D;
}

// Deposit Types
export type DepositState = "processing" | "done" | "submitted" | "rejected" | "aml_deposit_hold" | "confirming" | "pending" | "successful" | "completed";

export interface IQuidaxDeposit {
    id: string;
    reference: string | null;
    currency: string;
    amount: string;
    fee: string;
    total: string;
    txid: string | null;
    state: DepositState;
    confirmations: number;
    status: string;
    created_at: string;
    completed_at: string | null;
    done_at: string | null;
    network: string | null;
    user: IAccount;
    wallet: Wallet;
}

export interface FetchDepositsOptions {
    user_id: string;
    currency: CurrencyName;
    state?: DepositState;
    order_by?: "asc" | "desc";
}

export type FetchDepositsResponse = IQuidaxDeposit[];

export interface FetchDepositOptions {
    user_id: string;
    currency: CurrencyName;
    deposit_id: string;
}

export type FetchDepositResponse = IQuidaxDeposit;
