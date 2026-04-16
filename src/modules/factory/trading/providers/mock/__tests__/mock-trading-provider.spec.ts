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
