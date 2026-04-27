export enum QuidaxTradingQueue {
    TRADING_ACCOUNT_INIT = "trading_account_init",
    SYNC_CRYPTO_BALANCE = "sync-crypto-balance",
    SYNC_USER_DEPOSITS = "sync-user-deposits",
}

export enum TradingQueue {
    QUIDAX_ACCOUNT_INIT = "quidaxCryptoAccountInit",
    QUIDAX_SYNC_BALANCE = "quidaxSyncBalance",
    QUIDAX_DEPOSIT_SYNC = "quidaxDepositSync",
}

export interface QuidaxTradingJobOptions {
    user_id: number;
}
