/**
 * ITradingProvider - Abstract interface for crypto trading providers
 * 
 * This interface defines the contract that any trading provider (Quidax, Binance, etc.)
 * must implement. This allows the application to be provider-agnostic and easily
 * switch between different trading platforms.
 * 
 * Benefits:
 * - Loose coupling: Services depend on interface, not concrete implementations
 * - Testability: Easy to create mock providers for unit testing
 * - Flexibility: Can add new providers without changing existing code
 * - Maintainability: Provider-specific logic is isolated
 */

// ============ Common Types ============

export interface ProviderResponse<T> {
    status: 'success' | 'error';
    message?: string;
    data: T;
}

export interface PaginationOptions {
    page?: number;
    limit?: number;
}

// ============ Account Types ============

export interface CreateSubAccountOptions {
    email: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
}

export interface SubAccount {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    reference?: string;
    status: string;
    createdAt: Date;
}

export interface AccountDetail {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    kycLevel?: number;
    status: string;
}

// ============ Wallet Types ============

export interface WalletBalance {
    currency: string;
    balance: string;
    lockedBalance: string;
    availableBalance: string;
}

export interface PaymentAddress {
    id: string;
    address: string;
    currency: string;
    network: string;
    status: string;
    createdAt: Date;
}

export interface CreatePaymentAddressOptions {
    userId: string;
    currency: string;
    network?: string;
}

export interface VerifyAddressOptions {
    currency: string;
    address: string;
    network?: string;
}

export interface AddressVerificationResult {
    isValid: boolean;
    address: string;
    network?: string;
}

// ============ Order Types ============

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'instant';

export interface PlaceOrderOptions {
    userId: string;
    pair: string;
    side: OrderSide;
    type: OrderType;
    amount: string;
    price?: string;
    volume?: string;
}

export interface OrderResult {
    id: string;
    pair: string;
    side: OrderSide;
    type: OrderType;
    status: string;
    price: string;
    volume: string;
    executedVolume: string;
    remainingVolume: string;
    fee?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface CancelOrderOptions {
    userId: string;
    orderId: string;
}

// ============ Swap Types ============

export interface CreateSwapQuoteOptions {
    userId: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount?: string;
    toAmount?: string;
}

export interface SwapQuote {
    id: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    toAmount: string;
    rate: string;
    fee: string;
    expiresAt: Date;
}

export interface ConfirmSwapOptions {
    userId: string;
    quoteId: string;
}

export interface SwapTransaction {
    id: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: string;
    toAmount: string;
    status: string;
    createdAt: Date;
}

// ============ Withdrawal Types ============

export interface CreateWithdrawalOptions {
    userId: string;
    currency: string;
    amount: string;
    address: string;
    network?: string;
    reference?: string;
    narration?: string;
}

export interface WithdrawalResult {
    id: string;
    currency: string;
    amount: string;
    fee: string;
    status: string;
    address: string;
    network?: string;
    txHash?: string;
    reference?: string;
    createdAt: Date;
}

export interface WithdrawalFee {
    currency: string;
    network?: string;
    fee: string;
    minimumAmount: string;
}

export interface CancelWithdrawalOptions {
    userId: string;
    withdrawalId: string;
}

// ============ Deposit Types ============

export interface DepositRecord {
    id: string;
    currency: string;
    amount: string;
    fee: string;
    status: string;
    txHash?: string;
    address?: string;
    network?: string;
    confirmations?: number;
    createdAt: Date;
    completedAt?: Date;
}

export interface FetchDepositsOptions {
    userId: string;
    currency?: string;
    status?: string;
    page?: number;
    limit?: number;
}

// ============ Market Data Types ============

export interface MarketTicker {
    pair: string;
    lastPrice: string;
    bidPrice: string;
    askPrice: string;
    volume24h: string;
    change24h: string;
    high24h: string;
    low24h: string;
}

export interface InstantPrice {
    currency: string;
    buyPrice: string;
    sellPrice: string;
    timestamp: Date;
}

// ============ Purchase Types ============

export interface PurchaseLimit {
    currency: string;
    minAmount: string;
    maxAmount: string;
}

export interface PurchaseQuote {
    currency: string;
    fiatCurrency: string;
    cryptoAmount: string;
    fiatAmount: string;
    rate: string;
    fee: string;
    expiresAt: Date;
}

// ============ Main Provider Interface ============

export interface ITradingProvider {
    // Provider identification
    readonly providerName: string;

    // ============ Account Operations ============
    
    /**
     * Create a sub-account for a user on the trading platform
     */
    createSubAccount(options: CreateSubAccountOptions): Promise<ProviderResponse<SubAccount>>;
    
    /**
     * Find a sub-account by email
     */
    findSubAccountByEmail(email: string): Promise<SubAccount | null>;
    
    /**
     * Get account details by user ID
     */
    getAccountDetail(userId: string): Promise<ProviderResponse<AccountDetail>>;

    // ============ Wallet Operations ============
    
    /**
     * Get all wallet balances for a user
     */
    getUserWalletList(userId: string): Promise<ProviderResponse<WalletBalance[]>>;
    
    /**
     * Get specific wallet balance for a user
     */
    getUserWallet(userId: string, currency: string): Promise<ProviderResponse<WalletBalance>>;
    
    /**
     * Create a new payment/deposit address
     */
    createPaymentAddress(options: CreatePaymentAddressOptions): Promise<ProviderResponse<PaymentAddress>>;
    
    /**
     * Get payment address by ID
     */
    getPaymentAddressById(userId: string, addressId: string): Promise<ProviderResponse<PaymentAddress>>;
    
    /**
     * Get all payment addresses for a user's currency
     */
    getPaymentAddressList(userId: string, currency: string): Promise<ProviderResponse<PaymentAddress[]>>;
    
    /**
     * Verify if an external address is valid
     */
    verifyAddress(options: VerifyAddressOptions): Promise<ProviderResponse<AddressVerificationResult>>;

    // ============ Order Operations ============
    
    /**
     * Place a buy or sell order
     */
    placeOrder(options: PlaceOrderOptions): Promise<ProviderResponse<OrderResult>>;
    
    /**
     * Cancel an existing order
     */
    cancelOrder(options: CancelOrderOptions): Promise<ProviderResponse<OrderResult>>;
    
    /**
     * Get order details by ID
     */
    getOrderById(userId: string, orderId: string): Promise<ProviderResponse<OrderResult>>;
    
    /**
     * Get all orders for a user
     */
    getOrderList(userId: string, options?: PaginationOptions): Promise<ProviderResponse<OrderResult[]>>;

    // ============ Swap Operations ============
    
    /**
     * Create a swap quote (not yet executed)
     */
    createSwapQuote(options: CreateSwapQuoteOptions): Promise<ProviderResponse<SwapQuote>>;
    
    /**
     * Confirm and execute a swap quote
     */
    confirmSwap(options: ConfirmSwapOptions): Promise<ProviderResponse<SwapTransaction>>;
    
    /**
     * Get swap transaction details
     */
    getSwapTransaction(userId: string, transactionId: string): Promise<ProviderResponse<SwapTransaction>>;
    
    /**
     * Get all swap transactions for a user
     */
    getSwapTransactionList(userId: string): Promise<ProviderResponse<SwapTransaction[]>>;

    // ============ Withdrawal Operations ============
    
    /**
     * Create a withdrawal request
     */
    createWithdrawal(options: CreateWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>>;
    
    /**
     * Cancel a pending withdrawal
     */
    cancelWithdrawal(options: CancelWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>>;
    
    /**
     * Get withdrawal details by ID
     */
    getWithdrawalById(userId: string, withdrawalId: string): Promise<ProviderResponse<WithdrawalResult>>;
    
    /**
     * Get withdrawal by reference
     */
    getWithdrawalByReference(userId: string, reference: string): Promise<ProviderResponse<WithdrawalResult>>;
    
    /**
     * Get all withdrawals for a user
     */
    getWithdrawalList(userId: string, options?: PaginationOptions): Promise<ProviderResponse<WithdrawalResult[]>>;
    
    /**
     * Get withdrawal fees for a currency
     */
    getWithdrawalFees(userId: string, currency: string, network?: string): Promise<ProviderResponse<WithdrawalFee>>;

    // ============ Deposit Operations ============
    
    /**
     * Get deposit history for a user
     */
    fetchDeposits(options: FetchDepositsOptions): Promise<ProviderResponse<DepositRecord[]>>;
    
    /**
     * Get specific deposit by ID
     */
    fetchDeposit(userId: string, depositId: string): Promise<ProviderResponse<DepositRecord>>;

    // ============ Market Data Operations ============
    
    /**
     * Get all market tickers
     */
    getMarketTickers(): Promise<ProviderResponse<MarketTicker[]>>;
    
    /**
     * Get ticker for a specific market
     */
    getSingleMarketTicker(pair: string): Promise<ProviderResponse<MarketTicker>>;
    
    /**
     * Get list of available markets/pairs
     */
    getMarketList(): Promise<ProviderResponse<string[]>>;

    // ============ Purchase Operations ============
    
    /**
     * Get purchase limits for buying crypto
     */
    getPurchaseLimitForBuy(userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>>;
    
    /**
     * Get purchase limits for selling crypto
     */
    getPurchaseLimitForSell(userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>>;
    
    /**
     * Get quote for buying crypto with fiat
     */
    getPurchaseQuoteForBuy(userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>>;
    
    /**
     * Get quote for selling crypto for fiat
     */
    getPurchaseQuoteForSell(userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>>;
}

// ============ Mock Provider for Testing ============

/**
 * MockTradingProvider - Use for unit testing
 * 
 * Example usage:
 * ```typescript
 * const mockProvider = new MockTradingProvider();
 * mockProvider.setResponse('createSubAccount', {
 *   status: 'success',
 *   data: { id: 'test-id', email: 'test@example.com', ... }
 * });
 * ```
 */
export class MockTradingProvider implements ITradingProvider {
    readonly providerName = 'mock';
    private responses: Map<string, any> = new Map();

    setResponse<K extends keyof ITradingProvider>(
        method: K,
        response: Awaited<ReturnType<ITradingProvider[K] extends (...args: any[]) => any ? ITradingProvider[K] : never>>
    ): void {
        this.responses.set(method as string, response);
    }

    private getResponse<T>(method: string): T {
        const response = this.responses.get(method);
        if (!response) {
            throw new Error(`MockTradingProvider: No mock response set for method '${method}'`);
        }
        return response;
    }

    // Account
    async createSubAccount(_options: CreateSubAccountOptions): Promise<ProviderResponse<SubAccount>> {
        return this.getResponse('createSubAccount');
    }

    async findSubAccountByEmail(_email: string): Promise<SubAccount | null> {
        return this.getResponse('findSubAccountByEmail');
    }

    async getAccountDetail(_userId: string): Promise<ProviderResponse<AccountDetail>> {
        return this.getResponse('getAccountDetail');
    }

    // Wallet
    async getUserWalletList(_userId: string): Promise<ProviderResponse<WalletBalance[]>> {
        return this.getResponse('getUserWalletList');
    }

    async getUserWallet(_userId: string, _currency: string): Promise<ProviderResponse<WalletBalance>> {
        return this.getResponse('getUserWallet');
    }

    async createPaymentAddress(_options: CreatePaymentAddressOptions): Promise<ProviderResponse<PaymentAddress>> {
        return this.getResponse('createPaymentAddress');
    }

    async getPaymentAddressById(_userId: string, _addressId: string): Promise<ProviderResponse<PaymentAddress>> {
        return this.getResponse('getPaymentAddressById');
    }

    async getPaymentAddressList(_userId: string, _currency: string): Promise<ProviderResponse<PaymentAddress[]>> {
        return this.getResponse('getPaymentAddressList');
    }

    async verifyAddress(_options: VerifyAddressOptions): Promise<ProviderResponse<AddressVerificationResult>> {
        return this.getResponse('verifyAddress');
    }

    // Orders
    async placeOrder(_options: PlaceOrderOptions): Promise<ProviderResponse<OrderResult>> {
        return this.getResponse('placeOrder');
    }

    async cancelOrder(_options: CancelOrderOptions): Promise<ProviderResponse<OrderResult>> {
        return this.getResponse('cancelOrder');
    }

    async getOrderById(_userId: string, _orderId: string): Promise<ProviderResponse<OrderResult>> {
        return this.getResponse('getOrderById');
    }

    async getOrderList(_userId: string, _options?: PaginationOptions): Promise<ProviderResponse<OrderResult[]>> {
        return this.getResponse('getOrderList');
    }

    // Swap
    async createSwapQuote(_options: CreateSwapQuoteOptions): Promise<ProviderResponse<SwapQuote>> {
        return this.getResponse('createSwapQuote');
    }

    async confirmSwap(_options: ConfirmSwapOptions): Promise<ProviderResponse<SwapTransaction>> {
        return this.getResponse('confirmSwap');
    }

    async getSwapTransaction(_userId: string, _transactionId: string): Promise<ProviderResponse<SwapTransaction>> {
        return this.getResponse('getSwapTransaction');
    }

    async getSwapTransactionList(_userId: string): Promise<ProviderResponse<SwapTransaction[]>> {
        return this.getResponse('getSwapTransactionList');
    }

    // Withdrawal
    async createWithdrawal(_options: CreateWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        return this.getResponse('createWithdrawal');
    }

    async cancelWithdrawal(_options: CancelWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        return this.getResponse('cancelWithdrawal');
    }

    async getWithdrawalById(_userId: string, _withdrawalId: string): Promise<ProviderResponse<WithdrawalResult>> {
        return this.getResponse('getWithdrawalById');
    }

    async getWithdrawalByReference(_userId: string, _reference: string): Promise<ProviderResponse<WithdrawalResult>> {
        return this.getResponse('getWithdrawalByReference');
    }

    async getWithdrawalList(_userId: string, _options?: PaginationOptions): Promise<ProviderResponse<WithdrawalResult[]>> {
        return this.getResponse('getWithdrawalList');
    }

    async getWithdrawalFees(_userId: string, _currency: string, _network?: string): Promise<ProviderResponse<WithdrawalFee>> {
        return this.getResponse('getWithdrawalFees');
    }

    // Deposits
    async fetchDeposits(_options: FetchDepositsOptions): Promise<ProviderResponse<DepositRecord[]>> {
        return this.getResponse('fetchDeposits');
    }

    async fetchDeposit(_userId: string, _depositId: string): Promise<ProviderResponse<DepositRecord>> {
        return this.getResponse('fetchDeposit');
    }

    // Market Data
    async getMarketTickers(): Promise<ProviderResponse<MarketTicker[]>> {
        return this.getResponse('getMarketTickers');
    }

    async getSingleMarketTicker(_pair: string): Promise<ProviderResponse<MarketTicker>> {
        return this.getResponse('getSingleMarketTicker');
    }

    async getMarketList(): Promise<ProviderResponse<string[]>> {
        return this.getResponse('getMarketList');
    }

    // Purchase
    async getPurchaseLimitForBuy(_userId: string, _currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        return this.getResponse('getPurchaseLimitForBuy');
    }

    async getPurchaseLimitForSell(_userId: string, _currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        return this.getResponse('getPurchaseLimitForSell');
    }

    async getPurchaseQuoteForBuy(_userId: string, _currency: string, _amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        return this.getResponse('getPurchaseQuoteForBuy');
    }

    async getPurchaseQuoteForSell(_userId: string, _currency: string, _amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        return this.getResponse('getPurchaseQuoteForSell');
    }
}
