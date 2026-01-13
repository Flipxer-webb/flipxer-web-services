import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { COMPANY_NAME, frontendUrl } from "@/config";
import {
    LedgerType,
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    PaymentMethod,
    SweepStatus,
    TransactionFeeCategory,
    TransactionStatus,
    TransactionType,
    User,
    UserNotificationTarget,
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
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        @Inject(BankInjectionToken.NOMBA)
        private readonly nombaService: NombaBank,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly ledgerService: LedgerService
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
        const rate = await this.prisma.cryptoRate.findUnique({
            where: { currency: currency.toUpperCase() },
        });

        if (!rate) return null;

        return {
            amount: amount * rate.sellRate,
            rate: rate.sellRate,
        };
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
        const [rate] = await Promise.all([
            this.prisma.cryptoRate.findUnique({ where: { currency } }),
        ]);

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

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

        // Generate a deterministic checkout reference so the redirect callback can
        // include it and the frontend can verify payment status post-redirect.
        const checkoutReference = generateId({ type: "reference" });

        // Generate callback URL for Nomba to redirect after payment
        // The frontend checks for ?buy=success and then verifies using the ref
        // Dashboard is at root path (/) in the Next.js routing
        const callbackUrl = `${frontendUrl}/?buy=success&ref=${checkoutReference}`;

        const { data } = await this.nombaService.initializePayment(
            userData,
            amount,
            callbackUrl,
            checkoutReference
        );

        const result = data as {
            link: string;
            reference: string;
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

        await this.sendNotification(
            user.id,
            "Buy order initiated",
            message,
            order.currency,
            OrderCategory.BUY
        );

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

        // 2. Transfer Funds from Main Account to User Sub-Account (Quidax)
        try {
            const user = payment.user;
            if (!user.cryptoSubAccountId) {
                this.logger.error(
                    `User ${user.id} has no crypto sub-account. Cannot fulfill order.`
                );
                // Revert to PENDING for retry after admin fixes sub-account
                await this.prisma.payment.update({
                    where: { reference },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
                throw new Error(`User ${user.id} has no crypto sub-account`);
            }

            // Ensure user has a wallet address for this currency
            // This ensures the address exists on Quidax end for the sub-account
            const addresses =
                await this.walletAddressService.ensureWalletPaymentAddresses({
                    userId: user.id,
                    cryptoSubAccountId: user.cryptoSubAccountId,
                    assetSymbol: order.currency,
                });

            if (!addresses || addresses.length === 0) {
                this.logger.error(
                    `No wallet address found/created for user ${user.id} asset ${order.currency}`
                );
                // Revert to PENDING for retry
                await this.prisma.payment.update({
                    where: { reference },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
                throw new Error(`No wallet address for user ${user.id} asset ${order.currency}`);
            }

            // Prefer the BEP20 network address as it's the most common default, or fallback to first
            const destinationAddress =
                addresses.find((a) => a.network === "bep20") ||
                addresses.find((a) => a.network === "erc20") ||
                addresses[0];

            this.logger.log(
                `Initiating Quidax internal transfer for Order ${order.id} to sub-account ${user.cryptoSubAccountId}`
            );

            // Perform internal transfer from Main Account ("me") to User's Sub-Account (FREE - no network fees)
            // Using cryptoSubAccountId instead of blockchain address triggers Quidax's free internal transfer
            const transferRes =
                await this.quidaxService.createWithdrawerRequest({
                    user_id: "me", // "me" refers to the owner of the API Key (Main Account)
                    currency: order.currency.toLowerCase(),
                    amount: order.amount.toString(),
                    fund_uid: user.cryptoSubAccountId, // Sub-account ID for FREE internal transfer
                    transaction_note: `Fulfillment for Order ${order.transactionId}`,
                    narration: `Buy Order ${order.transactionId}`,
                    reference: `${order.transactionId}_fulfill`,
                });

            if (transferRes.status !== "success") {
                this.logger.error(
                    `Quidax transfer failed: ${JSON.stringify(transferRes)}`
                );
                // Revert payment to PENDING so next webhook retry can try again
                await this.prisma.payment.update({
                    where: { reference },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
                // Throw to trigger webhook retry (Nomba will get 5xx)
                throw new Error(`Quidax transfer failed: ${transferRes.message || JSON.stringify(transferRes)}`);
            }

            this.logger.log(
                `Quidax transfer successful: ${transferRes.data.id}`
            );

            // 3. Update Order, Payment, and Local Wallet (Only if transfer succeeded)
            // First, credit the user's ledger for the buy order
            const creditResult = await this.ledgerService.credit({
                userId: payment.userId,
                currency: order.currency.toUpperCase(),
                amount: order.amount,
                type: LedgerType.BUY,
                reference: `buy:${order.transactionId}`,
                metadata: {
                    transferId: transferRes.data.id,
                    orderId: order.id,
                    paymentReference: reference,
                },
                sweepStatus: SweepStatus.NOT_APPLICABLE, // Buy orders don't need sweep - funds come from platform
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
                    // Mark payment as SUCCESS now that Quidax transfer succeeded
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
                            providerOrderId: transferRes.data.id, // Link the transfer ID
                            fulfilled: true, // Mark as fulfilled so deposit webhook doesn't create duplicate RECEIVE
                            ledgerEntryId: creditResult.entry?.id, // Link to ledger entry
                        },
                    });

                    // Note: AssetWallet balance updates removed - Ledger is now the source of truth
                    // The ledger credit above (line ~550) handles the balance update
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
            await this.sendNotification(
                payment.userId,
                "Buy order successful",
                message,
                order.currency,
                OrderCategory.BUY
            );
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

    private async sendNotification(
        userId: number,
        title: string,
        body: string,
        currency: string,
        type: OrderCategory
    ) {
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
     * Executes the Internal Buy Leg of a Swap (Admin -> User)
     * Does NOT create a DB Order (SwapService handles that).
     * Returns the Quidax API response.
     * 
     * Virtual Balance: Credits the target currency to user's ledger
     */
    async executeInternalBuy(
        user: User,
        amount: number, // Amount of Crypto B to send to user
        currency: string,
        reference: string
    ) {
        // 1. Ensure User has Wallet for Crypto B
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "User crypto account not found",
                HttpStatus.BAD_REQUEST
            );
        }

        // Ensure wallet address exists on Quidax side (idempotent check)
        await this.walletAddressService.ensureWalletPaymentAddresses({
            userId: user.id,
            cryptoSubAccountId: user.cryptoSubAccountId,
            assetSymbol: currency,
        });

        // 2. Execute Internal Transfer (Admin Main Account -> User Sub-Account)
        this.logger.log(
            `Executing Internal Buy for Swap | User: ${user.id} | Amount: ${amount} ${currency} | Ref: ${reference}`
        );

        const transferRes = await this.quidaxService.createWithdrawerRequest({
            user_id: "me", // Source: Admin
            currency: currency.toLowerCase(),
            amount: amount.toString(),
            fund_uid: user.cryptoSubAccountId, // Destination: User
            transaction_note: "Flipxer Swap Buy Leg",
            narration: "Flipxer Swap Buy Leg",
            reference: reference, // Key for Atomicity
        });

        // Virtual Balance: Credit the target currency to user's ledger
        const creditResult = await this.ledgerService.credit({
            userId: user.id,
            currency: currency.toUpperCase(),
            amount,
            type: LedgerType.SWAP_IN,
            reference: `swap-buy:${reference}`,
            metadata: {
                transferId: transferRes.data.id,
                swapReference: reference,
            },
            sweepStatus: SweepStatus.NOT_APPLICABLE, // Swap buy doesn't need sweep - funds come from platform
        });

        if (!creditResult.success) {
            this.logger.error(
                `Failed to credit ledger for swap buy leg: ${creditResult.error}`
            );
            // Critical error - Quidax transfer succeeded but ledger credit failed
            // Continue and log for investigation - user received crypto on Quidax side
        }

        return transferRes;
    }
}
