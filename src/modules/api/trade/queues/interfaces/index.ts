export enum QuidaxTradingQueue {
    TRADING = "trading",
}

export enum TradingQueue {
    QUIDAX_TRADING = "quidaxQuery",
}

export interface QuidaxTradingJobOptions {
    user_id: string;
}
