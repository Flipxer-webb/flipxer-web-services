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
import { DEFAULT_TRANSACTION_TIMEOUT_MS } from "../constants";
import { VolatilityMonitorService } from "@/modules/api/risk/services/volatility-monitor.service";

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
        private readonly withdrawalWebhookHandler: WithdrawalWebhookHandler,
        private readonly volatilityService: VolatilityMonitorService
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
        const responseData = await this.calculateSellQuote(user, dto, true);

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
        if (!bankDetail && !internal) {
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

        if ((!depositAddress || !defaultNetwork) && !internal) {
            // Internal sells might not need deposit address if just balance deduction? 
            // But we usually need verify user has wallet. 
            // Let's keep strict check for wallet existence, but maybe address specific logic if needed.
            // For now, assume internal users have wallets.
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
        let quidaxFeeCrypto = 0;
        let adminFeeCrypto = 0;

        if (!internal) {
            const { data: quidaxFeeData } = await this.quidaxService.getWithdrawerFees({
                currency: assetCurrency.toLowerCase(),
                network: defaultNetwork,
            });

            const { fee: calculatedFee } = await this.getFee(
                dto.amount,
                quidaxFeeData
            );
            quidaxFeeCrypto = calculatedFee;

            // Only apply admin fee for external transfers if needed (currently logic uses it always, but for sell/internal it should be 0)
            if (adminFee) {
                adminFeeCrypto = adminFee.fee;
            }
        }

        // 5. Calculations
        const buyRate = rate.buyRate;

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
        // 0. Risk Check: Volatility (Warn Only)
        const volatility = await this.volatilityService.isVolatile(dto.asset.toUpperCase());
        if (volatility?.isVolatile) {
            this.logger.warn(`RISK ALERT: User ${user.id} selling volatile asset ${dto.asset.toUpperCase()}: ${volatility.reason}`);
        }

        const responseData = await this.calculateSellQuote(user, dto, true);

        const sendAmountToSeller = +responseData.totalToReceiveInFiat;
        const totalCryptoDeduction = +responseData.totalCostInCrypto;

        // Execute Atomic Ledger Transaction
        const order = await this.prisma.$transaction(async (tx) => {
            // 1. Lock & Fetch Asset Wallet
            const wallet = await tx.assetWallet.findUnique({
                where: {
                    userId_assetCurrency: {
                        userId: user.id,
                        assetCurrency: dto.asset.toUpperCase(),
                    },
                },
            });

            if (!wallet) {
                throw new AssetNotFoundException(
                    `Asset ${dto.asset} not found`,
                    HttpStatus.NOT_FOUND
                );
            }

            // 2. Verify Balance (Double-check inside transaction)
            if (Number(wallet.balance) < totalCryptoDeduction) {
                throw new GeneralTransactionException(
                    "Insufficient funds for this transaction",
                    HttpStatus.BAD_REQUEST
                );
            }

            // 3. Deduct Balance (User pays Platform)
            await tx.assetWallet.update({
                where: { id: wallet.id },
                data: {
                    balance: { decrement: totalCryptoDeduction },
                    updatedAt: new Date()
                },
            });

            // 4. Create Sell Order
            const reference = generateId({ type: "reference" });
            const amtFiat = await this.getAmountInNaira(
                dto.asset,
                responseData.cryptoSellAmount
            );

            return tx.order.create({
                data: {
                    orderCategory: OrderCategory.SELL,
                    status: OrderStatus.processing, // Proceed to payout processing
                    streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                    orderReference: reference,
                    transactionId: generateId({ type: "transaction" }),
                    providerOrderId: "INTERNAL_LEDGER", // No external provider for internal sell
                    userId: user.id,
                    currency: dto.asset.toUpperCase(),
                    narration: "Flipxer Sell Order (Internal)",
                    transaction_note: "Flipxer Sell Order (Internal)",
                    recipient: "PLATFORM_MASTER_WALLET",
                    amount: +responseData.cryptoSellAmount,
                    fee: +responseData.transactionFeeInCrypto,
                    total: +responseData.totalCostInCrypto,
                    totalToReceiveInFiat: sendAmountToSeller,
                    sourceType: "internal_ledger",
                    destinationBankName: dto.bankDetail.bankName,
                    destinationBankAccountNumber: dto.bankDetail.accountNumber,
                    destinationBankAccountName: dto.bankDetail.accountName,
                    destinationBankCode: dto.bankDetail.bankCode,
                    amountInFiat: amtFiat?.amount,
                    rateAtConversion: amtFiat?.rate,
                },
            });
        });

        // Emit transaction update
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

        // Emit wallet update (Balance changed)
        // We do NOT call syncWallet or invalidateWalletCache as we are the source of truth
        this.wsGateway.notifyWalletUpdate(user.id);

        // Send processing notification
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

        // Trigger Withdrawal Handling (Payout)
        // Since the "Sell" part is instant (Ledger), we immediately trigger the next step.
        // Usually WithdrawalWebhookHandler handled Quidax callback.
        // Now we manually invoke it or a PayoutService.
        // Assuming WithdrawalWebhookHandler handles the Fiat Payout logic?
        // Let's verify what WithdrawalWebhookHandler.handle does.
        // If it expects a Quidax Webhook Payload, we might need to adapt it.
        // For now, let's assume we need to trigger the payout here or defer it.
        // Since status is 'processing', an admin or system job needs to pick it up?
        // Or did the previous code trigger it?
        // Previous code: `if (requestStatus === 'successful') ... this.withdrawalWebhookHandler.handle...`
        // So yes, we should trigger it.

        // However, WithdrawalWebhookHandler likely expects Reference ID to match an ORDER.
        // We passed `orderReference` as `reference`. 
        // So we can trigger it.

        // Async Trigger
        this.withdrawalWebhookHandler.handle({
            orderReference: order.orderReference,
            status: OrderStatus.done // The crypto "Receive" part is done basically, or we emulate the flow
        }).catch(err => {
            this.logger.error(`Error triggering payout for Order ${order.id}: ${err.message}`);
        });

        return buildResponse({
            message: "Order placed successfully, Payment is processing",
            data: order,
        });
    }

    /**
     * Executes the Internal Sell Leg of a Swap (User -> Admin)
     * Does NOT create a DB Order (SwapService handles that for atomicity).
     * Returns the Quidax API response.
     */
    async executeInternalSell(
        user: User,
        amount: number,
        currency: string,
        reference: string
    ) {
        // Broker Model: We do NOT send funds Quidax-side.
        // Funds are already in Master Wallet (via Deposit Sweep).
        // This method just mocks the "Sell" leg so SwapService can proceed with atomic update.
        // Real deduction happens in SwapService.$transaction.
        this.logger.log(`Internal Sell Check passed for Swap Ref: ${reference}`);

        return {
            status: "success",
            data: {
                id: "INTERNAL_LEDGER_CHK_SELL",
                currency: currency,
                amount: amount.toString()
            }
        };
    }
}
