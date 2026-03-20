import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { NotificationEvent } from "../events/notification.event";
import { PushNotificationService } from "./push.notification.service";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    NotificationPreferences,
    OrderCategory,
    UserNotificationTarget,
} from "@prisma/client";
import { TransactionType } from "../types/notification.type";

/**
 * Notification categories that map to user preference toggles.
 * - transaction: buy/sell/swap/deposit/withdrawal events
 * - security: login, 2FA, password changes, tier verification
 * - price_alert: price alert triggers
 * - marketing: promotional / admin broadcast
 */
export type NotificationCategory = "transaction" | "security" | "price_alert" | "marketing";

/**
 * Options for sending a notification through all channels
 */
export interface NotifyOptions {
    userId: number;
    title: string;
    body: string;
    currency?: string;
    transactionType?: OrderCategory;

    /** Category controls which user preference toggle is checked */
    category?: NotificationCategory;

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
     * Check if the user's push preference allows this notification category.
     * Defaults to true if no preferences exist.
     */
    private shouldSendPush(
        prefs: NotificationPreferences | null,
        category?: NotificationCategory,
    ): boolean {
        if (!prefs) return true;
        switch (category) {
            case "security":
                return prefs.pushSecurityAlerts !== false;
            case "price_alert":
                return prefs.pushPriceAlerts !== false;
            case "marketing":
                return prefs.pushMarketing !== false;
            case "transaction":
            default:
                return prefs.pushTransactions !== false;
        }
    }

    /**
     * Check if the user's email preference allows this notification category.
     * Defaults to true if no preferences exist.
     */
    private shouldSendEmail(
        prefs: NotificationPreferences | null,
        category?: NotificationCategory,
    ): boolean {
        if (!prefs) return true;
        switch (category) {
            case "security":
                return prefs.emailSecurityAlerts !== false;
            case "marketing":
                return prefs.emailMarketing !== false;
            case "transaction":
            case "price_alert":
            default:
                return prefs.emailTransactions !== false;
        }
    }

    /**
     * Check if the current time falls within the user's quiet hours.
     * During quiet hours, push and email are suppressed (except security).
     */
    private isInQuietHours(prefs: NotificationPreferences | null): boolean {
        if (!prefs?.quietHoursEnabled || !prefs.quietHoursStart || !prefs.quietHoursEnd) {
            return false;
        }
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const [startH, startM] = prefs.quietHoursStart.split(":").map(Number);
        const [endH, endM] = prefs.quietHoursEnd.split(":").map(Number);
        const start = startH * 60 + startM;
        const end = endH * 60 + endM;
        // Handle overnight ranges (e.g., 22:00 - 07:00)
        if (start > end) {
            return currentMinutes >= start || currentMinutes < end;
        }
        return currentMinutes >= start && currentMinutes < end;
    }

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
                        category: options.category,
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

            // Quiet hours suppress push & email (security alerts bypass quiet hours)
            const inQuietHours = this.isInQuietHours(prefs) && options.category !== "security";

            // 4. Email (if enabled and user allows it)
            const shouldEmail = options.enableEmail &&
                options.emailPayload &&
                !inQuietHours &&
                this.shouldSendEmail(prefs, options.category);

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
                !inQuietHours &&
                this.shouldSendPush(prefs, options.category);

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
