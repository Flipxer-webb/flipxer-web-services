import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import {
    TransactionCompletedException,
    TransactionNotFoundException,
} from "../../errors";
import {
    getStreamlinedStatus,
    WithdrawerTransactionHandlerOptions,
} from "../../interfaces/trade";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    UserNotificationTarget,
} from "@prisma/client";
import { generateId } from "@/utils";
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
 * Withdrawal Webhook Handler
 * 
 * Handles withdrawal transaction webhooks from Quidax.
 * Processes status updates for outgoing crypto withdrawals.
 * 
 * For sell orders, triggers Fincra payout when withdrawal completes.
 */
@Injectable()
export class WithdrawalWebhookHandler {
    private readonly logger = new Logger("WithdrawalWebhookHandler");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        private readonly notificationEvent: NotificationEvent,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly lockService: DistributedLockService,
        private readonly walletAddressService: WalletAddressService
    ) { }

    /**
     * Handle withdrawal transaction webhook from Quidax
     * Uses distributed lock to prevent duplicate processing
     */
    async handle(options: WithdrawerTransactionHandlerOptions) {
        const lockKey = `withdraw:${options.orderReference}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () => this.processWithdrawerTransaction(options),
                { ttlMs: DEFAULT_TRANSACTION_TIMEOUT_MS, maxWaitMs: DEFAULT_TRANSACTION_MAX_WAIT_MS }
            );
        } catch (error) {
            if (error.message?.includes("Failed to acquire lock")) {
                this.logger.warn(
                    `Skipping duplicate withdrawal processing | ${JSON.stringify({
                        orderReference: options.orderReference,
                        reason: "Could not acquire lock - likely duplicate webhook",
                    })}`
                );
                return;
            }
            throw error;
        }
    }

    /**
     * Internal method to process withdrawal transaction - called within a distributed lock
     */
    private async processWithdrawerTransaction(options: WithdrawerTransactionHandlerOptions) {
        const transaction = await this.prisma.order.findUnique({
            where: { orderReference: options.orderReference },
            include: {
                user: { select: { id: true, email: true, userType: true } },
            },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (transaction.status === OrderStatus.done) {
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

        // Emit transaction update immediately so UI reflects status change
        this.emitTransactionUpdate(transaction.user.id, updatedOrder);

        // For sell orders: when crypto reaches admin, pay the seller in fiat
        if (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL
        ) {
            await this.initiateFiatPayout(transaction);
        }

        if (options.status == OrderStatus.done) {
            await this.handleWithdrawalDone(transaction);
        } else if (options.status == OrderStatus.failed) {
            await this.handleWithdrawalFailed(transaction);
        }
    }

    /**
     * Initiate fiat payout to seller via Fincra
     */
    private async initiateFiatPayout(transaction: any) {
        const payoutReference = generateId({ type: "reference" });

        this.logger.log(
            `Initiating Fincra payout | ${JSON.stringify({
                orderId: transaction.id,
                userId: transaction.userId,
                amount: transaction.totalToReceiveInFiat,
                accountName: transaction.destinationBankAccountName,
                accountNumber: transaction.destinationBankAccountNumber,
                bankCode: transaction.destinationBankCode,
                bankName: transaction.destinationBankName,
                reference: payoutReference,
            })}`
        );

        try {
            await this.fincraService.initializeTransfer({
                accountName: transaction.destinationBankAccountName,
                accountNumber: transaction.destinationBankAccountNumber,
                amount: transaction.totalToReceiveInFiat,
                bankCode: transaction.destinationBankCode,
                bankName: transaction.destinationBankName,
                serviceCharge: 0,
                userId: transaction.userId,
                orderId: transaction.id,
                reference: payoutReference,
            });

            this.logger.log(`Fincra payout initiated successfully for order ${transaction.id}, reference: ${payoutReference}`);
        } catch (error) {
            this.logger.error(
                `CRITICAL: Fincra payout FAILED | ${JSON.stringify({
                    orderId: transaction.id,
                    userId: transaction.userId,
                    error: error.message,
                    stack: error.stack,
                })}`
            );
            // Re-throw to ensure the caller knows payout failed
            throw error;
        }
    }

    /**
     * Handle successful withdrawal completion
     */
    private async handleWithdrawalDone(transaction: any) {
        // Sync wallet with Quidax to ensure balance is up to date
        await this.walletAddressService.syncWallet(transaction.user.id, transaction.currency);

        // Emit wallet update after sync
        this.wsGateway.notifyWalletUpdate(transaction.user.id);

        // Send success notification
        await this.sendWithdrawalSuccessNotification(transaction);
    }

    /**
     * Handle failed withdrawal
     */
    private async handleWithdrawalFailed(transaction: any) {
        // Sync wallet on failure too (in case funds were returned)
        await this.walletAddressService.syncWallet(transaction.user.id, transaction.currency);
        this.wsGateway.notifyWalletUpdate(transaction.user.id);

        // Send failure notification
        await this.sendWithdrawalFailedNotification(transaction);
    }

    /**
     * Send withdrawal success notification to user
     */
    private async sendWithdrawalSuccessNotification(transaction: any) {
        const message = this.notificationMessage.sendTransactionSuccess({
            amount: transaction.amount,
            currency: transaction.currency,
            recipient: transaction.recipient,
            transactionId: transaction.transactionId,
        });

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "Your send transaction is done",
                body: message,
                userId: transaction.user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: transaction.orderCategory,
                currency: transaction.currency,
            },
        });

        this.notificationEvent.emit("transaction_notification", {
            email: transaction.user.email,
            notice: message,
            transactionType: 'withdrawal',
            transactionId: transaction.transactionId,
            amount: String(transaction.amount),
            currency: transaction.currency.toUpperCase(),
            status: 'completed',
            date: new Date().toISOString(),
            recipient: transaction.recipient || '',
            network: transaction.network || '',
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
     * Send withdrawal failed notification to user
     */
    private async sendWithdrawalFailedNotification(transaction: any) {
        const message = `Your send of ${transaction.amount} ${transaction.currency.toUpperCase()} failed. Transaction ID: ${transaction.transactionId}`;

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "Send transaction failed",
                body: message,
                userId: transaction.user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: transaction.orderCategory,
                currency: transaction.currency,
            },
        });

        this.notificationEvent.emit("transaction_notification", {
            email: transaction.user.email,
            notice: message,
            transactionType: 'withdrawal',
            transactionId: transaction.transactionId,
            amount: String(transaction.amount),
            currency: transaction.currency.toUpperCase(),
            status: 'failed',
            date: new Date().toISOString(),
            recipient: transaction.recipient || '',
            network: transaction.network || '',
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
