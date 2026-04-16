/**
 * SafeQuidaxTradingProvider — Environment-guarded wrapper around a real ITradingProvider.
 *
 * Delegates all READ operations to the underlying provider unchanged.
 * BLOCKS destructive/financial operations (withdrawals, swaps, sweeps, orders)
 * when running outside production, preventing accidental real fund movement
 * from staging or development environments.
 *
 * Activated automatically in non-production when QUIDAX_MOCK is NOT enabled
 * (i.e. staging uses real Quidax reads but safe-guarded writes).
 */

import { Logger, ForbiddenException } from "@nestjs/common";
import {
    ITradingProvider,
    ProviderResponse,
    PaginationOptions,
    CreateSubAccountOptions,
    SubAccount,
    AccountDetail,
    WalletBalance,
    PaymentAddress,
    CreatePaymentAddressOptions,
    VerifyAddressOptions,
    AddressVerificationResult,
    PlaceOrderOptions,
    OrderResult,
    CancelOrderOptions,
    CreateSwapQuoteOptions,
    SwapQuote,
    ConfirmSwapOptions,
    SwapTransaction,
    CreateWithdrawalOptions,
    WithdrawalResult,
    CancelWithdrawalOptions,
    WithdrawalFee,
    FetchDepositsOptions,
    DepositRecord,
    MarketTicker,
    PurchaseLimit,
    PurchaseQuote,
} from "../../interfaces/trading-provider.interface";

export class SafeQuidaxTradingProvider implements ITradingProvider {
    readonly providerName: string;
    private readonly logger = new Logger(SafeQuidaxTradingProvider.name);
    private readonly environment: string;

    constructor(
        private readonly delegate: ITradingProvider,
        environment: string,
    ) {
        this.providerName = `${delegate.providerName}-safe`;
        this.environment = environment;
        this.logger.warn(
            `SafeQuidaxTradingProvider wrapping [${delegate.providerName}] — ` +
            `destructive operations BLOCKED in ${environment}`,
        );
    }

    /**
     * Block a destructive operation with a clear log and exception.
     */
    private blockDestructiveOp(operation: string): never {
        const msg = `[ENV-GUARD] Blocked ${operation} in ${this.environment} — only allowed in production`;
        this.logger.error(msg);
        throw new ForbiddenException(msg);
    }

    // ============ Account Operations (ALLOWED — creates sub-accounts, needed for dev) ============

    async createSubAccount(options: CreateSubAccountOptions): Promise<ProviderResponse<SubAccount>> {
        return this.delegate.createSubAccount(options);
    }

    async findSubAccountByEmail(email: string): Promise<SubAccount | null> {
        return this.delegate.findSubAccountByEmail(email);
    }

    async getAccountDetail(userId: string): Promise<ProviderResponse<AccountDetail>> {
        return this.delegate.getAccountDetail(userId);
    }

    // ============ Wallet Operations (ALLOWED — read-only + address generation) ============

    async getUserWalletList(userId: string): Promise<ProviderResponse<WalletBalance[]>> {
        return this.delegate.getUserWalletList(userId);
    }

    async getUserWallet(userId: string, currency: string): Promise<ProviderResponse<WalletBalance>> {
        return this.delegate.getUserWallet(userId, currency);
    }

    async createPaymentAddress(options: CreatePaymentAddressOptions): Promise<ProviderResponse<PaymentAddress>> {
        return this.delegate.createPaymentAddress(options);
    }

    async getPaymentAddressById(userId: string, addressId: string): Promise<ProviderResponse<PaymentAddress>> {
        return this.delegate.getPaymentAddressById(userId, addressId);
    }

    async getPaymentAddressList(userId: string, currency: string): Promise<ProviderResponse<PaymentAddress[]>> {
        return this.delegate.getPaymentAddressList(userId, currency);
    }

    async verifyAddress(options: VerifyAddressOptions): Promise<ProviderResponse<AddressVerificationResult>> {
        return this.delegate.verifyAddress(options);
    }

    // ============ Order Operations (BLOCKED — executes real trades) ============

    async placeOrder(_options: PlaceOrderOptions): Promise<ProviderResponse<OrderResult>> {
        return this.blockDestructiveOp("placeOrder");
    }

    async cancelOrder(_options: CancelOrderOptions): Promise<ProviderResponse<OrderResult>> {
        return this.blockDestructiveOp("cancelOrder");
    }

    async getOrderById(userId: string, orderId: string): Promise<ProviderResponse<OrderResult>> {
        return this.delegate.getOrderById(userId, orderId);
    }

    async getOrderList(userId: string, options?: PaginationOptions): Promise<ProviderResponse<OrderResult[]>> {
        return this.delegate.getOrderList(userId, options);
    }

    // ============ Swap Operations (BLOCKED — executes real swaps) ============

    async createSwapQuote(options: CreateSwapQuoteOptions): Promise<ProviderResponse<SwapQuote>> {
        // Quote creation is read-only (no funds move), allow it
        return this.delegate.createSwapQuote(options);
    }

    async confirmSwap(_options: ConfirmSwapOptions): Promise<ProviderResponse<SwapTransaction>> {
        return this.blockDestructiveOp("confirmSwap");
    }

    async getSwapTransaction(userId: string, transactionId: string): Promise<ProviderResponse<SwapTransaction>> {
        return this.delegate.getSwapTransaction(userId, transactionId);
    }

    async getSwapTransactionList(userId: string): Promise<ProviderResponse<SwapTransaction[]>> {
        return this.delegate.getSwapTransactionList(userId);
    }

    // ============ Withdrawal Operations (BLOCKED — sends real crypto) ============

    async createWithdrawal(_options: CreateWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        return this.blockDestructiveOp("createWithdrawal");
    }

    async cancelWithdrawal(options: CancelWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        // Cancellation is safe — prevents movement, doesn't initiate it
        return this.delegate.cancelWithdrawal(options);
    }

    async getWithdrawalById(userId: string, withdrawalId: string): Promise<ProviderResponse<WithdrawalResult>> {
        return this.delegate.getWithdrawalById(userId, withdrawalId);
    }

    async getWithdrawalByReference(userId: string, reference: string): Promise<ProviderResponse<WithdrawalResult>> {
        return this.delegate.getWithdrawalByReference(userId, reference);
    }

    async getWithdrawalList(userId: string, options?: PaginationOptions): Promise<ProviderResponse<WithdrawalResult[]>> {
        return this.delegate.getWithdrawalList(userId, options);
    }

    async getWithdrawalFees(userId: string, currency: string, network?: string): Promise<ProviderResponse<WithdrawalFee>> {
        return this.delegate.getWithdrawalFees(userId, currency, network);
    }

    // ============ Deposit Operations (ALLOWED — read-only) ============

    async fetchDeposits(options: FetchDepositsOptions): Promise<ProviderResponse<DepositRecord[]>> {
        return this.delegate.fetchDeposits(options);
    }

    async fetchDeposit(userId: string, depositId: string): Promise<ProviderResponse<DepositRecord>> {
        return this.delegate.fetchDeposit(userId, depositId);
    }

    // ============ Market Data Operations (ALLOWED — read-only) ============

    async getMarketTickers(): Promise<ProviderResponse<MarketTicker[]>> {
        return this.delegate.getMarketTickers();
    }

    async getSingleMarketTicker(pair: string): Promise<ProviderResponse<MarketTicker>> {
        return this.delegate.getSingleMarketTicker(pair);
    }

    async getMarketList(): Promise<ProviderResponse<string[]>> {
        return this.delegate.getMarketList();
    }

    // ============ Purchase Operations (read-only quotes ALLOWED, execution would be BLOCKED upstream) ============

    async getPurchaseLimitForBuy(userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        return this.delegate.getPurchaseLimitForBuy(userId, currency);
    }

    async getPurchaseLimitForSell(userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        return this.delegate.getPurchaseLimitForSell(userId, currency);
    }

    async getPurchaseQuoteForBuy(userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        return this.delegate.getPurchaseQuoteForBuy(userId, currency, amount);
    }

    async getPurchaseQuoteForSell(userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        return this.delegate.getPurchaseQuoteForSell(userId, currency, amount);
    }
}
