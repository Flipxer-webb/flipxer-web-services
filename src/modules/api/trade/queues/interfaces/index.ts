export enum QuidaxTradingQueue {
    TRADING_ACCOUNT_INIT = "trading_account_init",
    SYNC_CRYPTO_BALANCE = "sync-crypto-balance",
}

export enum TradingQueue {
    QUIDAX_ACCOUNT_INIT = "quidaxCryptoAccountInit",
    QUIDAX_SYNC_BALANCE = "quidaxSyncBalance",
}

export interface QuidaxTradingJobOptions {
    user_id: number;
}
