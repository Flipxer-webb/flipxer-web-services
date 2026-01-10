import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    TransactionCompletedException,
    TransactionNotFoundException,
} from "../../errors";
import {
    getStreamlinedStatus,
    SwapTransactionHandlerOptions,
} from "../../interfaces/trade";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderStatus,
    UserNotificationTarget,
} from "@prisma/client";
import { NotificationEvent } from "../../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { WalletAddressService } from "../wallet-address.service";
import {
    DEFAULT_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
} from "../../constants";

/**
 * Swap Webhook Handler
 * 
 * Handles swap transaction webhooks from Quidax.
 * Processes status updates for crypto-to-crypto swaps.
 */
@Injectable()
export class SwapWebhookHandler {
    private readonly logger = new Logger("SwapWebhookHandler");

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationEvent: NotificationEvent,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly lockService: DistributedLockService
    ) { }

    /**
     * Handle swap transaction webhook from Quidax
     * Uses distributed lock to prevent duplicate processing
     */
    async handle(options: SwapTransactionHandlerOptions) {
        const lockKey = `swap:${options.orderId}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () => this.processSwapTransaction(options),
                { ttlMs: DEFAULT_TRANSACTION_TIMEOUT_MS, maxWaitMs: DEFAULT_TRANSACTION_MAX_WAIT_MS }
            );
        } catch (error) {
            if (error.message?.includes("Failed to acquire lock")) {
                this.logger.warn(
                    `Skipping duplicate swap processing | ${JSON.stringify({
                        orderId: options.orderId,
                        reason: "Could not acquire lock - likely duplicate webhook",
                    })}`
                );
                return;
            }
            throw error;
        }
    }

    /**
     * Internal method to process swap transaction - called within a distributed lock
     */
    private async processSwapTransaction(options: SwapTransactionHandlerOptions) {
        const transaction = await this.prisma.order.findUnique({
            where: { providerOrderId: options.orderId },
            include: { user: { select: { id: true, email: true } } },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (transaction.status === OrderStatus.completed) {
            throw new TransactionCompletedException(
                "Transaction already completed",
                HttpStatus.BAD_REQUEST
            );
        }

        if (transaction.status === options.status) {
            return;
        }

        const updatedOrder = await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: options.status,
                streamlinedStatus: getStreamlinedStatus(options.status),
            },
        });

        // Emit transaction update immediately
        this.emitTransactionUpdate(transaction.user.id, updatedOrder);

        if (options.status == OrderStatus.completed) {
            await this.handleSwapCompleted(transaction);
        }
    }

    /**
     * Handle swap completion - sync wallets and send notifications
     */
    private async handleSwapCompleted(transaction: any) {
        // No sync needed, ledger is source of truth.
        // Atomic swap service already handled balance updates.

        // Emit wallet update (just to refresh UI state if needed)
        this.wsGateway.notifyWalletUpdate(transaction.user.id);

        // Send notification
        await this.sendSwapNotification(transaction);
    }

    /**
     * Send swap completion notification to user
     */
    private async sendSwapNotification(transaction: any) {
        const message = this.notificationMessage.swapTransactionSuccess({
            fromAmount: transaction.fromAmount,
            fromCurrency: transaction.fromCurrency,
            toAmount: transaction.toAmount,
            toCurrency: transaction.toCurrency,
            transactionId: transaction.transactionId,
        });

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "Your swap transaction is completed",
                body: message,
                userId: transaction.user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: transaction.orderCategory,
                currency: transaction.toCurrency,
            },
        });

        this.notificationEvent.emit("transaction_notification", {
            email: transaction.user.email,
            notice: message,
            transactionType: 'swap',
            transactionId: transaction.transactionId,
            amount: String(transaction.fromAmount),
            currency: transaction.fromCurrency?.toUpperCase(),
            status: 'completed',
            date: new Date().toISOString(),
            toAmount: String(transaction.toAmount),
            toCurrency: transaction.toCurrency?.toUpperCase(),
        });

        const notificationList = await this.prisma.notification.findMany({
            where: { userId: transaction.user.id },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        this.wsGateway.notifyUser(transaction.user.id, {
            type: "new_notification",
            notification: createdNotification,
            notificationList,
        });
    }

    /**
     * Emit transaction update via WebSocket
     */
    private emitTransactionUpdate(userId: number, order: any) {
        this.wsGateway.notifyTransactionUpdate(userId, {
            type: "transaction_update",
            transaction: {
                id: order.id,
                transactionId: order.transactionId,
                status: order.status,
                streamlinedStatus: order.streamlinedStatus,
                orderCategory: order.orderCategory,
                amount: order.amount,
                currency: order.currency,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt,
            },
        });
    }
}
