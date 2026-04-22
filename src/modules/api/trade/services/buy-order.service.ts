import { BadRequestException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    getBankProviderForPaymentMethod,
    getPaymentMethodForBankProvider,
    InboundPaymentInitializationResult,
    InboundPaymentProvider,
} from "@/modules/factory/bank/types";
import { InboundFiatPaymentService } from "@/modules/factory/bank/services/inbound-fiat-payment.service";
import { buildResponse } from "@/utils/api-response-util";
import { generateId } from "@/utils";
import { COMPANY_NAME, buyPaymentProvider, frontendUrl } from "@/config";
import { RateService } from "./rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import {
    CryptoWalletStatus,
    LedgerType,
    OrderCategory,
    OrderStatus,
    PaymentMethod,
    SweepStatus,
    TransactionStatus,
    TransactionType,
    User,
} from "@prisma/client";
import {
    AssetNotFoundException,
    IncompleteAccountSetupException,
    WalletAddressNotFoundException,
} from "../errors";
import { BuyQuoteResponse, getStreamlinedStatus } from "../interfaces/trade";
import { BuyCryptoOrderDto, InitiateBuyOrderDto } from "../dtos";
import { WsGateway } from "../gateway/v1";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService, PairedLedgerResult } from "./ledger/ledger.service";
import {
    EXTENDED_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
    MIN_BUY_AMOUNT_USDT,
} from "../constants";
import { generateUssdCode } from "@/libs/nomba/ussd-codes";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { TransactionService } from "@/modules/api/auth/services/transaction.service";

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
    private static readonly CRYPTO_AMOUNT_TOLERANCE = 1e-8;

    constructor(
        private readonly prisma: PrismaService,
        private readonly inboundFiatPaymentService: InboundFiatPaymentService,
        private readonly wsGateway: WsGateway,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly ledgerService: LedgerService,
        private readonly rateService: RateService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly distributedLockService: DistributedLockService,
        private readonly transactionService: TransactionService
    ) { }

    private async releaseReservedBuyLimit(payment: {
        userId: number;
        createdAt: Date;
        order?: {
            orderCategory?: OrderCategory;
            currency?: string | null;
            amount?: number | null;
        } | null;
    }): Promise<void> {
        if (!payment.order?.currency || !payment.order?.amount) {
            return;
        }

        await this.transactionService.releaseDailyLimitReservationForOrder({
            userId: payment.userId,
            orderCategory: payment.order.orderCategory ?? OrderCategory.BUY,
            currency: payment.order.currency,
            amount: Number(payment.order.amount),
            createdAt: payment.createdAt,
        });
    }

    private getSupportedBuyPaymentMethods(): PaymentMethod[] {
        return [PaymentMethod.NOMBA, PaymentMethod.FINCRA];
    }

    private getBuyPaymentProvider(paymentMethod?: PaymentMethod | null): InboundPaymentProvider {
        return getBankProviderForPaymentMethod(paymentMethod) || buyPaymentProvider;
    }

    private getBuyPaymentProviderLabel(paymentMethod?: PaymentMethod | null): string {
        return this.getBuyPaymentProvider(paymentMethod) === "fincra"
            ? "Fincra"
            : "Nomba";
    }

    private buildManualRefundAlertAmount(payment: {
        receivedAmount?: unknown;
        totalAmount?: unknown;
    }): number {
        const receivedAmount = Number(payment.receivedAmount);
        if (Number.isFinite(receivedAmount) && receivedAmount > 0) {
            return receivedAmount;
        }

        return Number(payment.totalAmount);
    }

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
            return this.calculateRangeFee(amount, data.fee);
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

    private calculateRangeFee(
        amount: number,
        ranges: { min: number; max: number; type: string; value: number }[],
    ): { fee: number; type: string } {
        for (const range of ranges) {
            if (amount >= range.min && amount < range.max) {
                return range.type === "percentage"
                    ? { fee: (amount * range.value) / 100, type: "percentage" }
                    : { fee: range.value, type: "flat" };
            }
        }

        throw new IncompleteAccountSetupException(
            "Amount is out of range.",
            HttpStatus.BAD_REQUEST
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

    private async getFallbackBuyWalletAddress(options: {
        userId: number;
        assetSymbol: string;
        normalizedDefaultNetwork: string | null;
    }): Promise<{
        address: string | null;
        network: string | null;
        destination_tag: string | null;
    } | null> {
        const { userId, assetSymbol, normalizedDefaultNetwork } = options;

        if (normalizedDefaultNetwork) {
            return this.prisma.cryptoWalletAddress.findFirst({
                where: {
                    userId,
                    assetSymbol,
                    status: CryptoWalletStatus.ACTIVE,
                    address: { not: null },
                    network: normalizedDefaultNetwork as any,
                },
                select: {
                    address: true,
                    network: true,
                    destination_tag: true,
                },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            });
        }

        const fallbackWalletAddresses = await this.prisma.cryptoWalletAddress.findMany({
            where: {
                userId,
                assetSymbol,
                status: CryptoWalletStatus.ACTIVE,
                address: { not: null },
                network: { not: null },
            },
            select: {
                address: true,
                network: true,
                destination_tag: true,
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        });

        if (fallbackWalletAddresses.length <= 1) {
            return fallbackWalletAddresses[0] ?? null;
        }

        this.logger.warn(
            `Ambiguous buy wallet fallback for user ${userId} asset ${assetSymbol}; refusing to choose between ${fallbackWalletAddresses.length} active network addresses`
        );

        throw new WalletAddressNotFoundException(
            `Unable to determine a safe wallet address for asset ${assetSymbol}. Please try again shortly.`,
            HttpStatus.CONFLICT
        );
    }

    private isSameCryptoAmount(requestedAmount: number, existingAmount?: number | null): boolean {
        if (typeof existingAmount !== "number") return false;
        return (
            Math.abs(requestedAmount - existingAmount) <=
            BuyOrderService.CRYPTO_AMOUNT_TOLERANCE
        );
    }

    private ensureIdempotentRequestMatchesExistingOrder(
        dto: BuyCryptoOrderDto,
        existingPayment: { order: { amount?: number | null; currency?: string | null } | null }
    ) {
        if (!existingPayment.order) {
            throw new BadRequestException(
                "Idempotency key is linked to an invalid order state"
            );
        }

        const requestedAsset = dto.asset.toUpperCase();
        const existingAsset = existingPayment.order.currency?.toUpperCase();
        if (existingAsset !== requestedAsset) {
            throw new BadRequestException(
                "Idempotency key already used for a different asset"
            );
        }

        if (!this.isSameCryptoAmount(dto.amount, existingPayment.order.amount)) {
            throw new BadRequestException(
                "Idempotency key already used with a different amount"
            );
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
        const currency = dto.asset.toUpperCase();
        const assetWalletWhere = {
            userId: user.id,
            assetCurrency: currency,
        };

        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        let assetWallet = await this.prisma.assetWallet.findFirst({
            where: assetWalletWhere,
        });

        if (!assetWallet) {
            throw new AssetNotFoundException(
                `Asset ${dto.asset} not found for the user`,
                HttpStatus.NOT_FOUND
            );
        }

        let normalizedDefaultNetwork = this.tradeHelpers.normalizeNetworkInput(
            assetWallet.defaultNetwork
        );

        if (!normalizedDefaultNetwork) {
            await this.walletAddressService.syncWallet(user.id, currency);

            assetWallet =
                (await this.prisma.assetWallet.findFirst({
                    where: assetWalletWhere,
                })) ?? assetWallet;

            normalizedDefaultNetwork = this.tradeHelpers.normalizeNetworkInput(
                assetWallet.defaultNetwork
            );
        }

        const fallbackWalletAddress =
            !assetWallet.depositAddress || !normalizedDefaultNetwork
                ? await this.getFallbackBuyWalletAddress({
                    userId: user.id,
                    assetSymbol: currency,
                    normalizedDefaultNetwork,
                })
                : null;

        let resolvedWalletAddress: {
            address: string;
            network: string | null;
            destinationTag: string | null;
        } | null = null;

        if (assetWallet.depositAddress && normalizedDefaultNetwork) {
            resolvedWalletAddress = {
                address: assetWallet.depositAddress,
                network: normalizedDefaultNetwork,
                destinationTag: assetWallet.destinationTag ?? null,
            };
        } else if (fallbackWalletAddress) {
            resolvedWalletAddress = {
                address: fallbackWalletAddress.address,
                network: fallbackWalletAddress.network,
                destinationTag: fallbackWalletAddress.destination_tag ?? null,
            };
        }

        const depositAddress = resolvedWalletAddress?.address ?? null;
        const defaultNetwork = resolvedWalletAddress?.network ?? null;
        const destinationTag = resolvedWalletAddress?.destinationTag ?? null;

        if (!depositAddress || !defaultNetwork) {
            throw new WalletAddressNotFoundException(
                `No wallet address found for asset ${dto.asset}`,
                HttpStatus.NOT_FOUND
            );
        }

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
            paymentGateway: getPaymentMethodForBankProvider(buyPaymentProvider),
            depositAddress,
            destinationTag,
        };
    }

    /**
     * Places a buy order for crypto
     * Creates provider-specific payment instructions for the user to complete.
     * Returns either temporary virtual account details or a hosted checkout URL.
     */
    async buyCryptoOrder(user: User, dto: BuyCryptoOrderDto) {
        return this.distributedLockService.withLock(
            `trade:buy:${user.id}`,
            async () => {
        // IDEMPOTENCY CHECK: Return existing order if same idempotencyKey was already used
        if (dto.idempotencyKey) {
            const existingPayment = await this.prisma.payment.findUnique({
                where: { idempotencyKey: dto.idempotencyKey },
                include: { order: true },
            });

            if (existingPayment?.order) {
                if (existingPayment.userId !== user.id) {
                    throw new BadRequestException(
                        "Idempotency key belongs to a different user"
                    );
                }

                this.ensureIdempotentRequestMatchesExistingOrder(dto, {
                    order: {
                        amount: existingPayment.order.amount,
                        currency: existingPayment.order.currency,
                    },
                });

                this.logger.warn(
                    `Duplicate buy request detected (Idempotency Key: ${dto.idempotencyKey}) - Returning existing order`
                );

                return this.buildExistingOrderResponse(existingPayment);
            }
        }

        // Minimum amount validation
        this.tradeHelpers.validateMinimumAmountInUSDT(dto.amount, dto.asset, MIN_BUY_AMOUNT_USDT, "buy");


        // EXISTING PENDING ORDER GUARD: Prevent duplicate orders for the same asset + amount
        // Catches cases where frontend generates a new idempotencyKey (e.g. modal re-opened)
        // but user already has a non-expired pending buy order for the same asset and amount.
        const existingPendingPayment = await this.prisma.payment.findFirst({
            where: {
                userId: user.id,
                status: TransactionStatus.PENDING,
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                type: TransactionType.P2P_PAYMENT,
                orderId: { not: null },
                order: {
                    orderCategory: OrderCategory.BUY,
                    currency: dto.asset.toUpperCase(),
                    status: OrderStatus.pending,
                    amount: {
                        gte: dto.amount - BuyOrderService.CRYPTO_AMOUNT_TOLERANCE,
                        lte: dto.amount + BuyOrderService.CRYPTO_AMOUNT_TOLERANCE,
                    },
                },
                // Only consider orders within the VA expiry window (35 min)
                createdAt: {
                    gt: new Date(Date.now() - 35 * 60 * 1000),
                },
            },
            include: { order: true },
            orderBy: {
                createdAt: "desc",
            },
        });

        if (existingPendingPayment?.order) {
            this.logger.warn(
                `User ${user.id} already has a pending buy order for ${dto.asset.toUpperCase()} (Order: ${existingPendingPayment.orderId}) - Returning existing order`
            );

            return this.buildExistingOrderResponse(existingPendingPayment);
        }

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

        const paymentGatewayData: InboundPaymentInitializationResult =
            await this.inboundFiatPaymentService.initializePayment({
                provider: buyPaymentProvider,
                user: userData,
                amount,
                callbackUrl: frontendUrl,
                modePreference: "virtual_account",
                allowCheckoutFallback: true,
            });

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
                        narration: `Buy ${responseData.cryptoBuyAmount} ${dto.asset.toUpperCase()}`,
                        transaction_note: `Buy ${responseData.cryptoBuyAmount} ${dto.asset.toUpperCase()}`,
                        sender: `${user.lastName} ${user.firstName}`,
                    },
                });
                await tx.payment.create({
                    data: {
                        reference: paymentGatewayData.reference,
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
                        paymentMethod: getPaymentMethodForBankProvider(
                            paymentGatewayData.provider
                        ),
                        sessionId: generateId({ type: "sessionId" }),
                        transactionId: generateId({ type: "transaction" }),
                        title: `${COMPANY_NAME} p2p buy order payment`,
                        narration: `Buy order payment for order with id ${order.id}`,
                        orderId: order.id,
                        isDebit: false,
                        expectedCurrency: responseData.currency,
                        idempotencyKey: dto.idempotencyKey || null,
                        externalReference:
                            paymentGatewayData.mode === "checkout"
                                ? paymentGatewayData.authorizationUrl
                                : null,
                        providerAccountReference:
                            paymentGatewayData.mode === "virtual_account"
                                ? paymentGatewayData.providerAccountReference
                                : null,
                        destinationBankAccountNumber:
                            paymentGatewayData.mode === "virtual_account"
                                ? paymentGatewayData.accountNumber
                                : null,
                        destinationBankAccountName:
                            paymentGatewayData.mode === "virtual_account"
                                ? paymentGatewayData.accountName
                                : null,
                        destinationBankName:
                            paymentGatewayData.mode === "virtual_account"
                                ? paymentGatewayData.bankName
                                : null,
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
            category: "transaction",
            currency: order.currency,
            transactionType: OrderCategory.BUY,
            enablePush: true,
        });

        // Generate USSD code if bank is supported
        const ussdCode =
            paymentGatewayData.mode === "virtual_account"
                ? generateUssdCode(
                    paymentGatewayData.bankCode,
                    paymentGatewayData.accountNumber,
                    amount
                )
                : null;

        return buildResponse({
            message:
                "Order placed successfully, Please proceed to make payment",
            data: {
                order: order,
                paymentInfo:
                    paymentGatewayData.mode === "virtual_account"
                        ? {
                            reference: paymentGatewayData.reference,
                            accountNumber: paymentGatewayData.accountNumber,
                            accountName: paymentGatewayData.accountName,
                            bankName: paymentGatewayData.bankName,
                            bankCode: paymentGatewayData.bankCode,
                            amount,
                            expiryAt: paymentGatewayData.expiryAt,
                            ussdCode,
                        }
                        : {
                            authorization_url:
                                paymentGatewayData.authorizationUrl,
                            reference: paymentGatewayData.reference,
                            amount: paymentGatewayData.amount,
                            expiryAt: paymentGatewayData.expiryAt,
                            ussdCode: null,
                        },
            },
        });
            },
            { ttlMs: 30000, maxWaitMs: 5000, strict: true },
        );
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
            } else if (existing.status === TransactionStatus.FAILED) {
                const provider = this.getBuyPaymentProvider(existing.paymentMethod);
                const receivedAmount = this.buildManualRefundAlertAmount(existing);

                // Payment was cancelled but funds still arrived — needs manual refund
                this.logger.error(
                    `Payment ${reference} was cancelled/failed but received funds — manual refund required`
                );
                await this.slackWebhookService.sendWebhookFailureAlert(
                    provider,
                    reference,
                    'Payment received for a cancelled/failed order. Manual refund required.',
                    {
                        paymentId: existing.id,
                        orderId: existing.orderId,
                        userId: existing.userId,
                        amount: receivedAmount,
                        expectedAmount: Number(existing.totalAmount),
                        receivedAmount,
                        status: existing.status,
                        senderAccountNumber: existing.senderAccountNumber,
                        senderAccountName: existing.senderAccountName,
                        senderBankName: existing.senderBankName,
                        externalReference: existing.externalReference,
                    }
                );
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

            // Credit the user's ledger (virtual balance) AND update order atomically
            // CRITICAL FIX: Previously credit happened OUTSIDE the transaction, creating a window
            // where user could get free crypto if the status update failed after credit succeeded.
            // Now both operations happen in a SINGLE atomic transaction.

            let creditResult: PairedLedgerResult;

            await this.prisma.$transaction(
                async (tx) => {
                    // Step 1: Credit user's ledger INSIDE the transaction
                    creditResult = await this.ledgerService.pairedCreditInTransaction(tx, {
                        userId: payment.userId,
                        currency: order.currency.toUpperCase(),
                        amount: order.amount,
                        type: LedgerType.BUY,
                        reference: `buy:${order.transactionId}`,
                        metadata: {
                            orderId: order.id,
                            paymentReference: reference,
                            omnibus: true,
                        },
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        createPlatformEntry: true
                    });

                    if (!creditResult.success) {
                        throw new Error(`Ledger credit failed: ${creditResult.error}`);
                    }

                    // Step 2: Mark payment as SUCCESS (same transaction)
                    await tx.payment.update({
                        where: { reference },
                        data: {
                            status: TransactionStatus.SUCCESS,
                            paymentStatus: TransactionStatus.SUCCESS,
                        },
                    });

                    // Step 3: Update Order with ledger entry link (same transaction)
                    await tx.order.update({
                        where: { id: order.id },
                        data: {
                            status: OrderStatus.completed,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.completed),
                            paymentStatus: TransactionStatus.SUCCESS,
                            fulfilled: true,
                            ledgerEntryId: creditResult.userEntry?.id,
                        },
                    });

                    // All three operations (credit, payment update, order update) are now atomic
                    // If ANY step fails, the ENTIRE transaction rolls back
                },
                {
                    maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
                    timeout: EXTENDED_TRANSACTION_TIMEOUT_MS,
                    isolationLevel: 'Serializable', // Ensures consistency
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
                category: "transaction",
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
                    notice: message,
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

    /**
     * Build a response for an existing order (used by idempotency check and pending order guard).
     * Calculates proper VA expiry from the payment creation time.
     */
    private buildExistingOrderResponse(existingPayment: any) {
        // VA expires 35 minutes after creation
        const VA_EXPIRY_MINUTES = 35;
        const expiryTime = existingPayment.createdAt.getTime() + VA_EXPIRY_MINUTES * 60 * 1000;
        const expiryAt = new Date(expiryTime).toISOString();

        // Don't return stale/near-expired VA details — force user to wait for expiry + create fresh order
        const remainingMs = expiryTime - Date.now();
        if (remainingMs < 2 * 60 * 1000) {
            throw new BadRequestException(
                'Your previous order has nearly expired. Please wait a moment and try again.'
            );
        }

        const paymentInfo = existingPayment.destinationBankAccountNumber
            ? {
                reference: existingPayment.reference,
                accountNumber: existingPayment.destinationBankAccountNumber || "",
                accountName: existingPayment.destinationBankAccountName || "",
                bankName: existingPayment.destinationBankName || "",
                bankCode: "",
                amount: Number(existingPayment.totalAmount),
                expiryAt,
                ussdCode: null,
            }
            : {
                authorization_url: existingPayment.externalReference || "",
                reference: existingPayment.reference,
                amount: Number(existingPayment.totalAmount),
                expiryAt,
                ussdCode: null,
            };

        return buildResponse({
            message: "Order already exists for this request",
            data: {
                order: existingPayment.order,
                paymentInfo,
            },
        });
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
     * Get the status of a buy order by payment reference.
     * Used as a polling fallback when WebSocket is unavailable.
     */
    async getBuyOrderStatus(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference, userId },
            include: { order: true },
        });

        if (!payment) {
            return buildResponse({
                message: "Payment not found",
                data: { status: "not_found" },
            });
        }

        const order = payment.order;

        // Derive client-facing status from payment + order state.
        // A cancelled order has payment.status = FAILED (set by cancelBuyOrder) and
        // order.status = cancelled. Distinguish it from a genuine payment failure so
        // the frontend can show the correct message to the user.
        let status: string;
        if (payment.status === TransactionStatus.SUCCESS) {
            status = "completed";
        } else if (payment.status === TransactionStatus.APPROVED) {
            status = "processing";
        } else if (payment.status === TransactionStatus.FAILED) {
            status = order?.status === OrderStatus.cancelled ? "cancelled" : "failed";
        } else {
            status = "pending";
        }

        return buildResponse({
            message: "Buy order status retrieved",
            data: {
                status,
                paymentStatus: payment.status,
                orderStatus: order?.status,
                orderId: order?.id,
                transactionId: order?.transactionId,
            },
        });
    }

    /**
     * Cancel a pending buy order.
     * Only cancels if payment is still PENDING (no money received yet).
     */
    async cancelBuyOrder(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference, userId, status: TransactionStatus.PENDING },
            include: { order: true, user: true },
        });

        if (!payment) {
            return buildResponse({
                message: "No pending payment found for this reference",
                data: { cancelled: false },
            });
        }

        // Atomic cancel: only cancel if payment is still PENDING.
        // Prevents race condition where webhook claims PENDING→APPROVED between
        // the findFirst above and this update.
        const cancelled = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.payment.updateMany({
                where: { id: payment.id, status: TransactionStatus.PENDING },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                },
            });

            if (updated.count === 0) {
                // Webhook claimed the payment between findFirst and now — abort cancel
                this.logger.warn(
                    `Cancel aborted: payment ${payment.id} no longer PENDING (webhook likely claimed it)`
                );
                return false;
            }

            if (payment.orderId) {
                await tx.order.update({
                    where: { id: payment.orderId },
                    data: {
                        status: OrderStatus.cancelled,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.cancelled
                        ),
                        paymentStatus: TransactionStatus.FAILED,
                    },
                });
            }

            return true;
        });

        if (!cancelled) {
            return buildResponse({
                message: "Order is already being processed and cannot be cancelled",
                data: { cancelled: false },
            });
        }

        await this.releaseReservedBuyLimit(payment);

        // Emit updates
        if (payment.order) {
            const updatedOrder = await this.prisma.order.findUnique({
                where: { id: payment.orderId },
            });
            if (updatedOrder) {
                this.emitTransactionUpdate(userId, updatedOrder);
            }
        }
        this.wsGateway.notifyWalletUpdate(userId);

        // Send cancellation notification (push + email)
        if (payment.order) {
            const message = `Your buy order of ${payment.order.amount} ${payment.order.currency.toUpperCase()} was cancelled. Transaction ID: ${payment.order.transactionId}.`;
            await this.notificationDispatcher.notify({
                userId: userId,
                title: "Buy order cancelled",
                body: `\uD83D\uDEAB ${message}`,
                category: "transaction",
                currency: payment.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: payment.user?.email || '',
                    transactionType: 'buy',
                    transactionId: payment.order.transactionId,
                    amount: String(payment.order.amount),
                    currency: payment.order.currency.toUpperCase(),
                    status: 'cancelled',
                    date: new Date().toISOString(),
                    notice: message,
                },
                enablePush: true,
            });
        }

        // Best-effort: release provider-side pending payment artifacts when applicable.
        await this.inboundFiatPaymentService
            .cleanupPendingPayment({
                provider: this.getBuyPaymentProvider(payment.paymentMethod),
                reference: payment.providerAccountReference || payment.reference,
            })
            .catch(() => {});

        this.logger.log(
            `Buy order cancelled by user ${userId} | Payment ref: ${reference}`
        );

        return buildResponse({
            message: "Buy order cancelled successfully",
            data: { cancelled: true },
        });
    }

    /**
     * Send a "still pending" notification when user closes the payment modal
     * without cancelling. The order stays active.
     */
    async notifyPendingBuyOrder(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference, userId, status: TransactionStatus.PENDING },
            include: { order: true },
        });

        if (!payment?.order) {
            return buildResponse({
                message: "No pending payment found",
                data: {},
            });
        }

        await this.notificationDispatcher.notify({
            userId,
            title: "Buy order still pending",
            body: `\u23F3 Your buy order of ${payment.order.amount} ${payment.order.currency.toUpperCase()} is still pending payment. Complete the bank transfer before the account expires. Transaction ID: ${payment.order.transactionId}.`,
            category: "transaction",
            currency: payment.order.currency,
            transactionType: OrderCategory.BUY,
            enablePush: true,
        });

        this.logger.log(
            `Pending buy order reminder sent to user ${userId} | Payment ref: ${reference}`
        );

        return buildResponse({
            message: "Pending reminder sent",
            data: {},
        });
    }

    /**
     * Record that the user clicked "I've sent the money".
     * Sets a timestamp so the stuck-order detector can alert admins
     * if the Nomba webhook doesn't arrive within a reasonable window.
     */
    async confirmPaymentSent(reference: string, userId: number) {
        const payment = await this.prisma.payment.findFirst({
            where: {
                reference,
                userId,
                status: { in: [TransactionStatus.PENDING, TransactionStatus.APPROVED] },
            },
            include: { order: true },
        });

        if (!payment) {
            return buildResponse({
                message: "No active payment found for this reference",
                data: { confirmed: false },
            });
        }

        // Only set once — ignore duplicate clicks
        if (!payment.paymentConfirmedByUser) {
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: { paymentConfirmedByUser: new Date() },
            });

            this.logger.log(
                `User ${userId} confirmed payment sent | Ref: ${reference} | Order: ${payment.orderId}`
            );
        }

        return buildResponse({
            message: "Payment confirmation recorded",
            data: { confirmed: true },
        });
    }

    /**
     * Detect buy orders where user confirmed payment but webhook hasn't arrived.
     * Called by a scheduled cron job.
     * Sends Slack alerts for admin intervention.
     */
    async detectStuckConfirmedOrders() {
        const stuckPayments = await this.prisma.payment.findMany({
            where: {
                status: TransactionStatus.PENDING,
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                type: TransactionType.P2P_PAYMENT,
                orderId: { not: null },
                // Only alert payments we haven't already alerted
                stuckAlertSentAt: null,
                paymentConfirmedByUser: {
                    not: null,
                    // User confirmed over 5 minutes ago but webhook never arrived
                    lt: new Date(Date.now() - 5 * 60 * 1000),
                },
            },
            include: {
                order: true,
                user: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
        });

        if (stuckPayments.length === 0) return 0;

        this.logger.warn(
            `Found ${stuckPayments.length} stuck buy orders where user confirmed payment but webhook didn't arrive`
        );

        for (const payment of stuckPayments) {
            try {
                const provider = this.getBuyPaymentProvider(payment.paymentMethod);
                const providerLabel = this.getBuyPaymentProviderLabel(payment.paymentMethod);

                await this.slackWebhookService.sendWebhookFailureAlert(
                    provider,
                    payment.reference,
                    `User confirmed payment sent but ${providerLabel} webhook never arrived. Manual verification required.`,
                    {
                        orderId: payment.orderId,
                        transactionId: payment.order?.transactionId,
                        amount: payment.order?.amount,
                        currency: payment.order?.currency,
                        userId: payment.userId,
                        userEmail: payment.user?.email,
                        userName: `${payment.user?.firstName} ${payment.user?.lastName}`,
                        confirmedAt: payment.paymentConfirmedByUser?.toISOString(),
                        paymentCreatedAt: payment.createdAt.toISOString(),
                    }
                );

                // Mark as alerted so we don't spam Slack on subsequent cron runs
                await this.prisma.payment.update({
                    where: { id: payment.id },
                    data: { stuckAlertSentAt: new Date() },
                });

                this.logger.warn(
                    `Slack alert sent for stuck order | Payment: ${payment.id} | Ref: ${payment.reference} | User: ${payment.userId}`
                );
            } catch (error) {
                this.logger.error(
                    `Failed to send Slack alert for stuck payment ${payment.id}: ${error.message}`
                );
            }
        }

        return stuckPayments.length;
    }

    /**
     * Cancel expired buy orders.
     * Called by a scheduled job to clean up orders whose virtual account expired
     * without receiving payment.
     * NOTE: Excludes orders where user confirmed they sent payment or where
     * partial funds were already received — those are routed to manual review
     * and the underpayment refund flow instead.
     */
    async cancelExpiredBuyOrders() {
        const expiredPayments = await this.prisma.payment.findMany({
            where: {
                status: TransactionStatus.PENDING,
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                type: TransactionType.P2P_PAYMENT,
                orderId: { not: null },
                // Don't auto-cancel orders where user confirmed payment — admin must review
                paymentConfirmedByUser: null,
                // Don't auto-cancel underpaid orders that already need the 2-hour refund path
                receivedAmount: null,
                // Orders older than 35 minutes (5 min buffer beyond 30 min VA expiry)
                createdAt: {
                    lt: new Date(Date.now() - 35 * 60 * 1000),
                },
            },
            include: { order: true, user: { select: { id: true, email: true } } },
        });

        this.logger.log(
            `Found ${expiredPayments.length} expired buy order payments to cancel`
        );

        for (const payment of expiredPayments) {
            try {
                // Atomic: only cancel if still PENDING — prevents race with late webhook
                const didCancel = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.payment.updateMany({
                        where: { id: payment.id, status: TransactionStatus.PENDING },
                        data: {
                            status: TransactionStatus.FAILED,
                            paymentStatus: TransactionStatus.FAILED,
                        },
                    });

                    if (updated.count === 0) {
                        this.logger.warn(
                            `Skipping expired cancel for payment ${payment.id} — no longer PENDING`
                        );
                        return false;
                    }

                    if (payment.orderId) {
                        await tx.order.update({
                            where: { id: payment.orderId },
                            data: {
                                status: OrderStatus.cancelled,
                                streamlinedStatus: getStreamlinedStatus(
                                    OrderStatus.cancelled
                                ),
                                paymentStatus: TransactionStatus.FAILED,
                            },
                        });
                    }

                    return true;
                });

                if (!didCancel) continue;

                await this.releaseReservedBuyLimit(payment);

                // Emit updates
                if (payment.order) {
                    this.emitTransactionUpdate(payment.userId, {
                        ...payment.order,
                        status: OrderStatus.cancelled,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.cancelled
                        ),
                    });
                }
                this.wsGateway.notifyWalletUpdate(payment.userId);

                // Send expired cancellation notification (push + email - user may not be in app)
                if (payment.order) {
                    const expiredMessage = `Your buy order of ${payment.order.amount} ${payment.order.currency.toUpperCase()} was cancelled because the payment window expired. Transaction ID: ${payment.order.transactionId}.`;
                    await this.notificationDispatcher.notify({
                        userId: payment.userId,
                        title: "Buy order expired",
                        body: `\uD83D\uDEAB ${expiredMessage}`,
                        category: "transaction",
                        currency: payment.order.currency,
                        transactionType: OrderCategory.BUY,
                        enableEmail: true,
                        emailPayload: {
                            email: payment.user?.email || '',
                            transactionType: 'buy',
                            transactionId: payment.order.transactionId,
                            amount: String(payment.order.amount),
                            currency: payment.order.currency.toUpperCase(),
                            status: 'cancelled',
                            date: new Date().toISOString(),
                            notice: expiredMessage,
                        },
                        enablePush: true,
                    });
                }

                // Best-effort: release provider-side pending payment artifacts when applicable.
                await this.inboundFiatPaymentService
                    .cleanupPendingPayment({
                        provider: this.getBuyPaymentProvider(payment.paymentMethod),
                        reference: payment.providerAccountReference || payment.reference,
                    })
                    .catch(() => {});

                this.logger.log(
                    `Cancelled expired buy order | Payment: ${payment.id} | Ref: ${payment.reference}`
                );
            } catch (error) {
                this.logger.error(
                    `Failed to cancel expired payment ${payment.id}: ${error.message}`
                );
            }
        }

        return expiredPayments.length;
    }

    /**
     * Cancel underpaid buy orders after a 2-hour grace period.
     * When a user pays less than the expected amount, the order stays PENDING.
     * After 2 hours this cron cancels the order and notifies the user + ops.
     * Ops must process the refund manually using the captured sender details.
     */
    async cancelUnderpaidBuyOrders() {
        const underpaidPayments = await this.prisma.payment.findMany({
            where: {
                paymentMethod: { in: this.getSupportedBuyPaymentMethods() },
                orderId: { not: null },
                receivedAmount: { not: null },
                status: TransactionStatus.PENDING,
                // 2-hour grace period for underpayments
                createdAt: {
                    lt: new Date(Date.now() - 2 * 60 * 60 * 1000),
                },
            },
            include: {
                order: true,
                user: { select: { id: true, email: true } },
            },
        });

        // Filter to those that are actually underpaid (receivedAmount < 99% of totalAmount)
        const toCancel = underpaidPayments.filter((p) => {
            const expected = Number(p.totalAmount);
            const received = Number(p.receivedAmount);
            return expected > 0 && received < expected * 0.99 && p.order?.status === OrderStatus.pending;
        });

        this.logger.log(
            `Found ${toCancel.length} underpaid buy orders to auto-cancel`,
        );

        for (const payment of toCancel) {
            try {
                const provider = this.getBuyPaymentProvider(payment.paymentMethod);
                const providerLabel = this.getBuyPaymentProviderLabel(payment.paymentMethod);

                const didCancel = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.payment.updateMany({
                        where: { id: payment.id, status: TransactionStatus.PENDING },
                        data: {
                            status: TransactionStatus.FAILED,
                            paymentStatus: TransactionStatus.FAILED,
                        },
                    });

                    if (updated.count === 0) return false;

                    if (payment.orderId) {
                        await tx.order.update({
                            where: { id: payment.orderId },
                            data: {
                                status: OrderStatus.cancelled,
                                streamlinedStatus: getStreamlinedStatus(
                                    OrderStatus.cancelled,
                                ),
                                paymentStatus: TransactionStatus.FAILED,
                            },
                        });
                    }

                    return true;
                });

                if (!didCancel) continue;

                await this.releaseReservedBuyLimit(payment);

                if (payment.order) {
                    this.emitTransactionUpdate(payment.userId, {
                        ...payment.order,
                        status: OrderStatus.cancelled,
                        streamlinedStatus: getStreamlinedStatus(
                            OrderStatus.cancelled,
                        ),
                    });
                }
                this.wsGateway.notifyWalletUpdate(payment.userId);

                // Send underpayment cancellation notification
                if (payment.order) {
                    const expected = Number(payment.totalAmount);
                    const received = Number(payment.receivedAmount);
                    const underpaidMessage = `Your payment of \u20a6${received} was less than the required \u20a6${expected}. Order #${payment.order.transactionId} has been cancelled. Our team will process your refund shortly.`;
                    await this.notificationDispatcher.notify({
                        userId: payment.userId,
                        title: "Buy order cancelled - underpayment",
                        body: `\u26a0\ufe0f ${underpaidMessage}`,
                        category: "transaction",
                        currency: payment.order.currency,
                        transactionType: OrderCategory.BUY,
                        enableEmail: true,
                        emailPayload: {
                            email: payment.user?.email || '',
                            transactionType: 'buy',
                            transactionId: payment.order.transactionId,
                            amount: String(payment.order.amount),
                            currency: payment.order.currency.toUpperCase(),
                            status: 'cancelled',
                            date: new Date().toISOString(),
                            notice: underpaidMessage,
                        },
                        enablePush: true,
                    });
                }

                // Slack alert with sender details for ops refund
                await this.slackWebhookService.sendWebhookFailureAlert(
                    provider,
                    payment.reference,
                    `Underpaid buy order auto-cancelled after 2h grace period. ` +
                    `Expected ₦${Number(payment.totalAmount)}, received ₦${Number(payment.receivedAmount)}. ` +
                    `Sender: ${payment.senderAccountName || 'N/A'} (${payment.senderAccountNumber || 'N/A'}) @ ${payment.senderBankName || 'N/A'}. ` +
                    `${providerLabel} refund/manual review required. ` +
                    `Ops must process refund of ₦${Number(payment.receivedAmount)}.`,
                    {
                        orderId: payment.orderId,
                        userId: payment.userId,
                        receivedAmount: Number(payment.receivedAmount),
                        senderAccountNumber: payment.senderAccountNumber,
                        senderAccountName: payment.senderAccountName,
                        senderBankName: payment.senderBankName,
                    },
                );

                // Best-effort: release provider-side pending payment artifacts when applicable.
                await this.inboundFiatPaymentService
                    .cleanupPendingPayment({
                        provider: provider,
                        reference: payment.providerAccountReference || payment.reference,
                    })
                    .catch(() => {});

                this.logger.log(
                    `Cancelled underpaid buy order | Payment: ${payment.id} | Ref: ${payment.reference} | Received: ₦${Number(payment.receivedAmount)} of ₦${Number(payment.totalAmount)}`,
                );
            } catch (error) {
                this.logger.error(
                    `Failed to cancel underpaid payment ${payment.id}: ${error.message}`,
                );
            }
        }

        return toCancel.length;
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
