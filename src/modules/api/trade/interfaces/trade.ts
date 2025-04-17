interface FundingFailure {
    transactionId: number;
}

export interface TradingEventMap {
    "funding-failure": FundingFailure;
}
