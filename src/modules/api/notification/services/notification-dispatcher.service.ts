import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { NotificationEvent } from "../events/notification.event";
import { PushNotificationService } from "./push.notification.service";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    UserNotificationTarget,
} from "@prisma/client";
import { TransactionType } from "../types/notification.type";

/**
 * Options for sending a notification through all channels
 */
export interface NotifyOptions {
    userId: number;
    title: string;
    body: string;
    currency?: string;
    transactionType?: OrderCategory;

    // Email options
    enableEmail?: boolean;
    emailPayload?: {
        email: string;
        transactionType: TransactionType;
        transactionId: string;
        amount: string;
        currency: string;
        status: string;
        date: string;
        // Optional fields
        txHash?: string;
        network?: string;
        walletAddress?: string;
        explorerUrl?: string;
        recipient?: string;
        toAmount?: string;
        toCurrency?: string;
        fromAmount?: string;
        fromCurrency?: string;
        fiatAmount?: string;
        bankName?: string;
        accountNumber?: string;
        orderReference?: string;
        networkFee?: string;
        exchangeRate?: string;
    };

    // Push options
    enablePush?: boolean;
    pushTitle?: string;
    pushBody?: string;
}

/**
 * Centralized notification dispatcher that handles all notification channels:
 * - Database (in-app notifications)
 * - WebSocket (real-time updates)
 * - Email (via NotificationEvent)
 * - Push (via Firebase)
 * 
 * Features:
 * - Uses $transaction to prevent race conditions
 * - Checks user preferences before each channel
 * - Centralized error handling
 */
@Injectable()
export class NotificationDispatcher {
    private readonly logger = new Logger(NotificationDispatcher.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly wsGateway: WsGateway,
        private readonly notificationEvent: NotificationEvent,
        private readonly pushNotificationService: PushNotificationService,
    ) { }

    /**
     * Send a notification through all enabled channels.
     * This method is atomic for DB operations (prevents race conditions).
     */
    async notify(options: NotifyOptions): Promise<void> {
        try {
            // 1. Query user preferences FIRST
            const prefs = await this.prisma.notificationPreferences.findUnique({
                where: { userId: options.userId }
            });

            // 2. Atomic DB operation (fixes race condition)
            // Create notification and fetch list in same transaction
            const { notification, notificationList } = await this.prisma.$transaction(async (tx) => {
                const notification = await tx.notification.create({
                    data: {
                        title: options.title,
                        body: options.body,
                        userId: options.userId,
                        target: UserNotificationTarget.SINGLE,
                        beneficiary: NotificationBeneficiary.INDIVIDUAL,
                        type: NotificationType.MESSAGE,
                        status: NotificationStatus.APPROVED,
                        senderId: null,
                        transactionType: options.transactionType,
                        currency: options.currency,
                    },
                });

                const notificationList = await tx.notification.findMany({
                    where: { userId: options.userId },
                    orderBy: { createdAt: "desc" },
                    take: 20,
                });

                return { notification, notificationList };
            });

            // 3. WebSocket (always sent - real-time is expected)
            try {
                this.wsGateway.notifyUser(options.userId, {
                    type: "new_notification",
                    notification,
                    notificationList,
                });
            } catch (wsError) {
                this.logger.warn(`WebSocket notification failed for user ${options.userId}: ${wsError.message}`);
            }

            // 4. Email (if enabled and user allows it)
            const shouldEmail = options.enableEmail &&
                options.emailPayload &&
                (prefs?.emailTransactions !== false); // Default to true if no prefs

            if (shouldEmail) {
                try {
                    this.notificationEvent.emit("transaction_notification", {
                        ...options.emailPayload,
                        notice: options.body,
                    });
                } catch (emailError) {
                    this.logger.warn(`Email notification failed for user ${options.userId}: ${emailError.message}`);
                }
            }

            // 5. Push (if enabled and user allows it)
            const shouldPush = options.enablePush &&
                (prefs?.pushTransactions !== false); // Default to true if no prefs

            if (shouldPush) {
                try {
                    await this.pushNotificationService.sendToUser(options.userId, {
                        title: options.pushTitle || options.title,
                        body: options.pushBody || options.body,
                        data: {
                            type: options.transactionType || "notification",
                            currency: options.currency || "",
                        },
                    });
                } catch (pushError) {
                    this.logger.warn(`Push notification failed for user ${options.userId}: ${pushError.message}`);
                }
            }

            this.logger.log(`Notification sent to user ${options.userId}: ${options.title}`);

        } catch (error) {
            this.logger.error(`Failed to send notification to user ${options.userId}: ${error.message}`, error.stack);
            // Don't throw - notification failures shouldn't break business logic
        }
    }

    /**
     * Send a transaction update via WebSocket only (no DB notification).
     * Use this for status updates where a notification already exists.
     */
    notifyTransactionUpdate(userId: number, transaction: {
        id: number;
        transactionId: string;
        status: string;
        streamlinedStatus: string;
        orderCategory: OrderCategory;
        amount: number;
        currency: string;
        createdAt: Date;
        updatedAt: Date;
    }): void {
        try {
            this.wsGateway.notifyTransactionUpdate(userId, {
                type: "transaction_update",
                transaction,
            });
        } catch (error) {
            this.logger.warn(`Transaction update notification failed for user ${userId}: ${error.message}`);
        }
    }

    /**
     * Send a wallet update via WebSocket only.
     * Use this when balance changes.
     */
    notifyWalletUpdate(userId: number): void {
        try {
            this.wsGateway.notifyWalletUpdate(userId);
        } catch (error) {
            this.logger.warn(`Wallet update notification failed for user ${userId}: ${error.message}`);
        }
    }
}
