/**
 * Quidax Service - Main facade that composes all domain-specific services
 * 
 * This file has been refactored to reduce cyclomatic complexity and file size.
 * The implementation is split into domain-specific services:
 * - AccountService: Sub-account operations
 * - WalletService: Wallet and payment address operations
 * - WithdrawalService: Withdrawal operations
 * - OrderService: Buy/sell order operations
 * - SwapService: Instant swap operations
 * - MarketService: Market data operations
 * - PurchaseService: Purchase limits, quotes, and payment methods
 */

import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";

// Import domain services
import { QuidaxAccountService } from "./account.service";
import { QuidaxWalletService } from "./wallet.service";
import { QuidaxWithdrawalService } from "./withdrawal.service";
import { QuidaxOrderService } from "./order.service";
import { QuidaxSwapService } from "./swap.service";
import { QuidaxMarketService } from "./market.service";
import { QuidaxPurchaseService } from "./purchase.service";

/**
 * Main Quidax Service facade - maintains backward compatibility
 * while delegating to domain-specific services
 */
export class QuidaxService {
    private readonly logger = new Logger(QuidaxService.name);
    
    // Composed services
    private readonly accountService: QuidaxAccountService;
    private readonly walletService: QuidaxWalletService;
    private readonly withdrawalService: QuidaxWithdrawalService;
    private readonly orderService: QuidaxOrderService;
    private readonly swapService: QuidaxSwapService;
    private readonly marketService: QuidaxMarketService;
    private readonly purchaseService: QuidaxPurchaseService;

    constructor(private readonly quidax: QD.QuidaxLib) {
        this.accountService = new QuidaxAccountService(quidax);
        this.walletService = new QuidaxWalletService(quidax);
        this.withdrawalService = new QuidaxWithdrawalService(quidax);
        this.orderService = new QuidaxOrderService(quidax);
        this.swapService = new QuidaxSwapService(quidax);
        this.marketService = new QuidaxMarketService(quidax);
        this.purchaseService = new QuidaxPurchaseService(quidax);
    }

    // ============ Account Operations ============
    
    async findSubAccountByEmail(email: string): Promise<QD.IAccount | null> {
        return this.accountService.findSubAccountByEmail(email);
    }

    async createOrFindSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>> {
        return this.accountService.createOrFindSubAccount(options);
    }

    async createSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>> {
        return this.accountService.createSubAccount(options);
    }

    async getAccountDetail(
        options: t.GetAccountDetailOptions
    ): Promise<QD.QuidaxResponse<QD.GetAccountDetailResponse>> {
        return this.accountService.getAccountDetail(options);
    }

    // ============ Wallet Operations ============

    async getUserWalletList(
        options: t.GetUserWalletListOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletListResponse>> {
        return this.walletService.getUserWalletList(options);
    }

    async getUserWallet(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>> {
        return this.walletService.getUserWallet(options);
    }

    async getPaymentAddress(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetUserWalletResponse>> {
        return this.walletService.getPaymentAddress(options);
    }

    async getPaymentAddressList(
        options: t.GetUserWalletOptions
    ): Promise<QD.QuidaxResponse<QD.GetPaymentAddressListResponse>> {
        return this.walletService.getPaymentAddressList(options);
    }

    async getPaymentAddressById(
        options: t.GetPaymentAddressByIdOptions
    ): Promise<QD.QuidaxResponse<QD.GetPaymentAddressByIdResponse>> {
        return this.walletService.getPaymentAddressById(options);
    }

    async createPaymentAddress(
        options: t.CreatePaymentAddressOptions
    ): Promise<QD.QuidaxResponse<QD.CreatePaymentAddressResponse>> {
        return this.walletService.createPaymentAddress(options);
    }

    async verifyAddress(
        options: t.VerifyAddressOptions
    ): Promise<QD.QuidaxResponse<QD.VerifyAddressResponse>> {
        return this.walletService.verifyAddress(options);
    }

    // ============ Deposit Operations ============

    async fetchDeposits(
        options: QD.FetchDepositsOptions
    ): Promise<QD.QuidaxResponse<QD.FetchDepositsResponse>> {
        return this.quidax.fetchDeposits(options);
    }

    async fetchDeposit(
        options: QD.FetchDepositOptions
    ): Promise<QD.QuidaxResponse<QD.FetchDepositResponse>> {
        return this.quidax.fetchDeposit(options);
    }

    // ============ Withdrawal Operations ============

    async createWithdrawerRequest(
        options: t.CreateWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateWithdrawerRequestResponse>> {
        return this.withdrawalService.createWithdrawerRequest(options);
    }

    async cancelWithdrawerRequest(
        options: t.CancelWithdrawerRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CancelWithdrawerRequestResponse>> {
        return this.withdrawalService.cancelWithdrawerRequest(options);
    }

    async getWithdrawerList(
        user_id: string,
        options: t.WithdrawalListOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawalListResponse>> {
        return this.withdrawalService.getWithdrawerList(user_id, options);
    }

    async getWithdrawerDetail(
        options: t.WithdrawerDetailOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerDetailResponse>> {
        return this.withdrawalService.getWithdrawerDetail(options);
    }

    async getWithdrawerByReference(
        options: t.WithdrawerRecordByReferenceOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerRecordByReferenceResponse>> {
        return this.withdrawalService.getWithdrawerByReference(options);
    }

    async getWithdrawerFees(
        options: t.WithdrawerFeesOptions
    ): Promise<QD.QuidaxResponse<QD.WithdrawerFeesResponse>> {
        return this.withdrawalService.getWithdrawerFees(options);
    }

    // ============ Order Operations ============

    async buyOrSellOrderRequest(
        user_id: string,
        options: t.SellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>> {
        return this.orderService.buyOrSellOrderRequest(user_id, options);
    }

    async cancelBuyOrSellOrderRequest(
        user_id: string,
        options: t.CancelSellOrBuyOrderRequestOptions
    ): Promise<QD.QuidaxResponse<QD.SellOrBuyOrderRequestResponse>> {
        return this.orderService.cancelBuyOrSellOrderRequest(user_id, options);
    }

    async getAllOrders(
        user_id: string,
        options: t.GetOrderListOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderListResponse>> {
        return this.orderService.getAllOrders(user_id, options);
    }

    async getOrderRecord(
        options: t.GetOrderRecordOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderRecordResponse>> {
        return this.orderService.getOrderRecord(options);
    }

    async getOrderBookItemsForAMarket(
        options: t.GetOrderBookItemsForAMarketOptions
    ): Promise<QD.QuidaxResponse<QD.GetOrderBookItemsForAMarketResponse>> {
        return this.orderService.getOrderBookItemsForAMarket(options);
    }

    async instantOrdersRequery(
        options: t.InstantOrdersRequeryOptions
    ): Promise<QD.QuidaxResponse<QD.InstantOrderResponse>> {
        return this.orderService.instantOrdersRequery(options);
    }

    // ============ Swap Operations ============

    async createInstantSwapRequest(
        user_id: string,
        options: t.CreateInstantSwapRequestOptions
    ): Promise<QD.QuidaxResponse<QD.CreateInstantSwapRequestResponse>> {
        return this.swapService.createInstantSwapRequest(user_id, options);
    }

    async confirmInstantSwap(
        options: t.ConfirmInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.ConfirmInstantSwapRequestResponse>> {
        return this.swapService.confirmInstantSwap(options);
    }

    async refreshInstantSwapQuote(
        user_id: string,
        quotation_id: string,
        options: t.RefreshInstantSwapOptions
    ): Promise<QD.QuidaxResponse<QD.RefreshInstantSwapResponse>> {
        return this.swapService.refreshInstantSwapQuote(user_id, quotation_id, options);
    }

    async getSwapTransaction(
        options: t.GetSwapTransactionOptions
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionResponse>> {
        return this.swapService.getSwapTransaction(options);
    }

    async getSwapTransactionList(
        user_id: string
    ): Promise<QD.QuidaxResponse<QD.GetSwapTransactionListResponse>> {
        return this.swapService.getSwapTransactionList(user_id);
    }

    // ============ Market Operations ============

    async getMarketList(): Promise<QD.QuidaxResponse<QD.GetMarketListResponse>> {
        return this.marketService.getMarketList();
    }

    async getMarketTickers(): Promise<QD.QuidaxResponse<QD.GetMarketTickersResponse>> {
        return this.marketService.getMarketTickers();
    }

    async getSingleMarketTicker(
        currency: string
    ): Promise<QD.QuidaxResponse<QD.GetMarketTickerResponse>> {
        return this.marketService.getSingleMarketTicker(currency);
    }

    // ============ Purchase Operations ============

    async getPaymentMethods(
        options: t.PaymentMethodsOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return this.purchaseService.getPaymentMethods(options);
    }

    async getPurchaseLimitForBuy(
        options: t.PurchaseLimitBuyOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return this.purchaseService.getPurchaseLimitForBuy(options);
    }

    async getPurchaseLimitForSell(
        options: t.PurchaseLimitSellOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return this.purchaseService.getPurchaseLimitForSell(options);
    }

    async getPurchaseQuoteForBuy(
        options: t.PurchaseQuoteBuyOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return this.purchaseService.getPurchaseQuoteForBuy(options);
    }

    async getPurchaseQuoteForSell(
        options: t.PurchaseQuoteSellOptions
    ): Promise<QD.QuidaxResponse<any>> {
        return this.purchaseService.getPurchaseQuoteForSell(options);
    }
}

// Re-export domain services for direct usage if needed
export { QuidaxAccountService } from "./account.service";
export { QuidaxWalletService } from "./wallet.service";
export { QuidaxWithdrawalService } from "./withdrawal.service";
export { QuidaxOrderService } from "./order.service";
export { QuidaxSwapService } from "./swap.service";
export { QuidaxMarketService } from "./market.service";
export { QuidaxPurchaseService } from "./purchase.service";
export { handleQuidaxError, executeQuidaxCall } from "./error-handler";
