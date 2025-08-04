export interface SendTransactionNotification {
    email: string;
    notice: string;
}

export interface NotificationEventMap {
    transaction_notification: SendTransactionNotification;
}
