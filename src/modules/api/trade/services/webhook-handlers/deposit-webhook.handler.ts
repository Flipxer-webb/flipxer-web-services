import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import {
    DepositTransaction,
    getStreamlinedStatus,
} from "../../interfaces/trade";
import {
    LedgerType,
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    SweepStatus,
    UserNotificationTarget,
} from "@prisma/client";
import { generateId } from "@/utils";
import { NotificationEvent } from "../../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { WalletAddressService } from "../wallet-address.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "../ledger/ledger.service";
import {
    DEFAULT_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
    EXTENDED_TRANSACTION_TIMEOUT_MS,
} from "../../constants";

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
        private readonly ledgerService: LedgerService
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
            // Check if this deposit is the result of a BUY order completion
            // If so, skip creating a duplicate RECEIVE entry
            const isBuyRelated = await this.isBuyOrderRelatedDeposit(user.id, options);
            if (isBuyRelated) {
                this.logger.log(
                    `Skipping RECEIVE order creation - deposit is from BUY order | ${JSON.stringify({
                        userId: user.id,
                        currency: options.currency,
                        amount: options.amount,
                        recipient: options.recipient,
                    })}`
                );
                // Still sync wallet and update balances
                if (options.status === OrderStatus.accepted) {
                    await this.handleDepositAccepted(user, options, `buy-deposit-${options.referenceId}`);
                }
                return buildResponse({
                    message: "Deposit processed (linked to BUY order, no duplicate RECEIVE created)",
                });
            }
            return this.createNewDepositTransaction(user, options);
        } else {
            return this.updateExistingDepositTransaction(user, transaction, options);
        }
    }

    /**
     * Check if a deposit is the result of a BUY order completion
     * This prevents duplicate RECEIVE entries when user buys crypto
     * 
     * Detection strategy:
     * 1. PRIMARY: Check if there's a fulfilled BUY order for this user/currency (deterministic)
     * 2. FALLBACK: Address matching for orders not yet marked fulfilled
     * 3. FALLBACK: Amount-based matching within tolerance
     */
    private async isBuyOrderRelatedDeposit(userId: number, options: DepositTransaction): Promise<boolean> {
        // Extend time window to 2 hours to account for slow blockchain confirmations
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const depositAmount = parseFloat(options.amount);
        const depositAddress = options.recipient?.toLowerCase();

        // Strategy 1 (PRIMARY): Check for fulfilled BUY orders
        // This is the most reliable - if a BUY order is marked fulfilled, skip deposit
        const fulfilledBuyOrder = await this.prisma.order.findFirst({
            where: {
                userId: userId,
                orderCategory: OrderCategory.BUY,
                currency: options.currency.toUpperCase(),
                fulfilled: true,
                createdAt: {
                    gte: twoHoursAgo,
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (fulfilledBuyOrder) {
            this.logger.log(
                `Found related BUY order (fulfilled flag) | ${JSON.stringify({
                    buyOrderId: fulfilledBuyOrder.id,
                    transactionId: fulfilledBuyOrder.transactionId,
                    currency: options.currency,
                })}`
            );
            return true;
        }

        // Check for SWAP orders (internal buy leg creates deposit to user)
        // The swap service handles the entire flow atomically, so we skip duplicate deposits
        // Strategy 1: Check by toCurrency field
        const swapOrderByToCurrency = await this.prisma.order.findFirst({
            where: {
                userId: userId,
                orderCategory: OrderCategory.SWAP,
                toCurrency: options.currency.toUpperCase(),
                status: { in: [OrderStatus.processing, OrderStatus.completed] },
                createdAt: { gte: twoHoursAgo },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (swapOrderByToCurrency) {
            this.logger.log(
                `Skipping deposit - related to SWAP order (toCurrency match) | ${JSON.stringify({
                    swapOrderId: swapOrderByToCurrency.id,
                    transactionId: swapOrderByToCurrency.transactionId,
                    toCurrency: options.currency,
                })}`
            );
            return true;
        }

        // Strategy 2: Check by narration pattern and amount (fallback for orders without toCurrency)
        const swapOrderByNarration = await this.prisma.order.findFirst({
            where: {
                userId: userId,
                orderCategory: OrderCategory.SWAP,
                narration: { contains: `-> ${options.currency.toUpperCase()}` },
                status: { in: [OrderStatus.processing, OrderStatus.completed] },
                createdAt: { gte: twoHoursAgo },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (swapOrderByNarration) {
            // Verify amount matches within 1% tolerance
            const swapToAmount = swapOrderByNarration.toAmount || 0;
            const percentDiff = swapToAmount > 0
                ? Math.abs(swapToAmount - depositAmount) / swapToAmount * 100
                : 100;

            if (percentDiff <= 1) {
                this.logger.log(
                    `Skipping deposit - related to SWAP order (narration match) | ${JSON.stringify({
                        swapOrderId: swapOrderByNarration.id,
                        transactionId: swapOrderByNarration.transactionId,
                        narration: swapOrderByNarration.narration,
                        swapToAmount,
                        depositAmount,
                    })}`
                );
                return true;
            }
        }

        // Strategy 2 & 3: Fall back to heuristics for orders not yet fulfilled
        // (handles race condition where deposit arrives before fulfillBuyOrder completes)
        const recentBuyOrders = await this.prisma.order.findMany({
            where: {
                userId: userId,
                orderCategory: OrderCategory.BUY,
                currency: options.currency.toUpperCase(),
                fulfilled: false, // Only check non-fulfilled orders
                status: {
                    in: [OrderStatus.pending, OrderStatus.processing, OrderStatus.confirmed, OrderStatus.done, OrderStatus.completed],
                },
                createdAt: {
                    gte: twoHoursAgo,
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (recentBuyOrders.length === 0) {
            return false;
        }

        // Strategy 2: Check if deposit address matches any BUY order's recipient
        if (depositAddress) {
            for (const buyOrder of recentBuyOrders) {
                const orderRecipient = buyOrder.recipient?.toLowerCase();
                if (orderRecipient && orderRecipient === depositAddress) {
                    this.logger.log(
                        `Found related BUY order (address match) | ${JSON.stringify({
                            buyOrderId: buyOrder.id,
                            transactionId: buyOrder.transactionId,
                            depositAddress: depositAddress,
                            currency: options.currency,
                        })}`
                    );
                    return true;
                }
            }
        }

        // Strategy 3: Fall back to amount-based matching (within 30% tolerance)
        for (const buyOrder of recentBuyOrders) {
            const buyAmount = buyOrder.amount || 0;
            const amountDiff = Math.abs(buyAmount - depositAmount);
            const percentDiff = buyAmount > 0 ? (amountDiff / buyAmount) * 100 : 100;

            if (percentDiff <= 30) {
                this.logger.log(
                    `Found related BUY order (amount match) | ${JSON.stringify({
                        buyOrderId: buyOrder.id,
                        transactionId: buyOrder.transactionId,
                        buyAmount: buyAmount,
                        depositAmount: depositAmount,
                        percentDiff: percentDiff.toFixed(2),
                        currency: options.currency,
                    })}`
                );
                return true;
            }
        }

        // No match found - log for debugging
        this.logger.debug(
            `No related BUY order found for deposit | ${JSON.stringify({
                userId: userId,
                depositAmount: depositAmount,
                depositAddress: depositAddress,
                currency: options.currency,
                recentBuyOrderCount: recentBuyOrders.length,
            })}`
        );

        return false;
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

        // Credit user's ledger with deposit amount
        // sweepStatus = PENDING means user can't withdraw until sweep confirms
        const creditResult = await this.ledgerService.credit({
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
            sweepStatus: SweepStatus.PENDING, // Block withdrawal until sweep confirms
        });

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
            `Deposit credited to ledger | ${JSON.stringify({
                userId: user.id,
                currency: currency,
                amount: depositAmount,
                ledgerEntryId: creditResult.entry?.id,
                balanceAfter: creditResult.entry?.balanceAfter.toString(),
                sweepStatus: SweepStatus.PENDING,
            })}`
        );

        // Link ledger entry to the order
        if (creditResult.entry) {
            await this.prisma.order.updateMany({
                where: { transactionId: transactionId },
                data: { ledgerEntryId: creditResult.entry.id },
            });
        }

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

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "You've received a new payment",
                body: message,
                userId: user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: OrderCategory.RECEIVE,
                currency: options.currency.toUpperCase(),
            },
        });

        this.notificationEvent.emit("transaction_notification", {
            email: user.email,
            notice: message,
            transactionType: 'deposit',
            transactionId: transactionId,
            amount: String(options.amount),
            currency: options.currency.toUpperCase(),
            status: 'completed',
            date: new Date().toISOString(),
            txHash: options.txid || '',
            network: options.network || '',
            walletAddress: options.payment_address || '',
        });

        const notificationList = await this.prisma.notification.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        this.wsGateway.notifyUser(user.id, {
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
