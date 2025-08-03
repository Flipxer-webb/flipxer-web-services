export interface IReceiveTransaction {
    amount: number | string;
    currency: string;
    sender?: string;
    transactionId: string;
}

export interface ISwapTransactionSuccess {
    fromAmount: number | string;
    fromCurrency: string;
    toAmount: number | string;
    toCurrency: string;
    transactionId: string;
}

export interface ISendTransactionSuccess {
    amount: number | string;
    currency: string;
    recipient?: string;
    transactionId: string;
}

export interface IFiatPaymentSuccess {
    amount: number | string;
    bankName: string;
    accountNumber: string;
    transactionId: string;
}
