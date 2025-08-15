import * as QD from "@/libs/quidax";
import {
    CurrencyName,
    OrderStatus,
    TradingPair,
} from "@/libs/quidax/types/trade";
export interface InstantOrdersRequeryOptions {
    instant_order_id: string;
    user_id: string;
}

export interface CreateSubAccountOptions {
    email: string;
    first_name: string;
    last_name: string;
}

export interface GetAccountDetailOptions {
    user_id: string;
}

export interface GetUserWalletListOptions {
    user_id: string;
}

export interface GetUserWalletOptions {
    user_id: string;
    currency: string;
}

export interface GetPaymentAddressByIdOptions {
    user_id: string;
    currency: string;
    address_id: string;
}

export interface CreatePaymentAddressOptions {
    user_id: string;
    currency: string;
    network?: string;
}

export interface VerifyAddressOptions {
    currency: string;
    address: string;
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
}

export interface CancelWithdrawerRequestOptions {
    user_id: string;
    withdrawal_id: string;
}

export interface WithdrawalListOptions {
    currency: CurrencyName;
    state: QD.WithdrawalState;
    order_by?: "asc" | "desc";
}

export interface WithdrawerDetailOptions {
    user_id: string;
    withdrawal_id: string;
}

export interface WithdrawerRecordByReferenceOptions {
    user_id: string;
    reference: string;
}

export interface WithdrawerFeesOptions {
    currency: string;
    network?: QD.NetworkTypes;
}

export interface SellOrBuyOrderRequestOptions {
    market: TradingPair;
    side: "buy" | "sell"; //Defaults to buy
    ord_type: "limit" | "market"; //Defaults to limit
    price?: number; //Required if ord_type is limit. It should be left blank for market ord_type. default: 68000
    volume: number; //Defaults to 0.1
}

export interface CancelSellOrBuyOrderRequestOptions {
    user_id: string;
    order_id: string;
}

export interface GetOrderListOptions {
    market: TradingPair;
    state: OrderStatus;
    order_by?: QD.OrderBy;
}

export interface GetOrderRecordOptions {
    user_id: string;
    order_id: string;
}

export interface CreateInstantSwapRequestOptions {
    from_currency: string; //the currency you are swapping from
    to_currency: string; //the currency you are swapping to.
    from_amount?: string; //the amount you want to swap.
    to_amount?: string; //the amount you want to swap to.
}

export interface ConfirmInstantSwapOptions {
    user_id: string;
    quotation_id: string;
}

export interface RefreshInstantSwapOptions {
    from_currency: string; //the currency you are swapping from
    to_currency: string; //the currency you are swapping to.
    from_amount: string; //the amount you want to swap.
    to_amount: string; //the amount you want to swap to.
}

export interface GetSwapTransactionOptions {
    user_id: string;
    swap_transaction_id: string;
}

export interface GetOrderBookItemsForAMarketOptions {
    currency: string;
    ask_limit: number; //Limit the number of returned sell orders. Type: Integer, Allowed values: 1..200
    bids_limit: number; //Limit the number of returned buy orders. Type: Integer, Allowed values: 1..200. Default to 20.
}

export interface PaymentMethodsOptions {
    currency: string;
    side: string;
}

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

export interface IQuidaxService {
    instantOrdersRequery(
        options: InstantOrdersRequeryOptions
    ): Promise<QD.QuidaxResponse<QD.InstantOrderResponse>>;

    createSubAccount(
        options: CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>>;

    getAccountDetail(
        options: GetAccountDetailOptions
    ): Promise<QD.QuidaxResponse<QD.GetAccountDetailResponse>>;

    getUserWalletList(
        options: GetUserWalletListOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletListResponse>>;

    getUserWallet(
        options: GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>>;

    getPaymentAddress(
        options: GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>>;

    createPaymentAddress(
        options: CreatePaymentAddressOptions
    ): Promise<QD.QuidaxResponse<QD.CreatePaymentAddressResponse>>;

    verifyAddress(
        options: VerifyAddressOptions
    ): Promise<QD.QuidaxResponse<QD.VerifyAddressResponse>>;

    createWithdrawerRequest(
        options: CreateWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateWithdrawerRequestResponse>>;

    cancelWithdrawerRequest(
        options: CancelWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CancelWithdrawerRequestResponse>>;

    getWithdrawerList(
        user_id: string,
        options: WithdrawalListOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawalListResponse>>;

    getWithdrawerDetail(
        options: WithdrawerDetailOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerDetailResponse>>;

    getWithdrawerByReference(
        options: WithdrawerRecordByReferenceOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerRecordByReferenceResponse>>;

    getWithdrawerFees(
        options: WithdrawerFeesOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerFeesResponse>>;

    buyOrSellOrderRequest(
        user_id: string,
        options: SellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>>;

    cancelBuyOrSellOrderRequest(
        user_id: string,
        options: CancelSellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>>;

    getAllOrders(
        user_id: string,
        options: GetOrderListOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderListResponse>>;

    getOrderRecord(
        options: GetOrderRecordOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderRecordResponse>>;

    createInstantSwapRequest(
        user_id: string,
        options: CreateInstantSwapRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateInstantSwapRequestResponse>>;

    confirmInstantSwap(
        options: ConfirmInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.ConfirmInstantSwapRequestResponse>>;

    refreshInstantSwapQuote(
        user_id: string,
        quotation_id: string,
        options: RefreshInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.RefreshInstantSwapResponse>>;

    getSwapTransaction(
        options: GetSwapTransactionOptions
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionResponse>>;

    getSwapTransactionList(
        user_id: string
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionListResponse>>;

    getMarketList(): Promise<QD.QuidaxResponse<QD.GetMarketListResponse>>;

    getMarketTickers(): Promise<QD.QuidaxResponse<QD.GetMarketTickersResponse>>;
    getSingleMarketTicker(
        currency: string
    ): Promise<QD.QuidaxResponse<QD.GetMarketTickerResponse>>;

    getOrderBookItemsForAMarket(
        options: GetOrderBookItemsForAMarketOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderBookItemsForAMarketResponse>>;

    getPaymentMethods(
        options: PaymentMethodsOptions
    ): Promise<QD.QuidaxResponse<any>>;

    getPurchaseLimitForBuy(
        options: PurchaseLimitBuyOptions
    ): Promise<QD.QuidaxResponse<any>>;

    getPurchaseLimitForSell(
        options: PurchaseLimitSellOptions
    ): Promise<QD.QuidaxResponse<any>>;

    getPurchaseQuoteForBuy(
        options: PurchaseQuoteBuyOptions
    ): Promise<QD.QuidaxResponse<any>>;

    getPurchaseQuoteForSell(
        options: PurchaseQuoteSellOptions
    ): Promise<QD.QuidaxResponse<any>>;
}

