import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { CoinGeckoService } from "@/modules/factory/trading/providers/coingecko/services";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { GetUserWalletResponse, IPaymentAddress } from "@/libs/quidax";
import {
    AccountCreationException,
    AssetNotFoundException,
    GeneralTransactionException,
    IncompleteAccountSetupException,
    OutOfRangeException,
    QuidaxApiException,
    TransactionCompletedException,
    TransactionNotFoundException,
    UnknownFeeStructureException,
    WalletAddressNotFoundException,
} from "../errors";
import {
    BuyQuoteResponse,
    DepositTransaction,
    getStreamlinedStatus,
    IWalletAddressCreatedSuccess,
    IWalletUpdated,
    OrderType,
    SellQuoteResponse,
    SupportedAssets,
    SwapTransactionHandlerOptions,
    TradingPair,
    WithdrawerTransactionHandlerOptions,
} from "../interfaces/trade";
import {
    CryptoWalletAddress,
    CryptoWalletStatus,
    NetworkTypes,
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    OrderCategory,
    OrderSide,
    OrderStatus,
    PaymentMethod,
    TransactionFeeCategory,
    TransactionStatus,
    TransactionType,
    User,
    UserNotificationTarget,
} from "@prisma/client";
import {
    CancelWithdrawerRequestDto,
    ConfirmInstantSwapQuoteDto,
    GetCryptoWithdrawerFeeDto,
    GetWalletDto,
    GetWalletAddressesDto,
    InitiateBuyOrderDto,
    InitiateSellOrderDto,
    InitiateWalletCreationDto,
    PlaceInstantSwapRequestDto,
    PurchaseLimitBuyDto,
    RefreshInstantSwapRequestDto,
    SellCryptoOrderDto,
    SupportedPaymentMethodDto,
    VerifyWalletAddressDto,
    WithdrawerRequestDto,
} from "../dtos";
import { UserNotFoundException } from "../../user";
import { CryptoAccountQueueProducer } from "../queues/producers/producer.service";
import { GetPaymentAddressByIdOptions } from "@/libs/quidax";
import { generateId } from "@/utils";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { FincraBank } from "@/modules/factory/bank/providers/fincra.provider";
import { FincraInitiationResponseResultType } from "@/modules/factory/bank/types/fincra";
import { COMPANY_NAME } from "@/config";
import {
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
} from "../../settings/errors";
import { BankDetailNotFoundException } from "../../banks/errors";
import { NotificationEvent } from "../../notification/events/notification.event";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { WsGateway } from "../gateway/v1";
import { WalletManagementService } from "../../operations/services/wallet-management.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { TradeHelpersService } from "./trade-helpers.service";
import { WalletAddressService } from "./wallet-address.service";
import { BuyOrderService } from "./buy-order.service";
import { SellOrderService } from "./sell-order.service";
import { SwapService } from "./swap.service";
import { SendService } from "./send.service";
import { WebhookHandlerService } from "./webhook-handler.service";
import {
    SUPPORTED_ASSETS,
    QUOTE_EXPIRY_MS,
    DEFAULT_TRANSACTION_TIMEOUT_MS,
    EXTENDED_TRANSACTION_TIMEOUT_MS,
    DEFAULT_TRANSACTION_MAX_WAIT_MS,
} from "../constants";

@Injectable()
export class TradingService {
    private readonly logger = new Logger("TradeService");

    private logWalletFlow(step: string, payload: Record<string, unknown> = {}) {
        const safePayload = this.tradeHelpers.safeJsonStringify(payload);
        console.log(`[WalletFlow] ${step}`, payload);
        this.logger.log(`${step} | ${safePayload}`, "WalletFlow");
    }

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly cryptoAccountQueueProducer: CryptoAccountQueueProducer,
        @Inject(BankInjectionToken.FINCRA)
        private readonly fincraService: FincraBank,
        private readonly notificationEvent: NotificationEvent,
        private readonly notificationMessage: NotificationMessageService,
        private readonly wsGateway: WsGateway,
        @Inject(TradingInjectionToken.COINGECKO)
        private readonly coinGeckoService: CoinGeckoService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        private readonly walletManagementService: WalletManagementService,
        private readonly lockService: DistributedLockService,
        private readonly tradeHelpers: TradeHelpersService,
        private readonly walletAddressService: WalletAddressService,
        private readonly buyOrderService: BuyOrderService,
        private readonly sellOrderService: SellOrderService,
        private readonly swapService: SwapService,
        private readonly sendService: SendService,
        private readonly webhookHandlerService: WebhookHandlerService
    ) { }

    getSupportedAssets() {
        const assets = Object.values(SupportedAssets);

        return buildResponse({
            message: "Supported assets retrieved",
            data: assets,
        });
    }

    async getSupportedPaymentMethod(query: SupportedPaymentMethodDto) {
        const result = await this.quidaxService.getPaymentMethods(query);

        return buildResponse({
            message: "Supported payment methods retrieved",
            data: result.data,
        });
    }

    async getPurchaseLimitForBuy(query: PurchaseLimitBuyDto) {
        const result = await this.quidaxService.getPurchaseLimitForBuy(query);

        return buildResponse({
            message: "Purchase limit retrieved",
            data: result.data,
        });
    }

    getSupportedNetworks() {
        const networks = Object.values(NetworkTypes);

        return buildResponse({
            message: "Supported networks retrieved",
            data: networks,
        });
    }

    getSupportedTradingPairs() {
        const tradingPair = Object.values(TradingPair);

        return buildResponse({
            message: "Supported Trading Pairs retrieved",
            data: tradingPair,
        });
    }

    /**
     * Syncs wallet balance - delegates to WalletAddressService
     */
    private async syncWallet(userId: number, currency: string): Promise<void> {
        return this.walletAddressService.syncWallet(userId, currency);
    }

    /**
     * Extracts deposit-enabled networks - delegates to WalletAddressService
     */
    private extractDepositEnabledNetworkMap(
        wallet: GetUserWalletResponse
    ): Map<NetworkTypes, string> {
        return this.walletAddressService.extractDepositEnabledNetworkMap(wallet);
    }

    /**
     * Ensures wallet payment addresses exist - delegates to WalletAddressService
     */
    async ensureWalletPaymentAddresses(options: {
        userId: number;
        cryptoSubAccountId: string;
        assetSymbol: string;
        requestedNetworks?: string[];
        walletData?: GetUserWalletResponse;
    }): Promise<CryptoWalletAddress[]> {
        return this.walletAddressService.ensureWalletPaymentAddresses(options);
    }

    /**
     * Gets a specific wallet address - delegates to WalletAddressService
     */
    async getWalletAddress(userId: number, dto: GetWalletDto) {
        return this.walletAddressService.getWalletAddress(userId, dto);
    }

    /**
     * Gets all wallet addresses for an asset - delegates to WalletAddressService
     */
    async getWalletAddresses(userId: number, dto: GetWalletAddressesDto) {
        return this.walletAddressService.getWalletAddresses(userId, dto);
    }

    /**
     * Verifies a wallet address - delegates to WalletAddressService
     */
    async verifyWalletAddress(dto: VerifyWalletAddressDto) {
        return this.walletAddressService.verifyWalletAddress(dto);
    }

    /**
     * Initiates wallet address creation - delegates to WalletAddressService
     */
    async initiateWalletAddressCreation(
        userId: number,
        dto: InitiateWalletCreationDto
    ) {
        return this.walletAddressService.initiateWalletAddressCreation(userId, dto);
    }

    /**
     * Gets a quote for buying crypto - delegates to BuyOrderService
     */
    async buyCryptoQuoteRequest(user: User, dto: InitiateBuyOrderDto) {
        return this.buyOrderService.buyCryptoQuoteRequest(user, dto);
    }

    /**
     * Gets a quote for selling crypto - delegates to SellOrderService
     */
    async sellCryptoQuoteRequest(user: User, dto: InitiateSellOrderDto) {
        return this.sellOrderService.sellCryptoQuoteRequest(user, dto);
    }

    /**
     * Places a buy order - delegates to BuyOrderService
     */
    async buyCryptoOrder(user: User, dto: InitiateBuyOrderDto) {
        return this.buyOrderService.buyCryptoOrder(user, dto);
    }

    /**
     * Places a sell order - delegates to SellOrderService
     */
    async sellCryptoOrder(user: User, dto: SellCryptoOrderDto) {
        return this.sellOrderService.sellCryptoOrder(user, dto);
    }

    /**
     * Calculates buy quote - delegates to BuyOrderService
     */
    async calculateBuyQuote(
        user: User,
        dto: InitiateBuyOrderDto
    ): Promise<BuyQuoteResponse> {
        return this.buyOrderService.calculateBuyQuote(user, dto);
    }

    /**
     * Calculates sell quote - delegates to SellOrderService
     */
    async calculateSellQuote(
        user: User,
        dto: InitiateSellOrderDto,
        internal = false
    ): Promise<SellQuoteResponse> {
        return this.sellOrderService.calculateSellQuote(user, dto, internal);
    }

    /**
     * Creates an instant swap quote - delegates to SwapService
     */
    async createInstantSwap(user: User, dto: PlaceInstantSwapRequestDto) {
        return this.swapService.createInstantSwap(user, dto);
    }

    /**
     * Refreshes an instant swap quote - delegates to SwapService
     */
    async refreshInstantSwap(user: User, dto: RefreshInstantSwapRequestDto) {
        return this.swapService.refreshInstantSwap(user, dto);
    }

    /**
     * Gets a swap estimate using cached market data.
     * Use this for the UI polling to avoid hitting Quidax rate limits.
     */
    async getSwapEstimate(user: User, dto: PlaceInstantSwapRequestDto) {
        try {
            // Use LiveCoinWatch to get latest prices avoiding Quidax limits
            const [fromPrice, toPrice] = await Promise.all([
                this.liveCoinWatchService.getPriceInUSD(dto.from_currency),
                this.liveCoinWatchService.getPriceInUSD(dto.to_currency)
            ]);

            const fromAmount = parseFloat(dto.from_amount);
            // Calculate raw conversion: (Amount * FromPrice) / ToPrice
            const conversionRate = fromPrice / toPrice;
            // Apply a small safety slippage buffer (e.g. 0.5%) to the estimate
            // so user isn't disappointed if real execution is slightly lower
            const estimatedRate = conversionRate * 0.995;
            const toAmount = fromAmount * estimatedRate;

            return buildResponse({
                message: "Swap estimate retrieved",
                data: {
                    id: "estimate_" + Date.now(), // Fake ID
                    from_currency: dto.from_currency,
                    to_currency: dto.to_currency,
                    from_amount: dto.from_amount,
                    to_amount: toAmount.toFixed(8),
                    quoted_price: estimatedRate.toFixed(8),
                    quoted_currency: dto.to_currency,
                    expires_at: new Date(Date.now() + 15000).toISOString(), // Mock expiry
                }
            });
        } catch (error) {
            this.logger.error(`Failed to get swap estimate: ${error.message}`);
            // Fallback to Quidax if LCW fails (though unlikely with cache)
            return this.swapService.createInstantSwap(user, dto);
        }
    }

    /**
     * Executes an atomic swap (get quote + confirm in one operation)
     * This is the recommended method for swaps as it eliminates timing issues
     * with quote expiry by getting and confirming a quote in milliseconds.
     */
    async executeAtomicSwap(user: User, dto: {
        from_currency: string;
        to_currency: string;
        from_amount: number;
    }) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        this.logger.log(`Executing atomic swap: ${dto.from_amount} ${dto.from_currency} -> ${dto.to_currency}`);

        // Step 1: Get a fresh quote
        const quoteStartTime = Date.now();
        const quote = await this.quidaxService.createInstantSwapRequest(
            user.cryptoSubAccountId,
            {
                from_currency: dto.from_currency.toLowerCase(),
                to_currency: dto.to_currency.toLowerCase(),
                from_amount: dto.from_amount.toString(),
            }
        );
        this.logger.log(`Got quote ${quote.data.id} in ${Date.now() - quoteStartTime}ms`);

        // Step 2: Immediately confirm the quote
        const confirmStartTime = Date.now();
        const swapInfo = await this.quidaxService.confirmInstantSwap({
            user_id: user.cryptoSubAccountId,
            quotation_id: quote.data.id,
        });
        this.logger.log(`Confirmed swap in ${Date.now() - confirmStartTime}ms`);

        this.logger.log(`Atomic swap completed: ${dto.from_amount} ${dto.from_currency} -> ${swapInfo.data.received_amount} ${dto.to_currency}`);

        // Step 3: Create order record (same as confirmInstantSwapQuote)
        const amtFiat = await this.getAmountInNaira(
            swapInfo.data.from_currency,
            Number(swapInfo.data?.from_amount),
            "sell"
        );
        const transactionId = generateId({ type: "transaction" });

        if (swapInfo.data) {
            await this.prisma.$transaction(
                async (tx) => {
                    await tx.order.create({
                        data: {
                            orderCategory: OrderCategory.SWAP,
                            status: swapInfo.data.status,
                            streamlinedStatus: getStreamlinedStatus(swapInfo.data.status),
                            transactionId: transactionId,
                            providerOrderId: swapInfo.data.id,
                            orderReference: generateId({ type: "reference" }),
                            userId: user.id,
                            fromCurrency: swapInfo.data.from_currency.toUpperCase(),
                            toCurrency: swapInfo.data.to_currency.toUpperCase(),
                            fromAmount: +swapInfo.data?.from_amount,
                            toAmount: +swapInfo.data?.received_amount,
                            amount: +swapInfo.data?.from_amount,
                            quotationId: swapInfo.data.swap_quotation.id,
                            quoted_currency: swapInfo.data.swap_quotation.quoted_currency,
                            quoted_price: +swapInfo.data.swap_quotation.quoted_price,
                            executionPrice: +swapInfo.data.execution_price,
                            amountInFiat: amtFiat?.amount,
                            rateAtConversion: amtFiat?.rate,
                        },
                    });
                },
                { maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS, timeout: DEFAULT_TRANSACTION_TIMEOUT_MS }
            );

            // Emit transaction update for swap
            this.wsGateway.notifyTransactionUpdate(user.id, {
                type: "transaction_update",
                transaction: {
                    id: 0,
                    transactionId: transactionId,
                    status: swapInfo.data.status,
                    streamlinedStatus: getStreamlinedStatus(swapInfo.data.status),
                    orderCategory: OrderCategory.SWAP,
                    amount: +swapInfo.data?.from_amount,
                    currency: swapInfo.data.from_currency.toUpperCase(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            });

            // Create and send notification
            const message = `Your swap of ${swapInfo.data.from_amount} ${swapInfo.data.from_currency.toUpperCase()} to ${swapInfo.data.to_currency.toUpperCase()} is processing. Transaction ID: ${transactionId}`;

            const createdNotification = await this.prisma.notification.create({
                data: {
                    title: "Swap transaction initiated",
                    body: message,
                    userId: user.id,
                    target: UserNotificationTarget.SINGLE,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    type: NotificationType.MESSAGE,
                    status: NotificationStatus.APPROVED,
                    senderId: null,
                    transactionType: OrderCategory.SWAP,
                    currency: swapInfo.data.from_currency.toUpperCase(),
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
        }

        return buildResponse({
            message: "Swap executed successfully",
            data: {
                ...swapInfo.data,
                transactionId: transactionId,
                quote: quote.data,
            },
        });
    }

    /**
     * Creates a withdrawal request - delegates to SendService
     */
    async withdrawerRequest(user: User, dto: WithdrawerRequestDto) {
        return this.sendService.withdrawerRequest(user, dto);
    }

    /**
     * Cancels a withdrawal request - delegates to SendService
     */
    async cancelWithdrawerRequest(user: User, dto: CancelWithdrawerRequestDto) {
        return this.sendService.cancelWithdrawerRequest(user, dto);
    }

    /**
     * Gets crypto withdrawal fee - delegates to SendService
     */
    async getCryptoWithdrawerFee(dto: GetCryptoWithdrawerFeeDto) {
        return this.sendService.getCryptoWithdrawerFee(dto);
    }

    async cancelOrder(user: User, orderId: number) {
        // Find the order
        const order = await this.prisma.order.findFirst({
            where: {
                id: orderId,
                userId: user.id,
            },
        });

        if (!order) {
            throw new TransactionNotFoundException(
                "Order not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Check if order is pending or processing
        if (order.streamlinedStatus !== "pending" && order.status !== OrderStatus.processing) {
            throw new GeneralTransactionException(
                "Only pending or processing orders can be cancelled",
                HttpStatus.BAD_REQUEST
            );
        }

        // For SEND orders, we need to check Quidax status first and cancel there if possible
        if (order.orderCategory === OrderCategory.SEND && order.providerOrderId) {
            try {
                // Check current status on Quidax
                const withdrawalDetail = await this.quidaxService.getWithdrawerDetail({
                    user_id: user.cryptoSubAccountId,
                    withdrawal_id: order.providerOrderId,
                });

                const quidaxStatus = withdrawalDetail.data?.status?.toLowerCase();

                // If already done/completed on Quidax, cannot cancel
                if (quidaxStatus === 'done' || quidaxStatus === 'completed' || quidaxStatus === 'successful') {
                    // Update local status to match Quidax
                    await this.prisma.order.update({
                        where: { id: orderId },
                        data: {
                            status: OrderStatus.done,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.done),
                        },
                    });

                    // Emit wallet update to refresh balance
                    this.wsGateway.notifyWalletUpdate(user.id);

                    throw new GeneralTransactionException(
                        "Transaction has already been completed on the blockchain and cannot be cancelled",
                        HttpStatus.BAD_REQUEST
                    );
                }

                // If still pending/processing on Quidax, attempt to cancel
                if (quidaxStatus === 'pending' || quidaxStatus === 'processing' || quidaxStatus === 'submitted') {
                    try {
                        await this.quidaxService.cancelWithdrawerRequest({
                            user_id: user.cryptoSubAccountId,
                            withdrawal_id: order.providerOrderId,
                        });
                        this.logger.log(`Successfully cancelled withdrawal ${order.providerOrderId} on Quidax`);
                    } catch (cancelError) {
                        this.logger.warn(`Failed to cancel on Quidax (may already be processed): ${cancelError.message}`);
                        // Re-check status after cancel attempt
                        const recheckDetail = await this.quidaxService.getWithdrawerDetail({
                            user_id: user.cryptoSubAccountId,
                            withdrawal_id: order.providerOrderId,
                        });
                        const recheckStatus = recheckDetail.data?.status?.toLowerCase();

                        if (recheckStatus === 'done' || recheckStatus === 'completed' || recheckStatus === 'successful') {
                            await this.prisma.order.update({
                                where: { id: orderId },
                                data: {
                                    status: OrderStatus.done,
                                    streamlinedStatus: getStreamlinedStatus(OrderStatus.done),
                                },
                            });
                            this.wsGateway.notifyWalletUpdate(user.id);
                            throw new GeneralTransactionException(
                                "Transaction completed while attempting to cancel. Your funds have been sent.",
                                HttpStatus.BAD_REQUEST
                            );
                        }
                    }
                }
            } catch (error) {
                // If error is already a GeneralTransactionException, rethrow it
                if (error instanceof GeneralTransactionException) {
                    throw error;
                }
                this.logger.error(`Error checking/cancelling withdrawal on Quidax: ${error.message}`);
                // Continue with local cancellation if Quidax check fails
            }
        }

        // Update order status to cancelled
        const updatedOrder = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: OrderStatus.cancelled,
                streamlinedStatus: "cancelled",
            },
        });

        // Emit transaction update
        this.wsGateway.notifyTransactionUpdate(user.id, {
            type: "transaction_update",
            transaction: {
                id: updatedOrder.id,
                transactionId: updatedOrder.transactionId,
                status: updatedOrder.status,
                streamlinedStatus: updatedOrder.streamlinedStatus,
                orderCategory: updatedOrder.orderCategory,
                amount: updatedOrder.amount,
                currency: updatedOrder.currency,
                createdAt: updatedOrder.createdAt,
                updatedAt: updatedOrder.updatedAt,
            },
        });

        // Sync wallet with Quidax to ensure balance is up to date
        await this.syncWallet(user.id, updatedOrder.currency);

        // Emit wallet update to refresh balance after cancellation
        this.wsGateway.notifyWalletUpdate(user.id);

        return buildResponse({
            message: "Order cancelled successfully",
            data: {
                orderId: updatedOrder.id,
                status: updatedOrder.status,
                streamlinedStatus: updatedOrder.streamlinedStatus,
            },
        });
    }

    async confirmInstantSwapQuote(user: User, dto: ConfirmInstantSwapQuoteDto) {
        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Please complete your account setup or contact admin for support",
                HttpStatus.BAD_REQUEST
            );
        }

        const swapInfo = await this.quidaxService.confirmInstantSwap({
            quotation_id: dto.quotationId,
            user_id: user.cryptoSubAccountId,
        });

        const amtFiat = await this.getAmountInNaira(
            swapInfo.data.from_currency,
            Number(swapInfo.data?.from_amount),
            "sell"
        );
        const transactionId = generateId({ type: "transaction" });
        if (swapInfo.data) {
            // CRITICAL: Must await the transaction to ensure order is created before continuing
            await this.prisma.$transaction(
                async (tx) => {
                    await tx.order.create({
                        data: {
                            orderCategory: OrderCategory.SWAP,
                            status: swapInfo.data.status,
                            streamlinedStatus: getStreamlinedStatus(swapInfo.data.status),
                            transactionId: transactionId,
                            providerOrderId: swapInfo.data.id,
                            orderReference: generateId({
                                type: "reference",
                            }),
                            userId: user.id,
                            fromCurrency:
                                swapInfo.data.from_currency.toUpperCase(),
                            toCurrency: swapInfo.data.to_currency.toUpperCase(),
                            fromAmount: +swapInfo.data?.from_amount,
                            toAmount: +swapInfo.data?.received_amount,
                            amount: +swapInfo.data?.from_amount,
                            quotationId: swapInfo.data.swap_quotation.id,
                            quoted_currency:
                                swapInfo.data.swap_quotation.quoted_currency,
                            quoted_price:
                                +swapInfo.data.swap_quotation.quoted_price,
                            executionPrice: +swapInfo.data.execution_price,
                            amountInFiat: amtFiat?.amount,
                            rateAtConversion: amtFiat?.rate,
                        },
                    });
                },
                { maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS, timeout: DEFAULT_TRANSACTION_TIMEOUT_MS }
            );

            // Emit transaction update for swap
            this.wsGateway.notifyTransactionUpdate(user.id, {
                type: "transaction_update",
                transaction: {
                    id: 0, // Will be updated by webhook
                    transactionId: transactionId,
                    status: swapInfo.data.status,
                    streamlinedStatus: getStreamlinedStatus(swapInfo.data.status),
                    orderCategory: OrderCategory.SWAP,
                    amount: +swapInfo.data?.from_amount,
                    currency: swapInfo.data.from_currency.toUpperCase(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            });

            // NOTE: Do NOT sync wallets immediately after swap confirmation
            // The swap is still processing on Quidax - syncing now would show incorrect locked balances
            // The webhook (swapTransactionHandler) will sync wallets when the swap actually completes
            // This prevents the "balance goes down then up" UI issue

            // Create and send notification for processing
            const message = `Your swap of ${swapInfo.data.from_amount} ${swapInfo.data.from_currency.toUpperCase()} to ${swapInfo.data.to_currency.toUpperCase()} is processing. Transaction ID: ${transactionId}`;

            const createdNotification = await this.prisma.notification.create({
                data: {
                    title: "Swap transaction initiated",
                    body: message,
                    userId: user.id,
                    target: UserNotificationTarget.SINGLE,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    type: NotificationType.MESSAGE,
                    status: NotificationStatus.APPROVED,
                    senderId: null,
                    transactionType: OrderCategory.SWAP,
                    currency: swapInfo.data.from_currency.toUpperCase(),
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
        }

        return buildResponse({
            message: "Swap request processed successfully",
            data: {
                ...swapInfo.data,
                transactionId: transactionId,
            },
        });
    }

    async verifySwapQuoteTransaction(
        swap_transaction_id: string,
        user_id: string
    ) {
        const result = await this.quidaxService.getSwapTransaction({
            swap_transaction_id,
            user_id,
        });
        return result;
    }

    async getWithdrawerTransactionByReference(
        reference: string,
        user_id: string
    ) {
        const result = await this.quidaxService.getWithdrawerByReference({
            user_id,
            reference,
        });
        return result;
    }

    async triggerQuidaxAccountCreation(user: User) {
        // Run synchronously instead of using queue for reliability
        try {
            let cryptoSubAccountId = user.cryptoSubAccountId;

            // If user doesn't have a crypto sub-account, create or find existing one
            if (!cryptoSubAccountId) {
                this.logger.log(`Creating/finding crypto account for user ${user.id} (${user.email})`);

                // Use createOrFindSubAccount to handle existing accounts gracefully
                let result;
                try {
                    result = await this.quidaxService.createOrFindSubAccount({
                        email: user.email,
                        first_name: user.firstName,
                        last_name: user.lastName,
                    });
                } catch (quidaxError) {
                    this.logger.error(`Quidax createOrFindSubAccount failed: ${quidaxError?.message}`, quidaxError?.stack);
                    throw new QuidaxApiException(`Quidax API error: ${quidaxError?.message}`, {
                        userId: user.id,
                        email: user.email,
                    });
                }

                if (result.status !== "success") {
                    this.logger.error(`Sub-account creation/lookup failed: ${JSON.stringify(result)}`);
                    throw new AccountCreationException("Failed to create or find sub-account", HttpStatus.BAD_GATEWAY);
                }

                cryptoSubAccountId = result.data.id;

                await this.prisma.user.update({
                    where: { id: user.id },
                    data: { cryptoSubAccountId },
                });

                this.logger.log(`Sub-account ID stored: ${cryptoSubAccountId}`);
            } else {
                this.logger.log(`User ${user.id} already has crypto sub-account: ${cryptoSubAccountId}, ensuring wallets exist`);
            }

            // Check if AssetWallet records already exist for all currencies
            // Supported cryptocurrencies with full Quidax wallet support
            const currencies = [
                "btc",   // Bitcoin
                "eth",   // Ethereum
                "usdt",  // Tether
                "usdc",  // USD Coin
                "bnb",   // Binance Coin
                "sol",   // Solana
                "xrp",   // Ripple
                "ada",   // Cardano
                "doge",  // Dogecoin
                "ltc",   // Litecoin
                "trx",   // Tron
                "shib",  // Shiba Inu
            ];
            const existingWallets = await this.prisma.assetWallet.findMany({
                where: {
                    userId: user.id,
                    assetCurrency: { in: currencies.map(c => c.toUpperCase()) },
                },
                select: { assetCurrency: true, addressSynced: true },
            });
            const existingCurrencies = new Set(existingWallets.map(w => w.assetCurrency.toLowerCase()));

            // Find currencies that don't have AssetWallet records yet
            const missingCurrencies = currencies.filter(c => !existingCurrencies.has(c));

            // Find currencies that have wallets but no addresses synced
            const walletsNeedingAddresses = existingWallets
                .filter(w => !w.addressSynced)
                .map(w => w.assetCurrency.toLowerCase());

            // Combine: create new wallets + generate addresses for existing wallets without addresses
            const currenciesToProcess = [...new Set([...missingCurrencies, ...walletsNeedingAddresses])];

            if (currenciesToProcess.length === 0) {
                this.logger.log(`User ${user.id} already has all AssetWallet records with addresses, skipping`);
                return buildResponse({
                    message: `account already fully set up`,
                    data: { walletResults: currencies.map(c => ({ currency: c, success: true, existing: true })) },
                });
            }

            this.logger.log(`User ${user.id} needs processing for: ${currenciesToProcess.join(', ')}`);
            const walletResults = [];

            for (const currency of currenciesToProcess) {
                try {
                    this.logger.log(`Creating wallet for ${currency.toUpperCase()}...`);
                    const addresses = await this.ensureWalletPaymentAddresses({
                        userId: user.id,
                        cryptoSubAccountId,
                        assetSymbol: currency.toUpperCase(),
                    });
                    this.logger.log(`Wallet created for ${currency.toUpperCase()}: ${addresses?.length || 0} addresses`);

                    // Also create/update AssetWallet record directly (don't wait for webhook)
                    try {
                        const walletData = await this.quidaxService.getUserWallet({
                            user_id: cryptoSubAccountId,
                            currency: currency.toLowerCase(),
                        });

                        if (walletData.status === "success" && walletData.data) {
                            const data = walletData.data;
                            await this.prisma.assetWallet.upsert({
                                where: {
                                    userId_assetCurrency: {
                                        userId: user.id,
                                        assetCurrency: currency.toUpperCase(),
                                    },
                                },
                                update: {
                                    quidaxWalletId: data.id,
                                    assetName: data.name,
                                    balance: data.balance,
                                    locked: data.locked,
                                    staked: data.staked,
                                    convertedBalance: data.converted_balance,
                                    blockchainEnabled: data.blockchain_enabled,
                                    defaultNetwork: data.default_network,
                                    isCrypto: data.is_crypto,
                                    networks: data.networks,
                                    referenceCurrency: data.reference_currency,
                                    depositAddress: data.deposit_address,
                                    destinationTag: data.destination_tag,
                                    ...(data.deposit_address && { addressSynced: true }),
                                    ...(data.deposit_address && { isActive: true }),
                                },
                                create: {
                                    quidaxWalletId: data.id,
                                    assetCurrency: data.currency.toUpperCase(),
                                    assetName: data.name,
                                    balance: data.balance,
                                    locked: data.locked,
                                    staked: data.staked,
                                    convertedBalance: data.converted_balance,
                                    blockchainEnabled: data.blockchain_enabled,
                                    defaultNetwork: data.default_network,
                                    isCrypto: data.is_crypto,
                                    networks: data.networks,
                                    referenceCurrency: data.reference_currency,
                                    depositAddress: data.deposit_address,
                                    destinationTag: data.destination_tag,
                                    userId: user.id,
                                    ...(data.deposit_address && { addressSynced: true }),
                                    ...(data.deposit_address && { isActive: true }),
                                },
                            });
                            this.logger.log(`AssetWallet created/updated for ${currency.toUpperCase()}`);
                        }
                    } catch (assetError) {
                        this.logger.error(`Failed to create AssetWallet for ${currency}: ${assetError?.message}`);
                    }

                    walletResults.push({ currency, success: true, addresses: addresses?.length || 0 });
                } catch (error) {
                    this.logger.error(`Address creation error for ${currency}: ${error?.message}`, error?.stack);
                    walletResults.push({ currency, success: false, error: error?.message });
                }
            }

            const successCount = walletResults.filter(r => r.success).length;
            this.logger.log(`Wallet creation summary: ${successCount}/${currencies.length} successful`);

            return buildResponse({
                message: `account generation completed (${successCount}/${currencies.length} wallets created)`,
                data: { walletResults },
            });
        } catch (error) {
            this.logger.error(`triggerQuidaxAccountCreation failed: ${error?.message}`, error?.stack);
            throw error;
        }
    }

    // Handles successful wallet address creation webhook from Quidax
    async walletAddressCreatedSuccessHandler(
        data: IWalletAddressCreatedSuccess
    ) {
        // Step 1: Find the associated crypto wallet address record using the ID from the webhook
        const walletAddress = await this.prisma.cryptoWalletAddress.findUnique({
            where: { walletAddressId: data.walletAddressId },
            select: {
                id: true,
                assetSymbol: true,
                network: true,
                user: { select: { id: true, cryptoSubAccountId: true } },
            },
        });

        // Step 2: If wallet address is not found, throw an error
        if (!walletAddress) {
            this.logger.error("Crypto Wallet Address Record not found");
            return;
        }

        // Step 3: Check if an asset wallet already exists for this user and asset
        const assetWallet = await this.prisma.assetWallet.findUnique({
            where: {
                userId_assetCurrency: {
                    userId: walletAddress.user.id,
                    assetCurrency: walletAddress.assetSymbol.toUpperCase(),
                },
            },
            select: {
                id: true,
                quidaxWalletId: true,
                user: { select: { cryptoSubAccountId: true } },
            },
        });

        // Step 4: If no asset wallet exists, fetch wallet data from Quidax and create a new asset wallet
        if (!assetWallet) {
            const { status, data } = await this.quidaxService.getUserWallet({
                user_id: walletAddress.user.cryptoSubAccountId,
                currency: walletAddress.assetSymbol.toLowerCase(),
            });

            if (status === "success") {
                await this.prisma.assetWallet.upsert({
                    where: {
                        userId_assetCurrency: {
                            userId: walletAddress.user.id,
                            assetCurrency:
                                walletAddress.assetSymbol.toUpperCase(),
                        },
                    },
                    update: {
                        quidaxWalletId: data.id,
                        assetName: data.name,
                        balance: data.balance,
                        locked: data.locked,
                        staked: data.staked,
                        convertedBalance: data.converted_balance,
                        blockchainEnabled: data.blockchain_enabled,
                        defaultNetwork: data.default_network,
                        isCrypto: data.is_crypto,
                        networks: data.networks,
                        referenceCurrency: data.reference_currency,
                        depositAddress: data.deposit_address,
                        destinationTag: data.destination_tag,
                        ...(data.deposit_address && { addressSynced: true }),
                        ...(data.deposit_address && { isActive: true }),
                    },
                    create: {
                        quidaxWalletId: data.id, // Quidax wallet ID
                        assetCurrency: data.currency.toUpperCase(),
                        assetName: data.name,
                        balance: data.balance,
                        locked: data.locked,
                        staked: data.staked,
                        convertedBalance: data.converted_balance,
                        blockchainEnabled: data.blockchain_enabled,
                        defaultNetwork: data.default_network,
                        isCrypto: data.is_crypto,
                        networks: data.networks, // List of network objects with deposit/withdraw status
                        referenceCurrency: data.reference_currency,
                        depositAddress: data.deposit_address, // Can be null initially
                        destinationTag: data.destination_tag,
                        userId: walletAddress.user.id,
                        ...(data.deposit_address && { addressSynced: true }), // Mark address as synced if present
                        ...(data.deposit_address && { isActive: true }), // Mark wallet as active if deposit address exists
                    },
                });

                this.logWalletFlow(
                    "walletAddressCreatedSuccessHandler:asset_wallet_synced",
                    {
                        userId: walletAddress.user.id,
                        asset: walletAddress.assetSymbol,
                        walletId: data.id,
                    }
                );
            }
        }

        const webhookNetwork = this.tradeHelpers.normalizeNetworkInput(data.network);
        console.log("webhook network", webhookNetwork);

        if (
            walletAddress.network &&
            webhookNetwork &&
            walletAddress.network !== webhookNetwork
        ) {
            this.logger.warn(
                `Incoming network ${webhookNetwork} differs from stored network ${walletAddress.network} for wallet ${data.walletAddressId}`
            );
        }

        // Step 5: Update the crypto wallet address record with the new address and mark it active
        await this.prisma.cryptoWalletAddress.update({
            where: { id: walletAddress.id },
            data: {
                address: data.walletAddress,
                ...(data.totalPayments && {
                    totalPayments: data.totalPayments, // Optional field if available
                }),
                destination_tag: data.destination_tag,
                status: CryptoWalletStatus.ACTIVE, // Mark as active
                lastSyncedAt: new Date(), // Timestamp of the last sync
                ...(webhookNetwork &&
                    !walletAddress.network && {
                    network: webhookNetwork,
                }),
            },
        });
    }

    async getGeneratedWalletAddress(data: GetPaymentAddressByIdOptions) {
        const result = await this.quidaxService.getPaymentAddressById(data);
        return result;
    }

    async walletUpdatedHandler(data: IWalletUpdated) {
        const wallet = await this.prisma.assetWallet.findUnique({
            where: { quidaxWalletId: data.walletId },
        });

        if (!wallet) {
            throw new WalletAddressNotFoundException(
                "Crypto Wallet Record not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.assetWallet.update({
            where: { id: wallet.id },
            data: {
                balance: data.balance,
                locked: data.locked,
                staked: data.staked,
                convertedBalance: data.convertedBalance,
                updatedAt: new Date(data.updatedAt),
                depositAddress: data.depositAddress, // Can be null initially
                destinationTag: data.destinationTag,
                ...(data.depositAddress && { addressSynced: true }), // Mark address as synced if present
                ...(data.depositAddress && { isActive: true }), // Mark wallet as active if deposit address exists
            },
        });
    }

    async depositHandler(options: DepositTransaction) {
        return this.webhookHandlerService.depositHandler(options);
    }

    async swapTransactionHandler(options: SwapTransactionHandlerOptions) {
        return this.webhookHandlerService.swapTransactionHandler(options);
    }

    async withdrawerTransactionHandler(
        options: WithdrawerTransactionHandlerOptions
    ) {
        return this.webhookHandlerService.withdrawerTransactionHandler(options);
    }

    async getFee(
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

            throw new OutOfRangeException(
                "Amount is out of range.",
                HttpStatus.BAD_REQUEST
            );
        }

        throw new UnknownFeeStructureException(
            `Unknown fee type or structure. Received data: ${JSON.stringify(
                data
            )}`,
            HttpStatus.INTERNAL_SERVER_ERROR
        );
    }

    async getAmountInNaira(
        asset: string,
        amount: number,
        rateType: "buy" | "sell" | "last" = "buy"
    ): Promise<{ amount?: number; rate?: number } | null> {
        const referenceCurrency = "ngn";
        const assetCurrency = asset.toLowerCase();
        const marketSymbol = `${assetCurrency}${referenceCurrency}`;
        const marketData = await this.quidaxService.getSingleMarketTicker(
            marketSymbol
        );

        const ticker = marketData.data?.ticker;
        if (!ticker) return null;

        const rate = parseFloat(ticker[rateType]);
        if (isNaN(rate)) return null;

        return {
            amount: amount * rate,
            rate: rate,
        };
    }

    /**
     * Get market chart data for an asset including price history and market statistics
     * Uses LiveCoinWatch for all data (ATH/ATL removed to eliminate CoinGecko rate limits)
     */
    async getMarketChart(asset: string, days: number = 7) {
        console.log(`📊 [LCW] Getting market chart for ${asset} (${days} days)`);

        // Fetch from LiveCoinWatch only (CoinGecko removed)
        const [lcwMarketData, lcwHistory] = await Promise.all([
            this.liveCoinWatchService.getMarketData(asset).catch(err => {
                console.warn(`⚠️ [LCW] Market data fetch failed:`, err.message);
                return null;
            }),
            this.liveCoinWatchService.getHistoricalData(asset, days).catch(err => {
                console.warn(`⚠️ [LCW] History fetch failed:`, err.message);
                return null;
            }),
        ]);

        // Build market_data from LiveCoinWatch (ATH/ATL removed)
        const market_data = {
            current_price: lcwMarketData?.rate || null,
            market_cap: lcwMarketData?.cap || null,
            total_volume: lcwMarketData?.volume || null,
            high_24h: lcwHistory?.high24h || null,
            low_24h: lcwHistory?.low24h || null,
            price_change_percentage_24h: lcwMarketData?.delta?.day
                ? (lcwMarketData.delta.day - 1) * 100
                : null,
            price_change_percentage_7d: lcwMarketData?.delta?.week
                ? (lcwMarketData.delta.week - 1) * 100
                : null,
            price_change_percentage_30d: lcwMarketData?.delta?.month
                ? (lcwMarketData.delta.month - 1) * 100
                : null,
            circulating_supply: lcwMarketData?.circulatingSupply || null,
            max_supply: lcwMarketData?.maxSupply || null,
            // ATH/ATL removed - was causing CoinGecko rate limiting (429 errors)
            ath: null,
            ath_date: null,
            atl: null,
            atl_date: null,
        };

        return buildResponse({
            message: "Market chart data retrieved",
            data: {
                asset: asset.toUpperCase(),
                days,
                prices: lcwHistory?.prices || [],
                market_data,
            },
        });
    }

    /**
     * Get sparkline data (7-day mini charts) for multiple assets
     * Uses LiveCoinWatch for sparklines
     */
    async getBatchSparklines(assets: string[]) {
        const sparklines = await this.liveCoinWatchService.getBatchSparklines(assets);

        return buildResponse({
            message: "Sparkline data retrieved",
            data: sparklines,
        });
    }

    /**
     * Sync deposits from Quidax for a specific user
     * This function fetches deposit history from Quidax and creates missing Order records
     */
    async syncUserDeposits(userId: number) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                cryptoSubAccountId: true,
                email: true,
                firstName: true,
                lastName: true,
            },
        });

        if (!user || !user.cryptoSubAccountId) {
            throw new UserNotFoundException(
                "User not found or no crypto sub-account",
                HttpStatus.NOT_FOUND
            );
        }

        // Check ALL supported currencies, not just those in wallet table
        // This ensures we catch deposits even if wallet address record is missing
        const ALL_SUPPORTED_CURRENCIES = ['usdt', 'btc', 'eth', 'usdc', 'sol', 'xrp', 'bnb', 'trx', 'matic', 'avax'];

        // Also get user's wallet addresses for logging
        const walletAddresses = await this.prisma.cryptoWalletAddress.findMany({
            where: { userId: user.id },
            select: { assetSymbol: true },
        });

        const userCurrencies = walletAddresses.map(w => w.assetSymbol.toLowerCase());
        this.logger.log(`User ${user.email} has wallet addresses for: ${userCurrencies.join(', ') || 'NONE'}`);
        this.logger.log(`Checking ALL supported currencies: ${ALL_SUPPORTED_CURRENCIES.join(', ')}`);

        const syncResults = {
            synced: 0,
            skipped: 0,
            errors: 0,
            details: [] as { currency: string; depositId: string; status: string; amount: string; result: string }[],
        };

        for (const currency of ALL_SUPPORTED_CURRENCIES) {
            try {
                // Fetch deposits from Quidax
                this.logger.log(`Fetching ${currency} deposits for sub-account: ${user.cryptoSubAccountId}`);

                const depositsResponse = await this.quidaxService.fetchDeposits({
                    user_id: user.cryptoSubAccountId,
                    currency: currency as any,
                });

                this.logger.log(`${currency} deposits response: ${JSON.stringify(depositsResponse?.data?.length || 0)} deposits found`);

                if (!depositsResponse?.data || depositsResponse.data.length === 0) {
                    this.logger.log(`No ${currency} deposits found on Quidax`);
                    continue;
                }

                this.logger.log(`Processing ${depositsResponse.data.length} ${currency} deposits...`);

                for (const deposit of depositsResponse.data) {
                    try {
                        this.logger.log(`Checking deposit ${deposit.id}: ${deposit.amount} ${currency}, status: ${deposit.status || deposit.state}`);

                        // Check if order already exists for this deposit
                        const existingOrder = await this.prisma.order.findUnique({
                            where: { providerOrderId: deposit.id },
                        });

                        if (existingOrder) {
                            this.logger.log(`Deposit ${deposit.id} already exists as order ${existingOrder.id}`);
                            syncResults.skipped++;
                            syncResults.details.push({
                                currency,
                                depositId: deposit.id,
                                status: deposit.status,
                                amount: deposit.amount,
                                result: "skipped - already exists",
                            });
                            continue;
                        }

                        // Normalize the status
                        const normalizedStatus = this.normalizeDepositStatus(deposit.status || deposit.state);

                        // Log the deposit data for debugging timestamps
                        this.logger.log(`Deposit ${deposit.id} timestamps: created_at=${deposit.created_at}, done_at=${deposit.done_at}, completed_at=${deposit.completed_at}`);

                        // Get amount in fiat for record
                        const amtFiat = await this.getAmountInNaira(
                            currency,
                            Number(deposit.amount),
                            "buy"
                        );

                        const transactionId = generateId({ type: "transaction" });

                        // Use the original deposit timestamp from Quidax
                        const depositCreatedAt = deposit.created_at ? new Date(deposit.created_at) : new Date();
                        const depositCompletedAt = deposit.completed_at || deposit.done_at
                            ? new Date(deposit.completed_at || deposit.done_at)
                            : null;

                        // Create the order with the original Quidax timestamp
                        await this.prisma.order.create({
                            data: {
                                orderCategory: OrderCategory.RECEIVE,
                                status: normalizedStatus,
                                transactionId: transactionId,
                                streamlinedStatus: getStreamlinedStatus(normalizedStatus),
                                providerOrderId: deposit.id,
                                blockchain_txid: deposit.txid,
                                userId: user.id,
                                currency: currency.toUpperCase(),
                                amount: +deposit.amount,
                                fee: +deposit.fee,
                                amountInFiat: amtFiat?.amount,
                                rateAtConversion: amtFiat?.rate,
                                createdAt: depositCreatedAt,
                                updatedAt: depositCompletedAt || depositCreatedAt,
                            },
                        });

                        syncResults.synced++;
                        syncResults.details.push({
                            currency,
                            depositId: deposit.id,
                            status: deposit.status,
                            amount: deposit.amount,
                            result: "synced successfully",
                        });

                        this.logger.log(
                            `Synced deposit: ${deposit.id} - ${deposit.amount} ${currency}`
                        );
                    } catch (depositError) {
                        syncResults.errors++;
                        syncResults.details.push({
                            currency,
                            depositId: deposit.id,
                            status: deposit.status,
                            amount: deposit.amount,
                            result: `error: ${depositError.message}`,
                        });
                        this.logger.error(
                            `Error syncing deposit ${deposit.id}: ${depositError.message}`
                        );
                    }
                }
            } catch (currencyError) {
                this.logger.error(
                    `Error fetching deposits for ${currency}: ${currencyError.message}`
                );
            }
        }

        return buildResponse({
            message: `Deposit sync completed for user ${user.email}`,
            data: syncResults,
        });
    }

    /**
     * Normalize deposit status from Quidax to OrderStatus
     */
    private normalizeDepositStatus(status: string): OrderStatus {
        const normalizedStatus = status?.toLowerCase();

        switch (normalizedStatus) {
            case "successful":
            case "done":
            case "completed":
            case "accepted":
                return OrderStatus.accepted;
            case "processing":
            case "confirming":
            case "submitted":
            case "pending":
                return OrderStatus.pending;
            case "rejected":
            case "failed":
            case "aml_deposit_hold":
                return OrderStatus.rejected;
            default:
                return OrderStatus.pending;
        }
    }

    /**
     * Debug: Get wallet info from both our DB and Quidax
     */
    async debugUserWallet(userId: number, currency: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                cryptoSubAccountId: true,
            },
        });

        if (!user || !user.cryptoSubAccountId) {
            return { error: "User not found or no crypto sub-account" };
        }

        // Get wallet address from our DB
        const dbWallet = await this.prisma.cryptoWalletAddress.findFirst({
            where: {
                userId: user.id,
                assetSymbol: { equals: currency.toUpperCase(), mode: 'insensitive' },
            },
        });

        // Get wallet from Quidax
        let quidaxWallet = null;
        let quidaxAddress = null;
        let quidaxDeposits = null;
        let quidaxError = null;

        // Get wallet balance
        try {
            const wallets = await this.quidaxService.getUserWalletList({
                user_id: user.cryptoSubAccountId,
            });
            this.logger.log(`Quidax wallets response: ${wallets?.data?.length} wallets`);
            quidaxWallet = wallets?.data?.find(w => w.currency?.toLowerCase() === currency.toLowerCase());
        } catch (e) {
            this.logger.error(`Error fetching wallets: ${e.message}`);
            quidaxError = e.message;
        }

        // Get deposit address (don't let this block deposits fetch)
        try {
            quidaxAddress = await this.quidaxService.createPaymentAddress({
                user_id: user.cryptoSubAccountId,
                currency: currency.toLowerCase() as any,
            });
            this.logger.log(`Quidax address response: ${JSON.stringify(quidaxAddress?.data)}`);
        } catch (e) {
            this.logger.warn(`Address fetch warning: ${e.message}`);
            // Not a critical error - address may already exist
        }

        // Get deposits - this is the important one
        try {
            const deposits = await this.quidaxService.fetchDeposits({
                user_id: user.cryptoSubAccountId,
                currency: currency.toLowerCase() as any,
            });
            this.logger.log(`Quidax deposits response: ${deposits?.data?.length} deposits`);
            quidaxDeposits = deposits?.data || [];
        } catch (e) {
            this.logger.error(`Error fetching deposits: ${e.message}`);
            if (!quidaxError) quidaxError = e.message;
        }

        return {
            user: { id: user.id, email: user.email, cryptoSubAccountId: user.cryptoSubAccountId },
            dbWallet: dbWallet || null,
            quidax: {
                wallet: quidaxWallet || null,
                address: quidaxAddress?.data || null,
                deposits: quidaxDeposits,
                error: quidaxError,
            },
        };
    }

    /**
     * Refresh transaction status from Quidax provider
     * This allows users to manually trigger a status check for pending transactions
     */
    async refreshTransactionStatus(user: User, transactionId: string) {
        // Find the transaction
        const transaction = await this.prisma.order.findFirst({
            where: {
                transactionId,
                userId: user.id,
            },
        });

        if (!transaction) {
            throw new TransactionNotFoundException(
                "Transaction not found",
                HttpStatus.NOT_FOUND
            );
        }

        // Only refresh pending/processing transactions
        if (transaction.status === OrderStatus.done ||
            transaction.status === OrderStatus.completed ||
            transaction.status === OrderStatus.failed ||
            transaction.status === OrderStatus.cancelled) {
            return buildResponse({
                message: "Transaction status is already final",
                data: {
                    transactionId: transaction.transactionId,
                    status: transaction.status,
                    streamlinedStatus: transaction.streamlinedStatus,
                },
            });
        }

        if (!user.cryptoSubAccountId) {
            throw new IncompleteAccountSetupException(
                "Account setup incomplete",
                HttpStatus.BAD_REQUEST
            );
        }

        // Handle based on transaction category
        if (transaction.orderCategory === OrderCategory.SEND ||
            transaction.orderCategory === OrderCategory.SELL) {
            // Withdrawal transaction - check by reference
            if (!transaction.orderReference) {
                throw new GeneralTransactionException(
                    "Transaction reference not found",
                    HttpStatus.BAD_REQUEST
                );
            }

            try {
                const response = await this.getWithdrawerTransactionByReference(
                    transaction.orderReference,
                    user.cryptoSubAccountId
                );

                const quidaxStatus = response.data?.status?.toLowerCase();

                if (quidaxStatus === OrderStatus.done) {
                    await this.withdrawerTransactionHandler({
                        orderReference: transaction.orderReference,
                        status: OrderStatus.done,
                    });

                    return buildResponse({
                        message: "Transaction completed successfully",
                        data: {
                            transactionId: transaction.transactionId,
                            status: OrderStatus.done,
                            streamlinedStatus: "completed",
                        },
                    });
                } else if (quidaxStatus === OrderStatus.rejected) {
                    await this.withdrawerTransactionHandler({
                        orderReference: transaction.orderReference,
                        status: OrderStatus.rejected,
                    });

                    return buildResponse({
                        message: "Transaction was rejected",
                        data: {
                            transactionId: transaction.transactionId,
                            status: OrderStatus.rejected,
                            streamlinedStatus: "failed",
                        },
                    });
                }

                return buildResponse({
                    message: "Transaction is still processing",
                    data: {
                        transactionId: transaction.transactionId,
                        status: transaction.status,
                        streamlinedStatus: transaction.streamlinedStatus,
                        providerStatus: quidaxStatus,
                    },
                });
            } catch (error) {
                this.logger.error(`Error refreshing transaction ${transactionId}: ${error.message}`);
                return buildResponse({
                    message: "Unable to refresh status. Please try again later.",
                    data: {
                        transactionId: transaction.transactionId,
                        status: transaction.status,
                        streamlinedStatus: transaction.streamlinedStatus,
                    },
                });
            }
        } else if (transaction.orderCategory === OrderCategory.SWAP) {
            // Swap transaction - check by provider order ID
            if (!transaction.providerOrderId) {
                throw new GeneralTransactionException(
                    "Provider order ID not found",
                    HttpStatus.BAD_REQUEST
                );
            }

            try {
                const response = await this.verifySwapQuoteTransaction(
                    transaction.providerOrderId,
                    user.cryptoSubAccountId
                );

                const quidaxStatus = response.data?.status;

                if (quidaxStatus === OrderStatus.completed) {
                    await this.swapTransactionHandler({
                        orderId: transaction.providerOrderId,
                        status: OrderStatus.completed,
                    });

                    return buildResponse({
                        message: "Swap completed successfully",
                        data: {
                            transactionId: transaction.transactionId,
                            status: OrderStatus.completed,
                            streamlinedStatus: "completed",
                        },
                    });
                } else if (quidaxStatus === OrderStatus.failed) {
                    await this.swapTransactionHandler({
                        orderId: transaction.providerOrderId,
                        status: OrderStatus.failed,
                    });

                    return buildResponse({
                        message: "Swap failed",
                        data: {
                            transactionId: transaction.transactionId,
                            status: OrderStatus.failed,
                            streamlinedStatus: "failed",
                        },
                    });
                }

                return buildResponse({
                    message: "Swap is still processing",
                    data: {
                        transactionId: transaction.transactionId,
                        status: transaction.status,
                        streamlinedStatus: transaction.streamlinedStatus,
                        providerStatus: quidaxStatus,
                    },
                });
            } catch (error) {
                this.logger.error(`Error refreshing swap ${transactionId}: ${error.message}`);
                return buildResponse({
                    message: "Unable to refresh status. Please try again later.",
                    data: {
                        transactionId: transaction.transactionId,
                        status: transaction.status,
                        streamlinedStatus: transaction.streamlinedStatus,
                    },
                });
            }
        }

        return buildResponse({
            message: "Transaction type does not support manual refresh",
            data: {
                transactionId: transaction.transactionId,
                status: transaction.status,
                streamlinedStatus: transaction.streamlinedStatus,
            },
        });
    }
}
