import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    LedgerType,
    OrderCategory,
    OrderStatus,
    QueueReason,
    TransactionFeeCategory,
    User,
} from "@prisma/client";
import { IncompleteAccountSetupException, UnknownFeeStructureException, RateLimitExceededException } from "../errors";
import {
    CancelWithdrawerRequestDto,
    GetCryptoWithdrawerFeeDto,
    WithdrawerRequestDto,
} from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { getStreamlinedStatus } from "../interfaces/trade";
import { DEFAULT_TRANSACTION_TIMEOUT_MS } from "../constants";
import { RateLimiterService } from "@/modules/core/rate-limit/services/rate-limiter.service";
import { LedgerService } from "./ledger/ledger.service";
import { WithdrawalQueueService } from "./ledger/withdrawal-queue.service";
import { SweepService } from "./ledger/sweep.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";
import { TransactionMonitorService } from "./ledger/transaction-monitor.service";
import { GeneralTransactionException } from "../errors";

// Withdrawal rate limits: configurable via environment variables
// Default: 5 withdrawals per hour per user
const WITHDRAWAL_RATE_LIMIT = parseInt(process.env.WITHDRAWAL_RATE_LIMIT || "5", 10);
const WITHDRAWAL_RATE_WINDOW_SECONDS = parseInt(process.env.WITHDRAWAL_RATE_WINDOW_SECONDS || "3600", 10); // 1 hour default

/**
 * Send Service
 * 
 * Handles all crypto send/withdrawal operations including:
 * - Creating withdrawal requests
 * - Calculating withdrawal fees
 * - Canceling pending withdrawals
 * - Rate limiting (5/hour/user, 1 pending/currency)
 */
@Injectable()
export class SendService {
    private readonly logger = new Logger("SendService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly rateLimiter: RateLimiterService,
        private readonly ledgerService: LedgerService,
        private readonly withdrawalQueueService: WithdrawalQueueService,
        private readonly sweepService: SweepService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly rateService: RateService,
        private readonly transactionMonitor: TransactionMonitorService,
        private readonly notificationDispatcher: NotificationDispatcher
    ) { }

    /**
     * Checks withdrawal rate limits
     * - Max 5 withdrawals per hour per user
     * - Max 1 pending withdrawal per currency per user
     */
    private async checkWithdrawalRateLimits(
        userId: number,
        currency: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        // Check hourly rate limit (5/hour)
        const rateLimitResult = await this.rateLimiter.checkLimit(
            `withdrawal:${userId}`,
            {
                limit: WITHDRAWAL_RATE_LIMIT,
                windowSeconds: WITHDRAWAL_RATE_WINDOW_SECONDS,
                keyPrefix: "ratelimit:",
            }
        );

        if (!rateLimitResult.allowed) {
            return {
                allowed: false,
                reason: `Rate limit exceeded. You can make ${WITHDRAWAL_RATE_LIMIT} withdrawals per hour. Try again in ${Math.ceil(rateLimitResult.retryAfter || 0)} seconds.`,
            };
        }

        // Check for existing pending withdrawal in same currency
        const pendingWithdrawal = await this.prisma.order.findFirst({
            where: {
                userId,
                orderCategory: OrderCategory.SEND,
                currency: currency.toUpperCase(),
                status: {
                    in: [
                        OrderStatus.submitted,
                        OrderStatus.pending,
                        OrderStatus.processing,
                        OrderStatus.accepted,
                    ],
                },
            },
            select: { id: true, orderReference: true, amount: true },
        });

        if (pendingWithdrawal) {
            return {
                allowed: false,
                reason: `You already have a pending ${currency.toUpperCase()} withdrawal (${pendingWithdrawal.orderReference}). Please wait for it to complete before making another.`,
            };
        }

        return { allowed: true };
    }

    /**
     * Gets a fee based on amount and fee data structure
     */
    private async getFee(
        amount: number,
        data: any
    ): Promise<{ fee: number; type: string }> {
        if (data.type === "flat" && typeof data.fee === "number") {
            return {
                fee: data.fee,
                type: "flat",
            };
        }

        if (data.type === "percentage" && typeof data.fee === "number") {
            return {
                fee: (amount * data.fee) / 100,
                type: "percentage",
            };
        }

        if (data.type === "range" && Array.isArray(data.fee)) {
            for (const range of data.fee) {
                if (amount >= range.min && amount < range.max) {
                    if (range.type === "percentage") {
                        return {
                            fee: (amount * range.value) / 100,
                            type: "percentage",
                        };
                    } else {
                        return {
                            fee: range.value,
                            type: "flat",
                        };
                    }
                }
            }

            throw new IncompleteAccountSetupException(
                "Amount is out of range.",
                HttpStatus.BAD_REQUEST
            );
        }

        // Fallback for simple fee structures
        if (typeof data.fee === "number") {
            return { fee: data.fee, type: "fixed" };
        }

        throw new IncompleteAccountSetupException(
            "Unknown fee structure",
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }

    /**
     * Gets the amount converted to Naira for sell/send orders
     */
    private async getAmountInNaira(
        currency: string,
        amount: number
    ): Promise<{ amount: number; rate: number } | null> {
        try {
            const rate = await this.rateService.getAssetRate(currency.toUpperCase());
            // Use buy rate for outgoing (what user sends out)
            return {
                amount: amount * rate.buyRate,
                rate: rate.buyRate,
            };
        } catch {
            return null;
        }
    }

    /**
     * Gets the crypto withdrawal fee including network and admin fees
     */
    async getCryptoWithdrawerFee(dto: GetCryptoWithdrawerFeeDto) {
        const currency = dto.currency.toUpperCase();

        // Fetch both provider fee and admin transaction fee
        const [providerFeeInfo, adminFee] = await Promise.all([
            this.quidaxService.getWithdrawerFees({
                currency: dto.currency,
                ...(dto.network && { network: dto.network }),
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SELL,
                        currency,
                    },
                },
            }),
        ]);

        this.logger.debug(`Admin fee for ${currency}: ${JSON.stringify(adminFee)}`);

        // Calculate provider fee
        const providerFee = await this.getFee(dto.amount, providerFeeInfo.data);

        // Calculate admin fee (default to 0 if not configured)
        const adminFeeAmount = adminFee ? adminFee.fee : 0;

        // Calculate total fee (provider fee + admin fee)
        const totalFee = providerFee.fee + adminFeeAmount;

        return buildResponse({
            message: "withdrawer fee info retrieved",
            data: {
                networkFee: providerFee.fee,
                adminFee: adminFeeAmount,
                totalFee: totalFee,
                feeType: providerFee.type,
                currency: currency,
            },
        });
    }

    /**
     * Creates a withdrawal/send request
     * 
     * VIRTUAL BALANCE FLOW:
     * 1. Check rate limits
     * 2. Check for pending sweeps (block if user's deposits not yet confirmed)
     * 3. HOLD amount on user's ledger
     * 4. Check main wallet liquidity
     * 5. If liquidity available: execute withdrawal from main wallet
     * 6. If insufficient: add to queue (shows as pending to user)
     */
    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        // Handle Internal Transfer
        if (dto.isInternal === true) {
            return this.processInternalTransfer(user, dto);
        }

        const currency = dto.currency.toUpperCase();
        const totalAmount = dto.amount; // Amount + fees will be calculated

        // Check rate limits first
        const rateLimitCheck = await this.checkWithdrawalRateLimits(user.id, currency);
        if (!rateLimitCheck.allowed) {
            throw new RateLimitExceededException(rateLimitCheck.reason);
        }

        // Check for pending sweeps - user can't withdraw until deposits are confirmed
        const hasPendingSweeps = await this.sweepService.hasPendingSweeps(user.id, currency);
        if (hasPendingSweeps) {
            return buildResponse({
                message: "Please wait for your recent deposit to be confirmed before withdrawing.",
                data: {
                    status: "pending_sweep",
                    hint: "Your deposit is being processed. This usually takes a few minutes.",
                },
            });
        }

        // Get user's available balance from ledger
        const balance = await this.ledgerService.getBalance(user.id, currency);
        if (balance.available.lessThan(totalAmount)) {
            throw new IncompleteAccountSetupException(
                `Insufficient balance. Available: ${balance.available.toString()} ${currency}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const reference = generateId({ type: "reference" });
        const transactionId = generateId({ type: "transaction" });

        // Phase 2: Unified lock scope for monitor validation + hold
        // This ensures balance state cannot change between monitor check and hold execution
        const holdResult = await this.ledgerService.runWithLock(
            user.id,
            currency,
            async () => {
                // Step 1: Real-time monitoring for high-value transactions (now inside lock)
                const monitorResult = await this.transactionMonitor.validateBeforeExecution({
                    userId: user.id,
                    currency,
                    amount: totalAmount,
                    operationType: "WITHDRAWAL",
                    reference: `withdrawal:${reference}`,
                });

                if (!monitorResult.success) {
                    this.logger.warn(
                        `Transaction monitor blocked withdrawal | User: ${user.id} | Amount: ${totalAmount} ${currency} | Reason: ${monitorResult.reason}`
                    );
                    throw new GeneralTransactionException(
                        monitorResult.reason || "Transaction blocked by monitoring system",
                        HttpStatus.FORBIDDEN
                    );
                }

                // Step 2: HOLD the amount on user's ledger (same lock scope)
                const holdResult = await this.ledgerService.hold({
                    userId: user.id,
                    currency: currency,
                    amount: totalAmount,
                    reference: `withdrawal:${reference}`,
                    type: LedgerType.WITHDRAWAL,
                    description: `Withdrawal to ${dto.recipientWalletAddress}`,
                });

                return holdResult;
            }
        );

        if (!holdResult.success) {
            this.logger.error(`Failed to hold balance for withdrawal | ${JSON.stringify({
                userId: user.id,
                currency,
                amount: totalAmount,
                error: holdResult.error,
            })}`);
            throw new IncompleteAccountSetupException(
                holdResult.error || "Failed to process withdrawal",
                HttpStatus.BAD_REQUEST
            );
        }

        // Check main wallet liquidity
        const mainWalletBalance = await this.getMainWalletBalance(currency);
        const hasLiquidity = mainWalletBalance.greaterThanOrEqualTo(totalAmount);

        // Get fiat equivalent for record
        const amtFiat = await this.getAmountInNaira(currency, totalAmount);

        // Create order record (will be updated with provider ID once executed)
        const createdOrder = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: hasLiquidity ? OrderStatus.processing : OrderStatus.pending,
                streamlinedStatus: getStreamlinedStatus(hasLiquidity ? OrderStatus.processing : OrderStatus.pending),
                orderReference: reference,
                transactionId: transactionId,
                userId: user.id,
                currency: currency,
                narration: dto.narration,
                transaction_note: dto.transaction_note,
                recipient: dto.recipientWalletAddress,
                destinationTag: dto.destinationTag,
                amount: totalAmount,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
                ledgerEntryId: holdResult.entryId,
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

        if (hasLiquidity) {
            // Execute withdrawal from main wallet immediately
            return await this.executeWithdrawalFromMainWallet(user, createdOrder, dto, holdResult.entryId!);
        } else {
            // Add to queue - withdrawal will be processed when liquidity is available
            const queueResult = await this.withdrawalQueueService.addToQueue({
                holdEntryId: holdResult.entryId!,
                userId: user.id,
                currency: currency,
                amount: totalAmount,
                reason: QueueReason.LOW_LIQUIDITY,
            });

            if (!queueResult.success) {
                // Release hold if queueing fails
                await this.ledgerService.releaseHold(
                    `withdrawal:${reference}`,
                    false,
                    "Failed to queue withdrawal"
                );
                throw new IncompleteAccountSetupException(
                    "Failed to process withdrawal. Please try again.",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }

            // Notify admin about liquidity issue
            await this.slackWebhookService.sendAlert(
                "LOW_LIQUIDITY_QUEUE",
                {
                    text: `⚠️ Withdrawal queued due to low liquidity\n` +
                        `User: ${user.id} (${user.email})\n` +
                        `Amount: ${totalAmount} ${currency}\n` +
                        `Queue Position: ${queueResult.queueEntry?.position}\n` +
                        `Main Wallet Balance: ${mainWalletBalance.toString()} ${currency}`,
                },
                { alertKey: `queue:${reference}` }
            );

            // WebSocket: Notify user their withdrawal is queued
            this.wsGateway.notifyWithdrawalQueued(user.id, {
                queueId: queueResult.queueEntry!.id,
                currency,
                amount: totalAmount.toString(),
                position: queueResult.queueEntry!.position,
                reason: "LOW_LIQUIDITY",
            });

            // Emit wallet update
            this.wsGateway.notifyWalletUpdate(user.id);

            return buildResponse({
                message: "Withdrawal request received and is being processed",
                data: {
                    transactionId: createdOrder.transactionId,
                    status: "queued",
                    statusHint: "Your withdrawal is being processed. This may take a few minutes.",
                    queuePosition: queueResult.queueEntry?.position,
                },
            });
        }
    }

    /**
     * Gets main wallet balance for a currency
     */
    private async getMainWalletBalance(currency: string): Promise<Decimal> {
        try {
            // Get balance from Quidax main account
            const wallets = await this.quidaxService.getUserWalletList({ user_id: "me" });
            const wallet = wallets.data?.find(
                (w: any) => w.currency.toUpperCase() === currency.toUpperCase()
            );
            return wallet ? new Decimal(wallet.balance || "0") : new Decimal(0);
        } catch (error) {
            this.logger.error(`Failed to get main wallet balance | ${JSON.stringify({
                currency,
                error: error.message,
            })}`);
            return new Decimal(0);
        }
    }

    /**
     * Executes withdrawal from main wallet
     */
    private async executeWithdrawalFromMainWallet(
        user: User,
        order: any,
        dto: WithdrawerRequestDto,
        holdEntryId: string
    ) {
        try {
            // Execute withdrawal from main wallet (not user's sub-account)
            const requestRes = await this.quidaxService.createWithdrawerRequest({
                amount: order.amount.toString(),
                currency: order.currency,
                narration: dto.narration || order.narration,
                transaction_note: dto.transaction_note || order.transaction_note,
                user_id: "me", // Main wallet
                fund_uid: dto.recipientWalletAddress,
                fund_uid2: dto.destinationTag,
                reference: order.orderReference,
                network: dto.network,
            });

            // Update order with provider details
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    providerOrderId: requestRes.data.id,
                    fee: +requestRes.data.fee,
                    total: +requestRes.data.total,
                    status: OrderStatus.processing,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                },
            });

            // Emit wallet update
            this.wsGateway.notifyWalletUpdate(user.id);

            // Send notification
            const message = `Your send of ${order.amount} ${order.currency.toUpperCase()} is being processed. Transaction ID: ${order.transactionId}`;

            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Send transaction initiated",
                body: message,
                currency: order.currency,
                transactionType: OrderCategory.SEND,
                enableEmail: true,
                emailPayload: {
                    email: user.email,
                    transactionType: 'withdrawal',
                    transactionId: order.transactionId,
                    amount: String(order.amount),
                    currency: order.currency,
                    status: 'processing',
                    date: new Date().toISOString(),
                },
                enablePush: true,
            });

            return buildResponse({
                message: "Withdrawal request placed successfully",
                data: {
                    ...requestRes.data,
                    transactionId: order.transactionId,
                },
            });
        } catch (error) {
            this.logger.error(`Failed to execute withdrawal | ${JSON.stringify({
                orderId: order.id,
                error: error.message,
            })}`);

            // Queue the withdrawal instead of failing completely
            const queueResult = await this.withdrawalQueueService.addToQueue({
                holdEntryId: holdEntryId,
                userId: user.id,
                currency: order.currency,
                amount: order.amount,
                reason: QueueReason.LOW_LIQUIDITY,
            });

            // Update order status
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.pending,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
                    reason: `Queued: ${error.message}`,
                },
            });

            // WebSocket: Notify user their withdrawal is queued
            if (queueResult.success && queueResult.queueEntry) {
                this.wsGateway.notifyWithdrawalQueued(user.id, {
                    queueId: queueResult.queueEntry.id,
                    currency: order.currency,
                    amount: order.amount.toString(),
                    position: queueResult.queueEntry.position,
                    reason: "LOW_LIQUIDITY",
                });
            }

            return buildResponse({
                message: "Withdrawal request received and is being processed",
                data: {
                    transactionId: order.transactionId,
                    status: "queued",
                    statusHint: "Your withdrawal is being processed. This may take a few minutes.",
                },
            });
        }
    }



    /**
     * Cancels a pending withdrawal request
     */
    async cancelWithdrawerRequest(user: User, dto: CancelWithdrawerRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const requestRes = await this.quidaxService.cancelWithdrawerRequest({
            user_id: user.cryptoSubAccountId,
            withdrawal_id: dto.withdrawal_id,
        });

        return buildResponse({
            message: "Withdrawer cancel request placed successfully",
            data: requestRes.data,
        });
    }

    /**
     * Processing for internal P2P transfers
     */
    private async processInternalTransfer(user: User, dto: WithdrawerRequestDto) {
        const currency = dto.currency.toUpperCase();
        const totalAmount = dto.amount;

        if (!dto.recipientEmail) {
            throw new IncompleteAccountSetupException(
                "Recipient email is required for internal transfers",
                HttpStatus.BAD_REQUEST
            );
        }

        // 1. Resolve Recipient
        // Using prisma directly to avoid circular dependency if UserService is not available or to be efficient
        const recipient = await this.prisma.user.findUnique({
            where: { email: dto.recipientEmail },
            select: { id: true, email: true, firstName: true, lastName: true },
        });

        if (!recipient) {
            throw new IncompleteAccountSetupException(
                "Recipient user not found",
                HttpStatus.NOT_FOUND
            );
        }

        if (recipient.id === user.id) {
            throw new IncompleteAccountSetupException(
                "Cannot send funds to yourself",
                HttpStatus.BAD_REQUEST
            );
        }

        // 2. Check Rate Limits (Sharing limit with external withdrawals for now)
        const rateLimitCheck = await this.checkWithdrawalRateLimits(user.id, currency);
        if (!rateLimitCheck.allowed) {
            throw new RateLimitExceededException(rateLimitCheck.reason);
        }

        // 3. Check Balance
        const balance = await this.ledgerService.getBalance(user.id, currency);
        if (balance.available.lessThan(totalAmount)) {
            throw new IncompleteAccountSetupException(
                `Insufficient balance. Available: ${balance.available.toString()} ${currency}`,
                HttpStatus.BAD_REQUEST
            );
        }

        let reference = generateId({ type: "reference" });
        const transactionId = generateId({ type: "transaction" });

        // Idempotency Check
        if (dto.idempotencyKey) {
            reference = `INT-${dto.idempotencyKey}`;
            const existingOrder = await this.prisma.order.findFirst({
                where: { orderReference: reference },
                select: { transactionId: true, recipient: true },
            });

            if (existingOrder) {
                return buildResponse({
                    message: "Transfer successful",
                    data: {
                        transactionId: existingOrder.transactionId,
                        status: "completed",
                        recipient: existingOrder.recipient,
                    },
                });
            }
        }

        // 4. Validation (Monitor)
        const monitorResult = await this.transactionMonitor.validateBeforeExecution({
            userId: user.id,
            currency,
            amount: totalAmount,
            operationType: "SEND", // Monitor as SEND
            reference: `send:${reference}`,
        });

        if (!monitorResult.success) {
            this.logger.warn(
                `Transaction monitor blocked internal send | User: ${user.id} | Amount: ${totalAmount} | Reason: ${monitorResult.reason}`
            );
            throw new GeneralTransactionException(
                monitorResult.reason || "Transaction blocked by monitoring system",
                HttpStatus.FORBIDDEN
            );
        }

        // 5. Execute Atomic Transfer
        const transferResult = await this.ledgerService.internalTransfer(
            user.id,
            recipient.id,
            currency,
            totalAmount,
            reference,
            dto.narration || dto.transaction_note
        );

        if (!transferResult.success) {
            throw new GeneralTransactionException(
                transferResult.error || "Transfer failed",
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        // 6. Create Order Record (Sender side)
        const amtFiat = await this.getAmountInNaira(currency, totalAmount);

        await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.completed, // Done immediately
                streamlinedStatus: "completed",
                orderReference: reference,
                transactionId: transactionId,
                userId: user.id,
                currency: currency,
                narration: dto.narration,
                transaction_note: dto.transaction_note,
                recipient: recipient.email, // Store email as recipient
                amount: totalAmount,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
                ledgerEntryId: transferResult.entryId,
                fulfilled: true,
            },
        });

        // 7. Notifications
        // Notify Sender
        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Transfer Sent",
            body: `You sent ${totalAmount} ${currency} to ${recipient.email}`,
            currency: currency,
            transactionType: OrderCategory.SEND,
            enableEmail: true,
            enablePush: true,
        });

        // Notify Recipient
        await this.notificationDispatcher.notify({
            userId: recipient.id,
            title: "Funds Received",
            body: `You received ${totalAmount} ${currency} from ${user.email}`,
            currency: currency,
            transactionType: OrderCategory.RECEIVE, // Assuming RECEIVE exists or fallback
            enableEmail: true,
            enablePush: true,
        });

        // Emit Wallet Updates
        this.wsGateway.notifyWalletUpdate(user.id);
        this.wsGateway.notifyWalletUpdate(recipient.id);

        return buildResponse({
            message: "Transfer successful",
            data: {
                transactionId,
                status: "completed",
                recipient: recipient.email,
                amount: totalAmount,
                currency,
            },
        });
    }
}
