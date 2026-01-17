import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";
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
    OrderStreamlinedStatus,
    UserNotificationTarget,
} from "@prisma/client";

import { generateId } from "@/utils";
import { NotificationEvent } from "../../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { WalletAddressService } from "../wallet-address.service";
import { slackPayoutAlertWebhookUrl } from "@/config";
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
 * For sell orders, triggers Nomba payout when withdrawal completes.
 */
@Injectable()
export class WithdrawalWebhookHandler {
    private readonly logger = new Logger("WithdrawalWebhookHandler");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
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
            // Check if this is a buy order fulfillment withdrawal (format: transactionId_fulfill)
            if (options.orderReference?.endsWith('_fulfill')) {
                this.logger.debug(
                    `Skipping withdrawal webhook for buy order fulfillment: ${options.orderReference}`
                );
                return; // This is expected - buy order fulfillments don't create separate Order records
            }
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        // CRITICAL: Ignore withdrawals related to SWAP orders.
        // The SwapService handles the entire flow (Sell -> Buy) atomically.
        // Processing this webhook would prematurely mark the Swap as COMPLETED when only the Sell leg is done.
        if (transaction.orderCategory === OrderCategory.SWAP) {
            this.logger.log(`Ignoring withdrawal webhook for SWAP order ${transaction.id}. Internal flow handles this.`);
            return;
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

        // For SELL orders where crypto arrived (done), don't mark completed yet
        // Wait for payout to succeed before marking completed
        const isSellPayoutPending = (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL &&
            !transaction.transaction_note?.match(/^BUY:\d+$/) // Not a BUY fulfillment
        );

        // Update order status
        // For SELL orders awaiting payout, set to "processing" instead of "done/completed"
        const updatedOrder = await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: isSellPayoutPending ? OrderStatus.processing : options.status,
                streamlinedStatus: isSellPayoutPending
                    ? OrderStreamlinedStatus.pending
                    : getStreamlinedStatus(options.status),
            },
        });

        // Emit transaction update immediately so UI reflects status change
        this.emitTransactionUpdate(transaction.user.id, updatedOrder);

        // For sell orders: when crypto reaches admin, pay the seller in fiat
        if (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL
        ) {
            // Check if this is an admin's SELL order linked to a user's BUY order
            const buyOrderMatch = transaction.transaction_note?.match(/^BUY:(\d+)$/);
            if (buyOrderMatch) {
                // This is admin sending crypto to user for a BUY order - complete the BUY order
                const buyOrderId = parseInt(buyOrderMatch[1], 10);
                await this.completeBuyOrder(buyOrderId, transaction);
            } else {
                // This is a regular user SELL order - pay them in fiat
                // If payout succeeds, mark order as completed
                try {
                    await this.initiateFiatPayout(transaction);

                    // Payout succeeded - NOW mark order as completed
                    const completedOrder = await this.prisma.order.update({
                        where: { id: transaction.id },
                        data: {
                            status: OrderStatus.done,
                            streamlinedStatus: OrderStreamlinedStatus.completed,
                        },
                    });

                    // Emit final completion status
                    this.emitTransactionUpdate(transaction.user.id, completedOrder);
                    this.logger.log(`Order ${transaction.id} marked COMPLETED after successful payout`);
                } catch (payoutError) {
                    // Payout failed - mark order as failed
                    const failedOrder = await this.prisma.order.update({
                        where: { id: transaction.id },
                        data: {
                            status: OrderStatus.failed,
                            streamlinedStatus: OrderStreamlinedStatus.failed,
                            reason: `Payout failed: ${payoutError.message}`,
                        },
                    });

                    // Emit failure status so UI shows failed, not stuck on processing
                    this.emitTransactionUpdate(transaction.user.id, failedOrder);
                    this.logger.error(`Order ${transaction.id} marked FAILED due to payout error: ${payoutError.message}`);

                    // Send failure notification
                    await this.handleWithdrawalFailed(transaction);
                    return; // Don't proceed to handleWithdrawalDone
                }
            }
        }

        if (options.status == OrderStatus.done && transaction.orderCategory !== OrderCategory.SELL) {
            await this.handleWithdrawalDone(transaction);
        } else if (options.status == OrderStatus.failed) {
            await this.handleWithdrawalFailed(transaction);

            // Check if this failed withdrawal was for a BUY order
            const buyOrderMatch = transaction.transaction_note?.match(/^BUY:(\d+)$/);
            if (buyOrderMatch) {
                const buyOrderId = parseInt(buyOrderMatch[1], 10);
                await this.failBuyOrder(buyOrderId, transaction);
            }
        }
    }

    /**
     * Complete a BUY order when crypto has been successfully delivered to user
     */
    private async completeBuyOrder(buyOrderId: number, withdrawalTransaction: any) {
        this.logger.log(`Completing BUY order ${buyOrderId} - crypto delivered successfully`);

        const buyOrder = await this.prisma.order.findUnique({
            where: { id: buyOrderId },
            include: { user: { select: { id: true, email: true } } },
        });

        if (!buyOrder) {
            this.logger.error(`BUY order ${buyOrderId} not found for completion`);
            return;
        }

        // Update BUY order to completed
        await this.prisma.order.update({
            where: { id: buyOrderId },
            data: {
                status: OrderStatus.completed,
                streamlinedStatus: OrderStreamlinedStatus.completed,
            },
        });

        // Emit transaction update for the BUY order
        this.wsGateway.notifyTransactionUpdate(buyOrder.user.id, {
            type: "transaction_update",
            transaction: {
                id: buyOrder.id,
                transactionId: buyOrder.transactionId,
                status: OrderStatus.completed,
                streamlinedStatus: OrderStreamlinedStatus.completed,
                orderCategory: buyOrder.orderCategory,
                amount: buyOrder.amount,
                currency: buyOrder.currency,
                createdAt: buyOrder.createdAt,
                updatedAt: new Date(),
            },
        });

        // NOW send the BUY completion notification to user
        const message = this.notificationMessage.buyTransactionSuccess({
            amount: buyOrder.amount,
            currency: buyOrder.currency,
            transactionId: buyOrder.transactionId,
        });

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "Your purchase is complete",
                body: message,
                userId: buyOrder.user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: OrderCategory.BUY,
                currency: buyOrder.currency,
            },
        });

        this.notificationEvent.emit("transaction_notification", {
            email: buyOrder.user.email,
            notice: message,
            transactionType: 'buy',
            transactionId: buyOrder.transactionId,
            amount: String(buyOrder.amount),
            currency: buyOrder.currency.toUpperCase(),
            status: 'completed',
            date: new Date().toISOString(),
            walletAddress: buyOrder.recipient || '',
        });

        const notificationList = await this.prisma.notification.findMany({
            where: { userId: buyOrder.user.id },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        this.wsGateway.notifyUser(buyOrder.user.id, {
            type: "new_notification",
            notification: createdNotification,
            notificationList,
        });

        this.logger.log(`BUY order ${buyOrderId} completed and user notified`);
    }

    /**
     * Fail a BUY order when crypto delivery failed
     */
    private async failBuyOrder(buyOrderId: number, withdrawalTransaction: any) {
        this.logger.error(`FAILING BUY order ${buyOrderId} - crypto delivery failed`);

        const buyOrder = await this.prisma.order.findUnique({
            where: { id: buyOrderId },
            include: { user: { select: { id: true, email: true } } },
        });

        if (!buyOrder) {
            this.logger.error(`BUY order ${buyOrderId} not found for failure handling`);
            return;
        }

        // Update BUY order to failed
        await this.prisma.order.update({
            where: { id: buyOrderId },
            data: {
                status: OrderStatus.failed,
                streamlinedStatus: OrderStreamlinedStatus.failed,
                reason: "Crypto delivery failed - refund required",
            },
        });

        // Emit transaction update for the BUY order
        this.wsGateway.notifyTransactionUpdate(buyOrder.user.id, {
            type: "transaction_update",
            transaction: {
                id: buyOrder.id,
                transactionId: buyOrder.transactionId,
                status: OrderStatus.failed,
                streamlinedStatus: OrderStreamlinedStatus.failed,
                orderCategory: buyOrder.orderCategory,
                amount: buyOrder.amount,
                currency: buyOrder.currency,
                createdAt: buyOrder.createdAt,
                updatedAt: new Date(),
            },
        });

        this.logger.error(`BUY order ${buyOrderId} marked as failed - manual refund required`);
    }


    /**
     * Initiate fiat payout to seller - Nomba only
     */
    private async initiateFiatPayout(transaction: any) {
        const payoutReference = generateId({ type: "reference" });
        const payoutData = {
            accountName: transaction.destinationBankAccountName,
            accountNumber: transaction.destinationBankAccountNumber,
            amount: transaction.totalToReceiveInFiat,
            bankCode: transaction.destinationBankCode,
            bankName: transaction.destinationBankName,
            serviceCharge: 0,
            userId: transaction.userId,
            orderId: transaction.id,
            reference: payoutReference,
            senderName: "Resolve", // Platform name - required by Nomba v2
        };

        this.logger.log(
            `Initiating payout via Nomba | ${JSON.stringify({
                orderId: transaction.id,
                userId: transaction.userId,
                amount: transaction.totalToReceiveInFiat,
                accountNumber: transaction.destinationBankAccountNumber,
                reference: payoutReference,
            })}`
        );

        try {
            await this.nombaService.initializeTransfer(payoutData);
            this.logger.log(`✅ Nomba payout SUCCESS for order ${transaction.id}, ref: ${payoutReference}`);
        } catch (nombaError) {
            this.logger.error(
                `❌ Nomba payout FAILED | ${JSON.stringify({
                    orderId: transaction.id,
                    userId: transaction.userId,
                    error: nombaError.message,
                })}`
            );

            // Send Slack alert for payout failure
            await this.sendPayoutAlert({
                orderId: transaction.id,
                userId: transaction.userId,
                amount: transaction.totalToReceiveInFiat,
                accountNumber: transaction.destinationBankAccountNumber,
                bankName: transaction.destinationBankName,
                provider: "Nomba",
                error: nombaError.message,
                willRetryWithFincra: false,
                isCritical: true,
            });

            throw new Error(`Nomba payout failed for order ${transaction.id}: ${nombaError.message}`);
        }
    }

    /**
     * Send Slack alert for payout failures
     */
    private async sendPayoutAlert(data: {
        orderId: number;
        userId: number;
        amount: number;
        accountNumber: string;
        bankName: string;
        provider: string;
        error: string;
        willRetryWithFincra?: boolean;
        isCritical?: boolean;
    }) {
        try {
            if (!slackPayoutAlertWebhookUrl) {
                this.logger.warn("Slack webhook URL not configured - skipping payout alert");
                return;
            }

            const emoji = data.isCritical ? "🚨" : "⚠️";
            const status = data.isCritical
                ? "CRITICAL: ALL PAYOUT PROVIDERS FAILED"
                : data.willRetryWithFincra
                    ? "Nomba failed, trying Fincra..."
                    : `${data.provider} payout failed`;

            const message = {
                text: `${emoji} *Payout Alert*`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `${emoji} *${status}*`,
                        },
                    },
                    {
                        type: "section",
                        fields: [
                            { type: "mrkdwn", text: `*Order ID:*\n${data.orderId}` },
                            { type: "mrkdwn", text: `*User ID:*\n${data.userId}` },
                            { type: "mrkdwn", text: `*Amount:*\n₦${data.amount?.toLocaleString()}` },
                            { type: "mrkdwn", text: `*Bank:*\n${data.bankName}` },
                            { type: "mrkdwn", text: `*Account:*\n${data.accountNumber}` },
                            { type: "mrkdwn", text: `*Provider:*\n${data.provider}` },
                        ],
                    },
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Error:*\n\`\`\`${data.error}\`\`\``,
                        },
                    },
                ],
            };

            await fetch(slackPayoutAlertWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(message),
            });

            this.logger.log(`Slack payout alert sent for order ${data.orderId}`);
        } catch (slackError) {
            this.logger.error(`Failed to send Slack alert: ${slackError.message}`);
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
