import { ForbiddenException } from "@nestjs/common";
import { SafeQuidaxTradingProvider } from "../safe-trading-provider";
import {
    ITradingProvider,
    MockTradingProvider,
} from "../../../interfaces/trading-provider.interface";

describe("SafeQuidaxTradingProvider", () => {
    let delegate: MockTradingProvider;
    let safe: SafeQuidaxTradingProvider;

    type TradingProviderMethod = {
        [K in keyof ITradingProvider]: ITradingProvider[K] extends (
            ...args: any[]
        ) => any
            ? K
            : never;
    }[keyof ITradingProvider];

    type TradingProviderResponse = Awaited<
        ReturnType<ITradingProvider[TradingProviderMethod]>
    >;

    type DelegationCase = readonly [
        label: string,
        method: TradingProviderMethod,
        expected: TradingProviderResponse,
        invoke: () => Promise<TradingProviderResponse>
    ];

    beforeEach(() => {
        delegate = new MockTradingProvider();
        safe = new SafeQuidaxTradingProvider(delegate, "test");
    });

    // ---- Read operations should delegate ----

    it("delegates getUserWalletList to the underlying provider", async () => {
        const expected = { status: "success" as const, data: [] };
        delegate.setResponse("getUserWalletList", expected);
        const result = await safe.getUserWalletList("user-1");
        expect(result).toBe(expected);
    });

    it("delegates getPaymentAddressList to the underlying provider", async () => {
        const expected = { status: "success" as const, data: [] };
        delegate.setResponse("getPaymentAddressList", expected);
        const result = await safe.getPaymentAddressList("user-1", "btc");
        expect(result).toBe(expected);
    });

    it("delegates createSubAccount to the underlying provider", async () => {
        const expected = {
            status: "success" as const,
            data: {
                id: "sub-1",
                email: "test@example.com",
                firstName: "Test",
                lastName: "User",
                status: "active",
                createdAt: new Date(),
            },
        };
        delegate.setResponse("createSubAccount", expected);
        const result = await safe.createSubAccount({
            email: "test@example.com",
            firstName: "Test",
            lastName: "User",
        });
        expect(result).toBe(expected);
    });

    it("delegates createPaymentAddress to the underlying provider", async () => {
        const expected = {
            status: "success" as const,
            data: {
                id: "addr-1",
                address: "0xabc",
                currency: "btc",
                network: "bitcoin",
                status: "active",
                createdAt: new Date(),
            },
        };
        delegate.setResponse("createPaymentAddress", expected);
        const result = await safe.createPaymentAddress({
            userId: "user-1",
            currency: "btc",
        });
        expect(result).toBe(expected);
    });

    it("delegates getMarketTickers to the underlying provider", async () => {
        const expected = { status: "success" as const, data: [] };
        delegate.setResponse("getMarketTickers", expected);
        const result = await safe.getMarketTickers();
        expect(result).toBe(expected);
    });

    it("delegates fetchDeposits to the underlying provider", async () => {
        const expected = { status: "success" as const, data: [] };
        delegate.setResponse("fetchDeposits", expected);
        const result = await safe.fetchDeposits({ userId: "user-1" });
        expect(result).toBe(expected);
    });

    it("delegates createSwapQuote (read-only) to the underlying provider", async () => {
        const expected = {
            status: "success" as const,
            data: {
                id: "q-1",
                fromCurrency: "btc",
                toCurrency: "usdt",
                fromAmount: "1",
                toAmount: "50000",
                rate: "50000",
                fee: "0",
                expiresAt: new Date(),
            },
        };
        delegate.setResponse("createSwapQuote", expected);
        const result = await safe.createSwapQuote({
            userId: "user-1",
            fromCurrency: "btc",
            toCurrency: "usdt",
            fromAmount: "1",
        });
        expect(result).toBe(expected);
    });

    it("delegates cancelWithdrawal (safe) to the underlying provider", async () => {
        const expected = {
            status: "success" as const,
            data: {
                id: "wd-1",
                currency: "btc",
                amount: "0.1",
                fee: "0",
                status: "cancelled",
                address: "",
                createdAt: new Date(),
            },
        };
        delegate.setResponse("cancelWithdrawal", expected);
        const result = await safe.cancelWithdrawal({
            userId: "user-1",
            withdrawalId: "wd-1",
        });
        expect(result).toBe(expected);
    });

    const delegationCases: readonly DelegationCase[] = [
        [
            "getUserWallet",
            "getUserWallet",
            {
                status: "success" as const,
                data: {
                    currency: "btc",
                    balance: "0",
                    lockedBalance: "0",
                    availableBalance: "0",
                },
            },
            () => safe.getUserWallet("user-1", "btc"),
        ],
        [
            "getPaymentAddressById",
            "getPaymentAddressById",
            {
                status: "success" as const,
                data: {
                    id: "addr-1",
                    address: "0xabc",
                    currency: "btc",
                    network: "bitcoin",
                    status: "active",
                    createdAt: new Date(),
                },
            },
            () => safe.getPaymentAddressById("user-1", "addr-1"),
        ],
        [
            "verifyAddress",
            "verifyAddress",
            {
                status: "success" as const,
                data: { isValid: true, address: "0xabc", network: "ethereum" },
            },
            () =>
                safe.verifyAddress({
                    currency: "eth",
                    address: "0xabc",
                    network: "ethereum",
                }),
        ],
        [
            "getOrderById",
            "getOrderById",
            {
                status: "success" as const,
                data: {
                    id: "ord-1",
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
                },
            },
            () => safe.getOrderById("user-1", "ord-1"),
        ],
        [
            "getOrderList",
            "getOrderList",
            { status: "success" as const, data: [] },
            () => safe.getOrderList("user-1", { page: 1, limit: 10 }),
        ],
        [
            "getSwapTransaction",
            "getSwapTransaction",
            {
                status: "success" as const,
                data: {
                    id: "swap-1",
                    fromCurrency: "btc",
                    toCurrency: "usdt",
                    fromAmount: "1",
                    toAmount: "50000",
                    status: "done",
                    createdAt: new Date(),
                },
            },
            () => safe.getSwapTransaction("user-1", "swap-1"),
        ],
        [
            "getSwapTransactionList",
            "getSwapTransactionList",
            { status: "success" as const, data: [] },
            () => safe.getSwapTransactionList("user-1"),
        ],
        [
            "getWithdrawalById",
            "getWithdrawalById",
            {
                status: "success" as const,
                data: {
                    id: "wd-1",
                    currency: "btc",
                    amount: "1",
                    fee: "0",
                    status: "done",
                    address: "0xabc",
                    createdAt: new Date(),
                },
            },
            () => safe.getWithdrawalById("user-1", "wd-1"),
        ],
        [
            "getWithdrawalByReference",
            "getWithdrawalByReference",
            {
                status: "success" as const,
                data: {
                    id: "wd-1",
                    currency: "btc",
                    amount: "1",
                    fee: "0",
                    status: "done",
                    address: "0xabc",
                    reference: "ref-1",
                    createdAt: new Date(),
                },
            },
            () => safe.getWithdrawalByReference("user-1", "ref-1"),
        ],
        [
            "getWithdrawalList",
            "getWithdrawalList",
            { status: "success" as const, data: [] },
            () => safe.getWithdrawalList("user-1", { page: 1, limit: 10 }),
        ],
        [
            "getWithdrawalFees",
            "getWithdrawalFees",
            {
                status: "success" as const,
                data: {
                    currency: "btc",
                    network: "bitcoin",
                    fee: "0.0001",
                    minimumAmount: "0.001",
                },
            },
            () => safe.getWithdrawalFees("user-1", "btc", "bitcoin"),
        ],
        [
            "fetchDeposit",
            "fetchDeposit",
            {
                status: "success" as const,
                data: {
                    id: "dep-1",
                    currency: "btc",
                    amount: "1",
                    fee: "0",
                    status: "done",
                    createdAt: new Date(),
                },
            },
            () => safe.fetchDeposit("user-1", "dep-1"),
        ],
        [
            "getSingleMarketTicker",
            "getSingleMarketTicker",
            {
                status: "success" as const,
                data: {
                    pair: "btcngn",
                    lastPrice: "0",
                    bidPrice: "0",
                    askPrice: "0",
                    volume24h: "0",
                    change24h: "0",
                    high24h: "0",
                    low24h: "0",
                },
            },
            () => safe.getSingleMarketTicker("btcngn"),
        ],
        [
            "getMarketList",
            "getMarketList",
            { status: "success" as const, data: ["btcngn", "ethngn"] },
            () => safe.getMarketList(),
        ],
        [
            "getPurchaseLimitForBuy",
            "getPurchaseLimitForBuy",
            {
                status: "success" as const,
                data: { currency: "btc", minAmount: "0", maxAmount: "1000000" },
            },
            () => safe.getPurchaseLimitForBuy("user-1", "btc"),
        ],
        [
            "getPurchaseLimitForSell",
            "getPurchaseLimitForSell",
            {
                status: "success" as const,
                data: { currency: "btc", minAmount: "0", maxAmount: "1000000" },
            },
            () => safe.getPurchaseLimitForSell("user-1", "btc"),
        ],
        [
            "getPurchaseQuoteForBuy",
            "getPurchaseQuoteForBuy",
            {
                status: "success" as const,
                data: {
                    currency: "btc",
                    fiatCurrency: "NGN",
                    cryptoAmount: "0",
                    fiatAmount: "1000",
                    rate: "0",
                    fee: "0",
                    expiresAt: new Date(),
                },
            },
            () => safe.getPurchaseQuoteForBuy("user-1", "btc", "1000"),
        ],
        [
            "getPurchaseQuoteForSell",
            "getPurchaseQuoteForSell",
            {
                status: "success" as const,
                data: {
                    currency: "btc",
                    fiatCurrency: "NGN",
                    cryptoAmount: "1000",
                    fiatAmount: "0",
                    rate: "0",
                    fee: "0",
                    expiresAt: new Date(),
                },
            },
            () => safe.getPurchaseQuoteForSell("user-1", "btc", "1000"),
        ],
    ];

    it.each(delegationCases)(
        "delegates %s to the underlying provider",
        async (_label, method, expected, invoke) => {
            delegate.setResponse(method, expected);
            const result = await invoke();
            expect(result).toBe(expected);
        }
    );

    // ---- Destructive operations should be BLOCKED ----

    it("blocks placeOrder with ForbiddenException", async () => {
        await expect(
            safe.placeOrder({
                userId: "user-1",
                pair: "btcngn",
                side: "buy",
                type: "market",
                amount: "100",
            })
        ).rejects.toThrow(ForbiddenException);
    });

    it("blocks cancelOrder with ForbiddenException", async () => {
        await expect(
            safe.cancelOrder({ userId: "user-1", orderId: "order-1" })
        ).rejects.toThrow(ForbiddenException);
    });

    it("blocks confirmSwap with ForbiddenException", async () => {
        await expect(
            safe.confirmSwap({ userId: "user-1", quoteId: "quote-1" })
        ).rejects.toThrow(ForbiddenException);
    });

    it("blocks createWithdrawal with ForbiddenException", async () => {
        await expect(
            safe.createWithdrawal({
                userId: "user-1",
                currency: "btc",
                amount: "0.5",
                address: "0xabc",
            })
        ).rejects.toThrow(ForbiddenException);
    });

    it("includes environment name in the error message", async () => {
        try {
            await safe.placeOrder({
                userId: "user-1",
                pair: "btcngn",
                side: "buy",
                type: "market",
                amount: "100",
            });
        } catch (error) {
            expect(error.message).toContain("test");
            expect(error.message).toContain("placeOrder");
        }
    });
});
