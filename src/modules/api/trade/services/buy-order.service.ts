import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { COMPANY_NAME, frontendUrl } from "@/config";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    LedgerType,
    OrderCategory,
    OrderStatus,
    PaymentMethod,
    SweepStatus,
    TransactionFeeCategory,
    TransactionStatus,
    TransactionType,
    User,
} from "@prisma/client";
import {
    AssetNotFoundException,
    IncompleteAccountSetupException,
    WalletAddressNotFoundException,
} from "../errors";
import {
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
} from "../../settings/errors";
import { BuyQuoteResponse, getStreamlinedStatus } from "../interfaces/trade";
import { InitiateBuyOrderDto } from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "./ledger/ledger.service";
import {
    EXTENDED_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
} from "../constants";

/**
 * Buy Order Service
 *
 * Handles all buy order operations including:
 * - Quote calculation for buy orders
 * - Order placement with payment gateway integration
 * - Fiat-to-crypto conversions
 */
@Injectable()
export class BuyOrderService {
    private readonly logger = new Logger("BuyOrderService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService,
        private readonly notificationDispatcher: NotificationDispatcher
    ) { }

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
     * Gets the amount converted to Naira
     */
    private async getAmountInNaira(
        currency: string,
        amount: number
    ): Promise<{ amount: number; rate: number } | null> {
        try {
            const rate = await this.rateService.getAssetRate(currency.toUpperCase());
            return {
                amount: amount * rate.sellRate,
                rate: rate.sellRate,
            };
        } catch {
            return null;
        }
    }

    /**
     * Gets a quote request for buying crypto
     */
    async buyCryptoQuoteRequest(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        return buildResponse({
            message: "Quotation for buy order retrieved successfully",
            data: responseData,
        });
    }

    /**
     * Calculates the quote for a buy order
     */
    async calculateBuyQuote(
        user: User,
        dto: InitiateBuyOrderDto
    ): Promise<BuyQuoteResponse> {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const assetExist = await this.prisma.assetWallet.findFirst({
            where: { userId: user.id, assetCurrency: dto.asset.toUpperCase() },
        });

        if (!assetExist) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        if (!assetExist.depositAddress || !assetExist.defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

        const currency = dto.asset.toUpperCase();
        // sell rate is used when user is buying.
        const rate = await this.rateService.getAssetRate(currency);

        // Zero out fees for buy orders as requested
        const quidaxFeeInCrypto = { fee: 0, type: "flat" };
        const adminFeeInCrypto = { fee: 0 };

        const assetValueInNaira = dto.amount * rate.sellRate;
        const quidaxFeeInNaira = 0;
        const adminFeeInNaira = 0;

        const totalToChargeInCrypto =
            dto.amount + quidaxFeeInCrypto.fee + adminFeeInCrypto.fee;
        const totalToChargeViaPaymentGateway =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;

        return {
            buyRate: rate.sellRate,
            cryptoBuyAmount: dto.amount,
            transactionFeeInCrypto:
                quidaxFeeInCrypto.fee + adminFeeInCrypto.fee,
            totalToChargeInCrypto,
            totalToChargeViaPaymentGateway,
            currency: "NGN",
            paymentGateway: PaymentMethod.NOMBA,
            depositAddress: assetExist.depositAddress,
            destinationTag: assetExist.destinationTag,
        };
    }

    /**
     * Places a buy order for crypto
     */
    async buyCryptoOrder(user: User, dto: InitiateBuyOrderDto) {
        const responseData = await this.calculateBuyQuote(user, dto);

        const userData = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNumber: user.phone,
        };

        const amount = +responseData.totalToChargeViaPaymentGateway;
        Logger.log(`amount: ${typeof amount}`);

        // Generate callback URL for Nomba to redirect after payment
        // The frontend checks for ?buy=success and uses the stored reference for verification
        // We don't include ref in URL since Nomba returns their own orderReference which we store
        const callbackUrl = `${frontendUrl}/?buy=success`;

        const { data } = await this.nombaService.initializePayment(
            userData,
            amount,
            callbackUrl
            // No checkoutReference override - let Nomba generate and use their orderReference
        );

        const result = data as {
            link: string;
            reference: string;  // This is now Nomba's orderReference
            amount: number;
        };

        const amtFiat = await this.getAmountInNaira(
            dto.asset,
            responseData.cryptoBuyAmount
        );

        const order = await this.prisma.$transaction(
            async (tx) => {
                const order = await tx.order.create({
                    data: {
                        orderCategory: OrderCategory.BUY,
                        transactionId: generateId({ type: "transaction" }),
                        amount: responseData.cryptoBuyAmount,
                        fee: responseData.transactionFeeInCrypto,
                        total: responseData.totalToChargeInCrypto,
                        status: OrderStatus.pending,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.pending
                        ),
                        paymentStatus: TransactionStatus.PENDING,
                        currency: dto.asset.toUpperCase(),
                        recipient: responseData.depositAddress,
                        destinationTag: responseData.destinationTag,
                        userId: user.id,
                        amountInFiat: amtFiat?.amount,
                        rateAtConversion: amtFiat?.rate,
                    },
                });
                await tx.payment.create({
                    data: {
                        reference: result.reference,
                        userId: user.id,
                        amount:
                            responseData.buyRate * responseData.cryptoBuyAmount,
                        chargeFee:
                            responseData.buyRate *
                            responseData.transactionFeeInCrypto,
                        totalAmount:
                            responseData.totalToChargeViaPaymentGateway,
                        type: TransactionType.P2P_PAYMENT,
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                        paymentMethod: PaymentMethod.NOMBA,
                        sessionId: generateId({ type: "sessionId" }),
                        transactionId: generateId({ type: "transaction" }),
                        title: `${COMPANY_NAME} p2p buy order payment`,
                        narration: `Buy order payment for order with id ${order.id}`,
                        orderId: order.id,
                        isDebit: false,
                        expectedCurrency: responseData.currency,
                    },
                });

                return order;
            },
            {
                maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
                timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
            }
        );

        // Emit transaction update for new buy order
        this.emitTransactionUpdate(user.id, order);

        // Emit wallet update for buy order initiation
        this.wsGateway.notifyWalletUpdate(user.id);

        // Create and send notification for processing
        const message = `Your buy order of ${order.amount
            } ${order.currency.toUpperCase()} is pending payment. Transaction ID: ${order.transactionId
            }`;

        await this.notificationDispatcher.notify({
            userId: user.id,
            title: "Buy order initiated",
            body: message,
            currency: order.currency,
            transactionType: OrderCategory.BUY,
            enablePush: true,
        });

        return buildResponse({
            message:
                "Order placed successfully, Please proceed to make payment",
            data: {
                order: order,
                paymentInfo: {
                    ...data,
                    authorization_url: data.link,
                },
            },
        });
    }

    /**
     * Fulfills a buy order after successful payment
     *
     * Uses atomic update to prevent double-fulfillment from duplicate webhooks.
     */
    async fulfillBuyOrder(reference: string) {
        this.logger.log(
            `Fulfilling buy order for payment reference: ${reference}`
        );

        // Atomic: Only update if status is still PENDING.
        // This prevents race conditions where duplicate webhooks could both
        // pass a non-atomic check and double-credit the user.
        // We use APPROVED as an intermediate "claimed" status - only mark SUCCESS
        // after Quidax transfer succeeds. If Quidax fails, we revert to PENDING
        // and throw so the webhook handler returns 5xx and Nomba retries.
        const updated = await this.prisma.payment.updateMany({
            where: {
                reference,
                status: TransactionStatus.PENDING,
            },
            data: {
                status: TransactionStatus.APPROVED, // Intermediate: claimed for processing
                paymentStatus: TransactionStatus.APPROVED,
            },
        });

        if (updated.count === 0) {
            // Either payment not found, already processed (SUCCESS), or being processed (APPROVED)
            const existing = await this.prisma.payment.findUnique({
                where: { reference },
            });
            if (!existing) {
                this.logger.error(
                    `Payment not found for reference: ${reference}`
                );
            } else if (existing.status === TransactionStatus.SUCCESS) {
                this.logger.log(`Payment ${reference} already completed successfully`);
            } else if (existing.status === TransactionStatus.APPROVED) {
                // Another webhook instance is currently processing - let that one finish
                this.logger.log(`Payment ${reference} currently being processed by another instance`);
            } else {
                this.logger.log(`Payment ${reference} in unexpected state: ${existing.status}`);
            }
            return;
        }

        // We now "own" this fulfillment - fetch full payment data
        const payment = await this.prisma.payment.findUnique({
            where: { reference },
            include: { user: true },
        });

        if (!payment) {
            // Shouldn't happen since updateMany succeeded, but guard anyway
            this.logger.error(
                `Payment disappeared after atomic update: ${reference}`
            );
            return;
        }

        const order = await this.prisma.order.findUnique({
            where: { id: payment.orderId },
        });

        if (!order) {
            this.logger.error(`Order not found for payment: ${payment.id}`);
            return;
        }

        // OMNIBUS VIRTUAL BALANCE SYSTEM
        // Crypto stays in the main (omnibus) wallet - we only credit the user's virtual balance (ledger)
        // No Quidax transfers needed - the platform holds all crypto in one main account
        try {
            const user = payment.user;

            this.logger.log(
                `[Omnibus] Crediting virtual balance for Order ${order.id} | User: ${user.id} | Amount: ${order.amount} ${order.currency}`
            );

            // Credit the user's ledger (virtual balance)
            // DOUBLE ENTRY: pairedCredit ensures platform liability (debit) is created
            const creditResult = await this.ledgerService.pairedCredit({
                userId: payment.userId,
                currency: order.currency.toUpperCase(),
                amount: order.amount,
                type: LedgerType.BUY,
                reference: `buy:${order.transactionId}`,
                metadata: {
                    orderId: order.id,
                    paymentReference: reference,
                    omnibus: true, // Flag indicating this is omnibus (no Quidax transfer)
                },
                sweepStatus: SweepStatus.NOT_APPLICABLE, // Buy orders don't need sweep - funds stay in omnibus
                createPlatformEntry: true
            });

            if (!creditResult.success) {
                this.logger.error(
                    `Failed to credit ledger for buy order ${order.id}: ${creditResult.error}`
                );
                // Revert payment to PENDING so next webhook retry can try again
                await this.prisma.payment.update({
                    where: { reference },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
                throw new Error(`Ledger credit failed: ${creditResult.error}`);
            }

            await this.prisma.$transaction(
                async (tx) => {
                    // Mark payment as SUCCESS
                    await tx.payment.update({
                        where: { reference },
                        data: {
                            status: TransactionStatus.SUCCESS,
                            paymentStatus: TransactionStatus.SUCCESS,
                        },
                    });

                    // Update Order with ledger entry link
                    await tx.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.completed,
                            streamlinedStatus: getStreamlinedStatus(
                                OrderStatus.completed
                            ),
                            paymentStatus: TransactionStatus.SUCCESS,
                            fulfilled: true, // Mark as fulfilled
                            ledgerEntryId: creditResult.userEntry?.id, // Link to ledger entry
                        },
                    });

                    // Note: No Quidax transfer needed - omnibus virtual balance system
                    // Crypto stays in main wallet, user has virtual balance in ledger
                },
                {
                    maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
                    timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
                }
            );

            // Notifications
            this.logger.log(
                `Buy order ${order.id} fulfilled and completed successfully`
            );

            const updatedOrder = await this.prisma.order.findUnique({
                where: { id: order.id },
            });
            if (updatedOrder) {
                this.emitTransactionUpdate(payment.userId, updatedOrder);
            }
            this.wsGateway.notifyWalletUpdate(payment.userId);

            const message = `Your buy order of ${order.amount
                } ${order.currency.toUpperCase()} has been completed successfully.`;
            await this.notificationDispatcher.notify({
                userId: payment.userId,
                title: "Buy order successful",
                body: message,
                currency: order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: payment.user?.email || '',
                    transactionType: 'buy',
                    transactionId: order.transactionId,
                    amount: String(order.amount),
                    currency: order.currency,
                    status: 'completed',
                    date: new Date().toISOString(),
                },
                enablePush: true,
            });
        } catch (error) {
            this.logger.error(
                `Failed to fulfill buy order (Transfer/Update Error) for order ${order.id}: ${error.message}`,
                error.stack
            );

            // Revert payment to PENDING so next webhook retry can try again
            try {
                await this.prisma.payment.update({
                    where: { reference },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
            } catch (revertError) {
                this.logger.error(`Failed to revert payment status: ${revertError.message}`);
            }

            // Send Slack Alert for admin intervention
            await this.slackWebhookService.sendWebhookFailureAlert(
                "quidax",
                reference,
                error.message,
                {
                    orderId: order.id,
                    transactionId: order.transactionId,
                    amount: order.amount,
                    currency: order.currency,
                    userId: order.userId,
                    cryptoSubAccountId: payment.user.cryptoSubAccountId,
                }
            );

            // Re-throw so webhook controller returns 5xx and Nomba retries
            throw error;
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
     * Executes the Internal Buy Leg of a Swap (Admin -> User)
     * Does NOT create a DB Order (SwapService handles that).
     * Returns a success result.
     * 
     * OMNIBUS VIRTUAL BALANCE: Only credits the target currency to user's ledger
     * No actual crypto transfer happens - crypto stays in omnibus wallet
     */
    async executeInternalBuy(
        user: User,
        amount: number, // Amount of Crypto B to credit to user's virtual balance
        currency: string,
        reference: string
    ) {
        this.logger.log(
            `[Omnibus] Executing Internal Buy for Swap | User: ${user.id} | Amount: ${amount} ${currency} | Ref: ${reference}`
        );

        // OMNIBUS: Credit the target currency to user's ledger (virtual balance)
        // No Quidax transfer needed - crypto stays in main omnibus wallet
        // DOUBLE ENTRY: pairedCredit ensures platform liability (debit) is created
        const creditResult = await this.ledgerService.pairedCredit({
            userId: user.id,
            currency: currency.toUpperCase(),
            amount,
            type: LedgerType.SWAP_IN,
            reference: `swap-buy:${reference}`,
            metadata: {
                swapReference: reference,
                omnibus: true, // Flag indicating this is omnibus (no Quidax transfer)
            },
            sweepStatus: SweepStatus.NOT_APPLICABLE, // Swap buy doesn't need sweep - funds stay in omnibus
            createPlatformEntry: true
        });

        if (!creditResult.success) {
            this.logger.error(
                `Failed to credit ledger for swap buy leg: ${creditResult.error}`
            );
            throw new Error(`Ledger credit failed: ${creditResult.error}`);
        }

        // Return a success result (matches the interface callers expect)
        return {
            status: "success",
            data: {
                id: creditResult.userEntry?.id,
                amount,
                currency: currency.toUpperCase(),
            },
        };
    }
}
