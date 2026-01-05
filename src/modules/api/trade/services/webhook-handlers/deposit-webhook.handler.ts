import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import {
    DepositTransaction,
    getStreamlinedStatus,
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
        private readonly walletAddressService: WalletAddressService
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
        const paymentAddress = await this.prisma.cryptoWalletAddress.findUnique({
            where: { walletAddressId: options.payment_address_id },
            select: {
                id: true,
                userId: true,
                assetSymbol: true,
                network: true,
                address: true,
            },
        });

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
            // Log mismatch but still process - Quidax user ID is the source of truth
            this.logger.warn(
                `Payment address userId mismatch, using Quidax userId | ${JSON.stringify({
                    paymentAddressUserId: paymentAddress.userId,
                    quidaxUserId: user.id,
                    payment_address_id: options.payment_address_id,
                })}`
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
     * 1. First, check if the deposit address matches any recent BUY order's recipient (most reliable)
     * 2. Fall back to amount-based matching within tolerance
     */
    private async isBuyOrderRelatedDeposit(userId: number, options: DepositTransaction): Promise<boolean> {
        // Extend time window to 2 hours to account for slow blockchain confirmations
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const depositAmount = parseFloat(options.amount);
        const depositAddress = options.recipient?.toLowerCase();

        // Find BUY orders that match currency and are recent
        // Include multiple statuses to catch orders at different stages of processing
        const recentBuyOrders = await this.prisma.order.findMany({
            where: {
                userId: userId,
                orderCategory: OrderCategory.BUY,
                currency: options.currency.toUpperCase(),
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

        // Strategy 1: Check if deposit address matches any BUY order's recipient
        // This is the most reliable method
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

        // Strategy 2: Fall back to amount-based matching
        // Check if any BUY order has a close amount match (within 30% tolerance for fees)
        for (const buyOrder of recentBuyOrders) {
            const buyAmount = buyOrder.amount || 0;
            const amountDiff = Math.abs(buyAmount - depositAmount);
            const percentDiff = buyAmount > 0 ? (amountDiff / buyAmount) * 100 : 100;

            // If amounts are within 30% of each other, consider it a match
            // Increased from 25% to 30% to account for high network fees on small orders
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
     * Handle deposit accepted - update wallet balance and send notifications
     * Uses a database transaction to ensure atomicity of wallet balance update
     */
    private async handleDepositAccepted(
        user: any,
        options: DepositTransaction,
        transactionId: string
    ) {
        // Update user's wallet balance atomically
        const walletUpdated = await this.prisma.$transaction(
            async (tx) => {
                const assetWallet = await tx.assetWallet.findUnique({
                    where: {
                        userId_assetCurrency: {
                            userId: user.id,
                            assetCurrency: options.currency.toUpperCase(),
                        },
                    },
                });

                if (!assetWallet) {
                    return false;
                }

                const currentBalance = parseFloat(assetWallet.balance.toString());
                const depositAmount = parseFloat(options.amount);
                const newBalance = (currentBalance + depositAmount).toString();

                await tx.assetWallet.update({
                    where: { id: assetWallet.id },
                    data: { balance: newBalance },
                });

                this.logger.log(
                    `Wallet balance updated | ${JSON.stringify({
                        userId: user.id,
                        currency: options.currency,
                        oldBalance: assetWallet.balance.toString(),
                        depositAmount: options.amount,
                        newBalance: newBalance,
                    })}`
                );

                return true;
            },
            { maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS, timeout: EXTENDED_TRANSACTION_TIMEOUT_MS }
        );

        if (walletUpdated) {
            // Sync wallet with Quidax to ensure balance is up to date (outside transaction)
            await this.walletAddressService.syncWallet(user.id, options.currency);
        }

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
        const marketSymbol = `${assetCurrency}${referenceCurrency}`;
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
