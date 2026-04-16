/**
 * MockQuidaxTradingProvider — Offline mock that returns realistic canned data.
 *
 * Activated when QUIDAX_MOCK=true. No Quidax API calls are made.
 * Designed for local Docker development so developers don't need real
 * Quidax credentials and no sub-account pollution occurs.
 */

import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
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

const SUPPORTED_CURRENCIES = [
    "btc", "eth", "usdt", "usdc", "bnb", "sol",
    "xrp", "ada", "doge", "ltc", "trx", "shib",
];

const MOCK_NETWORKS: Record<string, string[]> = {
    btc: ["bitcoin"],
    eth: ["ethereum"],
    usdt: ["tron", "ethereum", "bsc"],
    usdc: ["ethereum", "solana"],
    bnb: ["bsc"],
    sol: ["solana"],
    xrp: ["ripple"],
    ada: ["cardano"],
    doge: ["dogecoin"],
    ltc: ["litecoin"],
    trx: ["tron"],
    shib: ["ethereum"],
};

function mockAddress(currency: string, network: string): string {
    const short = randomUUID().replaceAll("-", "").substring(0, 16);
    return `mock_${currency}_${network}_${short}`;
}

function ok<T>(data: T, message = "Mock success"): ProviderResponse<T> {
    return { status: "success", message, data };
}

export class MockQuidaxTradingProvider implements ITradingProvider {
    readonly providerName = "quidax-mock";
    private readonly logger = new Logger(MockQuidaxTradingProvider.name);

    constructor() {
        this.logger.warn(
            "MockQuidaxTradingProvider active — all Quidax calls return canned data",
        );
    }

    // ============ Account Operations ============

    async createSubAccount(options: CreateSubAccountOptions): Promise<ProviderResponse<SubAccount>> {
        const id = `mock-sub-${randomUUID().substring(0, 8)}`;
        this.logger.log(`[MOCK] createSubAccount email=${options.email} → id=${id}`);
        return ok({
            id,
            email: options.email,
            firstName: options.firstName,
            lastName: options.lastName,
            reference: `mock-sn-${Date.now()}`,
            status: "active",
            createdAt: new Date(),
        });
    }

    async findSubAccountByEmail(email: string): Promise<SubAccount | null> {
        this.logger.log(`[MOCK] findSubAccountByEmail email=${email} → null`);
        return null;
    }

    async getAccountDetail(userId: string): Promise<ProviderResponse<AccountDetail>> {
        return ok({
            id: userId,
            email: "mock@flipxer.local",
            firstName: "Mock",
            lastName: "User",
            status: "active",
        });
    }

    // ============ Wallet Operations ============

    async getUserWalletList(userId: string): Promise<ProviderResponse<WalletBalance[]>> {
        const wallets: WalletBalance[] = SUPPORTED_CURRENCIES.map((c) => ({
            currency: c,
            balance: "0",
            lockedBalance: "0",
            availableBalance: "0",
        }));
        return ok(wallets);
    }

    async getUserWallet(_userId: string, currency: string): Promise<ProviderResponse<WalletBalance>> {
        return ok({
            currency: currency.toLowerCase(),
            balance: "0",
            lockedBalance: "0",
            availableBalance: "0",
        });
    }

    async createPaymentAddress(options: CreatePaymentAddressOptions): Promise<ProviderResponse<PaymentAddress>> {
        const network = options.network || (MOCK_NETWORKS[options.currency.toLowerCase()]?.[0] ?? "mainnet");
        const address = mockAddress(options.currency.toLowerCase(), network);
        this.logger.log(`[MOCK] createPaymentAddress currency=${options.currency} network=${network} → ${address}`);
        return ok({
            id: `mock-addr-${randomUUID().substring(0, 8)}`,
            address,
            currency: options.currency.toLowerCase(),
            network,
            status: "active",
            createdAt: new Date(),
        });
    }

    async getPaymentAddressById(_userId: string, addressId: string): Promise<ProviderResponse<PaymentAddress>> {
        return ok({
            id: addressId,
            address: mockAddress("btc", "bitcoin"),
            currency: "btc",
            network: "bitcoin",
            status: "active",
            createdAt: new Date(),
        });
    }

    async getPaymentAddressList(_userId: string, currency: string): Promise<ProviderResponse<PaymentAddress[]>> {
        const networks = MOCK_NETWORKS[currency.toLowerCase()] || ["mainnet"];
        const addresses: PaymentAddress[] = networks.map((net) => ({
            id: `mock-addr-${randomUUID().substring(0, 8)}`,
            address: mockAddress(currency.toLowerCase(), net),
            currency: currency.toLowerCase(),
            network: net,
            status: "active",
            createdAt: new Date(),
        }));
        return ok(addresses);
    }

    async verifyAddress(options: VerifyAddressOptions): Promise<ProviderResponse<AddressVerificationResult>> {
        return ok({
            isValid: true,
            address: options.address,
            network: options.network,
        });
    }

    // ============ Order Operations ============

    async placeOrder(options: PlaceOrderOptions): Promise<ProviderResponse<OrderResult>> {
        const id = `mock-order-${randomUUID().substring(0, 8)}`;
        this.logger.log(`[MOCK] placeOrder ${options.side} ${options.pair} amount=${options.amount} → ${id}`);
        return ok({
            id,
            pair: options.pair,
            side: options.side,
            type: options.type,
            status: "done",
            price: options.price || "0",
            volume: options.volume || options.amount,
            executedVolume: options.volume || options.amount,
            remainingVolume: "0",
            fee: "0",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }

    async cancelOrder(options: CancelOrderOptions): Promise<ProviderResponse<OrderResult>> {
        return ok({
            id: options.orderId,
            pair: "",
            side: "buy",
            type: "market",
            status: "cancelled",
            price: "0",
            volume: "0",
            executedVolume: "0",
            remainingVolume: "0",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }

    async getOrderById(_userId: string, orderId: string): Promise<ProviderResponse<OrderResult>> {
        return ok({
            id: orderId,
            pair: "btcngn",
            side: "buy",
            type: "market",
            status: "done",
            price: "0",
            volume: "0",
            executedVolume: "0",
            remainingVolume: "0",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }

    async getOrderList(_userId: string, _options?: PaginationOptions): Promise<ProviderResponse<OrderResult[]>> {
        return ok([]);
    }

    // ============ Swap Operations ============

    async createSwapQuote(options: CreateSwapQuoteOptions): Promise<ProviderResponse<SwapQuote>> {
        const id = `mock-swap-${randomUUID().substring(0, 8)}`;
        return ok({
            id,
            fromCurrency: options.fromCurrency,
            toCurrency: options.toCurrency,
            fromAmount: options.fromAmount || "0",
            toAmount: options.toAmount || "0",
            rate: "1",
            fee: "0",
            expiresAt: new Date(Date.now() + 60_000),
        });
    }

    async confirmSwap(options: ConfirmSwapOptions): Promise<ProviderResponse<SwapTransaction>> {
        return ok({
            id: options.quoteId,
            fromCurrency: "",
            toCurrency: "",
            fromAmount: "0",
            toAmount: "0",
            status: "done",
            createdAt: new Date(),
        });
    }

    async getSwapTransaction(_userId: string, transactionId: string): Promise<ProviderResponse<SwapTransaction>> {
        return ok({
            id: transactionId,
            fromCurrency: "",
            toCurrency: "",
            fromAmount: "0",
            toAmount: "0",
            status: "done",
            createdAt: new Date(),
        });
    }

    async getSwapTransactionList(_userId: string): Promise<ProviderResponse<SwapTransaction[]>> {
        return ok([]);
    }

    // ============ Withdrawal Operations ============

    async createWithdrawal(options: CreateWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        const id = `mock-wd-${randomUUID().substring(0, 8)}`;
        this.logger.log(`[MOCK] createWithdrawal currency=${options.currency} amount=${options.amount} → ${id}`);
        return ok({
            id,
            currency: options.currency,
            amount: options.amount,
            fee: "0",
            status: "done",
            address: options.address,
            network: options.network,
            txHash: `mock-tx-${randomUUID().substring(0, 12)}`,
            reference: options.reference,
            createdAt: new Date(),
        });
    }

    async cancelWithdrawal(options: CancelWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        return ok({
            id: options.withdrawalId,
            currency: "",
            amount: "0",
            fee: "0",
            status: "cancelled",
            address: "",
            createdAt: new Date(),
        });
    }

    async getWithdrawalById(_userId: string, withdrawalId: string): Promise<ProviderResponse<WithdrawalResult>> {
        return ok({
            id: withdrawalId,
            currency: "",
            amount: "0",
            fee: "0",
            status: "done",
            address: "",
            createdAt: new Date(),
        });
    }

    async getWithdrawalByReference(_userId: string, reference: string): Promise<ProviderResponse<WithdrawalResult>> {
        return ok({
            id: `mock-wd-${randomUUID().substring(0, 8)}`,
            currency: "",
            amount: "0",
            fee: "0",
            status: "done",
            address: "",
            reference,
            createdAt: new Date(),
        });
    }

    async getWithdrawalList(_userId: string, _options?: PaginationOptions): Promise<ProviderResponse<WithdrawalResult[]>> {
        return ok([]);
    }

    async getWithdrawalFees(_userId: string, currency: string, network?: string): Promise<ProviderResponse<WithdrawalFee>> {
        return ok({
            currency,
            network,
            fee: "0.0001",
            minimumAmount: "0.001",
        });
    }

    // ============ Deposit Operations ============

    async fetchDeposits(_options: FetchDepositsOptions): Promise<ProviderResponse<DepositRecord[]>> {
        return ok([]);
    }

    async fetchDeposit(_userId: string, depositId: string): Promise<ProviderResponse<DepositRecord>> {
        return ok({
            id: depositId,
            currency: "btc",
            amount: "0",
            fee: "0",
            status: "done",
            createdAt: new Date(),
        });
    }

    // ============ Market Data Operations ============

    async getMarketTickers(): Promise<ProviderResponse<MarketTicker[]>> {
        const tickers: MarketTicker[] = SUPPORTED_CURRENCIES.map((c) => ({
            pair: `${c}ngn`,
            lastPrice: "0",
            bidPrice: "0",
            askPrice: "0",
            volume24h: "0",
            change24h: "0",
            high24h: "0",
            low24h: "0",
        }));
        return ok(tickers);
    }

    async getSingleMarketTicker(pair: string): Promise<ProviderResponse<MarketTicker>> {
        return ok({
            pair,
            lastPrice: "0",
            bidPrice: "0",
            askPrice: "0",
            volume24h: "0",
            change24h: "0",
            high24h: "0",
            low24h: "0",
        });
    }

    async getMarketList(): Promise<ProviderResponse<string[]>> {
        return ok(SUPPORTED_CURRENCIES.map((c) => `${c}ngn`));
    }

    // ============ Purchase Operations ============

    async getPurchaseLimitForBuy(_userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        return ok({ currency, minAmount: "0", maxAmount: "1000000" });
    }

    async getPurchaseLimitForSell(_userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        return ok({ currency, minAmount: "0", maxAmount: "1000000" });
    }

    async getPurchaseQuoteForBuy(_userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        return ok({
            currency,
            fiatCurrency: "NGN",
            cryptoAmount: "0",
            fiatAmount: amount,
            rate: "0",
            fee: "0",
            expiresAt: new Date(Date.now() + 60_000),
        });
    }

    async getPurchaseQuoteForSell(_userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        return ok({
            currency,
            fiatCurrency: "NGN",
            cryptoAmount: amount,
            fiatAmount: "0",
            rate: "0",
            fee: "0",
            expiresAt: new Date(Date.now() + 60_000),
        });
    }
}
