import { MockQuidaxTradingProvider } from "../mock-trading-provider";

describe("MockQuidaxTradingProvider", () => {
    let provider: MockQuidaxTradingProvider;

    beforeEach(() => {
        provider = new MockQuidaxTradingProvider();
    });

    it("has providerName 'quidax-mock'", () => {
        expect(provider.providerName).toBe("quidax-mock");
    });

    // ---- Account ----

    it("createSubAccount returns a mock sub-account with the provided email", async () => {
        const result = await provider.createSubAccount({
            email: "test@flipxer.local",
            firstName: "Test",
            lastName: "User",
        });
        expect(result.status).toBe("success");
        expect(result.data.email).toBe("test@flipxer.local");
        expect(result.data.id).toMatch(/^mock-sub-/);
    });

    it("findSubAccountByEmail returns null", async () => {
        const result = await provider.findSubAccountByEmail("test@flipxer.local");
        expect(result).toBeNull();
    });

    // ---- Wallet ----

    it("getUserWalletList returns balances for all supported currencies", async () => {
        const result = await provider.getUserWalletList("user-1");
        expect(result.status).toBe("success");
        expect(result.data.length).toBeGreaterThanOrEqual(12);
        for (const wallet of result.data) {
            expect(wallet.balance).toBe("0");
        }
    });

    it("getUserWallet returns zero balance for any currency", async () => {
        const result = await provider.getUserWallet("user-1", "BTC");
        expect(result.status).toBe("success");
        expect(result.data.currency).toBe("btc");
        expect(result.data.balance).toBe("0");
    });

    it("createPaymentAddress returns a mock address with currency and network", async () => {
        const result = await provider.createPaymentAddress({
            userId: "user-1",
            currency: "btc",
            network: "bitcoin",
        });
        expect(result.status).toBe("success");
        expect(result.data.address).toMatch(/^mock_btc_bitcoin_/);
        expect(result.data.currency).toBe("btc");
        expect(result.data.network).toBe("bitcoin");
    });

    it("getPaymentAddressList returns addresses for known networks", async () => {
        const result = await provider.getPaymentAddressList("user-1", "usdt");
        expect(result.status).toBe("success");
        // USDT has tron, ethereum, bsc networks
        expect(result.data.length).toBe(3);
        for (const addr of result.data) {
            expect(addr.address).toMatch(/^mock_usdt_/);
        }
    });

    it("createPaymentAddress falls back to the default network when none is supplied", async () => {
        const result = await provider.createPaymentAddress({
            userId: "user-1",
            currency: "eth",
        });

        expect(result.status).toBe("success");
        expect(result.data.network).toBe("ethereum");
        expect(result.data.address).toMatch(/^mock_eth_ethereum_/);
    });

    it("getPaymentAddressList falls back to mainnet for unknown currencies", async () => {
        const result = await provider.getPaymentAddressList("user-1", "xmr");

        expect(result.status).toBe("success");
        expect(result.data).toHaveLength(1);
        expect(result.data[0].network).toBe("mainnet");
        expect(result.data[0].address).toMatch(/^mock_xmr_mainnet_/);
    });

    it("getAccountDetail returns a canned active account", async () => {
        const result = await provider.getAccountDetail("user-1");

        expect(result.status).toBe("success");
        expect(result.data).toMatchObject({
            id: "user-1",
            email: "mock@flipxer.local",
            status: "active",
        });
    });

    it("verifyAddress echoes the supplied verification payload", async () => {
        const result = await provider.verifyAddress({
            currency: "eth",
            address: "0xabc",
            network: "ethereum",
        });

        expect(result.status).toBe("success");
        expect(result.data).toEqual({
            isValid: true,
            address: "0xabc",
            network: "ethereum",
        });
    });

    // ---- Orders ----

    it("placeOrder returns a mock completed order", async () => {
        const result = await provider.placeOrder({
            userId: "user-1",
            pair: "btcngn",
            side: "buy",
            type: "market",
            amount: "100",
        });
        expect(result.status).toBe("success");
        expect(result.data.status).toBe("done");
        expect(result.data.pair).toBe("btcngn");
    });

    it.each([
        ["cancelOrder", () => provider.cancelOrder({ userId: "user-1", orderId: "order-1" }), (data: any) => {
            expect(data.status).toBe("cancelled");
            expect(data.id).toBe("order-1");
        }],
        ["getOrderById", () => provider.getOrderById("user-1", "order-2"), (data: any) => {
            expect(data.id).toBe("order-2");
            expect(data.pair).toBe("btcngn");
        }],
        ["getOrderList", () => provider.getOrderList("user-1", { page: 1, limit: 10 }), (data: any) => {
            expect(data).toEqual([]);
        }],
        ["confirmSwap", () => provider.confirmSwap({ userId: "user-1", quoteId: "quote-1" }), (data: any) => {
            expect(data.id).toBe("quote-1");
            expect(data.status).toBe("done");
        }],
        ["getSwapTransaction", () => provider.getSwapTransaction("user-1", "swap-1"), (data: any) => {
            expect(data.id).toBe("swap-1");
            expect(data.status).toBe("done");
        }],
        ["getSwapTransactionList", () => provider.getSwapTransactionList("user-1"), (data: any) => {
            expect(data).toEqual([]);
        }],
        ["cancelWithdrawal", () => provider.cancelWithdrawal({ userId: "user-1", withdrawalId: "wd-1" }), (data: any) => {
            expect(data.id).toBe("wd-1");
            expect(data.status).toBe("cancelled");
        }],
        ["getWithdrawalById", () => provider.getWithdrawalById("user-1", "wd-2"), (data: any) => {
            expect(data.id).toBe("wd-2");
            expect(data.status).toBe("done");
        }],
        ["getWithdrawalByReference", () => provider.getWithdrawalByReference("user-1", "ref-1"), (data: any) => {
            expect(data.reference).toBe("ref-1");
            expect(data.status).toBe("done");
        }],
        ["getWithdrawalList", () => provider.getWithdrawalList("user-1", { page: 1, limit: 10 }), (data: any) => {
            expect(data).toEqual([]);
        }],
        ["getWithdrawalFees", () => provider.getWithdrawalFees("user-1", "btc", "bitcoin"), (data: any) => {
            expect(data).toMatchObject({ currency: "btc", network: "bitcoin", fee: "0.0001" });
        }],
        ["fetchDeposits", () => provider.fetchDeposits({ userId: "user-1", currency: "btc" }), (data: any) => {
            expect(data).toEqual([]);
        }],
        ["fetchDeposit", () => provider.fetchDeposit("user-1", "dep-1"), (data: any) => {
            expect(data.id).toBe("dep-1");
            expect(data.status).toBe("done");
        }],
        ["getSingleMarketTicker", () => provider.getSingleMarketTicker("btcngn"), (data: any) => {
            expect(data.pair).toBe("btcngn");
        }],
        ["getPurchaseLimitForBuy", () => provider.getPurchaseLimitForBuy("user-1", "btc"), (data: any) => {
            expect(data).toMatchObject({ currency: "btc", maxAmount: "1000000" });
        }],
        ["getPurchaseLimitForSell", () => provider.getPurchaseLimitForSell("user-1", "btc"), (data: any) => {
            expect(data).toMatchObject({ currency: "btc", maxAmount: "1000000" });
        }],
        ["getPurchaseQuoteForBuy", () => provider.getPurchaseQuoteForBuy("user-1", "btc", "1000"), (data: any) => {
            expect(data).toMatchObject({ currency: "btc", fiatAmount: "1000", fiatCurrency: "NGN" });
        }],
        ["getPurchaseQuoteForSell", () => provider.getPurchaseQuoteForSell("user-1", "btc", "1000"), (data: any) => {
            expect(data).toMatchObject({ currency: "btc", cryptoAmount: "1000", fiatCurrency: "NGN" });
        }],
    ])("returns canned data for %s", async (_label, invoke, assertResult) => {
        const result = await invoke();
        expect(result.status).toBe("success");
        assertResult(result.data);
    });

    // ---- Swap ----

    it("createSwapQuote returns a mock quote", async () => {
        const result = await provider.createSwapQuote({
            userId: "user-1",
            fromCurrency: "btc",
            toCurrency: "usdt",
            fromAmount: "1",
        });
        expect(result.status).toBe("success");
        expect(result.data.id).toMatch(/^mock-swap-/);
    });

    // ---- Withdrawal ----

    it("createWithdrawal returns a mock completed withdrawal", async () => {
        const result = await provider.createWithdrawal({
            userId: "user-1",
            currency: "btc",
            amount: "0.5",
            address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        });
        expect(result.status).toBe("success");
        expect(result.data.status).toBe("done");
        expect(result.data.txHash).toMatch(/^mock-tx-/);
    });

    // ---- Market Data ----

    it("getMarketTickers returns tickers for all currencies", async () => {
        const result = await provider.getMarketTickers();
        expect(result.status).toBe("success");
        expect(result.data.length).toBeGreaterThanOrEqual(12);
    });

    it("getMarketList returns NGN pairs", async () => {
        const result = await provider.getMarketList();
        expect(result.status).toBe("success");
        expect(result.data).toContain("btcngn");
        expect(result.data).toContain("ethngn");
    });
});
