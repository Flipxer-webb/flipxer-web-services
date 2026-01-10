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
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderStatus,
    PaymentMethod,
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
import { ExposureCapService } from "@/modules/api/risk/services/exposure-cap.service";
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
        private readonly exposureService: ExposureCapService
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
            const existing = await this.prisma.payment.findUnique({
                where: { reference },
            });
            if (!existing) {
                this.logger.error(`Payment disappeared: ${reference}`);
            } else {
                this.logger.log(`Payment ${reference} already processed or processing (Status: ${existing.status})`);
            }
            return;
        }

        const payment = await this.prisma.payment.findUnique({
            where: { reference },
            include: { user: true },
        });

        if (!payment) return;

        const order = await this.prisma.order.findUnique({
            where: { id: payment.orderId },
        });

        if (!order) {
            this.logger.error(`Order not found for payment: ${payment.id}`);
            return;
        }

        try {
            const user = payment.user;

            // Ensure AssetWallet exists (Lazy creation if needed via ensureWalletPaymentAddresses)
            // Even though we don't transfer on Quidax, we need the local DB record to exist.
            if (user.cryptoSubAccountId) {
                await this.walletAddressService.ensureWalletPaymentAddresses({
                    userId: user.id,
                    cryptoSubAccountId: user.cryptoSubAccountId,
                    assetSymbol: order.currency,
                });
            }

            this.logger.log(
                `Processing Internal Ledger Credit for Buy Order ${order.id}`
            );

            // EXPOSURE CAP CHECK
            const isBreached = await this.exposureService.isExposureBreached(order.currency, order.amount);
            if (isBreached) {
                this.logger.warn(`Exposure Cap Breached for ${order.currency}: Blocking Buy Order ${order.id}`);

                // Mark Payment as SUCCESS (we took the money) but Order as PENDING_REVIEW
                await this.prisma.$transaction([
                    this.prisma.payment.update({
                        where: { reference },
                        data: {
                            status: TransactionStatus.SUCCESS,
                            paymentStatus: TransactionStatus.SUCCESS,
                        },
                    }),
                    this.prisma.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.pending_liquidity_review,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
                            paymentStatus: TransactionStatus.SUCCESS,
                            providerOrderId: "INTERNAL_LEDGER_HELD",
                        },
                    })
                ]);

                await this.sendNotification(
                    payment.userId,
                    "Order Pending Review",
                    `Your buy order for ${order.amount} ${order.currency} is pending a liquidity review. This usually resolves quickly.`,
                    order.currency,
                    OrderCategory.BUY
                );
                return;
            }

            // 3. Update Order, Payment, and Local Wallet (Atomic DB Transaction)
            await this.prisma.$transaction(
                async (tx) => {
                    // Mark Payment as SUCCESS
                    await tx.payment.update({
                        where: { reference },
                        data: {
                            status: TransactionStatus.SUCCESS,
                            paymentStatus: TransactionStatus.SUCCESS,
                        },
                    });

                    // Update Order
                    await tx.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.completed,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.completed),
                            paymentStatus: TransactionStatus.SUCCESS,
                            providerOrderId: "INTERNAL_LEDGER", // Internal fulfilled
                            fulfilled: true,
                        },
                    });

                    // Create/Update AssetWallet
                    // We use upsert to be safe, though ensureWalletPaymentAddresses should have handled creation.
                    // But to be strictly atomic on balance update:
                    const wallet = await tx.assetWallet.findUnique({
                        where: {
                            userId_assetCurrency: {
                                userId: payment.userId,
                                assetCurrency: order.currency.toUpperCase(),
                            }
                        }
                    });

                    if (wallet) {
                        await tx.assetWallet.update({
                            where: { id: wallet.id },
                            data: {
                                balance: { increment: order.amount }
                            }
                        });
                    } else {
                        // Should not happen if ensureWalletPaymentAddresses succeeded, but fallback:
                        throw new Error(`AssetWallet not found for user ${payment.userId} currency ${order.currency}`);
                    }
                },
                {
                    maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
                    timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
                }
            );

            // Notifications
            this.logger.log(
                `Buy order ${order.id} fulfilled (Ledger Credit) successfully`
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
                `Failed to fulfill buy order (Ledger Error) for order ${order.id}: ${error.message}`,
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

            // Send Slack Alert
            await this.slackWebhookService.sendWebhookFailureAlert(
                "quidax",
                reference,
                error.message,
                {
                    orderId: order.id,
                    transactionId: order.transactionId,
                    userId: order.userId,
                }
            );

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
     * Broker Model: Just verifying wallet existence.
     * Actual Balance update handled by SwapService Transaction.
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

        // Ensure wallet address exists on Quidax side (and local DB)
        await this.walletAddressService.ensureWalletPaymentAddresses({
            userId: user.id,
            cryptoSubAccountId: user.cryptoSubAccountId,
            assetSymbol: currency,
        });

        // 2. Broker Model: We do NOT send funds Quidax-side.
        // We return a mock response indicating readiness.
        this.logger.log(`Internal Buy Check passed for Swap Ref: ${reference}`);

        return {
            status: "success",
            data: {
                id: "INTERNAL_LEDGER_CHK",
                currency: currency,
                amount: amount.toString()
            }
        };
    }
}
