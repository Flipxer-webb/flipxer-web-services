/**
 * QuidaxTradingProvider - Adapter that wraps QuidaxService to implement ITradingProvider
 * 
 * This adapter translates between the provider-agnostic ITradingProvider interface
 * and the Quidax-specific QuidaxService implementation.
 * 
 * Note: Uses 'any' type in places where Quidax API responses vary from documented types.
 * This is intentional to handle runtime API differences gracefully.
 */

import { Logger } from "@nestjs/common";
import { QuidaxService } from "./services";
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

export class QuidaxTradingProvider implements ITradingProvider {
    readonly providerName = 'quidax';
    private readonly logger = new Logger(QuidaxTradingProvider.name);

    constructor(private readonly quidaxService: QuidaxService) {}

    // Helper to safely extract value from response data
    private getValue(data: any, key: string, defaultValue: string = ''): string {
        return data?.[key]?.toString() ?? defaultValue;
    }

    // ============ Account Operations ============

    async createSubAccount(options: CreateSubAccountOptions): Promise<ProviderResponse<SubAccount>> {
        const result = await this.quidaxService.createSubAccount({
            email: options.email,
            first_name: options.firstName,
            last_name: options.lastName,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || '',
                email: data?.email || options.email,
                firstName: data?.first_name || options.firstName,
                lastName: data?.last_name || options.lastName,
                reference: data?.sn,
                status: 'active',
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async findSubAccountByEmail(email: string): Promise<SubAccount | null> {
        const account = await this.quidaxService.findSubAccountByEmail(email);
        if (!account) return null;

        const data: any = account;
        return {
            id: data.id,
            email: data.email,
            firstName: data.first_name,
            lastName: data.last_name,
            reference: data.sn,
            status: 'active',
            createdAt: new Date(data.created_at),
        };
    }

    async getAccountDetail(userId: string): Promise<ProviderResponse<AccountDetail>> {
        const result = await this.quidaxService.getAccountDetail({ user_id: userId });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || userId,
                email: data?.email || '',
                firstName: data?.first_name || '',
                lastName: data?.last_name || '',
                status: 'active',
            },
        };
    }

    // ============ Wallet Operations ============

    async getUserWalletList(userId: string): Promise<ProviderResponse<WalletBalance[]>> {
        const result = await this.quidaxService.getUserWalletList({ user_id: userId });

        const wallets: WalletBalance[] = ((result.data as any) || []).map((w: any) => ({
            currency: w.currency,
            balance: w.balance || '0',
            lockedBalance: w.locked || '0',
            availableBalance: w.available_balance || w.balance || '0',
        }));

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: wallets,
        };
    }

    async getUserWallet(userId: string, currency: string): Promise<ProviderResponse<WalletBalance>> {
        const result = await this.quidaxService.getUserWallet({ 
            user_id: userId, 
            currency: currency.toLowerCase() 
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                currency: data?.currency || currency,
                balance: data?.balance || '0',
                lockedBalance: data?.locked || '0',
                availableBalance: data?.available_balance || data?.balance || '0',
            },
        };
    }

    async createPaymentAddress(options: CreatePaymentAddressOptions): Promise<ProviderResponse<PaymentAddress>> {
        const result = await this.quidaxService.createPaymentAddress({
            user_id: options.userId,
            currency: options.currency.toLowerCase(),
            network: options.network,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || '',
                address: data?.address || '',
                currency: data?.currency || options.currency,
                network: data?.network || options.network || '',
                status: 'active',
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async getPaymentAddressById(userId: string, addressId: string): Promise<ProviderResponse<PaymentAddress>> {
        // Note: Quidax requires currency to fetch address by ID
        // This is a limitation that callers need to be aware of
        const result = await this.quidaxService.getPaymentAddressById({
            user_id: userId,
            currency: '', // Caller should provide this
            address_id: addressId,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || addressId,
                address: data?.address || '',
                currency: data?.currency || '',
                network: data?.network || '',
                status: 'active',
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async getPaymentAddressList(userId: string, currency: string): Promise<ProviderResponse<PaymentAddress[]>> {
        const result = await this.quidaxService.getPaymentAddressList({
            user_id: userId,
            currency: currency.toLowerCase(),
        });

        const addresses: PaymentAddress[] = ((result.data as any) || []).map((a: any) => ({
            id: a.id,
            address: a.address,
            currency: a.currency || currency,
            network: a.network || '',
            status: 'active',
            createdAt: new Date(a.created_at || Date.now()),
        }));

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: addresses,
        };
    }

    async verifyAddress(options: VerifyAddressOptions): Promise<ProviderResponse<AddressVerificationResult>> {
        const result = await this.quidaxService.verifyAddress({
            currency: options.currency.toLowerCase(),
            address: options.address,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                isValid: data?.valid || false,
                address: options.address,
                network: options.network,
            },
        };
    }

    async internalTransfer(options: any): Promise<ProviderResponse<any>> {
        // Extract userId and transfer options from the input
        // Expected structure: { userId: string, currency: string, amount: string, recipient?: string, reason?: string }
        const userId = options.userId || options.user_id;
        if (!userId) {
            throw new Error('userId is required for internalTransfer');
        }

        const result = await this.quidaxService.internalTransfer(userId, {
            currency: options.currency?.toLowerCase() || options.currency,
            amount: options.amount,
            recipient: options.recipient || 'me', // Default to master account if not specified
            reason: options.reason,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || '',
                currency: data?.currency || options.currency,
                amount: data?.amount?.toString() || options.amount,
                recipient: options.recipient || data?.recipient,
                status: data?.state || 'pending',
                txHash: data?.txid,
                createdAt: new Date(data?.created_at || Date.now()),
                completedAt: data?.done_at ? new Date(data.done_at) : undefined,
            },
        };
    }

    // ============ Order Operations ============

    async placeOrder(options: PlaceOrderOptions): Promise<ProviderResponse<OrderResult>> {
        const result = await this.quidaxService.buyOrSellOrderRequest(options.userId, {
            market: options.pair as any,
            side: options.side,
            ord_type: options.type === 'market' ? 'market' : 'limit',
            price: options.price ? parseFloat(options.price) : undefined,
            volume: parseFloat(options.volume || options.amount),
        });

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: this.mapOrderResult(result.data),
        };
    }

    async cancelOrder(options: CancelOrderOptions): Promise<ProviderResponse<OrderResult>> {
        const result = await this.quidaxService.cancelBuyOrSellOrderRequest(options.userId, {
            user_id: options.userId,
            order_id: options.orderId,
        });

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: this.mapOrderResult(result.data),
        };
    }

    async getOrderById(userId: string, orderId: string): Promise<ProviderResponse<OrderResult>> {
        const result = await this.quidaxService.getOrderRecord({
            user_id: userId,
            order_id: orderId,
        });

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: this.mapOrderResult(result.data),
        };
    }

    async getOrderList(userId: string, _options?: PaginationOptions): Promise<ProviderResponse<OrderResult[]>> {
        const result = await this.quidaxService.getAllOrders(userId, {
            market: 'btcngn' as any,
            state: 'done',
        });

        const orders: OrderResult[] = ((result.data as any) || []).map((o: any) => this.mapOrderResult(o));

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: orders,
        };
    }

    private mapOrderResult(data: any): OrderResult {
        return {
            id: data?.id || '',
            pair: data?.market || '',
            side: data?.side || 'buy',
            type: data?.ord_type || 'market',
            status: data?.state || 'pending',
            price: data?.price?.toString() || '0',
            volume: data?.volume?.toString() || '0',
            executedVolume: data?.executed_volume?.toString() || '0',
            remainingVolume: data?.remaining_volume?.toString() || '0',
            fee: data?.fee?.toString() || undefined,
            createdAt: new Date(data?.created_at || Date.now()),
            updatedAt: new Date(data?.updated_at || Date.now()),
        };
    }

    // ============ Swap Operations ============

    async createSwapQuote(options: CreateSwapQuoteOptions): Promise<ProviderResponse<SwapQuote>> {
        const result = await this.quidaxService.createInstantSwapRequest(options.userId, {
            from_currency: options.fromCurrency.toLowerCase(),
            to_currency: options.toCurrency.toLowerCase(),
            from_amount: options.fromAmount,
            to_amount: options.toAmount,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || '',
                fromCurrency: data?.from_currency || options.fromCurrency,
                toCurrency: data?.to_currency || options.toCurrency,
                fromAmount: data?.from_amount?.toString() || '0',
                toAmount: data?.to_amount?.toString() || '0',
                rate: data?.rate?.toString() || data?.exchange_rate?.toString() || '0',
                fee: data?.fee?.toString() || data?.total_fee?.toString() || '0',
                expiresAt: new Date(data?.expires_at || Date.now() + 60000),
            },
        };
    }

    async confirmSwap(options: ConfirmSwapOptions): Promise<ProviderResponse<SwapTransaction>> {
        const result = await this.quidaxService.confirmInstantSwap({
            user_id: options.userId,
            quotation_id: options.quoteId,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || '',
                fromCurrency: data?.from_currency || '',
                toCurrency: data?.to_currency || '',
                fromAmount: data?.from_amount?.toString() || '0',
                toAmount: data?.to_amount?.toString() || '0',
                status: data?.status || data?.state || 'pending',
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async getSwapTransaction(userId: string, transactionId: string): Promise<ProviderResponse<SwapTransaction>> {
        const result = await this.quidaxService.getSwapTransaction({
            user_id: userId,
            swap_transaction_id: transactionId,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || transactionId,
                fromCurrency: data?.from_currency || '',
                toCurrency: data?.to_currency || '',
                fromAmount: data?.from_amount?.toString() || '0',
                toAmount: data?.to_amount?.toString() || '0',
                status: data?.status || data?.state || 'pending',
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async getSwapTransactionList(userId: string): Promise<ProviderResponse<SwapTransaction[]>> {
        const result = await this.quidaxService.getSwapTransactionList(userId);

        const transactions: SwapTransaction[] = ((result.data as any) || []).map((t: any) => ({
            id: t.id,
            fromCurrency: t.from_currency,
            toCurrency: t.to_currency,
            fromAmount: t.from_amount?.toString() || '0',
            toAmount: t.to_amount?.toString() || '0',
            status: t.status || t.state || 'pending',
            createdAt: new Date(t.created_at || Date.now()),
        }));

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: transactions,
        };
    }

    // ============ Withdrawal Operations ============

    async createWithdrawal(options: CreateWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        const result = await this.quidaxService.createWithdrawerRequest({
            user_id: options.userId,
            currency: options.currency.toLowerCase(),
            amount: options.amount,
            fund_uid: options.address,
            network: options.network,
            reference: options.reference || '',
            narration: options.narration || '',
            transaction_note: options.narration || '',
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || '',
                currency: data?.currency || options.currency,
                amount: data?.amount?.toString() || options.amount,
                fee: data?.fee?.toString() || '0',
                status: data?.state || 'pending',
                address: options.address,
                network: options.network,
                txHash: data?.txid,
                reference: data?.reference || options.reference,
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async cancelWithdrawal(options: CancelWithdrawalOptions): Promise<ProviderResponse<WithdrawalResult>> {
        const result = await this.quidaxService.cancelWithdrawerRequest({
            user_id: options.userId,
            withdrawal_id: options.withdrawalId,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: options.withdrawalId,
                currency: data?.currency || '',
                amount: data?.amount?.toString() || '0',
                fee: data?.fee?.toString() || '0',
                status: 'cancelled',
                address: data?.fund_uid || '',
                createdAt: new Date(data?.created_at || Date.now()),
            },
        };
    }

    async getWithdrawalById(userId: string, withdrawalId: string): Promise<ProviderResponse<WithdrawalResult>> {
        const result = await this.quidaxService.getWithdrawerDetail({
            user_id: userId,
            withdrawal_id: withdrawalId,
        });

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: this.mapWithdrawalResult(result.data),
        };
    }

    async getWithdrawalByReference(userId: string, reference: string): Promise<ProviderResponse<WithdrawalResult>> {
        const result = await this.quidaxService.getWithdrawerByReference({
            user_id: userId,
            reference,
        });

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: this.mapWithdrawalResult(result.data),
        };
    }

    async getWithdrawalList(userId: string, _options?: PaginationOptions): Promise<ProviderResponse<WithdrawalResult[]>> {
        const result = await this.quidaxService.getWithdrawerList(userId, {
            currency: 'btc' as any,
            state: 'done',
        });

        const withdrawals: WithdrawalResult[] = ((result.data as any) || []).map((w: any) => 
            this.mapWithdrawalResult(w)
        );

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: withdrawals,
        };
    }

    async getWithdrawalFees(userId: string, currency: string, network?: string): Promise<ProviderResponse<WithdrawalFee>> {
        const result = await this.quidaxService.getWithdrawerFees({
            currency: currency.toLowerCase(),
            network: network as any,
        });

        const data: any = result.data;
        // Handle case where fee might be an array or object
        const fee = Array.isArray(data?.fee) 
            ? data.fee[0]?.fee?.toString() || '0'
            : data?.fee?.toString() || '0';

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                currency,
                network,
                fee,
                minimumAmount: data?.minimum?.toString() || data?.min_amount?.toString() || '0',
            },
        };
    }

    private mapWithdrawalResult(data: any): WithdrawalResult {
        return {
            id: data?.id || '',
            currency: data?.currency || '',
            amount: data?.amount?.toString() || '0',
            fee: data?.fee?.toString() || '0',
            status: data?.state || 'pending',
            address: data?.fund_uid || '',
            network: data?.network,
            txHash: data?.txid,
            reference: data?.reference,
            createdAt: new Date(data?.created_at || Date.now()),
        };
    }

    // ============ Deposit Operations ============

    async fetchDeposits(options: FetchDepositsOptions): Promise<ProviderResponse<DepositRecord[]>> {
        const result = await this.quidaxService.fetchDeposits({
            user_id: options.userId,
            currency: options.currency?.toLowerCase() as any,
            state: options.status as any,
        });

        const deposits: DepositRecord[] = ((result.data as any) || []).map((d: any) => ({
            id: d.id,
            currency: d.currency,
            amount: d.amount?.toString() || '0',
            fee: d.fee?.toString() || '0',
            status: d.state || 'pending',
            txHash: d.txid,
            address: d.payment_address?.address || d.address,
            network: d.network,
            confirmations: d.confirmations,
            createdAt: new Date(d.created_at || Date.now()),
            completedAt: d.done_at ? new Date(d.done_at) : undefined,
        }));

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: deposits,
        };
    }

    async fetchDeposit(userId: string, depositId: string): Promise<ProviderResponse<DepositRecord>> {
        // Note: Quidax requires currency for fetchDeposit
        // Using 'btc' as placeholder - actual implementation may need currency from caller
        const result = await this.quidaxService.fetchDeposit({
            user_id: userId,
            deposit_id: depositId,
            currency: 'btc' as any,
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                id: data?.id || depositId,
                currency: data?.currency || '',
                amount: data?.amount?.toString() || '0',
                fee: data?.fee?.toString() || '0',
                status: data?.state || 'pending',
                txHash: data?.txid,
                address: data?.payment_address?.address || data?.address,
                network: data?.network,
                confirmations: data?.confirmations,
                createdAt: new Date(data?.created_at || Date.now()),
                completedAt: data?.done_at ? new Date(data.done_at) : undefined,
            },
        };
    }

    // ============ Market Data Operations ============

    async getMarketTickers(): Promise<ProviderResponse<MarketTicker[]>> {
        const result = await this.quidaxService.getMarketTickers();

        // Quidax returns an object with market pairs as keys
        const data: any = result.data;
        const tickers: MarketTicker[] = Object.entries(data || {}).map(([pair, tickerData]: [string, any]) => ({
            pair,
            lastPrice: tickerData?.ticker?.last || tickerData?.last || '0',
            bidPrice: tickerData?.ticker?.buy || tickerData?.buy || '0',
            askPrice: tickerData?.ticker?.sell || tickerData?.sell || '0',
            volume24h: tickerData?.ticker?.vol || tickerData?.vol || '0',
            change24h: tickerData?.ticker?.change || tickerData?.change || '0',
            high24h: tickerData?.ticker?.high || tickerData?.high || '0',
            low24h: tickerData?.ticker?.low || tickerData?.low || '0',
        }));

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: tickers,
        };
    }

    async getSingleMarketTicker(pair: string): Promise<ProviderResponse<MarketTicker>> {
        const result = await this.quidaxService.getSingleMarketTicker(pair.toLowerCase());

        const data: any = result.data;
        const ticker = data?.ticker || data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                pair: data?.market || pair,
                lastPrice: ticker?.last || '0',
                bidPrice: ticker?.buy || '0',
                askPrice: ticker?.sell || '0',
                volume24h: ticker?.vol || '0',
                change24h: ticker?.change || '0',
                high24h: ticker?.high || '0',
                low24h: ticker?.low || '0',
            },
        };
    }

    async getMarketList(): Promise<ProviderResponse<string[]>> {
        const result = await this.quidaxService.getMarketList();

        const markets: string[] = ((result.data as any) || []).map((m: any) => 
            typeof m === 'string' ? m : m.id || m.name || ''
        );

        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: markets,
        };
    }

    // ============ Purchase Operations ============

    async getPurchaseLimitForBuy(userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        const result = await this.quidaxService.getPurchaseLimitForBuy({
            currency_symbol: currency.toLowerCase(),
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                currency,
                minAmount: data?.min_amount?.toString() || data?.minimum?.toString() || '0',
                maxAmount: data?.max_amount?.toString() || data?.maximum?.toString() || '0',
            },
        };
    }

    async getPurchaseLimitForSell(userId: string, currency: string): Promise<ProviderResponse<PurchaseLimit>> {
        const result = await this.quidaxService.getPurchaseLimitForSell({
            token_symbol: currency.toLowerCase(),
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                currency,
                minAmount: data?.min_amount?.toString() || data?.minimum?.toString() || '0',
                maxAmount: data?.max_amount?.toString() || data?.maximum?.toString() || '0',
            },
        };
    }

    async getPurchaseQuoteForBuy(userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        const result = await this.quidaxService.getPurchaseQuoteForBuy({
            currency: 'ngn', // Fiat currency
            token: currency.toLowerCase(),
            fiat_amount: amount,
            token_network: 'mainnet',
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                currency,
                fiatCurrency: 'NGN',
                cryptoAmount: data?.crypto_amount?.toString() || '0',
                fiatAmount: data?.fiat_amount?.toString() || amount,
                rate: data?.rate?.toString() || '0',
                fee: data?.fee?.toString() || '0',
                expiresAt: new Date(Date.now() + 60000),
            },
        };
    }

    async getPurchaseQuoteForSell(userId: string, currency: string, amount: string): Promise<ProviderResponse<PurchaseQuote>> {
        const result = await this.quidaxService.getPurchaseQuoteForSell({
            currency: 'ngn', // Fiat currency
            token: currency.toLowerCase(),
            token_amount: amount,
            token_network: 'mainnet',
        });

        const data: any = result.data;
        return {
            status: result.status === 'successful' ? 'success' : 'error',
            message: result.message,
            data: {
                currency,
                fiatCurrency: 'NGN',
                cryptoAmount: amount,
                fiatAmount: data?.fiat_amount?.toString() || '0',
                rate: data?.rate?.toString() || '0',
                fee: data?.fee?.toString() || '0',
                expiresAt: new Date(Date.now() + 60000),
            },
        };
    }
}
