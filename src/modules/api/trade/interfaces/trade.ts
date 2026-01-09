import { Notification, OrderStatus, PaymentMethod } from "@prisma/client";

interface FundingFailure {
    transactionId: number;
}

export interface TradingEventMap {
    "funding-failure": FundingFailure;
}

export interface IWalletAddressCreatedSuccess {
    walletAddressId: string;
    walletAddress: string;
    totalPayments: string;
    destination_tag?: string;
    network?: string;
}

export interface IWalletUpdated {
    walletId: string;
    balance: string;
    locked: string;
    staked: string;
    convertedBalance: string;
    updatedAt: string;
    depositAddress: string; // Can be null initially
    destinationTag: string;
    referenceCurrency: string;
}

export enum SupportedAssets {
    QDX = "qdx",
    USD = "usd",
    NGN = "ngn",
    GHS = "ghs",
    BTC = "btc",
    USDT = "usdt",
    BUSD = "busd",
    CFX = "cfx",
    USDC = "usdc",
    CNHC = "cnhc",
    ETH = "eth",
    BNB = "bnb",
    XRP = "xrp",
    LTC = "ltc",
    WKD = "wkd",
    BCH = "bch",
    DOGE = "doge",
    DASH = "dash",
    TRX = "trx",
    ONE = "one",
    LINK = "link",
    CAKE = "cake",
    XLM = "xlm",
    AXS = "axs",
    SHIB = "shib",
    AFEN = "afen",
    BLS = "bls",
    FIL = "fil",
    ADA = "ada",
    DOT = "dot",
    BABYDOGE = "babydoge",
    XTZ = "xtz",
    MATIC = "matic",
    SFM = "sfm",
    AAVE = "aave",
    WSG = "wsg",
    CKT = "ckt",
    FLOKI = "floki",
    SOL = "sol",
    MANA = "mana",
    FTM = "ftm",
    SAND = "sand",
    SLP = "slp",
    ENJ = "enj",
    LRC = "lrc",
    APE = "ape",
    SUSHI = "sushi",
    ZIL = "zil",
}

export enum TradingPair {
    QDX_USDT = "qdxusdt",
    BTC_USDT = "btcusdt",
    BTC_NGN = "btcngn",
    ETH_NGN = "ethngn",
    QDX_NGN = "qdxngn",
    XRP_NGN = "xrpngn",
    DASH_NGN = "dashngn",
    LTC_NGN = "ltcngn",
    USDT_NGN = "usdtngn",
    BTC_GHS = "btcghs",
    USDT_GHS = "usdtghs",
    TRX_NGN = "trxngn",
    DOGE_USDT = "dogeusdt",
    BNB_USDT = "bnbusdt",
    MATIC_USDT = "maticusdt",
    SAFEMOON_USDT = "safemoonusdt",
    AAVE_USDT = "aaveusdt",
    SHIB_USDT = "shibusdt",
    DOT_USDT = "dotusdt",
    LINK_USDT = "linkusdt",
    CAKE_USDT = "cakeusdt",
    XLM_USDT = "xlmusdt",
    XRP_USDT = "xrpusdt",
    LTC_USDT = "ltcusdt",
    ETH_USDT = "ethusdt",
    TRX_USDT = "trxusdt",
    AXS_USDT = "axsusdt",
    WSG_USDT = "wsgusdt",
    AFEN_USDT = "afenusdt",
    BLS_USDT = "blsusdt",
    DASH_USDT = "dashusdt",
}

export enum OrderType {
    LIMIT = "limit",
    MARKET = "market",
}

export enum OrderSide {
    BUY = "buy",
    SELL = "sell",
}

export interface SwapTransactionHandlerOptions {
    orderId: string;
    status: OrderStatus;
}

export interface WithdrawerTransactionHandlerOptions {
    orderReference: string;
    status: OrderStatus;
}

export interface DepositTransaction {
    status: OrderStatus;
    txid: string;
    referenceId: string;
    type: string;
    fee: string;
    amount: string;
    recipient: string;
    payment_address?: string;
    payment_address_id?: string;
    network?: string;
    quidaxUserId: string;
    currency: string;
    reason: string;
    created_at?: string;
    done_at?: string | null;
}

export interface BuyQuoteResponse {
    buyRate: number;
    cryptoBuyAmount: number;
    transactionFeeInCrypto: number;
    totalToChargeInCrypto: number;
    totalToChargeViaPaymentGateway: number;
    currency: string;
    paymentGateway: PaymentMethod;
    depositAddress: string;
    destinationTag: string;
}

export interface SellQuoteResponse {
    sellRate: number;
    cryptoSellAmount: number;
    transactionFeeInCrypto: number;
    transactionFeeInFiat: number;
    totalCostInCrypto: number;
    totalCostInFiat: number;
    totalToReceiveInFiat: number;
    currency: string;
    bankDetail: {
        accountName: string;
        accountNumber: string;
        bankName: string;
    };
    totalCryptoToAdmin?: number;
}

enum OrderStreamlinedStatus {
    pending = "pending",
    completed = "completed",
    failed = "failed",
    cancelled = "cancelled",
}

const orderStatusToStreamlinedStatusMap: Record<
    string,
    OrderStreamlinedStatus
> = {
    // Pending group
    pending: OrderStreamlinedStatus.pending,
    initiated: OrderStreamlinedStatus.pending,
    submitted: OrderStreamlinedStatus.pending,
    processing: OrderStreamlinedStatus.pending,
    on_hold: OrderStreamlinedStatus.pending,

    // Completed group
    filled: OrderStreamlinedStatus.completed,
    completed: OrderStreamlinedStatus.completed,
    confirmed: OrderStreamlinedStatus.completed,
    done: OrderStreamlinedStatus.completed,
    accepted: OrderStreamlinedStatus.completed, // received type

    // Failed group
    failed: OrderStreamlinedStatus.failed,
    rejected: OrderStreamlinedStatus.failed,

    // Cancelled group
    cancelled: OrderStreamlinedStatus.cancelled,
    reversed: OrderStreamlinedStatus.cancelled,
};

export function getStreamlinedStatus(status: string): OrderStreamlinedStatus {
    return (
        orderStatusToStreamlinedStatusMap[status] ??
        OrderStreamlinedStatus.pending
    ); // default fallback
}

export interface IWsNewNotification {
    type: string;
    notification: Notification;
    notificationList: Notification[];
}

export interface IWsTransactionUpdate {
    type: "transaction_update";
    transaction: {
        id: number;
        transactionId: string;
        status: string;
        streamlinedStatus: string;
        orderCategory: string;
        amount: number;
        currency: string;
        createdAt: Date;
        updatedAt: Date;
    };
}

export interface IWsWalletUpdate {
    type: "wallet_update";
    wallets: any[];
}
