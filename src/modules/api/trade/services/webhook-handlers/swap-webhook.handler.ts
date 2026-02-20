import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    TransactionCompletedException,
    TransactionNotFoundException,
} from "../../errors";
import {
    getStreamlinedStatus,
    SwapTransactionHandlerOptions,
} from "../../interfaces/trade";
import {
    OrderCategory,
    OrderStatus,
    User,
} from "@prisma/client";
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
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly lockService: DistributedLockService,
        private readonly walletAddressService: WalletAddressService,
        private readonly notificationDispatcher: NotificationDispatcher
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
        } else if (
            options.status === OrderStatus.failed ||
            options.status === OrderStatus.reversed ||
            options.status === OrderStatus.cancelled
        ) {
            await this.handleSwapFailed(transaction, options.status);
        }
    }

    /**
     * Handle swap failure/reversal/cancellation - send notifications
     */
    private async handleSwapFailed(transaction: any, status: string) {
        // Sync both wallets (in case funds were returned)
        await Promise.all([
            this.walletAddressService.syncWallet(transaction.user.id, transaction.fromCurrency),
            this.walletAddressService.syncWallet(transaction.user.id, transaction.toCurrency),
        ]);

        this.wsGateway.notifyWalletUpdate(transaction.user.id);

        const statusLabel = status === OrderStatus.reversed ? 'reversed' : status === OrderStatus.cancelled ? 'cancelled' : 'failed';
        const message = `\u274C Your swap of ${transaction.fromAmount} ${transaction.fromCurrency?.toUpperCase()} to ${transaction.toCurrency?.toUpperCase()} has ${statusLabel}. Transaction ID: ${transaction.transactionId}.`;

        await this.notificationDispatcher.notify({
            userId: transaction.user.id,
            title: `Swap ${statusLabel}`,
            body: message,
            currency: transaction.fromCurrency,
            transactionType: transaction.orderCategory,
            enableEmail: true,
            emailPayload: {
                email: transaction.user.email,
                transactionType: 'swap',
                transactionId: transaction.transactionId,
                amount: String(transaction.fromAmount),
                currency: transaction.fromCurrency?.toUpperCase(),
                status: statusLabel,
                date: new Date().toISOString(),
                fromAmount: String(transaction.fromAmount),
                fromCurrency: transaction.fromCurrency?.toUpperCase(),
                toCurrency: transaction.toCurrency?.toUpperCase(),
            },
            enablePush: true,
        });
    }

    /**
     * Handle swap completion - sync wallets and send notifications
     */
    private async handleSwapCompleted(transaction: any) {
        // Sync both wallets involved in the swap
        await Promise.all([
            this.walletAddressService.syncWallet(transaction.user.id, transaction.fromCurrency),
            this.walletAddressService.syncWallet(transaction.user.id, transaction.toCurrency),
        ]);

        // Emit wallet update after sync
        this.wsGateway.notifyWalletUpdate(transaction.user.id);

        // Send notification
        await this.sendSwapNotification(transaction);
    }

    /**
     * Send swap completion notification to user
     */
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

        await this.notificationDispatcher.notify({
            userId: transaction.user.id,
            title: "Your swap transaction is completed",
            body: message,
            currency: transaction.toCurrency,
            transactionType: transaction.orderCategory,
            enableEmail: true,
            emailPayload: {
                email: transaction.user.email,
                transactionType: 'swap',
                transactionId: transaction.transactionId,
                amount: String(transaction.fromAmount),
                currency: transaction.fromCurrency?.toUpperCase(),
                status: 'completed',
                date: new Date().toISOString(),
                toAmount: String(transaction.toAmount),
                toCurrency: transaction.toCurrency?.toUpperCase(),
            },
            enablePush: true,
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
