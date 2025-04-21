interface FundingFailure {
    transactionId: number;
}

export interface TradingEventMap {
    "funding-failure": FundingFailure;
}

export interface IWalletAddressCreatedSuccess {
    walletId: string;
    walletAddress: string;
    balance: string;
    converted_balance?: string;
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
