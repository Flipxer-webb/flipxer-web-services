import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    LedgerType,
    OrderCategory,
    OrderStatus,
    User,
} from "@prisma/client";
import {
    AssetNotFoundException,
    GeneralTransactionException,
    IncompleteAccountSetupException,
    InsufficientBalanceException,
    WalletAddressNotFoundException,
} from "../errors";
import { BankDetailNotFoundException } from "../../banks/errors";
import { SellQuoteResponse, getStreamlinedStatus } from "../interfaces/trade";
import { InitiateSellOrderDto, SellCryptoOrderDto } from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { WalletManagementService } from "../../operations/services/wallet-management.service";
import { WithdrawalWebhookHandler } from "./webhook-handlers/withdrawal-webhook.handler";
import { LedgerService } from "./ledger/ledger.service";
import { TransactionMonitorService } from "./ledger/transaction-monitor.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";

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
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly walletManagementService: WalletManagementService,
        private readonly withdrawalWebhookHandler: WithdrawalWebhookHandler,
        private readonly ledgerService: LedgerService,
        private readonly transactionMonitorService: TransactionMonitorService,
        private readonly rateService: RateService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly distributedLockService: DistributedLockService
    ) { }


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

        // 2. Fetch bank detail, asset wallet, rate concurrently
        const [bankDetail, assetWallet, rate] = await Promise.all([
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

        const { depositAddress, defaultNetwork } = assetWallet;

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

        // Fee check removed per business plan (admin fees gone)

        // 4. Fees are no longer charged for sell orders
        const quidaxFeeCrypto = 0;
        const adminFeeCrypto = 0;

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
        return this.distributedLockService.withLock(
            `trade:sell:${user.id}`,
            async () => {
                const responseData = await this.calculateSellQuote(user, dto, true);

                // IDEMPOTENCY CHECK (TASK-008)
                // Check if an order with this idempotency key already exists to prevent double debits
                const existingOrder = await this.prisma.order.findFirst({
                    where: { orderReference: dto.idempotencyKey }
                });

                if (existingOrder) {
                    this.logger.warn(`Duplicate sell request detected (Idempotency Key: ${dto.idempotencyKey}) - Returning existing order`);
                    return buildResponse({
                        message: "Order placed successfully (Duplicate request processed)",
                        data: existingOrder,
                    });
                }

                const sendAmountToSeller = +responseData.totalToReceiveInFiat;
                const totalCryptoToAdmin = +responseData.totalCryptoToAdmin;

                // Virtual Balance: HOLD the crypto amount on user's ledger before proceeding
                const currency = dto.asset.toUpperCase();
                const holdAmount = totalCryptoToAdmin;

                 // Use idempotencyKey for deterministic hold reference
                // This physically prevents a second hold for the same request at the DB level
                const holdReference = `sell-hold:${dto.idempotencyKey}`;

                // Phase 2: Real-time monitoring for high-value transactions
                const monitorResult = await this.transactionMonitorService.validateBeforeExecution({
                    userId: user.id,
                    currency,
                    amount: holdAmount,
                    operationType: "SELL",
                    reference: holdReference,
                });

                if (!monitorResult.success) {
                    this.logger.warn(
                        `Transaction monitor blocked sell order | User: ${user.id} | Amount: ${holdAmount} ${currency} | Reason: ${monitorResult.reason}`
                    );
                    throw new GeneralTransactionException(
                        monitorResult.reason || "Transaction blocked by monitoring system",
                        HttpStatus.FORBIDDEN
                    );
                }

                const holdResult = await this.ledgerService.hold({
                    userId: user.id,
                    currency,
                    amount: holdAmount,
                    type: LedgerType.SELL,
                    reference: holdReference,
                    description: `Hold for sell order: ${dto.amount} ${currency}`,
                });

                if (!holdResult.success) {
                    // If hold fails because it already exists (race condition not caught by findFirst), 
                    // we should technically check if it's the SAME hold and proceed, or just fail.
                    // For safety, we fail and let the client retry (which will hit the findFirst check next time if it succeeded).
                    this.logger.error(
                        `Failed to hold funds for sell order: ${holdResult.error}`
                    );
                    throw new InsufficientBalanceException(
                        `Insufficient ${currency} balance. ${holdResult.error}`,
                        { currency, requiredAmount: holdAmount, error: holdResult.error }
                    );
                }

                // Wrap post-hold logic in try/catch to release hold if any step fails
                // This prevents funds from being stuck in HOLD status indefinitely
                try {
                    // Use idempotencyKey as the official Order Reference
                            const reference = dto.idempotencyKey;

                    // OMNIBUS VIRTUAL BALANCE SYSTEM
                    // In omnibus mode, crypto is already in the main wallet - no Quidax transfer needed
                    // We just settle the ledger hold to confirm the debit from user's virtual balance

                    this.logger.log(
                        `[Omnibus] Settling virtual balance for sell order | User: ${user.id} | Amount: ${totalCryptoToAdmin} ${dto.asset}`
                    );

                    // Settle the hold (converts HOLD to confirmed DEBIT)
                    // DOUBLE ENTRY: releaseHoldWithPlatformEntry ensures platform liability (credit) is created (reduced)
                    const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
                        holdReference,
                        settle: true, // settle = true converts hold to debit
                        description: `Sell order: ${reference}`,
                        createPlatformEntry: true
                    });

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

                    // Create order - remains in PROCESSING
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
                            sender: `${user.lastName} ${user.firstName}`,
                            ledgerEntryId: settleResult.userEntry?.id,
                        },
                    });

                    // Initiate payout directly. Do NOT update order status to done.
                    // Let Nomba's actual webhook handle success/failure and final status update.
                    this.logger.log(`[Omnibus] Sell Order ${order.id} - initiating fiat payout | Reference: ${reference}`);

                    await this.withdrawalWebhookHandler.initiateFiatPayout(order);

                    // Notify frontend (modal stays in "Processing Your Sale")
                    this.wsGateway.notifyTransactionUpdate(user.id, {
                        type: "transaction_update",
                        transaction: {
                            id: order.id,
                            transactionId: order.transactionId,
                            status: OrderStatus.processing,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.processing),
                            orderCategory: order.orderCategory,
                            amount: Number(order.amount),
                            currency: order.currency,
                            createdAt: order.createdAt,
                            updatedAt: order.updatedAt,
                        },
                    });
                    // Emit wallet update for sell order (balance changes with sell)

                    this.wsGateway.notifyWalletUpdate(user.id);

                    // Create and send notification for processing
                    await this.notificationDispatcher.notify({
                        userId: user.id,
                        title: "Sell order processing",
                        body: `Your sell of ${order.amount} ${order.currency.toUpperCase()} is processing. ₦${sendAmountToSeller.toLocaleString()} will be sent to your bank account shortly. Transaction ID: ${order.transactionId}`,
                        category: "transaction",
                        currency: order.currency,
                        transactionType: OrderCategory.SELL,
                        enablePush: true,
                    });

                    this.logger.log(`Sell Order ${order.id} payout initiated successfully. Awaiting Nomba webhook.`);

                    return buildResponse({
                        message: "Order placed successfully, Payment is processing",
                        data: order,
                    });

                } catch (error) {
                    this.logger.error(`Sell order failed during payout initiation: ${error.message}`);

                    // If payout initiation failed after hold was settled, refund the user
                    try {
                        await this.ledgerService.pairedCredit({
                            userId: user.id,
                            currency,
                            amount: totalCryptoToAdmin,
                            type: LedgerType.ADJUSTMENT,
                            reference: `${holdReference}:refund`,
                            description: `Refund: Payout initiation failed - ${error.message}`,
                            createPlatformEntry: true
                        });

                        this.logger.log(`Successfully refunded ${totalCryptoToAdmin} ${currency} due to payout initiation failure`);
                    } catch (refundError) {
                        this.logger.error(`CRITICAL: Failed to refund after payout initiation failure: ${refundError.message}`);

                        await this.slackWebhookService?.sendAlert?.('SELL_ORDER_REFUND_FAILED', {
                            text: `🚨 CRITICAL: Sell payout initiation failed AND refund failed!\n` +
                                  `User: ${user.id} | Amount: ${totalCryptoToAdmin} ${currency} | Ref: ${dto.idempotencyKey}`,
                        });
                    }

                    // Fallback: try to release hold (safe if already settled)
                    try {
                        await this.ledgerService.releaseHold(
                            holdReference, 
                            false, 
                            `Sell order failed: ${error.message}`
                        );
                    } catch (releaseError) {
                        this.logger.error(`Failed to release hold: ${releaseError.message}`);
                    }

                    throw new HttpException(
                        'Sell order failed - payout could not be initiated. Please try again.',
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
            },
            { ttlMs: 30000, maxWaitMs: 5000, strict: true }
        );
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
        // DOUBLE ENTRY: releaseHoldWithPlatformEntry ensures platform liability (credit) is created (reduced)
        const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
            holdReference,
            settle: true, // settle = true converts hold to debit
            description: `Swap sell leg: ${reference}`,
            createPlatformEntry: true
        });

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
                id: settleResult.userEntry?.id,
                amount,
                currency: currency.toUpperCase(),
            },
        };
    }
}
