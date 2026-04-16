import { ForbiddenException } from "@nestjs/common";
import { SafeQuidaxTradingProvider } from "../safe-trading-provider";
import { MockTradingProvider } from "../../../interfaces/trading-provider.interface";

describe("SafeQuidaxTradingProvider", () => {
    let delegate: MockTradingProvider;
    let safe: SafeQuidaxTradingProvider;

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

    // ---- Destructive operations should be BLOCKED ----

    it("blocks placeOrder with ForbiddenException", async () => {
        await expect(
            safe.placeOrder({
                userId: "user-1",
                pair: "btcngn",
                side: "buy",
                type: "market",
                amount: "100",
            }),
        ).rejects.toThrow(ForbiddenException);
    });

    it("blocks cancelOrder with ForbiddenException", async () => {
        await expect(
            safe.cancelOrder({ userId: "user-1", orderId: "order-1" }),
        ).rejects.toThrow(ForbiddenException);
    });

    it("blocks confirmSwap with ForbiddenException", async () => {
        await expect(
            safe.confirmSwap({ userId: "user-1", quoteId: "quote-1" }),
        ).rejects.toThrow(ForbiddenException);
    });

    it("blocks createWithdrawal with ForbiddenException", async () => {
        await expect(
            safe.createWithdrawal({
                userId: "user-1",
                currency: "btc",
                amount: "0.5",
                address: "0xabc",
            }),
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
