import { QuidaxTradingProvider } from "../quidax-trading-provider";

function makeQuidaxServiceMock() {
    return {
        createSubAccount: jest.fn(),
        findSubAccountByEmail: jest.fn(),
        getAccountDetail: jest.fn(),
        getUserWalletList: jest.fn(),
        getUserWallet: jest.fn(),
        createPaymentAddress: jest.fn(),
        getPaymentAddressById: jest.fn(),
        getPaymentAddressList: jest.fn(),
        verifyAddress: jest.fn(),
        buyOrSellOrderRequest: jest.fn(),
        cancelBuyOrSellOrderRequest: jest.fn(),
        getOrderRecord: jest.fn(),
        getAllOrders: jest.fn(),
        createInstantSwapRequest: jest.fn(),
        confirmInstantSwap: jest.fn(),
        getSwapTransaction: jest.fn(),
        getSwapTransactionList: jest.fn(),
        createWithdrawerRequest: jest.fn(),
        cancelWithdrawerRequest: jest.fn(),
        getWithdrawerDetail: jest.fn(),
        getWithdrawerByReference: jest.fn(),
        getWithdrawerList: jest.fn(),
        getWithdrawerFees: jest.fn(),
        fetchDeposits: jest.fn(),
        fetchDeposit: jest.fn(),
        getMarketTickers: jest.fn(),
        getSingleMarketTicker: jest.fn(),
        getMarketList: jest.fn(),
        getPurchaseLimitForBuy: jest.fn(),
        getPurchaseLimitForSell: jest.fn(),
        getPurchaseQuoteForBuy: jest.fn(),
        getPurchaseQuoteForSell: jest.fn(),
    };
}

describe("QuidaxTradingProvider", () => {
    let quidaxService: ReturnType<typeof makeQuidaxServiceMock>;
    let provider: QuidaxTradingProvider;

    beforeEach(() => {
        quidaxService = makeQuidaxServiceMock();
        provider = new QuidaxTradingProvider(quidaxService as any);
        jest.spyOn((provider as any).logger, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("should map account and wallet operations", async () => {
        quidaxService.createSubAccount.mockResolvedValue({
            status: "successful",
            message: "created",
            data: {
                id: "sub-1",
                email: "user@example.com",
                first_name: "Test",
                last_name: "User",
                sn: "SN-123",
                created_at: "2026-01-01T00:00:00.000Z",
            },
        });

        quidaxService.findSubAccountByEmail.mockResolvedValue({
            id: "sub-2",
            email: "find@example.com",
            first_name: "Find",
            last_name: "Me",
            sn: "SN-456",
            created_at: "2026-01-02T00:00:00.000Z",
        });

        quidaxService.getAccountDetail.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                id: "sub-3",
                email: "detail@example.com",
                first_name: "Detail",
                last_name: "User",
            },
        });

        quidaxService.getUserWalletList.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ currency: "btc", balance: "1", locked: "0.1", available_balance: "0.9" }],
        });

        quidaxService.getUserWallet.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { currency: "btc", balance: "2", locked: "0.2", available_balance: "1.8" },
        });

        quidaxService.createPaymentAddress.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                id: "addr-1",
                address: "bc1xxx",
                currency: "btc",
                network: "BTC",
                created_at: "2026-01-03T00:00:00.000Z",
            },
        });

        quidaxService.getPaymentAddressById.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                id: "addr-1",
                address: "bc1xxx",
                currency: "btc",
                network: "BTC",
                created_at: "2026-01-03T00:00:00.000Z",
            },
        });

        quidaxService.getPaymentAddressList.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ id: "addr-2", address: "bc1yyy", currency: "btc", network: "BTC" }],
        });

        quidaxService.verifyAddress.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { valid: true },
        });

        const createResult = await provider.createSubAccount({
            email: "user@example.com",
            firstName: "Test",
            lastName: "User",
        });
        const findResult = await provider.findSubAccountByEmail("find@example.com");
        const detailResult = await provider.getAccountDetail("sub-3");
        const walletList = await provider.getUserWalletList("sub-3");
        const wallet = await provider.getUserWallet("sub-3", "BTC");
        const paymentAddress = await provider.createPaymentAddress({ userId: "sub-3", currency: "BTC", network: "BTC" });
        const paymentAddressById = await provider.getPaymentAddressById("sub-3", "addr-1");
        const paymentAddressList = await provider.getPaymentAddressList("sub-3", "BTC");
        const verifyResult = await provider.verifyAddress({ currency: "BTC", address: "bc1xxx", network: "BTC" });

        expect(createResult.data.reference).toBe("SN-123");
        expect(findResult?.reference).toBe("SN-456");
        expect(detailResult.data.email).toBe("detail@example.com");
        expect(walletList.data[0].availableBalance).toBe("0.9");
        expect(wallet.data.balance).toBe("2");
        expect(paymentAddress.data.address).toBe("bc1xxx");
        expect(paymentAddressById.data.id).toBe("addr-1");
        expect(paymentAddressList.data).toHaveLength(1);
        expect(verifyResult.data.isValid).toBe(true);
    });

    it("should map order, swap, and withdrawal operations", async () => {
        quidaxService.buyOrSellOrderRequest.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                id: "o1",
                market: "btcngn",
                side: "buy",
                ord_type: "limit",
                state: "done",
                price: "100",
                volume: "2",
                executed_volume: "2",
                remaining_volume: "0",
                fee: "0.1",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T01:00:00.000Z",
            },
        });

        quidaxService.cancelBuyOrSellOrderRequest.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "o1", state: "cancelled" },
        });
        quidaxService.getOrderRecord.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "o2", market: "ethngn", state: "pending" },
        });
        quidaxService.getAllOrders.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ id: "o3", market: "btcngn", state: "done" }],
        });

        quidaxService.createInstantSwapRequest.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                id: "q1",
                from_currency: "btc",
                to_currency: "eth",
                from_amount: "1",
                to_amount: "12",
                exchange_rate: "12",
                total_fee: "0.01",
            },
        });
        quidaxService.confirmInstantSwap.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "s1", from_currency: "btc", to_currency: "eth", status: "completed" },
        });
        quidaxService.getSwapTransaction.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "s2", from_currency: "eth", to_currency: "btc", state: "pending" },
        });
        quidaxService.getSwapTransactionList.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ id: "s3", from_currency: "btc", to_currency: "usdt" }],
        });

        quidaxService.createWithdrawerRequest.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                id: "w1",
                currency: "btc",
                amount: "1",
                fee: "0.001",
                state: "pending",
                txid: "tx1",
                created_at: "2026-01-01T00:00:00.000Z",
            },
        });
        quidaxService.cancelWithdrawerRequest.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { currency: "btc", amount: "1", fee: "0.001", fund_uid: "bc1xx" },
        });
        quidaxService.getWithdrawerDetail.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "w2", currency: "btc", amount: "2", state: "done" },
        });
        quidaxService.getWithdrawerByReference.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "w3", currency: "eth", amount: "3", state: "done" },
        });
        quidaxService.getWithdrawerList.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ id: "w4", currency: "usdt", amount: "4", state: "done" }],
        });
        quidaxService.getWithdrawerFees.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                fee: [
                    { min: "0", max: "100", type: "flat", value: "5" },
                    { min: "100", max: "1000", type: "percentage", value: "2" },
                ],
                minimum: "0.1",
                type: "range",
            },
        });

        const order = await provider.placeOrder({
            userId: "u1",
            pair: "btcngn",
            side: "buy",
            type: "limit",
            price: "100",
            volume: "2",
            amount: "2",
        } as any);
        const cancelledOrder = await provider.cancelOrder({ userId: "u1", orderId: "o1" });
        const orderById = await provider.getOrderById("u1", "o2");
        const orderList = await provider.getOrderList("u1");

        const swapQuote = await provider.createSwapQuote({ userId: "u1", fromCurrency: "BTC", toCurrency: "ETH", fromAmount: "1" } as any);
        const swap = await provider.confirmSwap({ userId: "u1", quoteId: "q1" });
        const swapTx = await provider.getSwapTransaction("u1", "s2");
        const swaps = await provider.getSwapTransactionList("u1");

        const withdrawal = await provider.createWithdrawal({ userId: "u1", currency: "BTC", amount: "1", address: "bc1xx", network: "BTC", reference: "r1" });
        const cancelledWithdrawal = await provider.cancelWithdrawal({ userId: "u1", withdrawalId: "w1" });
        const withdrawalById = await provider.getWithdrawalById("u1", "w2");
        const withdrawalByRef = await provider.getWithdrawalByReference("u1", "r1");
        const withdrawals = await provider.getWithdrawalList("u1");
        const fees = await provider.getWithdrawalFees("u1", "BTC", "BTC");

        expect(order.data.status).toBe("done");
        expect(cancelledOrder.data.status).toBe("cancelled");
        expect(orderById.data.id).toBe("o2");
        expect(orderList.data).toHaveLength(1);

        expect(swapQuote.data.fee).toBe("0.01");
        expect(swap.data.status).toBe("completed");
        expect(swapTx.data.id).toBe("s2");
        expect(swaps.data).toHaveLength(1);

        expect(withdrawal.data.txHash).toBe("tx1");
        expect(cancelledWithdrawal.data.status).toBe("cancelled");
        expect(withdrawalById.data.id).toBe("w2");
        expect(withdrawalByRef.data.id).toBe("w3");
        expect(withdrawals.data).toHaveLength(1);
        expect(fees.data.fee).toEqual([
            { min: 0, max: 100, type: "flat", value: 5 },
            { min: 100, max: 1000, type: "percentage", value: 2 },
        ]);
        expect(fees.data.type).toBe("range");
    });

    it("should normalize flat withdrawal fees to numbers", async () => {
        quidaxService.getWithdrawerFees.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { fee: "0.001", minimum: "0.1", type: "flat" },
        });

        const fees = await provider.getWithdrawalFees("u1", "BTC", "BTC");

        expect(fees.data.fee).toBe(0.001);
        expect(fees.data.type).toBe("flat");
        expect(fees.data.minimumAmount).toBe("0.1");
    });

    it("should map deposits, market data, and purchase operations", async () => {
        quidaxService.fetchDeposits.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ id: "d1", currency: "btc", amount: "1", payment_address: { address: "bc1" } }],
        });
        quidaxService.fetchDeposit.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { id: "d2", currency: "eth", amount: "2", address: "0xabc" },
        });

        quidaxService.getMarketTickers.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: {
                btcngn: { ticker: { last: "100", buy: "99", sell: "101", vol: "10", high: "110", low: "90", change: "5" } },
            },
        });
        quidaxService.getSingleMarketTicker.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { market: "ethngn", ticker: { last: "200", buy: "198", sell: "202", vol: "20", high: "210", low: "190", change: "4" } },
        });
        quidaxService.getMarketList.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: [{ id: "btcngn" }, "ethngn"],
        });

        quidaxService.getPurchaseLimitForBuy.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { min_amount: "1000", max_amount: "500000" },
        });
        quidaxService.getPurchaseLimitForSell.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { minimum: "0.001", maximum: "10" },
        });
        quidaxService.getPurchaseQuoteForBuy.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { crypto_amount: "0.02", fiat_amount: "1000", rate: "50000", fee: "5" },
        });
        quidaxService.getPurchaseQuoteForSell.mockResolvedValue({
            status: "successful",
            message: "ok",
            data: { fiat_amount: "1200", rate: "60000", fee: "6" },
        });

        const deposits = await provider.fetchDeposits({ userId: "u1", currency: "BTC" });
        const deposit = await provider.fetchDeposit("u1", "d2");
        const tickers = await provider.getMarketTickers();
        const ticker = await provider.getSingleMarketTicker("ETHNGN");
        const markets = await provider.getMarketList();

        const buyLimit = await provider.getPurchaseLimitForBuy("u1", "BTC");
        const sellLimit = await provider.getPurchaseLimitForSell("u1", "BTC");
        const buyQuote = await provider.getPurchaseQuoteForBuy("u1", "BTC", "1000");
        const sellQuote = await provider.getPurchaseQuoteForSell("u1", "BTC", "0.02");

        expect(deposits.data[0].address).toBe("bc1");
        expect(deposit.data.id).toBe("d2");
        expect(tickers.data[0].pair).toBe("btcngn");
        expect(ticker.data.pair).toBe("ethngn");
        expect(markets.data).toEqual(["btcngn", "ethngn"]);
        expect(buyLimit.data.maxAmount).toBe("500000");
        expect(sellLimit.data.minAmount).toBe("0.001");
        expect(buyQuote.data.fiatAmount).toBe("1000");
        expect(sellQuote.data.cryptoAmount).toBe("0.02");
    });

    it("findSubAccountByEmail should return null when provider cannot find account", async () => {
        quidaxService.findSubAccountByEmail.mockResolvedValue(null);

        const account = await provider.findSubAccountByEmail("none@example.com");

        expect(account).toBeNull();
    });
});