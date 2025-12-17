/**
 * Webhook Handler Interfaces
 * 
 * Shared types and interfaces for webhook handlers
 */

/**
 * Result of a webhook notification operation
 */
export interface NotificationResult {
    notificationId: number;
    notificationList: any[];
}

/**
 * Webhook processing result
 */
export interface WebhookProcessingResult {
    success: boolean;
    message: string;
}

/**
 * Base interface for webhook handler dependencies
 */
export interface WebhookHandlerDependencies {
    prisma: any;
    quidaxService: any;
    notificationEvent: any;
    notificationMessage: any;
    wsGateway: any;
    lockService: any;
    tradeHelpers: any;
    walletAddressService: any;
}

/**
 * Transaction notification payload
 */
export interface TransactionNotificationPayload {
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
