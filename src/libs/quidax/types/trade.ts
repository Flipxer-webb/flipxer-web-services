import { IAccount } from ".";

export interface Market {
    id: string;
    base_unit: string;
    quote_unit: string;
}

export interface AmountWithUnit {
    unit: string;
    amount: string;
}

export interface Trade {
    id: string;
    market: Market;
    price: AmountWithUnit;
    volume: AmountWithUnit;
    total: AmountWithUnit;
    created_at: string;
    updated_at: string;
}

export type OrderStatus = "wait" | "done" | "cancel" | "pending";
export interface IOrder {
    id: string;
    reference: string | null;
    market: Market;
    side: "buy" | "sell";
    order_type: "limit" | "market";
    price: AmountWithUnit;
    avg_price: AmountWithUnit;
    volume: AmountWithUnit;
    origin_volume: AmountWithUnit;
    executed_volume: AmountWithUnit;
    status: OrderStatus;
    trades_count: number;
    created_at: string;
    updated_at: string;
    done_at: string | null;
    user: IAccount;
    trades: Trade[];
}

export interface SwapQuotation {
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

export interface SwapTransaction {
    id: string;
    from_currency: string;
    to_currency: string;
    from_amount: string;
    received_amount: string;
    execution_price: string;
    status: "initiated" | "completed" | "reversed" | "failed";
    created_at: string;
    updated_at: string;
    swap_quotation: SwapQuotation;
    user: IAccount;
}

export interface IMarket {
    id: string;
    name: string;
    base_unit: string;
    quote_unit: string;
    filters: {
        price_step: number;
    };
}

export interface Ticker {
    buy: string;
    sell: string;
    low: string;
    high: string;
    open: string;
    last: string;
    vol: string;
}

export interface MarketTickerData {
    at: number;
    ticker: Ticker;
    market?: string;
}

export interface CryptoMarketTicker {
    [pair: string]: MarketTickerData;
}

export interface Order {
    id: string;
    side: "buy" | "sell";
    ord_type: "market" | "limit";
    price: number | null;
    avg_price: string;
    state: "wait" | "done" | "cancel";
    currency: string;
    origin_volume: string;
    volume: string;
    executed_volume: string;
    trades_count: number;
    created_at: string; // ISO string
    updated_at: string; // ISO string
}

export interface OrderBookResponse {
    asks: Order[];
    bids: Order[];
}

export type TradingPair =
    | "qdxusdt"
    | "btcusdt"
    | "btcngn"
    | "ethngn"
    | "qdxngn"
    | "xrpngn"
    | "dashngn"
    | "ltcngn"
    | "usdtngn"
    | "btcghs"
    | "usdtghs"
    | "trxngn"
    | "dogeusdt"
    | "bnbusdt"
    | "maticusdt"
    | "safemoonusdt"
    | "aaveusdt"
    | "shibusdt"
    | "dotusdt"
    | "linkusdt"
    | "cakeusdt"
    | "xlmusdt"
    | "xrpusdt"
    | "ltcusdt"
    | "ethusdt"
    | "trxusdt"
    | "axsusdt"
    | "wsgusdt"
    | "afenusdt"
    | "blsusdt"
    | "dashusdt";

export type CurrencyName =
    | "usd"
    | "btc"
    | "ltc"
    | "eth"
    | "xrp"
    | "usdt"
    | "dash"
    | "trx"
    | "doge"
    | "bnb"
    | "matic"
    | "shib"
    | "axs"
    | "safemoon"
    | "cake"
    | "xlm"
    | "aave"
    | "link";
