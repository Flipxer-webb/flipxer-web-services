import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import {
    TransactionCompletedException,
    TransactionNotFoundException,
} from "../errors";
import {
    DepositTransaction,
    getStreamlinedStatus,
    SwapTransactionHandlerOptions,
    WithdrawerTransactionHandlerOptions,
} from "../interfaces/trade";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    UserNotificationTarget,
} from "@prisma/client";
import { generateId } from "@/utils";
import { NotificationEvent } from "../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../gateway/v1";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import {
    DEFAULT_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
} from "../constants";

/**
 * WebhookHandlerService
 * 
 * Handles webhook callbacks from Quidax for:
 * - Deposit transactions (incoming crypto)
 * - Swap transactions (crypto-to-crypto)
 * - Withdrawal transactions (outgoing crypto)
 * 
 * Each handler uses distributed locks to prevent race conditions
 * from duplicate webhook deliveries.
 */
@Injectable()
export class WebhookHandlerService {
    private readonly logger = new Logger("WebhookHandlerService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        private readonly notificationEvent: NotificationEvent,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        private readonly lockService: DistributedLockService,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService
    ) {}

    // =========================================================================
    // DEPOSIT HANDLER
    // =========================================================================

    /**
     * Handle incoming deposit webhook from Quidax
     * Uses distributed lock to prevent duplicate processing
     */
    async depositHandler(options: DepositTransaction) {
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
            this.logger.error(
                `User not found for deposit | ${JSON.stringify({
                    quidaxUserId: options.quidaxUserId,
                    referenceId: options.referenceId,
                })}`
            );
            return buildResponse({
                message: "User not found for deposit transaction",
            });
        }

        // Try to find payment address in our database (optional - for logging)
        const paymentAddress = await this.prisma.cryptoWalletAddress.findUnique(
            {
                where: { walletAddressId: options.payment_address_id },
                select: {
                    id: true,
                    userId: true,
                    assetSymbol: true,
                    network: true,
                    address: true,
                },
            }
        );

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
        this.wsGateway.notifyTransactionUpdate(user.id, {
            type: "transaction_update",
            transaction: {
                id: createdOrder.id,
                transactionId: createdOrder.transactionId,
                status: createdOrder.status,
                streamlinedStatus: createdOrder.streamlinedStatus,
                orderCategory: createdOrder.orderCategory,
                amount: createdOrder.amount,
                currency: createdOrder.currency,
                createdAt: createdOrder.createdAt,
                updatedAt: createdOrder.updatedAt,
            },
        });

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
        this.wsGateway.notifyTransactionUpdate(user.id, {
            type: "transaction_update",
            transaction: {
                id: updatedOrder.id,
                transactionId: updatedOrder.transactionId,
                status: updatedOrder.status,
                streamlinedStatus: updatedOrder.streamlinedStatus,
                orderCategory: updatedOrder.orderCategory,
                amount: updatedOrder.amount,
                currency: updatedOrder.currency,
                createdAt: updatedOrder.createdAt,
                updatedAt: updatedOrder.updatedAt,
            },
        });

        if (options.status == OrderStatus.accepted && transaction.status !== OrderStatus.accepted) {
            await this.handleDepositAccepted(user, options, transaction.transactionId);
        }

        return buildResponse({
            message: "Deposit transaction logged successfully",
        });
    }

    /**
     * Handle deposit accepted - update wallet balance and send notifications
     */
    private async handleDepositAccepted(
        user: any,
        options: DepositTransaction,
        transactionId: string
    ) {
        // Update user's wallet balance
        const assetWallet = await this.prisma.assetWallet.findUnique({
            where: {
                userId_assetCurrency: {
                    userId: user.id,
                    assetCurrency: options.currency.toUpperCase(),
                },
            },
        });

        if (assetWallet) {
            const currentBalance = parseFloat(assetWallet.balance.toString());
            const depositAmount = parseFloat(options.amount);
            const newBalance = (currentBalance + depositAmount).toString();

            await this.prisma.assetWallet.update({
                where: { id: assetWallet.id },
                data: { balance: newBalance },
            });

            // Sync wallet with Quidax to ensure balance is up to date
            await this.syncWallet(user.id, options.currency);

            this.logger.log(
                `Wallet balance updated | ${JSON.stringify({
                    userId: user.id,
                    currency: options.currency,
                    oldBalance: assetWallet.balance.toString(),
                    depositAmount: options.amount,
                    newBalance: newBalance,
                })}`
            );
        }

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

        // Emit wallet update after deposit
        this.wsGateway.notifyWalletUpdate(user.id);
    }

    // =========================================================================
    // SWAP TRANSACTION HANDLER
    // =========================================================================

    /**
     * Handle swap transaction webhook from Quidax
     * Uses distributed lock to prevent duplicate processing
     */
    async swapTransactionHandler(options: SwapTransactionHandlerOptions) {
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
            include: { user: true },
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
        this.wsGateway.notifyTransactionUpdate(transaction.user.id, {
            type: "transaction_update",
            transaction: {
                id: updatedOrder.id,
                transactionId: updatedOrder.transactionId,
                status: updatedOrder.status,
                streamlinedStatus: updatedOrder.streamlinedStatus,
                orderCategory: updatedOrder.orderCategory,
                amount: updatedOrder.amount,
                currency: updatedOrder.currency,
                createdAt: updatedOrder.createdAt,
                updatedAt: updatedOrder.updatedAt,
            },
        });

        if (options.status == OrderStatus.completed) {
            // Sync both wallets involved in the swap
            await Promise.all([
                this.syncWallet(transaction.user.id, transaction.fromCurrency),
                this.syncWallet(transaction.user.id, transaction.toCurrency),
            ]);

            // Emit wallet update after sync
            this.wsGateway.notifyWalletUpdate(transaction.user.id);

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
    }

    // =========================================================================
    // WITHDRAWAL TRANSACTION HANDLER
    // =========================================================================

    /**
     * Handle withdrawal transaction webhook from Quidax
     * Uses distributed lock to prevent duplicate processing
     */
    async withdrawerTransactionHandler(options: WithdrawerTransactionHandlerOptions) {
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
        this.wsGateway.notifyTransactionUpdate(transaction.user.id, {
            type: "transaction_update",
            transaction: {
                id: updatedOrder.id,
                transactionId: updatedOrder.transactionId,
                status: updatedOrder.status,
                streamlinedStatus: updatedOrder.streamlinedStatus,
                orderCategory: updatedOrder.orderCategory,
                amount: updatedOrder.amount,
                currency: updatedOrder.currency,
                createdAt: updatedOrder.createdAt,
                updatedAt: updatedOrder.updatedAt,
            },
        });

        // Asset has been moved to admin wallet for a buy and seller needs to be paid
        if (
            options.status === OrderStatus.done &&
            transaction.orderCategory === OrderCategory.SELL
        ) {
            await this.fincraService.initializeTransfer({
                accountName: transaction.destinationBankAccountName,
                accountNumber: transaction.destinationBankAccountNumber,
                amount: transaction.totalToReceiveInFiat,
                bankCode: transaction.destinationBankCode,
                bankName: transaction.destinationBankName,
                serviceCharge: 0,
                userId: transaction.userId,
                orderId: transaction.id,
                reference: generateId({ type: "reference" }),
            });
        }

        if (options.status == OrderStatus.done) {
            await this.handleWithdrawalDone(transaction);
        } else if (options.status == OrderStatus.failed) {
            await this.handleWithdrawalFailed(transaction);
        }
    }

    /**
     * Handle successful withdrawal completion
     */
    private async handleWithdrawalDone(transaction: any) {
        // Sync wallet with Quidax to ensure balance is up to date
        await this.syncWallet(transaction.user.id, transaction.currency);
        
        // Emit wallet update after sync
        this.wsGateway.notifyWalletUpdate(transaction.user.id);

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
     * Handle failed withdrawal
     */
    private async handleWithdrawalFailed(transaction: any) {
        // Sync wallet on failure too (in case funds were returned)
        await this.syncWallet(transaction.user.id, transaction.currency);
        this.wsGateway.notifyWalletUpdate(transaction.user.id);

        // Send notification for failed transaction
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

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /**
     * Sync wallet balance with Quidax - delegates to WalletAddressService
     */
    private async syncWallet(userId: number, currency: string): Promise<void> {
        return this.walletAddressService.syncWallet(userId, currency);
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
        const marketData = await this.quidaxService.getSingleMarketTicker(
            marketSymbol
        );

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
