import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { RateService } from "./rate.service";
import {
    LedgerType,
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
    InsufficientBalanceException,
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
import { LedgerService } from "./ledger/ledger.service";

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
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService
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
        try {
            const rate = await this.rateService.getAssetRate(currency.toUpperCase());
            // Use buy rate for sell orders (what we pay the user)
            return {
                amount: amount * rate.buyRate,
                rate: rate.buyRate,
            };
        } catch {
            return null;
        }
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
            this.rateService.getAssetRate(currency),
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
        const responseData = await this.calculateSellQuote(user, dto, true);

        const sendAmountToSeller = +responseData.totalToReceiveInFiat;
        const totalCryptoToAdmin = +responseData.totalCryptoToAdmin;

        // Virtual Balance: HOLD the crypto amount on user's ledger before proceeding
        const currency = dto.asset.toUpperCase();
        const holdAmount = totalCryptoToAdmin;
        const holdReference = `sell-hold:${generateId({ type: "reference" })}`;

        const holdResult = await this.ledgerService.hold({
            userId: user.id,
            currency,
            amount: holdAmount,
            type: LedgerType.SELL,
            reference: holdReference,
            description: `Hold for sell order: ${dto.amount} ${currency}`,
        });

        if (!holdResult.success) {
            this.logger.error(
                `Failed to hold funds for sell order: ${holdResult.error}`
            );
            throw new InsufficientBalanceException(
                `Insufficient ${currency} balance. ${holdResult.error}`,
                { currency, requiredAmount: holdAmount, error: holdResult.error }
            );
        }

        // Generate reference for the order
        const reference = generateId({ type: "reference" });

        // OMNIBUS VIRTUAL BALANCE SYSTEM
        // In omnibus mode, crypto is already in the main wallet - no Quidax transfer needed
        // We just settle the ledger hold to confirm the debit from user's virtual balance

        this.logger.log(
            `[Omnibus] Settling virtual balance for sell order | User: ${user.id} | Amount: ${totalCryptoToAdmin} ${dto.asset}`
        );

        // Settle the hold (converts HOLD to confirmed DEBIT)
        const settleResult = await this.ledgerService.releaseHold(
            holdReference,
            true, // settle = true converts hold to debit
            `Sell order: ${reference}`
        );

        if (!settleResult.success) {
            this.logger.error(
                `Failed to settle hold for sell order: ${settleResult.error}`
            );
            throw new GeneralTransactionException(
                `Failed to process sell order: ${settleResult.error}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

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
                userId: user.id,
                currency: dto.asset.toUpperCase(),
                narration: "Flipxer sell order",
                transaction_note: "Flipxer sell order",
                amount: +responseData.cryptoSellAmount,
                fee: +responseData.transactionFeeInCrypto,
                total: +responseData.totalCostInCrypto,
                totalToReceiveInFiat: sendAmountToSeller,
                sourceType: "omnibus", // Flag: no Quidax transfer, virtual balance only
                destinationBankName: dto.bankDetail.bankName,
                destinationBankAccountNumber: dto.bankDetail.accountNumber,
                destinationBankAccountName: dto.bankDetail.accountName,
                destinationBankCode: dto.bankDetail.bankCode,
                amountInFiat: amtFiat?.amount,
                rateAtConversion: amtFiat?.rate,
                ledgerEntryId: settleResult.entry?.id, // Link to ledger entry (from settled hold)
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
        // OMNIBUS: Sell order is "complete" from ledger perspective immediately
        // Trigger fiat payout handler since virtual balance is already debited
        this.logger.log(`[Omnibus] Sell Order ${order.id} ledger debit complete - triggering fiat payout | Reference: ${reference}`);

        // Trigger handler immediately since the "crypto transfer" (ledger debit) is done
        // We don't await this to avoid blocking the response to the client
        this.withdrawalWebhookHandler.handle({
            orderReference: reference,
            status: OrderStatus.done,
        }).catch(err => {
            this.logger.error(`Error handling omnibus sell order completion for Order ${order.id}: ${err.message}`, err.stack);
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
     * 
     * Virtual Balance: HOLD -> Settle (debit) the source currency
     */
    async executeInternalSell(
        user: User,
        amount: number,
        currency: string,
        reference: string
    ) {
        const currencyUpper = currency.toUpperCase();
        const holdReference = `swap-sell-hold:${reference}`;

        // Virtual Balance: HOLD the crypto amount on user's ledger
        const holdResult = await this.ledgerService.hold({
            userId: user.id,
            currency: currencyUpper,
            amount,
            type: LedgerType.SWAP_OUT,
            reference: holdReference,
            description: `Hold for swap sell leg: ${amount} ${currencyUpper}`,
        });

        if (!holdResult.success) {
            this.logger.error(
                `Failed to hold funds for swap sell leg: ${holdResult.error}`
            );
            throw new InsufficientBalanceException(
                `Insufficient ${currencyUpper} balance for swap. ${holdResult.error}`,
                { currency: currencyUpper, requiredAmount: amount, error: holdResult.error }
            );
        }

        // OMNIBUS VIRTUAL BALANCE SYSTEM
        // Crypto is already in main omnibus wallet - no Quidax transfer needed
        // We just settle the ledger hold to confirm the debit from user's virtual balance

        this.logger.log(
            `[Omnibus] Executing Internal Sell for Swap | User: ${user.id} | Amount: ${amount} ${currency} | Ref: ${reference}`
        );

        // Settle the hold (converts HOLD to confirmed DEBIT)
        const settleResult = await this.ledgerService.releaseHold(
            holdReference,
            true, // settle = true converts hold to debit
            `Swap sell leg: ${reference}`
        );

        if (!settleResult.success) {
            this.logger.error(
                `Failed to settle hold for swap sell leg: ${settleResult.error}`
            );
            throw new Error(`Ledger settle failed: ${settleResult.error}`);
        }

        // Return a success result (matches interface callers expect)
        return {
            status: "success",
            data: {
                id: settleResult.entry?.id,
                amount,
                currency: currency.toUpperCase(),
            },
        };
    }
}
