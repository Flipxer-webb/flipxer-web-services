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

export interface IBuyTransactionSuccess {
    amount: number | string;
    currency: string;
    transactionId: string;
}

export interface ISellTransactionSuccess {
    amount: number | string;
    currency: string;
    fiatAmount: number | string;
    bankName: string;
    accountNumber: string;
    transactionId: string;
}

export interface IBuyTransactionFailed {
    amount: number | string;
    currency: string;
    transactionId: string;
    reason?: string;
}

export interface IBuyTransactionCancelled {
    amount: number | string;
    currency: string;
    transactionId: string;
    reason?: string;
}

export interface ISellTransactionFailed {
    amount: number | string;
    currency: string;
    transactionId: string;
    reason?: string;
}

export interface ISwapTransactionFailed {
    fromAmount: number | string;
    fromCurrency: string;
    toCurrency: string;
    transactionId: string;
    reason?: string;
}

export interface ISendTransactionQueued {
    amount: number | string;
    currency: string;
    transactionId: string;
}

export interface IReceiveTransactionFailed {
    amount: number | string;
    currency: string;
    transactionId: string;
}

export interface IBuyPaymentShort {
    receivedAmount: number | string;
    expectedAmount: number | string;
    transactionId: string;
}

export interface ISendWithdrawalRefunded {
    amount: number | string;
    currency: string;
    transactionId: string;
}
