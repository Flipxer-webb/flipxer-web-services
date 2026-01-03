import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { NombaBank } from "@/modules/factory/bank/providers/nomba.provider";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { COMPANY_NAME } from "@/config";
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
        private readonly slackWebhookService: SlackWebhookService
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
        const [rate, adminFeeInCrypto] = await Promise.all([
            this.prisma.cryptoRate.findUnique({ where: { currency } }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.SELL,
                        currency,
                    },
                },
            }),
        ]);

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

        if (!adminFeeInCrypto) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${dto.asset}`
            );
        }

        const quidaxFeeRes = await this.quidaxService.getWithdrawerFees({
            currency: assetExist.assetCurrency.toLowerCase(),
            network: assetExist.defaultNetwork,
        });

        const quidaxFeeInCrypto = await this.getFee(
            dto.amount,
            quidaxFeeRes.data
        );

        const assetValueInNaira = dto.amount * rate.sellRate;
        const quidaxFeeInNaira = quidaxFeeInCrypto.fee * rate.sellRate;
        const adminFeeInNaira = adminFeeInCrypto.fee * rate.sellRate;

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
        const { data } = await this.nombaService.initializePayment(
            userData,
            amount
        );

        const result = data as { link: string; reference: string; amount: number };

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
                        streamlinedStatus: getStreamlinedStatus(OrderStatus.pending),
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
            { maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS, timeout: EXTENDED_TRANSACTION_TIMEOUT_MS }
        );

        // Emit transaction update for new buy order
        this.emitTransactionUpdate(user.id, order);

        // Emit wallet update for buy order initiation
        this.wsGateway.notifyWalletUpdate(user.id);

        // Create and send notification for processing
        const message = `Your buy order of ${order.amount} ${order.currency.toUpperCase()} is pending payment. Transaction ID: ${order.transactionId}`;

        await this.sendNotification(user.id, "Buy order initiated", message, order.currency, OrderCategory.BUY);

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
     */
    async fulfillBuyOrder(reference: string) {
        this.logger.log(`Fulfilling buy order for payment reference: ${reference}`);

        const payment = await this.prisma.payment.findUnique({
            where: { reference },
            include: { user: true },
        });

        if (!payment) {
            this.logger.error(`Payment not found for reference: ${reference}`);
            return;
        }

        if (payment.status === TransactionStatus.SUCCESS) {
            this.logger.log(`Payment ${reference} already processed`);
            return;
        }

        const order = await this.prisma.order.findUnique({
            where: { id: payment.orderId },
        });

        if (!order) {
            this.logger.error(`Order not found for payment: ${payment.id}`);
            return;
        }

        // 1. Update Payment to SUCCESS (Money received)
        await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
                status: TransactionStatus.SUCCESS,
                paymentStatus: TransactionStatus.SUCCESS,
            },
        });

        // 2. Transfer Funds from Main Account to User Sub-Account (Quidax)
        try {
            const user = payment.user;
            if (!user.cryptoSubAccountId) {
                this.logger.error(`User ${user.id} has no crypto sub-account. Cannot fulfill order.`);
                // TODO: Alert admin or queue for retry
                return;
            }

            // Ensure user has a wallet address for this currency
            // This ensures the address exists on Quidax end for the sub-account
            const addresses = await this.walletAddressService.ensureWalletPaymentAddresses({
                userId: user.id,
                cryptoSubAccountId: user.cryptoSubAccountId,
                assetSymbol: order.currency,
            });

            if (!addresses || addresses.length === 0) {
                this.logger.error(`No wallet address found/created for user ${user.id} asset ${order.currency}`);
                // TODO: Alert admin
                return;
            }

            // Prefer the BEP20 network address as it's the most common default, or fallback to first
            const destinationAddress = addresses.find(a => a.network === 'bep20')
                || addresses.find(a => a.network === 'erc20')
                || addresses[0];

            this.logger.log(`Initiating Quidax internal transfer for Order ${order.id} to ${destinationAddress.address} on network ${destinationAddress.network}`);

            // Perform transfer from Main Account ("me") to User's Address
            const transferRes = await this.quidaxService.createWithdrawerRequest({
                user_id: "me", // "me" refers to the owner of the API Key (Main Account)
                currency: order.currency.toLowerCase(),
                amount: order.amount.toString(),
                fund_uid: destinationAddress.address,
                fund_uid2: destinationAddress.destination_tag || undefined,
                transaction_note: `Fulfillment for Order ${order.transactionId}`,
                narration: `Buy Order ${order.transactionId}`,
                reference: `${order.transactionId}_fulfill`,
                network: destinationAddress.network, // Pass the network to ensure correct address validation
            });

            if (transferRes.status !== "success") {
                this.logger.error(`Quidax transfer failed: ${JSON.stringify(transferRes)}`);
                // Order remains PENDING
                return;
            }

            this.logger.log(`Quidax transfer successful: ${transferRes.data.id}`);

            // 3. Update Order and Local Wallet (Only if transfer succeeded)
            await this.prisma.$transaction(
                async (tx) => {
                    // Update Order
                    await tx.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.completed,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.completed),
                            paymentStatus: TransactionStatus.SUCCESS,
                            providerOrderId: transferRes.data.id // Link the transfer ID
                        },
                    });

                    // Update Local Wallet
                    const assetWallet = await tx.assetWallet.findUnique({
                        where: {
                            userId_assetCurrency: {
                                userId: payment.userId,
                                assetCurrency: order.currency.toUpperCase(),
                            },
                        },
                    });

                    if (assetWallet) {
                        const currentBalance = parseFloat(assetWallet.balance.toString());
                        const newBalance = currentBalance + order.amount; // Use order.amount

                        await tx.assetWallet.update({
                            where: { id: assetWallet.id },
                            data: {
                                balance: newBalance.toString(),
                            },
                        });
                    }
                },
                { maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS, timeout: EXTENDED_TRANSACTION_TIMEOUT_MS }
            );

            // Notifications
            this.logger.log(`Buy order ${order.id} fulfilled and completed successfully`);

            const updatedOrder = await this.prisma.order.findUnique({ where: { id: order.id } });
            if (updatedOrder) {
                this.emitTransactionUpdate(payment.userId, updatedOrder);
            }
            this.wsGateway.notifyWalletUpdate(payment.userId);

            const message = `Your buy order of ${order.amount} ${order.currency.toUpperCase()} has been completed successfully.`;
            await this.sendNotification(payment.userId, "Buy order successful", message, order.currency, OrderCategory.BUY);

        } catch (error) {
            this.logger.error(`Failed to fulfill buy order (Transfer/Update Error) for order ${order.id}: ${error.message}`, error.stack);

            // Send Slack Alert for admin intervention
            await this.slackWebhookService.sendWebhookFailureAlert(
                'quidax',
                reference,
                error.message,
                {
                    orderId: order.id,
                    transactionId: order.transactionId,
                    amount: order.amount,
                    currency: order.currency,
                    userId: order.userId,
                    cryptoSubAccountId: payment.user.cryptoSubAccountId
                }
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
}
