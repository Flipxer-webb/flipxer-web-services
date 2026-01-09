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
    PaymentMethod,
    TransactionFeeCategory,
    User,
    UserNotificationTarget,
} from "@prisma/client";
import {
    AssetNotFoundException,
    GeneralTransactionException,
    IncompleteAccountSetupException,
    WalletAddressNotFoundException,
} from "../errors";
import {
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
} from "../../settings/errors";
import { BankDetailNotFoundException } from "../../banks/errors";
import { SellQuoteResponse, getStreamlinedStatus } from "../interfaces/trade";
import { InitiateSellOrderDto, SellCryptoOrderDto } from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { WalletManagementService } from "../../operations/services/wallet-management.service";
import { WithdrawalWebhookHandler } from "./webhook-handlers/withdrawal-webhook.handler";

/**
 * Sell Order Service
 * 
 * Handles all sell order operations including:
 * - Quote calculation for sell orders
 * - Order placement with crypto withdrawal
 * - Crypto-to-fiat conversions
 */
@Injectable()
export class SellOrderService {
    private readonly logger = new Logger("SellOrderService");

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly walletManagementService: WalletManagementService,
        private readonly withdrawalWebhookHandler: WithdrawalWebhookHandler
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
     * Gets the amount converted to Naira for sell orders
     */
    private async getAmountInNaira(
        currency: string,
        amount: number
    ): Promise<{ amount: number; rate: number } | null> {
        const rate = await this.prisma.cryptoRate.findUnique({
            where: { currency: currency.toUpperCase() },
        });

        if (!rate) return null;

        // Use buy rate for sell orders (what we pay the user)
        return {
            amount: amount * rate.buyRate,
            rate: rate.buyRate,
        };
    }

    /**
     * Gets a quote request for selling crypto
     */
    async sellCryptoQuoteRequest(user: User, dto: InitiateSellOrderDto) {
        const responseData = await this.calculateSellQuote(user, dto);

        return buildResponse({
            message: "Quotation for sell order retrieved successfully",
            data: responseData,
        });
    }

    /**
     * Calculates the quote for a sell order
     */
    async calculateSellQuote(
        user: User,
        dto: InitiateSellOrderDto,
        internal = false
    ): Promise<SellQuoteResponse> {
        // 1. Ensure crypto account is set up
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const currency = dto.asset.toUpperCase();

        // 2. Fetch bank detail, asset wallet, rate, and admin fee concurrently
        const [bankDetail, assetWallet, rate, adminFee] = await Promise.all([
            this.prisma.bankDetail.findFirst({
                where: { userId: user.id },
                select: {
                    accountName: true,
                    accountNumber: true,
                    bankName: true,
                },
            }),
            this.prisma.assetWallet.findFirst({
                where: {
                    userId: user.id,
                    assetCurrency: currency,
                },
            }),
            this.prisma.cryptoRate.findUnique({
                where: { currency },
            }),
            this.prisma.transactionFee.findUnique({
                where: {
                    category_currency: {
                        category: TransactionFeeCategory.BUY,
                        currency,
                    },
                },
            }),
        ]);

        // 3. Validate fetched records
        if (!bankDetail) {
            throw new BankDetailNotFoundException(
                "No bank detail found. Please setup your bank detail",
                HttpStatus.NOT_FOUND
            );
        }

        if (!assetWallet) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        const { depositAddress, defaultNetwork, assetCurrency } = assetWallet;

        if (!depositAddress || !defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

        if (!rate) {
            throw new CryptoRateNotFoundException(
                `No rate found for asset ${dto.asset}`
            );
        }

        if (!adminFee) {
            throw new CryptoTransactionFeeNotFoundException(
                `No transaction fee record found for asset ${dto.asset}`
            );
        }

        // 4. Fetch Quidax withdrawal fee and compute in crypto
        const { data: quidaxFeeData } =
            await this.quidaxService.getWithdrawerFees({
                currency: assetCurrency.toLowerCase(),
                network: defaultNetwork,
            });

        const { fee: quidaxFeeCrypto } = await this.getFee(
            dto.amount,
            quidaxFeeData
        );

        // 5. Calculations
        const buyRate = rate.buyRate;
        const adminFeeCrypto = adminFee.fee;

        const assetValueInNaira = dto.amount * buyRate;
        const quidaxFeeInNaira = quidaxFeeCrypto * buyRate;
        const adminFeeInNaira = adminFeeCrypto * buyRate;

        const totalCostInCrypto = dto.amount + quidaxFeeCrypto + adminFeeCrypto;
        const totalCostInFiat =
            assetValueInNaira + quidaxFeeInNaira + adminFeeInNaira;
        const totalCryptoToAdmin = dto.amount + adminFeeCrypto;

        // 6. Build response
        return {
            sellRate: buyRate,
            cryptoSellAmount: dto.amount,
            transactionFeeInCrypto: quidaxFeeCrypto + adminFeeCrypto,
            transactionFeeInFiat: quidaxFeeInNaira + adminFeeInNaira,
            totalCostInCrypto,
            totalCostInFiat,
            totalToReceiveInFiat: assetValueInNaira,
            currency: "NGN",
            bankDetail,
            ...(internal && { totalCryptoToAdmin }),
        };
    }

    /**
     * Places a sell order for crypto
     */
    async sellCryptoOrder(user: User, dto: SellCryptoOrderDto) {
        const responseData = await this.calculateSellQuote(user, dto, true);

        const sendAmountToSeller = +responseData.totalToReceiveInFiat;
        const totalCryptoToAdmin = +responseData.totalCryptoToAdmin;

        //step 1: send crypto to admin quidax account
        const reference = generateId({ type: "reference" });
        const adminAssetWallet = await this.quidaxService.getUserWallet({
            user_id: "me",
            currency: dto.asset.toLowerCase(),
        });

        if (!adminAssetWallet.data.deposit_address) {
            await this.quidaxService.createPaymentAddress({
                user_id: "me",
                currency: dto.asset.toLowerCase(),
            });

            throw new GeneralTransactionException(
                "Destination crypto address is being set, Please try again",
                HttpStatus.BAD_REQUEST
            );
        }

        // Perform internal transfer from User's Sub-Account to Main Account (FREE - no network fees)
        // We use the Main Account's specific ID (from the wallet fetch above) instead of "me"
        // because "me" in the request body is not resolved by the API when acting as a sub-user.
        const adminUserId = adminAssetWallet.data.user.id;

        const requestRes = await this.quidaxService.createWithdrawerRequest({
            amount: totalCryptoToAdmin.toString(),
            currency: dto.asset.toLowerCase(),
            narration: "flipxer sell order transaction",
            transaction_note: "flipxer sell order transaction",
            user_id: user.cryptoSubAccountId,
            fund_uid: adminUserId, // Explicit Main User ID ensures internal transfer
            reference: reference,
        });

        const amtFiat = await this.getAmountInNaira(
            dto.asset,
            responseData.cryptoSellAmount
        );

        const order = await this.prisma.order.create({
            data: {
                orderCategory: OrderCategory.SELL,
                status: OrderStatus.processing,
                streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                orderReference: reference,
                transactionId: generateId({ type: "transaction" }),
                providerOrderId: requestRes.data.id,
                userId: user.id,
                currency: requestRes.data.currency.toUpperCase(),
                narration: requestRes.data.narration,
                transaction_note: requestRes.data.transaction_note,
                recipient: requestRes.data.recipient.details.address,
                amount: +responseData.cryptoSellAmount,
                fee: +responseData.transactionFeeInCrypto,
                total: +responseData.totalCostInCrypto,
                totalToReceiveInFiat: sendAmountToSeller,
                sourceType: requestRes.data.type,
                destinationBankName: dto.bankDetail.bankName,
                destinationBankAccountNumber: dto.bankDetail.accountNumber,
                destinationBankAccountName: dto.bankDetail.accountName,
                destinationBankCode: dto.bankDetail.bankCode,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
            },
        });

        //step 2: once step 1 is successfully completed (webhook listener), send fund to user bank account from paystack main account

        // Emit transaction update for new sell order
        this.wsGateway.notifyTransactionUpdate(user.id, {
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

        // Sync wallet with Quidax to ensure balance is up to date
        await this.walletAddressService.syncWallet(user.id, dto.asset);

        // Invalidate admin wallet cache since company wallet received funds
        await this.walletManagementService.invalidateWalletCache();

        // Emit wallet update for sell order (balance changes with sell)
        this.wsGateway.notifyWalletUpdate(user.id);

        // Create and send notification for processing
        const message = `Your sell order of ${order.amount} ${order.currency.toUpperCase()} is processing. Transaction ID: ${order.transactionId}`;

        const createdNotification = await this.prisma.notification.create({
            data: {
                title: "Sell order initiated",
                body: message,
                userId: user.id,
                target: UserNotificationTarget.SINGLE,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                type: NotificationType.MESSAGE,
                status: NotificationStatus.APPROVED,
                senderId: null,
                transactionType: OrderCategory.SELL,
                currency: order.currency,
            },
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

        // Check if the withdrawal was completed immediately (e.g. internal transfer)
        // If so, trigger the handler immediately instead of waiting for webhook
        const requestStatus = requestRes.data.status?.toLowerCase();
        this.logger.log(`Sell Order ${order.id} | Provider Status: ${requestStatus} | Reference: ${reference}`);

        if (
            requestStatus === "successful" ||
            requestStatus === "success" ||
            requestStatus === "completed" ||
            requestStatus === "done"
        ) {
            this.logger.log(`Sell Order ${order.id} completed immediately - triggering handler`);

            // We don't await this to avoid blocking the response to the client
            // The handler uses a lock so it's safe even if a webhook comes in simultaneously
            this.withdrawalWebhookHandler.handle({
                orderReference: reference,
                status: OrderStatus.done,
            }).catch(err => {
                this.logger.error(`Error handling immediate completion for Sell Order ${order.id}: ${err.message}`, err.stack);
            });
        }

        return buildResponse({
            message: "Order placed successfully, Payment is processing",
            data: order,
        });
    }
}
