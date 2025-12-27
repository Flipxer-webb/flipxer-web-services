export type TransactionType = 'deposit' | 'withdrawal' | 'swap' | 'buy' | 'sell';

export interface SendTransactionNotification {
    email: string;
    notice: string;
    // Structured transaction details for rich email templates
    transactionType: TransactionType;
    transactionId: string;
    amount: string;
    currency: string;
    status: string;
    date: string;
    // Optional blockchain details
    txHash?: string;
    network?: string;
    walletAddress?: string;
    explorerUrl?: string;
    recipient?: string;
    // For swaps
    toAmount?: string;
    toCurrency?: string;
    fromAmount?: string;
    fromCurrency?: string;
    // For sell/buy
    fiatAmount?: string;
    bankName?: string;
    accountNumber?: string;
    // Additional receipt fields
    orderReference?: string;
    networkFee?: string;
    exchangeRate?: string;
}

export interface NotificationEventMap {
    transaction_notification: SendTransactionNotification;
}

