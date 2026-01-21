import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    OrderCategory,
    OrderStatus,
    User,
} from "@prisma/client";
import {
    GeneralTransactionException,
    IncompleteAccountSetupException,
    TransactionExpiredException,
    TransactionNotFoundException,
} from "../errors";
import {
    PlaceInstantSwapRequestDto,
    RefreshInstantSwapRequestDto,
    ConfirmInstantSwapQuoteDto,
} from "../dtos";
import { QUOTE_EXPIRY_MS } from "../constants";
import { SellOrderService } from "./sell-order.service";
import { BuyOrderService } from "./buy-order.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { TransactionService } from "@/modules/api/auth/services/transaction.service";
import { WalletAddressService } from "./wallet-address.service";
import { WsGateway } from "../gateway/v1";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { WalletManagementService } from "../../operations/services/wallet-management.service";
import { getStreamlinedStatus } from "../interfaces/trade";

/**
 * Swap Service
 * 
 * Handles all crypto-to-crypto swap operations using an atomic Internal Swap Flow:
 * 1. User -> Admin (Sell Leg)
 * 2. Admin -> User (Buy Leg)
 * 
 * Ensures robust specific order tracking, atomicity, and prevents race conditions.
 */
@Injectable()
export class SwapService {
    private readonly logger = new Logger("SwapService");
    private readonly QUOTE_TTL_SECONDS = 25;

    constructor(
        private readonly prisma: PrismaService,
        private readonly sellOrderService: SellOrderService,
        private readonly buyOrderService: BuyOrderService,
        private readonly redisCacheService: RedisCacheService,
        private readonly transactionService: TransactionService,
        private readonly walletAddressService: WalletAddressService,
        private readonly wsGateway: WsGateway,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly walletManagementService: WalletManagementService,
        private readonly rateService: RateService,
        private readonly notificationDispatcher: NotificationDispatcher
    ) { }

    /**
     * Generates a swap quote locally using our internal rates
     */
    async createInstantSwap(user: User, dto: PlaceInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const quote = await this.generateInternalQuote(
            user,
            dto.from_currency,
            dto.to_currency,
            dto.from_amount ? parseFloat(dto.from_amount.toString()) : 0
        );

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: quote,
        });
    }

    /**
     * Refreshes an existing swap quote
     */
    async refreshInstantSwap(user: User, dto: RefreshInstantSwapRequestDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        // Just regenerate a new quote
        const quote = await this.generateInternalQuote(
            user,
            dto.from_currency,
            dto.to_currency,
            dto.from_amount ? parseFloat(dto.from_amount.toString()) : 0
        );

        return buildResponse({
            message: "Swap request quote retrieved successfully",
            data: quote,
        });
    }

    /**
     * Internal helper to calculate rates and store quote in Redis
     */
    private async generateInternalQuote(
        user: User,
        fromCurrency: string,
        toCurrency: string,
        amount: number
    ) {
        let rate: number;
        let fiatAmount: number | null = null;

        // --- HYBRID SWAP PAIR LOGIC ---
        // 1. Check for Admin Override (SwapPair)
        // Cast to any to avoid TS errors before migration
        const swapPair = await (this.prisma as any).swapPair.findUnique({
            where: {
                fromCurrency_toCurrency: {
                    fromCurrency: fromCurrency.toUpperCase(),
                    toCurrency: toCurrency.toUpperCase()
                }
            }
        });

        if (swapPair && swapPair.isActive && swapPair.rate > 0) {
            // Use Admin Rate
            rate = swapPair.rate;
            // For fiat amount (e.g. NGN value), we still need to estimate it for limits/logging
            // But the swap itself respects the explicit rate: 1 From = X To implies ToAmount = From * Rate
            // We can fetch the Source->Fiat price just for reference/limits
            const sourceRate = await this.rateService.getAssetRate(fromCurrency.toUpperCase());
            fiatAmount = amount * sourceRate.buyRate; // Estimate
        } else {
            // 2. Fallback to Auto-Pilot (Derived Cross-Rate)
            // Use Sell Price of A and Buy Price of B to capture spread on both sides
            // Sell A -> NGN
            const sellQuote = await this.sellOrderService.calculateSellQuote(user, {
                asset: fromCurrency,
                amount: amount,
            }, true); // Internal = true (No fees)

            fiatAmount = sellQuote.totalToReceiveInFiat;

            // Buy NGN -> B
            const buyRateRecord = await this.rateService.getAssetRate(toCurrency.toUpperCase());

            // User 'Buys' at the system's 'SellRate'
            // Rate for A -> B = (FiatValue of A) / (Price of B) / AmountA
            // Effective Rate = (SellRateA * Amount) / SellRateB / Amount = SellRateA / SellRateB
            rate = fiatAmount / amount / buyRateRecord.sellRate;
        }

        // Calculate To Amount
        const toAmount = amount * rate;

        // If fiatAmount wasn't set by the SellQuote fallback, ensure we have reasonable value for limits
        if (fiatAmount === null) {
            // Should have been set in override block, but double check
            fiatAmount = 0;
        }

        const quotationId = generateId({ type: "reference" });
        const expiresAt = new Date(Date.now() + QUOTE_EXPIRY_MS).toISOString();

        // 3. Store Quote in Redis
        const quoteData = {
            id: quotationId,
            user_id: user.id,
            from_currency: fromCurrency,
            to_currency: toCurrency,
            from_amount: amount,
            to_amount: toAmount,
            fiat_amount: fiatAmount,
            rate: rate,
            expires_at: expiresAt
        };

        await this.redisCacheService.set(
            `swap_quote:${quotationId}`,
            quoteData,
            this.QUOTE_TTL_SECONDS
        );

        // Map to Quidax-like response for frontend compatibility
        return {
            id: quotationId,
            quotation_id: quotationId,
            from_currency: fromCurrency,
            to_currency: toCurrency,
            from_amount: amount.toString(),
            to_amount: toAmount.toString(),
            rate: rate.toString(),
            quoted_price: rate.toString(), // Added for compatibility
            expires_at: expiresAt,
            // Mock other fields if needed
            created_at: new Date().toISOString(),
        };
    }

    /**
     * Confirms and executes a swap quote using the "Order-First" Atomic Pattern.
     */
    async confirmInstantSwapQuote(user: User, dto: ConfirmInstantSwapQuoteDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        // 1. Atomic Read-and-Burn of Quote (Idempotency)
        const quote = await this.redisCacheService.getDel<any>(`swap_quote:${dto.quotationId}`);

        if (!quote) {
            throw new TransactionExpiredException(
                "Swap quote expired or already processed. Please refresh."
            );
        }

        // 2. Transaction Limit Check
        // Use the source crypto currency and amount for validation
        await this.transactionService.validateTransaction(
            user,
            quote.from_amount,
            quote.from_currency.toUpperCase(),
            OrderCategory.SWAP,
            "swap"
        );

        // 3. Create Pending "Order-First" Record
        // We create one atomic SWAP order record.
        const reference = generateId({ type: "reference" });
        const transactionId = generateId({ type: "transaction" });

        const order = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.processing, // Processing while we do the legs
                streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                orderReference: reference,
                transactionId: transactionId,
                userId: user.id,
                // Source/destination currencies and amounts for swap
                fromCurrency: quote.from_currency.toUpperCase(),
                toCurrency: quote.to_currency.toUpperCase(),
                fromAmount: quote.from_amount,
                toAmount: quote.to_amount,
                quoted_price: quote.rate,
                // Legacy fields for compatibility
                currency: quote.from_currency.toUpperCase(),
                amount: quote.from_amount,
                amountInFiat: quote.fiat_amount,
                rateAtConversion: quote.rate,
                total: quote.from_amount,
                recipient: "Internal Swap",
                narration: `Swap ${quote.from_currency} -> ${quote.to_currency}`,
                transaction_note: `Swapping ${quote.from_amount} ${quote.from_currency} to ${quote.to_amount.toFixed(8)} ${quote.to_currency}`,
                quotationId: dto.quotationId, // Track the quote ID
            }
        });

        // 4. Orchestrate Internal Swap Flow
        try {
            // --- LEG A: SELL (User -> Admin) ---
            // If this fails, the whole swap fails (atomic).
            await this.sellOrderService.executeInternalSell(
                user,
                quote.from_amount,
                quote.from_currency,
                reference // Use Swap Reference
            );

            // Notify Progress
            this.wsGateway.notifyWalletUpdate(user.id); // Balance deducted
            this.emitTransactionUpdate(user.id, { ...order, status: OrderStatus.processing });

            // --- LEG B: BUY (Admin -> User) ---

            // Liquidity Check: Does Admin have enough Crypto B?
            const adminWallet = await this.walletManagementService.getWalletBalance(quote.to_currency.toUpperCase());
            const adminBalance = Number(adminWallet?.balance || 0);

            if (adminBalance < quote.to_amount) {
                this.logger.warn(`Insufficient Admin Liquidity for Swap ${order.id}. Holding Order.`);

                // Mark ON_HOLD (Pending Admin)
                await this.prisma.order.update({
                    where: { id: order.id },
                    data: {
                        status: OrderStatus.pending, // Stuck state
                        streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
                        transaction_note: `ON_HOLD: Insufficient Liquidity for ${quote.to_currency}. Waiting for Admin.`
                    }
                });

                // Alert Admin via Slack
                await this.slackWebhookService.sendWebhookFailureAlert(
                    'quidax',
                    reference,
                    `Insufficient Liquidity for Swap Buy Leg. Order ${order.id} Pending.`,
                    {
                        orderId: order.id,
                        required: quote.to_amount,
                        currency: quote.to_currency,
                        available: adminBalance
                    }
                );

                return buildResponse({
                    message: "Swap processing. Pending completion.",
                    data: this.mapToSwapResponse(order, quote, user),
                });
            }

            // Execute Buy
            const buyRef = `${reference}_buy`;
            await this.buyOrderService.executeInternalBuy(
                user,
                quote.to_amount,
                quote.to_currency,
                buyRef
            );

            // 5. Success
            const completedOrder = await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.completed,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.completed),
                    transaction_note: `Swap Completed. Received ${quote.to_amount} ${quote.to_currency}`
                }
            });

            // 6. Sync both wallets involved in the swap
            await Promise.all([
                this.walletAddressService.syncWallet(user.id, quote.from_currency),
                this.walletAddressService.syncWallet(user.id, quote.to_currency),
            ]);

            // 7. [Non-Blocking] Calculate & Record Profit
            this.calculateAndRecordProfit(completedOrder).catch(err => {
                this.logger.error(`Failed to record profit for swap ${reference}: ${err.message}`);
            });

            // Final Notifications
            this.wsGateway.notifyWalletUpdate(user.id);
            this.emitTransactionUpdate(user.id, { ...order, status: OrderStatus.completed });

            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Swap Successful",
                body: `Swapped ${quote.from_amount} ${quote.from_currency} for ${quote.to_amount.toFixed(6)} ${quote.to_currency}`,
                currency: quote.to_currency,
                transactionType: OrderCategory.SWAP,
                enableEmail: true,
                emailPayload: {
                    email: user.email,
                    transactionType: 'swap',
                    transactionId: order.transactionId,
                    amount: String(quote.from_amount),
                    currency: quote.from_currency,
                    status: 'completed',
                    date: new Date().toISOString(),
                    toAmount: String(quote.to_amount),
                    toCurrency: quote.to_currency,
                    fromAmount: String(quote.from_amount),
                    fromCurrency: quote.from_currency,
                },
                enablePush: true,
            });

            return buildResponse({
                message: "Swap confirmed successfully",
                data: this.mapToSwapResponse(order, quote, user),
            });

        } catch (error) {
            this.logger.error(`Swap Failed: ${error.message}`, error.stack);

            // ROLLBACK: If Sell Leg succeeded (funds debited), we must refund the user
            // The sell leg debits user's source currency - we need to credit it back
            try {
                this.logger.log(`Attempting swap rollback for order ${order.id} | Crediting back ${quote.from_amount} ${quote.from_currency}`);

                // Credit back the source currency that was debited in executeInternalSell
                await this.buyOrderService.executeInternalBuy(
                    user,
                    quote.from_amount,
                    quote.from_currency,
                    `${reference}_rollback`
                );

                this.logger.log(`Swap rollback successful for order ${order.id}`);
            } catch (rollbackError) {
                // Critical: Rollback failed - alert admin immediately
                this.logger.error(`CRITICAL: Swap rollback failed for order ${order.id}: ${rollbackError.message}`, rollbackError.stack);

                await this.slackWebhookService.sendAlert(
                    "SWAP_ROLLBACK_FAILED",
                    {
                        text: `🚨 CRITICAL: Swap rollback failed!\n` +
                            `Order: ${order.id}\n` +
                            `Transaction: ${order.transactionId}\n` +
                            `User: ${user.id} (${user.email})\n` +
                            `Amount: ${quote.from_amount} ${quote.from_currency}\n` +
                            `Original Error: ${error.message}\n` +
                            `Rollback Error: ${rollbackError.message}\n` +
                            `⚠️ MANUAL INTERVENTION REQUIRED - User funds may be stuck`
                    },
                    { alertKey: `swap-rollback-fail:${reference}` }
                );
            }

            // Mark Order as FAILED
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.failed,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.failed),
                    transaction_note: `Failed: ${error.message}`
                }
            });

            this.emitTransactionUpdate(user.id, { ...order, status: OrderStatus.failed });

            throw new GeneralTransactionException(
                "Swap failed. Please try again or contact support.",
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

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
     * Admin Action: Retry a pending swap order (e.g. after adding liquidity).
     * Only works for SWAP orders that are stuck in PENDING status.
     */
    async retryPendingSwap(orderId: number) {
        // 1. Fetch Order
        const order = await this.prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!order) {
            throw new TransactionNotFoundException("Order not found", HttpStatus.NOT_FOUND);
        }

        if (order.orderCategory !== OrderCategory.SWAP) {
            throw new GeneralTransactionException("Not a Swap Order", HttpStatus.BAD_REQUEST);
        }

        if (order.status !== OrderStatus.pending && order.status !== OrderStatus.failed) {
            throw new GeneralTransactionException(
                `Order is not in PENDING or FAILED state (Current: ${order.status}). Cannot retry.`,
                HttpStatus.BAD_REQUEST
            );
        }

        // 2. Get swap details - prefer stored fields, fallback to narration parsing
        let toCurrency = order.toCurrency;
        let toAmount = order.toAmount;

        // Fallback for older orders without stored swap fields
        if (!toCurrency || !toAmount) {
            if (!order.rateAtConversion) {
                throw new GeneralTransactionException("Critical data missing for retry (Rate)", HttpStatus.INTERNAL_SERVER_ERROR);
            }

            // Parse narration "Swap BTC -> USDT" as fallback
            const parts = order.narration?.split('->');
            if (!parts || parts.length !== 2) {
                throw new GeneralTransactionException("Could not determine destination currency from order", HttpStatus.INTERNAL_SERVER_ERROR);
            }
            toCurrency = parts[1].trim();
            toAmount = order.amount * order.rateAtConversion;
        }

        const reference = order.orderReference;
        const buyRef = `${reference}_buy`;

        // 3. Liquidity Check
        const adminWallet = await this.walletManagementService.getWalletBalance(toCurrency.toUpperCase());
        const adminBalance = Number(adminWallet?.balance || 0);

        if (adminBalance < toAmount) {
            throw new GeneralTransactionException(
                `Still insufficient liquidity. Required: ${toAmount} ${toCurrency}, Available: ${adminBalance}`,
                HttpStatus.BAD_REQUEST
            );
        }

        // 4. Execute Buy (Admin -> User)
        const user = await this.prisma.user.findUnique({ where: { id: order.userId } });
        if (!user) throw new GeneralTransactionException("User not found", HttpStatus.NOT_FOUND);

        try {
            await this.buyOrderService.executeInternalBuy(
                user,
                toAmount,
                toCurrency,
                buyRef
            );

            // 5. Success Update
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.completed,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.completed),
                    transaction_note: `Swap Completed (Retried). Received ${toAmount} ${toCurrency}`
                }
            });

            // Notifications
            this.wsGateway.notifyWalletUpdate(user.id);
            this.emitTransactionUpdate(user.id, { ...order, status: OrderStatus.completed });

            await this.notificationDispatcher.notify({
                userId: user.id,
                title: "Swap Successful",
                body: `Swapped ${order.amount} ${order.currency} for ${toAmount.toFixed(6)} ${toCurrency}`,
                currency: toCurrency,
                transactionType: OrderCategory.SWAP,
                enableEmail: true,
                emailPayload: {
                    email: user.email,
                    transactionType: 'swap',
                    transactionId: order.transactionId,
                    amount: String(order.amount),
                    currency: order.currency,
                    status: 'completed',
                    date: new Date().toISOString(),
                    toAmount: String(toAmount),
                    toCurrency: toCurrency,
                    fromAmount: String(order.amount),
                    fromCurrency: order.currency,
                },
                enablePush: true,
            });

            return buildResponse({
                message: "Swap retried and completed successfully",
                data: order,
            });

        } catch (error) {
            this.logger.error(`Retry Swap Failed: ${error.message}`, error.stack);
            throw new GeneralTransactionException(
                `Retry failed: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
    private mapToSwapResponse(order: any, quote: any, user: User) {
        return {
            id: order.id.toString(),
            created_at: order.createdAt.toISOString(),
            from_amount: quote.from_amount.toString(),
            from_currency: quote.from_currency,
            to_currency: quote.to_currency,
            received_amount: quote.to_amount.toString(),
            execution_price: quote.rate.toString(),
            status: order.streamlinedStatus || order.status,
            transactionId: order.transactionId,
            updated_at: order.updatedAt.toISOString(),
            swap_quotation: {
                id: quote.id,
                from_amount: quote.from_amount.toString(),
                to_amount: quote.to_amount.toString(),
                quoted_price: quote.rate.toString(),
                // Add minimal quote fields required by frontend
            },
            user: {
                id: user.id.toString(),
                email: user.email,
                first_name: user.firstName,
                last_name: user.lastName,
                created_at: user.createdAt.toISOString(),
                updated_at: user.updatedAt.toISOString(),
                reference: user.identifier || null,
                sn: user.identifier || "", // Mapping identifier to SN
                display_name: user.username || `${user.firstName} ${user.lastName}`,
            }
        };
    }

    /**
     * Calculates and records the estimated profit for a completed swap.
     * Profit = (Value of Asset IN) - (Value of Asset OUT)
     * Values are based on real-time market tickers at the moment of execution.
     */
    private async calculateAndRecordProfit(order: any) {
        try {
            // Parse narration to find currencies: "Swap BTC -> USDT"
            const match = order.narration.match(/Swap (\w+) -> (\w+)/);
            if (!match) return;

            const fromSymbol = match[1];
            const toSymbol = match[2];

            const fromAmount = order.amount;
            const toAmount = order.amount * (order.rateAtConversion || 0);

            // Use RateService instead of Quidax
            let fromRate = 0;
            let toRate = 0;

            if (fromSymbol.toUpperCase() === 'NGN') {
                fromRate = 1;
            } else {
                const fromRateData = await this.rateService.getAssetRate(fromSymbol.toUpperCase());
                fromRate = fromRateData.buyRate; // Admin Sell Price
            }

            if (toSymbol.toUpperCase() === 'NGN') {
                toRate = 1;
            } else {
                const toRateData = await this.rateService.getAssetRate(toSymbol.toUpperCase());
                toRate = toRateData.sellRate; // Admin Buy Price
            }

            if (fromRate === 0 || toRate === 0) return;

            // Value In (We Received): Amount * Market Bid
            const adminValueIn = fromAmount * fromRate;

            // Value Out (We Sent): Amount * Market Ask
            const adminValueOut = toAmount * toRate;

            const profit = adminValueIn - adminValueOut;

            await this.prisma.order.update({
                where: { id: order.id },
                data: { estimatedProfit: profit }
            });

        } catch (error) {
            this.logger.error(`Failed to record profit for swap ${order.id}: ${error.message}`);
        }
    }
}


