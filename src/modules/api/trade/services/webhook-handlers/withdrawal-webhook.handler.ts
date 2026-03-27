import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";
import {
    TransactionCompletedException,
    TransactionNotFoundException,
} from "../../errors";
import {
    getStreamlinedStatus,
    WithdrawerTransactionHandlerOptions,
} from "../../interfaces/trade";
import {
    LedgerType,
    OrderCategory,
    OrderStatus,
    OrderStreamlinedStatus,
} from "@prisma/client";

import { generateId } from "@/utils";

import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { WalletAddressService } from "../wallet-address.service";
import { LedgerService } from "../ledger/ledger.service";
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
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly lockService: DistributedLockService,
        private readonly walletAddressService: WalletAddressService,
        private readonly ledgerService: LedgerService,
        private readonly notificationDispatcher: NotificationDispatcher
    ) { }

    /**
     * Retry a failed fiat payout for a SELL order.
     * Called by AdminTransactionService.
     */
    async retryFiatPayout(transactionId: number) {
        this.logger.log(`Retrying fiat payout for transaction ${transactionId}`);

        const transaction = await this.prisma.order.findUnique({
            where: { id: transactionId },
            include: {
                user: { select: { id: true, email: true, userType: true } },
            },
        });

        if (!transaction) {
            throw new TransactionNotFoundException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        // Strict concurrency/status check
        if (transaction.status === OrderStatus.done || transaction.streamlinedStatus === OrderStreamlinedStatus.completed) {
            throw new TransactionCompletedException("Transaction already completed", HttpStatus.CONFLICT);
        }

        if (transaction.orderCategory !== OrderCategory.SELL) {
            throw new Error("Only SELL orders can be retried via this method");
        }

        // Re-initiate payout
        try {
            await this.initiateFiatPayout(transaction);

            // Update to completed on success
            const completedOrder = await this.prisma.order.update({
                where: { id: transaction.id },
                data: {
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    fulfilled: true,
                },
            });
            this.emitTransactionUpdate(transaction.user.id, completedOrder);
            this.logger.log(`Retry payout SUCCESS for order ${transaction.id}`);
            return { success: true };

        } catch (error) {
            // Update to failed on error
            const failedOrder = await this.prisma.order.update({
                where: { id: transaction.id },
                data: {
                    status: OrderStatus.failed,
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                    reason: `Retry payout failed: ${error.message}`,
                },
            });
            this.emitTransactionUpdate(transaction.user.id, failedOrder);
            throw error;
        }
    }

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
        const transaction = await this.findTransactionOrSkip(options);
        if (!transaction) return;

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

        const updatedOrder = await this.updateOrderStatus(transaction, options);
        this.emitTransactionUpdate(transaction.user.id, updatedOrder);

        if (options.status === OrderStatus.done) {
            await this.handleDoneStatus(transaction);
        } else if (options.status === OrderStatus.failed) {
            await this.handleFailedStatus(transaction);
        } else if (options.status === OrderStatus.cancelled) {
            await this.handleCancelledStatus(transaction);
        }
    }

    /**
     * Find transaction by order reference, or return null for expected skip scenarios
     */
    private async findTransactionOrSkip(options: WithdrawerTransactionHandlerOptions) {
        const transaction = await this.prisma.order.findUnique({
            where: { orderReference: options.orderReference },
            include: {
                user: { select: { id: true, email: true, userType: true } },
            },
        });

        if (!transaction) {
            if (options.orderReference?.endsWith('_fulfill')) {
                this.logger.debug(
                    `Skipping withdrawal webhook for buy order fulfillment: ${options.orderReference}`
                );
                return null;
            }
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        return transaction;
    }

    /**
     * Update order status, handling SELL payout-pending intermediate state
     */
    private async updateOrderStatus(transaction: any, options: WithdrawerTransactionHandlerOptions) {
        const isSellPayoutPending = (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL &&
            !transaction.transaction_note?.match(/^BUY:\d+$/)
        );

        return this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: isSellPayoutPending ? OrderStatus.processing : options.status,
                streamlinedStatus: isSellPayoutPending
                    ? OrderStreamlinedStatus.pending
                    : getStreamlinedStatus(options.status),
                ...(options.txid && { blockchain_txid: options.txid }),
            },
        });
    }

    /**
     * Handle withdrawal done: settle SEND holds, complete SELL payouts, notify user
     */
    private async handleDoneStatus(transaction: any): Promise<void> {
        if (transaction.orderCategory === OrderCategory.SELL) {
            await this.handleSellOrderDone(transaction);
            return;
        }

        if (transaction.orderCategory === OrderCategory.SEND) {
            await this.settleOrReleaseSendHold(transaction, true);
        }
        await this.handleWithdrawalDone(transaction);
    }

    /**
     * Handle withdrawal failed: release SEND holds, fail linked BUY orders, refund SELL orders
     */
    private async handleFailedStatus(transaction: any): Promise<void> {
        if (transaction.orderCategory === OrderCategory.SEND) {
            await this.settleOrReleaseSendHold(transaction, false);
        }

        await this.handleWithdrawalFailed(transaction);

        const buyOrderMatch = transaction.transaction_note?.match(/^BUY:(\d+)$/);
        if (buyOrderMatch) {
            const buyOrderId = Number.parseInt(buyOrderMatch[1], 10);
            await this.failBuyOrder(buyOrderId, transaction);
        }

        if (transaction.orderCategory === OrderCategory.SELL && !buyOrderMatch) {
            this.logger.warn(`Regular SELL order ${transaction.id} withdrawal failed - initiating refund`);
            await this.refundSellOrder(transaction);
        }
    }

    /**
     * Handle withdrawal cancelled: release SEND holds, notify failure
     */
    private async handleCancelledStatus(transaction: any): Promise<void> {
        if (transaction.orderCategory === OrderCategory.SEND) {
            await this.settleOrReleaseSendHold(transaction, false);
        }

        await this.handleWithdrawalFailed(transaction);
    }

    /**
     * Handles sell order completion: either completes a linked BUY order
     * or initiates fiat payout to the seller.
     * Returns true if flow succeeded, false if payout failed (already handled).
     */
    private async handleSellOrderDone(transaction: any): Promise<boolean> {
        const buyOrderMatch = transaction.transaction_note?.match(/^BUY:(\d+)$/);
        if (buyOrderMatch) {
            const buyOrderId = Number.parseInt(buyOrderMatch[1], 10);
            await this.completeBuyOrder(buyOrderId, transaction);
            return true;
        }

        try {
            await this.initiateFiatPayout(transaction);

            const completedOrder = await this.prisma.order.update({
                where: { id: transaction.id },
                data: {
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    fulfilled: true,
                },
            });

            this.emitTransactionUpdate(transaction.user.id, completedOrder);

            const sellMessage = this.notificationMessage.sellTransactionSuccess({
                amount: transaction.amount,
                currency: transaction.currency,
                fiatAmount: transaction.totalToReceiveInFiat,
                bankName: transaction.destinationBankName || 'your bank',
                accountNumber: transaction.destinationBankAccountNumber || '',
                transactionId: transaction.transactionId,
            });

            await this.notificationDispatcher.notify({
                userId: transaction.user.id,
                title: "Sell order completed",
                body: sellMessage,
                category: "transaction",
                currency: transaction.currency,
                transactionType: OrderCategory.SELL,
                enableEmail: true,
                emailPayload: {
                    email: transaction.user.email,
                    transactionType: 'sell',
                    transactionId: transaction.transactionId,
                    amount: String(transaction.amount),
                    currency: transaction.currency.toUpperCase(),
                    status: 'completed',
                    date: new Date().toISOString(),
                    fiatAmount: String(transaction.totalToReceiveInFiat || ''),
                    bankName: transaction.destinationBankName || '',
                    accountNumber: transaction.destinationBankAccountNumber || '',
                },
                enablePush: true,
            });

            this.logger.log(`Order ${transaction.id} marked COMPLETED after successful payout`);
            return true;
        } catch (payoutError) {
            const failedOrder = await this.prisma.order.update({
                where: { id: transaction.id },
                data: {
                    status: OrderStatus.failed,
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                    reason: `Payout failed: ${payoutError.message}`,
                },
            });

            this.emitTransactionUpdate(transaction.user.id, failedOrder);
            this.logger.error(`Order ${transaction.id} marked FAILED due to payout error: ${payoutError.message}`);

            await this.handleWithdrawalFailed(transaction);
            await this.refundSellOrder(transaction);
            return false;
        }
    }

    /**
     * Settle or release hold for external SEND transactions.
     * - settle=true  -> convert HOLD to settled debit (successful send)
     * - settle=false -> release HOLD back to available balance (failed send)
     */
    private async settleOrReleaseSendHold(transaction: any, settle: boolean): Promise<void> {
        const holdReference = `withdrawal:${transaction.orderReference}`;

        try {
            if (settle) {
                const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
                    holdReference,
                    settle: true,
                    description: `Withdrawal ${transaction.orderReference} confirmed on-chain`,
                    createPlatformEntry: true,
                });

                if (!settleResult.success) {
                    this.logger.error(
                        `Failed to settle SEND hold for order ${transaction.id}: ${settleResult.error}`
                    );
                }
            } else {
                const releaseResult = await this.ledgerService.releaseHold(
                    holdReference,
                    false,
                    `Withdrawal ${transaction.orderReference} failed`
                );

                if (!releaseResult.success) {
                    this.logger.error(
                        `Failed to release SEND hold for order ${transaction.id}: ${releaseResult.error}`
                    );
                }
            }
        } catch (error) {
            this.logger.error(
                `Exception while ${settle ? "settling" : "releasing"} SEND hold for order ${transaction.id}: ${error.message}`,
                error.stack
            );
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

        await this.notificationDispatcher.notify({
            userId: buyOrder.user.id,
            title: "Your purchase is complete",
            body: message,
            category: "transaction",
            currency: buyOrder.currency,
            transactionType: OrderCategory.BUY,
            enableEmail: true,
            emailPayload: {
                email: buyOrder.user.email,
                transactionType: 'buy',
                transactionId: buyOrder.transactionId,
                amount: String(buyOrder.amount),
                currency: buyOrder.currency.toUpperCase(),
                status: 'completed',
                date: new Date().toISOString(),
                walletAddress: buyOrder.recipient || '',
            },
            enablePush: true,
        });

        this.logger.log(`BUY order ${buyOrderId} completed and user notified`);
    }

    /**
     * Refund a failed SELL order
     * Credits the total crypto amount back to the user's ledger
     */
    private async refundSellOrder(transaction: any) {
        this.logger.log(`Initiating refund for failed SELL order ${transaction.id}`);

        try {
            // We refund the full crypto amount that was debited (total = amount + fee)
            // Ideally transaction.total holds the total debited amount. 
            // In SellOrderService: total = totalCostInCrypto
            const refundAmount = transaction.total || transaction.amount;

            // DOUBLE ENTRY: pairedCredit ensures platform liability (debit) is created
            // This reverses the previous Paired Debit (User Debit, Platform Credit)
            // So we have User Credit, Platform Debit.
            const result = await this.ledgerService.pairedCredit({
                userId: transaction.userId,
                currency: transaction.currency.toUpperCase(),
                type: LedgerType.ADJUSTMENT, // Using ADJUSTMENT as REFUND is not available
                amount: refundAmount,
                reference: `refund:${transaction.orderReference}`,
                description: `Refund for failed sell order #${transaction.id}`,
                metadata: {
                    originalOrderId: transaction.id,
                    originalOrderReference: transaction.orderReference,
                    reason: "Sell order failed",
                },
                createPlatformEntry: true
            });

            if (result.success) {
                this.logger.log(`✅ Successfully refunded ${refundAmount} ${transaction.currency} to user ${transaction.userId} for order ${transaction.id}`);
            } else {
                this.logger.error(`❌ Failed to refund user ${transaction.userId} for order ${transaction.id}: ${result.error}`);
                // Critical: This means funds are still lost. We should probably alert admin specifically here.
                await this.sendPayoutAlert({
                    orderId: transaction.id,
                    userId: transaction.userId,
                    amount: refundAmount,
                    accountNumber: "N/A",
                    bankName: "N/A",
                    provider: "Internal Ledger",
                    error: `REFUND FAILED: ${result.error}`,
                    isCritical: true
                });
            }
        } catch (error) {
            this.logger.error(`❌ Exception during refund for order ${transaction.id}: ${error.message}`, error.stack);
            await this.sendPayoutAlert({
                orderId: transaction.id,
                userId: transaction.userId,
                amount: transaction.total,
                accountNumber: "N/A",
                bankName: "N/A",
                provider: "Internal Ledger",
                error: `REFUND EXCEPTION: ${error.message}`,
                isCritical: true
            });
        }
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

        // Send failure notification to user
        const message = this.notificationMessage.buyTransactionFailed({
            amount: buyOrder.amount,
            currency: buyOrder.currency,
            transactionId: buyOrder.transactionId,
            reason: "Crypto delivery failed",
        });

        await this.notificationDispatcher.notify({
            userId: buyOrder.user.id,
            title: "Buy order failed",
            body: message,
            category: "transaction",
            currency: buyOrder.currency,
            transactionType: OrderCategory.BUY,
            enableEmail: true,
            emailPayload: {
                email: buyOrder.user.email,
                transactionType: 'buy',
                transactionId: buyOrder.transactionId,
                amount: String(buyOrder.amount),
                currency: buyOrder.currency.toUpperCase(),
                status: 'failed',
                date: new Date().toISOString(),
            },
            enablePush: true,
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
            let status = `${data.provider} payout failed`;
            if (data.isCritical) {
                status = "CRITICAL: ALL PAYOUT PROVIDERS FAILED";
            } else if (data.willRetryWithFincra) {
                status = "Nomba failed, trying Fincra...";
            }

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

        await this.notificationDispatcher.notify({
            userId: transaction.user.id,
            title: "Your send transaction is done",
            body: message,
            category: "transaction",
            currency: transaction.currency,
            transactionType: transaction.orderCategory,
            enableEmail: true,
            emailPayload: {
                email: transaction.user.email,
                transactionType: 'withdrawal',
                transactionId: transaction.transactionId,
                amount: String(transaction.amount),
                currency: transaction.currency.toUpperCase(),
                status: 'completed',
                date: new Date().toISOString(),
                recipient: transaction.recipient || '',
                network: transaction.network || '',
            },
            enablePush: true,
        });
    }

    /**
     * Send withdrawal failed notification to user
     */
    private async sendWithdrawalFailedNotification(transaction: any) {
        const message = `Your send of ${transaction.amount} ${transaction.currency.toUpperCase()} failed. Transaction ID: ${transaction.transactionId}`;

        await this.notificationDispatcher.notify({
            userId: transaction.user.id,
            title: "Send transaction failed",
            body: message,
            category: "transaction",
            currency: transaction.currency,
            transactionType: transaction.orderCategory,
            enableEmail: true,
            emailPayload: {
                email: transaction.user.email,
                transactionType: 'withdrawal',
                transactionId: transaction.transactionId,
                amount: String(transaction.amount),
                currency: transaction.currency.toUpperCase(),
                status: 'failed',
                date: new Date().toISOString(),
                recipient: transaction.recipient || '',
                network: transaction.network || '',
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
