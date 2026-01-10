import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    User,
    UserNotificationTarget,
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
    private readonly QUOTE_TTL_SECONDS = 15;

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly sellOrderService: SellOrderService,
        private readonly buyOrderService: BuyOrderService,
        private readonly redisCacheService: RedisCacheService,
        private readonly transactionService: TransactionService,
        private readonly walletAddressService: WalletAddressService,
        private readonly wsGateway: WsGateway,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly walletManagementService: WalletManagementService
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
        // 1. Calculate Sell (Crypto A -> NGN)
        const sellQuote = await this.sellOrderService.calculateSellQuote(user, {
            asset: fromCurrency,
            amount: amount,
        }, true); // Internal = true (No fees)

        const fiatAmount = sellQuote.totalToReceiveInFiat;

        // 2. Calculate Buy (NGN -> Crypto B)
        const buyRateRecord = await this.prisma.cryptoRate.findUnique({
            where: { currency: toCurrency.toUpperCase() }
        });

        if (!buyRateRecord) {
            throw new GeneralTransactionException("Rate not found for " + toCurrency, HttpStatus.BAD_REQUEST);
        }

        // Use SellRate for user buying (User buys at higher price usually? Wait. 
        // BuyOrderService: return { buyRate: rate.sellRate }. Yes, user buys at 'sellRate'.
        const rate = buyRateRecord.sellRate;
        const toAmount = fiatAmount / rate;

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
        // Explicitly check limits using NGN fiat amount and OrderCategory.SWAP
        await this.transactionService.validateTransaction(
            user,
            quote.fiat_amount,
            "NGN",
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
                currency: quote.from_currency.toUpperCase(), // Source Currency
                amount: quote.from_amount, // Source Amount
                amountInFiat: quote.fiat_amount,
                rateAtConversion: quote.rate, // Implied rate
                total: quote.from_amount,
                recipient: "Internal Swap",
                narration: `Swap ${quote.from_currency} -> ${quote.to_currency}`,
                transaction_note: `Swapping ${quote.from_amount} ${quote.from_currency} to ${quote.to_amount.toFixed(8)} ${quote.to_currency}`,
                // Store destination info in metadata or just notes for now
                providerOrderId: dto.quotationId, // Trace back to quote
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
            const adminWallet = await this.quidaxService.getUserWallet({
                user_id: "me",
                currency: quote.to_currency.toLowerCase()
            });
            const adminBalance = parseFloat(adminWallet.data.balance || "0");

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
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.completed,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.completed),
                    transaction_note: `Swap Completed. Received ${quote.to_amount} ${quote.to_currency}`
                }
            });

            // Final Notifications
            this.wsGateway.notifyWalletUpdate(user.id);
            this.emitTransactionUpdate(user.id, { ...order, status: OrderStatus.completed });

            await this.sendNotification(
                user.id,
                "Swap Successful",
                `Swapped ${quote.from_amount} ${quote.from_currency} for ${quote.to_amount.toFixed(6)} ${quote.to_currency}`,
                quote.to_currency,
                OrderCategory.SWAP
            );

            return buildResponse({
                message: "Swap confirmed successfully",
                data: this.mapToSwapResponse(order, quote, user),
            });

        } catch (error) {
            this.logger.error(`Swap Failed: ${error.message}`, error.stack);

            // Mark Order as FAILED if it was in processing
            await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.failed,
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.failed),
                    transaction_note: `Failed: ${error.message}`
                }
            });

            this.emitTransactionUpdate(user.id, { ...order, status: OrderStatus.failed });

            // If Sell succeeded but Buy failed (caught above?), we handle that logic inside checks.
            // If ExecuteInternalSell failed, we are here. User funds NOT deducted (atomic external call failed).
            // So failing the order is correct.

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

    private async sendNotification(userId: number, title: string, body: string, currency: string, type: OrderCategory) {
        const createdNotification = await this.prisma.notification.create({
            data: {
                title,
                body,
                userId,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: type,
                currency: currency,
            },
        });

        const notificationList = await this.prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        this.wsGateway.notifyUser(userId, {
            type: "new_notification",
            notification: createdNotification,
            notificationList,
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

        if (order.status !== OrderStatus.pending) {
            throw new GeneralTransactionException(
                `Order is not in PENDING state (Current: ${order.status}). Only pending swaps can be retried.`,
                HttpStatus.BAD_REQUEST
            );
        }

        // 2. Check Admin Liquidity again
        if (!order.amountInFiat || !order.rateAtConversion) {
            throw new GeneralTransactionException("Critical data missing for retry (Fiat Amount/Rate)", HttpStatus.INTERNAL_SERVER_ERROR);
        }

        // Parsing Narration "Swap BTC -> USDT"
        const parts = order.narration.split('->');
        if (parts.length !== 2) {
            throw new GeneralTransactionException("Could not determine destination currency from narration", HttpStatus.INTERNAL_SERVER_ERROR);
        }
        const toCurrency = parts[1].trim();
        const toAmount = order.amountInFiat / order.rateAtConversion;

        const reference = order.orderReference;
        const buyRef = `${reference}_buy`;

        // 3. Liquidity Check
        const adminWallet = await this.quidaxService.getUserWallet({
            user_id: "me",
            currency: toCurrency.toLowerCase()
        });
        const adminBalance = parseFloat(adminWallet.data.balance || "0");

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

            await this.sendNotification(
                user.id,
                "Swap Successful",
                `Swapped ${order.amount} ${order.currency} for ${toAmount.toFixed(6)} ${toCurrency}`,
                toCurrency,
                OrderCategory.SWAP
            );

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
}
