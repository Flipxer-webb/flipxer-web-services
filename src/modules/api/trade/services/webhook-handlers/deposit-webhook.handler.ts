import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import {
    DepositTransaction,
    getStreamlinedStatus,
} from "../../interfaces/trade";
import {
    LedgerType,
    OrderCategory,
    OrderStatus,
    Prisma,
    SweepStatus,
    User,
} from "@prisma/client";
import { generateId } from "@/utils";
import { NotificationEvent } from "../../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { WalletAddressService } from "../wallet-address.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "../ledger/ledger.service";
import { DepositReviewService } from "../ledger/deposit-review.service";
import { Decimal } from "@prisma/client/runtime/library";
import {
    DEFAULT_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
    EXTENDED_TRANSACTION_TIMEOUT_MS,
} from "../../constants";
import { TransactionMonitorService } from "../ledger/transaction-monitor.service";

/**
 * Deposit Webhook Handler
 * 
 * Handles incoming crypto deposit webhooks from Quidax.
 * Processes both new deposits and status updates to existing deposits.
 */
@Injectable()
export class DepositWebhookHandler {
    private readonly logger = new Logger("DepositWebhookHandler");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly notificationEvent: NotificationEvent,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly lockService: DistributedLockService,
        private readonly walletAddressService: WalletAddressService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly transactionMonitor: TransactionMonitorService,
        private readonly ledgerService: LedgerService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly depositReviewService: DepositReviewService
    ) { }

    /**
     * Handle incoming deposit webhook from Quidax
     * Uses distributed lock to prevent duplicate processing
     */
    async handle(options: DepositTransaction) {
        const lockKey = `deposit:${options.referenceId}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () => this.processDeposit(options),
                { ttlMs: DEFAULT_TRANSACTION_TIMEOUT_MS, maxWaitMs: DEFAULT_TRANSACTION_MAX_WAIT_MS }
            );
        } catch (error) {
            if (error.message?.includes("Failed to acquire lock")) {
                this.logger.warn(
                    `Skipping duplicate deposit processing | ${JSON.stringify({
                        referenceId: options.referenceId,
                        reason: "Could not acquire lock - likely duplicate webhook",
                    })}`
                );
                return buildResponse({
                    message: "Deposit already being processed",
                });
            }
            throw error;
        }
    }

    /**
     * Internal method to process deposit - called within a distributed lock
     */
    private async processDeposit(options: DepositTransaction) {
        const user = await this.prisma.user.findUnique({
            where: { cryptoSubAccountId: options.quidaxUserId },
        });

        if (!user) {
            this.logger.debug(
                `Skipping deposit for non-user wallet (likely main account) | ${JSON.stringify({
                    quidaxUserId: options.quidaxUserId,
                    referenceId: options.referenceId,
                })}`
            );
            return buildResponse({
                message: "Skipped - User not found (likely main account)",
            });
        }

        // Try to find payment address in our database (optional - for logging)
        let paymentAddress = null;
        if (options.payment_address_id) {
            paymentAddress = await this.prisma.cryptoWalletAddress.findUnique({
                where: { walletAddressId: options.payment_address_id },
                select: {
                    id: true,
                    userId: true,
                    assetSymbol: true,
                    network: true,
                    address: true,
                },
            });
        }

        // Log if payment address not found but continue processing
        // The Quidax userId is the source of truth for deposit ownership
        if (!paymentAddress) {
            this.logger.warn(
                `Payment address not found in database, proceeding with deposit | ${JSON.stringify({
                    payment_address_id: options.payment_address_id,
                    network: options.network,
                    currency: options.currency,
                    amount: options.amount,
                    userId: user.id,
                })}`
            );
        } else if (paymentAddress.userId !== user.id) {
            // SECURITY: Payment address belongs to different user - reject and alert
            const alertMessage = [
                `🚨 *SECURITY ALERT: Payment Address Mismatch*`,
                ``,
                `A deposit was received to an address belonging to a different user.`,
                ``,
                `*Deposit Details:*`,
                `• Amount: ${options.amount} ${options.currency}`,
                `• Reference: ${options.referenceId}`,
                `• Network: ${options.network || "N/A"}`,
                ``,
                `*User Mismatch:*`,
                `• Payment Address Owner: User #${paymentAddress.userId}`,
                `• Quidax Sub-Account Owner: User #${user.id}`,
                `• Address ID: ${options.payment_address_id}`,
                ``,
                `⚠️ *Action Required*: Manual investigation needed. Deposit has been rejected.`,
            ].join("\n");

            this.logger.error(
                `SECURITY: Payment address userId mismatch - REJECTING deposit | ${JSON.stringify({
                    paymentAddressUserId: paymentAddress.userId,
                    quidaxUserId: user.id,
                    payment_address_id: options.payment_address_id,
                    amount: options.amount,
                    currency: options.currency,
                })}`
            );

            // Send Slack alert
            try {
                await this.slackWebhookService.sendAlert(
                    "SECURITY_ALERT",
                    { text: alertMessage },
                    { alertKey: `deposit-mismatch:${options.referenceId}` }
                );
            } catch (alertError) {
                this.logger.error(`Failed to send security alert: ${alertError.message}`);
            }

            throw new HttpException(
                "Rejected - Payment address owner mismatch",
                HttpStatus.FORBIDDEN
            );
        }

        this.logger.log(
            `Processing deposit | ${JSON.stringify({
                userId: user.id,
                currency: options.currency,
                amount: options.amount,
                network: options.network,
                paymentAddressId: options.payment_address_id,
                status: options.status,
            })}`
        );

        const transaction = await this.prisma.order.findUnique({
            where: { providerOrderId: options.referenceId },
        });

        if (!transaction) {
            // All Quidax deposit webhooks are external deposits - credit the user
            // Note: BUY/SELL/SWAP are purely ledger-based and never trigger Quidax webhooks
            return this.createNewDepositTransaction(user, options);
        } else {
            return this.updateExistingDepositTransaction(user, transaction, options);
        }
    }

    /**
     * Create a new deposit transaction record
     */
    private async createNewDepositTransaction(user: any, options: DepositTransaction) {
        const amtFiat = await this.getAmountInNaira(
            options.currency,
            Number(options.amount),
            "buy"
        );

        const transactionId = generateId({ type: "transaction" });

        // Use the original deposit timestamp from Quidax
        const depositCreatedAt = options.created_at ? new Date(options.created_at) : new Date();
        const depositCompletedAt = options.done_at ? new Date(options.done_at) : null;

        const createdOrder = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.RECEIVE,
                status: options.status,
                transactionId: transactionId,
                streamlinedStatus: getStreamlinedStatus(options.status),
                providerOrderId: options.referenceId,
                blockchain_txid: options.txid,
                userId: user.id,
                currency: options.currency.toUpperCase(),
                reason: options.reason,
                recipient: options.recipient,
                sender: options.payment_address,
                amount: +options.amount,
                fee: +options.fee,
                sourceType: options.type,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
                createdAt: depositCreatedAt,
                updatedAt: depositCompletedAt || depositCreatedAt,
            },
        });

        // Emit transaction update immediately
        this.emitTransactionUpdate(user.id, createdOrder);

        if (options.status == OrderStatus.accepted) {
            await this.handleDepositAccepted(user, options, transactionId);
        }

        return buildResponse({
            message: "Deposit transaction logged successfully",
        });
    }

    /**
     * Update an existing deposit transaction
     */
    private async updateExistingDepositTransaction(
        user: any,
        transaction: any,
        options: DepositTransaction
    ) {
        const updatedOrder = await this.prisma.order.update({
            where: { id: transaction.id },
            data: {
                status: options.status,
                streamlinedStatus: getStreamlinedStatus(options.status),
            },
        });

        // Emit transaction update for existing transaction status change
        this.emitTransactionUpdate(user.id, updatedOrder);

        if (options.status == OrderStatus.accepted && transaction.status !== OrderStatus.accepted) {
            await this.handleDepositAccepted(user, options, transaction.transactionId);
        }

        return buildResponse({
            message: "Deposit transaction logged successfully",
        });
    }

    /**
     * Handle deposit accepted - credit user's ledger and send notifications
     * 
     * NEW VIRTUAL BALANCE FLOW:
     * 1. Credit user's ledger (instead of updating assetWallet)
     * 2. Set sweepStatus = PENDING (user can't withdraw until sweep confirms)
     * 3. Link ledger entry to the order
     * 4. Sweep will be processed by SweepService cron
     */
    private async handleDepositAccepted(
        user: any,
        options: DepositTransaction,
        transactionId: string
    ) {
        const depositAmount = parseFloat(options.amount);
        const currency = options.currency.toUpperCase();

        // Phase 4: Check float threshold before crediting
        const floatCheck = await this.depositReviewService.checkAndQueueIfNeeded(
            user.id,
            currency,
            new Decimal(depositAmount),
            options.payment_address || options.recipient || "unknown",
            options.txid
        );

        if (!floatCheck.allowed && floatCheck.queued) {
            // Deposit queued for review - don't credit yet
            this.logger.warn(
                `Deposit queued for float review | ${JSON.stringify({
                    userId: user.id,
                    currency,
                    amount: depositAmount,
                    floatPercentage: floatCheck.floatPercentage,
                    queueId: floatCheck.queueId,
                })}`
            );

            // Update order status to show deposit is pending review
            await this.prisma.order.updateMany({
                where: { transactionId: transactionId },
                data: {
                    status: OrderStatus.pending,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
                    reason: floatCheck.reason,
                },
            });

            // Send user notification about pending review
            await this.sendDepositQueuedNotification(user, options, transactionId, floatCheck.reason || "Deposit pending review");

            return; // Don't credit until admin approves
        }

        // TASK-005: Atomic credit and order link
        // Credit user's ledger and link to order in a single atomic transaction
        // This prevents orphaned ledger entries if the order update fails
        //
        // Sweep status logic:
        //   - Users WITH cryptoSubAccountId: deposits go to per-user sub-accounts
        //     and need sweeping to the main wallet → PENDING
        //   - Users WITHOUT cryptoSubAccountId (omnibus mode): deposits go directly
        //     to shared addresses, nothing to sweep → NOT_APPLICABLE
        const sweepStatus = user.cryptoSubAccountId
            ? SweepStatus.PENDING
            : SweepStatus.NOT_APPLICABLE;

        const creditResult = await this.prisma.$transaction(
            async (tx) => {
                // Credit user's ledger with deposit amount using transaction client
                // DOUBLE ENTRY: pairedCredit ensures platform liability (debit) is created
                const result = await this.ledgerService.pairedCreditInTransaction(tx, {
                    userId: user.id,
                    currency: currency,
                    amount: depositAmount,
                    type: LedgerType.DEPOSIT,
                    reference: `deposit:${options.referenceId}`,
                    metadata: {
                        txid: options.txid,
                        paymentAddress: options.payment_address,
                        recipient: options.recipient,
                        network: options.network,
                        fee: options.fee,
                        providerOrderId: options.referenceId,
                        transactionId: transactionId,
                    },
                    sweepStatus: sweepStatus,
                    createPlatformEntry: true // Explicitly create platform debit
                });

                if (!result.success) {
                    throw new Error(result.error || 'Ledger credit failed');
                }

                // Link ledger entry to the order atomically
                if (result.userEntry) {
                    await tx.order.updateMany({
                        where: { transactionId: transactionId },
                        data: { ledgerEntryId: result.userEntry.id },
                    });
                }

                return result;
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
            }
        );

        if (!creditResult.success) {
            this.logger.error(
                `Failed to credit ledger for deposit | ${JSON.stringify({
                    userId: user.id,
                    currency: currency,
                    amount: depositAmount,
                    error: creditResult.error,
                })}`
            );
            // Don't throw - the order is already created, log for investigation
            await this.slackWebhookService.sendAlert(
                "DEPOSIT_LEDGER_FAILED",
                {
                    text: `⚠️ Failed to credit ledger for deposit!\n` +
                        `User: ${user.id} (${user.email})\n` +
                        `Amount: ${depositAmount} ${currency}\n` +
                        `Transaction: ${transactionId}\n` +
                        `Error: ${creditResult.error}`,
                },
                { alertKey: `deposit-ledger-fail:${options.referenceId}` }
            );
            return;
        }

        this.logger.log(
            `Deposit credited to ledger (atomic) | ${JSON.stringify({
                userId: user.id,
                currency: currency,
                amount: depositAmount,
                ledgerEntryId: creditResult.userEntry?.id,
                balanceAfter: creditResult.userEntry?.balanceAfter.toString(),
                platformEntryId: creditResult.platformEntry?.id,
                sweepStatus: sweepStatus,
            })}`
        );

        // NOTE: AssetWallet balance updates removed - Ledger is now the source of truth

        // Send notifications (outside transaction - not critical for data integrity)
        await this.sendDepositNotification(user, options, transactionId);

        // Emit wallet update after deposit
        this.wsGateway.notifyWalletUpdate(user.id);
    }


    /**
     * Send deposit notification to user
     */
    private async sendDepositNotification(
        user: any,
        options: DepositTransaction,
        transactionId: string
    ) {
        const message = this.notificationMessage.receiveTransaction({
            amount: +options.amount,
            currency: options.currency.toUpperCase(),
            transactionId: transactionId,
            sender: options.payment_address,
        });

        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "You've received a new payment",
            body: message,
            currency: options.currency.toUpperCase(),
            transactionType: OrderCategory.RECEIVE,
            enableEmail: true,
            emailPayload: {
                email: user.email,
                transactionType: 'deposit',
                transactionId: transactionId,
                amount: String(options.amount),
                currency: options.currency.toUpperCase(),
                status: 'completed',
                date: new Date().toISOString(),
                txHash: options.txid || '',
                network: options.network || '',
                walletAddress: options.payment_address || '',
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

    /**
     * Send notification when deposit is queued for float review
     */
    private async sendDepositQueuedNotification(
        user: any,
        options: DepositTransaction,
        transactionId: string,
        reason: string
    ) {
        const message = `Your deposit of ${options.amount} ${options.currency.toUpperCase()} is pending review. ${reason}`;

        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Deposit Pending Review",
            body: message,
            currency: options.currency.toUpperCase(),
            transactionType: OrderCategory.RECEIVE,
            enablePush: true,
        });

        // Emit wallet update to refresh UI
        this.wsGateway.notifyWalletUpdate(user.id);
    }

    /**
     * Get amount in Naira based on current exchange rate
     */
    private async getAmountInNaira(
        asset: string,
        amount: number,
        rateType: "buy" | "sell" | "last" = "buy"
    ): Promise<{ amount?: number; rate?: number } | null> {
        const referenceCurrency = "ngn";
        const assetCurrency = asset.toLowerCase();
        const marketSymbol = `${assetCurrency}${referenceCurrency} `;
        const marketData = await this.quidaxService.getSingleMarketTicker(marketSymbol);

        const ticker = marketData.data?.ticker;
        if (!ticker) return null;

        const rate = parseFloat(ticker[rateType]);
        if (isNaN(rate)) return null;

        return {
            amount: amount * rate,
            rate: rate,
        };
    }
}
