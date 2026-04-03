import { NotificationMessageService } from "../notification.service";

describe("NotificationMessageService", () => {
    let service: NotificationMessageService;

    beforeEach(() => {
        service = new NotificationMessageService();
    });

    it("builds receive transaction message with sender fallback", () => {
        const message = service.receiveTransaction({
            amount: "100",
            currency: "btc",
            transactionId: "tx-1",
        } as any);

        expect(message).toContain("100 BTC");
        expect(message).toContain("a sender");
        expect(message).toContain("tx-1");
    });

    it("builds swap transaction success message", () => {
        const message = service.swapTransactionSuccess({
            fromAmount: "50",
            fromCurrency: "usdt",
            toAmount: "0.001",
            toCurrency: "btc",
            transactionId: "tx-2",
        } as any);

        expect(message).toContain("50 USDT");
        expect(message).toContain("0.001 BTC");
        expect(message).toContain("tx-2");
    });

    it("builds send transaction success message with recipient fallback", () => {
        const message = service.sendTransactionSuccess({
            amount: "10",
            currency: "eth",
            transactionId: "tx-3",
        } as any);

        expect(message).toContain("10 ETH");
        expect(message).toContain("the recipient");
        expect(message).toContain("tx-3");
    });

    it("builds fiat payment success message", () => {
        const message = service.fiatPaymentSuccess({
            amount: "25000",
            bankName: "Zenith",
            accountNumber: "1234567890",
            transactionId: "tx-4",
        } as any);

        expect(message).toContain("₦25000");
        expect(message).toContain("Zenith - 1234567890");
        expect(message).toContain("tx-4");
    });

    it("builds buy and sell success messages", () => {
        const buy = service.buyTransactionSuccess({
            amount: "3",
            currency: "sol",
            transactionId: "tx-5",
        } as any);

        const sell = service.sellTransactionSuccess({
            amount: "2",
            currency: "xrp",
            fiatAmount: "1300",
            bankName: "GTB",
            accountNumber: "1122334455",
            transactionId: "tx-6",
        } as any);

        expect(buy).toContain("3 SOL");
        expect(buy).toContain("tx-5");
        expect(sell).toContain("2 XRP");
        expect(sell).toContain("₦1300");
        expect(sell).toContain("GTB");
        expect(sell).toContain("tx-6");
    });

    it("builds buy failed message with and without reason", () => {
        const withReason = service.buyTransactionFailed({
            amount: "5",
            currency: "usdc",
            reason: "Insufficient liquidity",
            transactionId: "tx-7",
        } as any);

        const noReason = service.buyTransactionFailed({
            amount: "5",
            currency: "usdc",
            transactionId: "tx-8",
        } as any);

        expect(withReason).toContain("Reason: Insufficient liquidity");
        expect(noReason).not.toContain("Reason:");
    });

    it("builds buy cancelled message with and without reason", () => {
        const withReason = service.buyTransactionCancelled({
            amount: "7",
            currency: "bnb",
            reason: "User request",
            transactionId: "tx-9",
        } as any);

        const noReason = service.buyTransactionCancelled({
            amount: "7",
            currency: "bnb",
            transactionId: "tx-10",
        } as any);

        expect(withReason).toContain("Reason: User request");
        expect(noReason).not.toContain("Reason:");
    });

    it("builds sell failed and swap failed messages with and without reason", () => {
        const sellWithReason = service.sellTransactionFailed({
            amount: "4",
            currency: "ada",
            reason: "Price moved",
            transactionId: "tx-11",
        } as any);

        const sellNoReason = service.sellTransactionFailed({
            amount: "4",
            currency: "ada",
            transactionId: "tx-12",
        } as any);

        const swapWithReason = service.swapTransactionFailed({
            fromAmount: "100",
            fromCurrency: "usdt",
            toCurrency: "eth",
            reason: "Market volatility",
            transactionId: "tx-13",
        } as any);

        const swapNoReason = service.swapTransactionFailed({
            fromAmount: "100",
            fromCurrency: "usdt",
            toCurrency: "eth",
            transactionId: "tx-14",
        } as any);

        expect(sellWithReason).toContain("Reason: Price moved");
        expect(sellNoReason).not.toContain("Reason:");
        expect(swapWithReason).toContain("Reason: Market volatility");
        expect(swapNoReason).not.toContain("Reason:");
    });

    it("builds queued, receive failed, short payment and withdrawal refunded messages", () => {
        const queued = service.sendTransactionQueued({
            amount: "1.5",
            currency: "ltc",
            transactionId: "tx-15",
        } as any);

        const receiveFailed = service.receiveTransactionFailed({
            amount: "200",
            currency: "trx",
            transactionId: "tx-16",
        } as any);

        const shortPayment = service.buyPaymentShort({
            receivedAmount: "5000",
            expectedAmount: "6000",
            transactionId: "tx-17",
        } as any);

        const refunded = service.sendWithdrawalRefunded({
            amount: "2",
            currency: "doge",
            transactionId: "tx-18",
        } as any);

        expect(queued).toContain("1.5 LTC");
        expect(queued).toContain("tx-15");
        expect(receiveFailed).toContain("200 TRX");
        expect(receiveFailed).toContain("tx-16");
        expect(shortPayment).toContain("₦5000");
        expect(shortPayment).toContain("₦6000");
        expect(shortPayment).toContain("#tx-17");
        expect(refunded).toContain("2 DOGE");
        expect(refunded).toContain("tx-18");
    });
});
