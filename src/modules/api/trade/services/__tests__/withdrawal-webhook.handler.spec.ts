import {
    OrderCategory,
    OrderStatus,
    OrderStreamlinedStatus,
    TransactionStatus,
} from "@prisma/client";

// Break circular dependency: auth/guard -> @/modules/api/user -> auth/index -> auth/controllers -> @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

jest.mock("@/utils", () => ({
    generateId: jest.fn().mockReturnValue("payout-ref-123"),
    __esModule: true,
}));

jest.mock("@/config", () => {
    const actual = jest.requireActual("@/config");
    return {
        ...actual,
        sellPayoutProvider: "fincra",
        slackPayoutAlertWebhookUrl: "",
    };
});

import { WithdrawalWebhookHandler } from "../webhook-handlers/withdrawal-webhook.handler";

const makeTransaction = (overrides: Record<string, any> = {}) => ({
    id: 22,
    userId: 5,
    orderReference: "wd-ref-22",
    transactionId: "wd-tx-22",
    transaction_note: null,
    status: OrderStatus.pending,
    streamlinedStatus: OrderStreamlinedStatus.pending,
    orderCategory: OrderCategory.SEND,
    amount: 0.5,
    total: 0.5,
    currency: "btc",
    recipient: "bc1qrecipient",
    network: "btc",
    totalToReceiveInFiat: 100000,
    destinationBankName: "Resolve Bank",
    destinationBankCode: "999",
    destinationBankAccountName: "Alice",
    destinationBankAccountNumber: "1234567890",
    user: {
        id: 5,
        email: "withdraw@example.com",
        userType: "individual",
    },
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
});

describe("WithdrawalWebhookHandler", () => {
    let handler: WithdrawalWebhookHandler;

    let prisma: {
        order: {
            findUnique: jest.Mock;
            update: jest.Mock;
        };
    };
    let fincraService: { initializeTransfer: jest.Mock };
    let nombaService: { initializeTransfer: jest.Mock };
    let notificationMessage: {
        sellTransactionSuccess: jest.Mock;
        buyTransactionSuccess: jest.Mock;
        buyTransactionFailed: jest.Mock;
        sendTransactionSuccess: jest.Mock;
    };
    let wsGateway: { notifyWalletUpdate: jest.Mock; notifyTransactionUpdate: jest.Mock };
    let lockService: { withLock: jest.Mock };
    let walletAddressService: { syncWallet: jest.Mock };
    let ledgerService: {
        releaseHoldWithPlatformEntry: jest.Mock;
        releaseHold: jest.Mock;
        pairedCredit: jest.Mock;
    };
    let notificationDispatcher: { notify: jest.Mock };

    beforeEach(() => {
        prisma = {
            order: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
        };
        fincraService = {
            initializeTransfer: jest.fn().mockResolvedValue(undefined),
        };
        nombaService = {
            initializeTransfer: jest.fn().mockResolvedValue(undefined),
        };
        notificationMessage = {
            sellTransactionSuccess: jest.fn().mockReturnValue("sell-success-message"),
            buyTransactionSuccess: jest.fn().mockReturnValue("buy-success-message"),
            buyTransactionFailed: jest.fn().mockReturnValue("buy-failed-message"),
            sendTransactionSuccess: jest.fn().mockReturnValue("send-success-message"),
        };
        wsGateway = {
            notifyWalletUpdate: jest.fn(),
            notifyTransactionUpdate: jest.fn(),
        };
        lockService = {
            withLock: jest.fn().mockImplementation(async (_key, fn) => fn()),
        };
        walletAddressService = {
            syncWallet: jest.fn().mockResolvedValue(undefined),
        };
        ledgerService = {
            releaseHoldWithPlatformEntry: jest.fn().mockResolvedValue({ success: true }),
            releaseHold: jest.fn().mockResolvedValue({ success: true }),
            pairedCredit: jest.fn().mockResolvedValue({ success: true }),
        };
        notificationDispatcher = {
            notify: jest.fn().mockResolvedValue(undefined),
        };

        handler = new WithdrawalWebhookHandler(
            prisma as any,
            fincraService as any,
            nombaService as any,
            notificationMessage as any,
            wsGateway as any,
            lockService as any,
            walletAddressService as any,
            ledgerService as any,
            notificationDispatcher as any
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("uses a distributed lock keyed by withdrawal reference", async () => {
        lockService.withLock.mockResolvedValue({ ok: true });

        const result = await handler.handle({ orderReference: "WD-100", status: OrderStatus.done });

        expect(result).toEqual({ ok: true });
        expect(lockService.withLock).toHaveBeenCalledWith(
            "withdraw:WD-100",
            expect.any(Function),
            expect.any(Object)
        );
    });

    it("returns silently when lock acquisition fails", async () => {
        lockService.withLock.mockRejectedValue(new Error("Failed to acquire lock for withdrawal"));

        await expect(handler.handle({ orderReference: "WD-100", status: OrderStatus.done })).resolves.toBeUndefined();
    });

    it("rethrows non-lock errors from handle", async () => {
        lockService.withLock.mockRejectedValue(new Error("redis unavailable"));

        await expect(handler.handle({ orderReference: "WD-100", status: OrderStatus.done })).rejects.toThrow("redis unavailable");
    });

    it("finds no transaction and skips buy-fulfillment webhooks", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        const result = await (handler as any).findTransactionOrSkip({
            orderReference: "buy-123_fulfill",
            status: OrderStatus.done,
        });

        expect(result).toBeNull();
    });

    it("throws when transaction is not found and not a fulfillment suffix", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await expect(
            (handler as any).findTransactionOrSkip({ orderReference: "unknown-ref", status: OrderStatus.done })
        ).rejects.toThrow("Transaction not found");
    });

    it("skips processing for SWAP withdrawals", async () => {
        jest.spyOn(handler as any, "findTransactionOrSkip").mockResolvedValue(
            makeTransaction({ orderCategory: OrderCategory.SWAP })
        );

        await (handler as any).processWithdrawerTransaction({
            orderReference: "wd-ref-22",
            status: OrderStatus.done,
        });

        expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("throws when withdrawal is already done", async () => {
        jest.spyOn(handler as any, "findTransactionOrSkip").mockResolvedValue(
            makeTransaction({ status: OrderStatus.done })
        );

        await expect(
            (handler as any).processWithdrawerTransaction({
                orderReference: "wd-ref-22",
                status: OrderStatus.failed,
            })
        ).rejects.toThrow("Transaction already completed");
    });

    it("updates order and routes to done/failed/cancelled handlers", async () => {
        const transaction = makeTransaction({ status: OrderStatus.pending, orderCategory: OrderCategory.SEND });
        const updated = makeTransaction({ status: OrderStatus.processing });
        jest.spyOn(handler as any, "findTransactionOrSkip").mockResolvedValue(transaction);
        jest.spyOn(handler as any, "updateOrderStatus").mockResolvedValue(updated);
        const doneSpy = jest.spyOn(handler as any, "handleDoneStatus").mockResolvedValue(undefined);
        const failedSpy = jest.spyOn(handler as any, "handleFailedStatus").mockResolvedValue(undefined);
        const cancelledSpy = jest.spyOn(handler as any, "handleCancelledStatus").mockResolvedValue(undefined);

        await (handler as any).processWithdrawerTransaction({
            orderReference: transaction.orderReference,
            status: OrderStatus.done,
        });
        await (handler as any).processWithdrawerTransaction({
            orderReference: transaction.orderReference,
            status: OrderStatus.failed,
        });
        await (handler as any).processWithdrawerTransaction({
            orderReference: transaction.orderReference,
            status: OrderStatus.cancelled,
        });

        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalled();
        expect(doneSpy).toHaveBeenCalled();
        expect(failedSpy).toHaveBeenCalled();
        expect(cancelledSpy).toHaveBeenCalled();
    });

    it("sets SELL done status to processing while payout is pending", async () => {
        prisma.order.update.mockResolvedValue(makeTransaction({ status: OrderStatus.processing }));

        await (handler as any).updateOrderStatus(
            makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: null }),
            {
                orderReference: "wd-ref-22",
                status: OrderStatus.done,
                txid: "txid-abc",
            }
        );

        expect(prisma.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: OrderStatus.processing,
                    streamlinedStatus: OrderStreamlinedStatus.pending,
                    blockchain_txid: "txid-abc",
                }),
            })
        );
    });

    it("keeps retry payout in processing until the configured provider confirms the transfer", async () => {
        const sellTx = makeTransaction({
            orderCategory: OrderCategory.SELL,
            status: OrderStatus.pending,
            streamlinedStatus: OrderStreamlinedStatus.pending,
        });
        prisma.order.findUnique.mockResolvedValue(sellTx);
        prisma.order.update.mockResolvedValue(
            makeTransaction({
                status: OrderStatus.processing,
                streamlinedStatus: OrderStreamlinedStatus.pending,
                paymentStatus: TransactionStatus.PENDING,
                fulfilled: false,
                reason: null,
            })
        );
        jest.spyOn(handler as any, "initiateFiatPayout").mockResolvedValue(undefined);

        const result = await handler.retryFiatPayout(sellTx.id);

        expect(result).toEqual({ success: true });
        expect(prisma.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: sellTx.id },
                data: expect.objectContaining({
                    status: OrderStatus.processing,
                    streamlinedStatus: OrderStreamlinedStatus.pending,
                    paymentStatus: TransactionStatus.PENDING,
                    fulfilled: false,
                    reason: null,
                }),
            })
        );
        expect(wsGateway.notifyWalletUpdate).not.toHaveBeenCalled();
    });

    it("handles retry payout failure and marks transaction failed", async () => {
        const sellTx = makeTransaction({
            orderCategory: OrderCategory.SELL,
            status: OrderStatus.pending,
            streamlinedStatus: OrderStreamlinedStatus.pending,
        });
        prisma.order.findUnique.mockResolvedValue(sellTx);
        jest.spyOn(handler as any, "initiateFiatPayout").mockRejectedValue(new Error("nomba down"));
        prisma.order.update.mockResolvedValue(
            makeTransaction({ status: OrderStatus.failed, streamlinedStatus: OrderStreamlinedStatus.failed })
        );

        await expect(handler.retryFiatPayout(sellTx.id)).rejects.toThrow("nomba down");
        expect(prisma.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: sellTx.id },
                data: expect.objectContaining({
                    status: OrderStatus.failed,
                    paymentStatus: TransactionStatus.FAILED,
                }),
            })
        );
    });

    it("routes failed SELL-with-BUY-link and regular SELL failure flows", async () => {
        const withBuyRef = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: "BUY:101" });
        const regularSell = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: null });
        const failBuySpy = jest.spyOn(handler as any, "failBuyOrder").mockResolvedValue(undefined);
        const refundSpy = jest.spyOn(handler as any, "refundSellOrder").mockResolvedValue(undefined);
        jest.spyOn(handler as any, "handleWithdrawalFailed").mockResolvedValue(undefined);

        await (handler as any).handleFailedStatus(withBuyRef);
        await (handler as any).handleFailedStatus(regularSell);

        expect(failBuySpy).toHaveBeenCalledWith(101, withBuyRef);
        expect(refundSpy).toHaveBeenCalledWith(regularSell);
    });

    it("completes linked BUY order from SELL done webhook", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: "BUY:77" });
        const completeSpy = jest.spyOn(handler as any, "completeBuyOrder").mockResolvedValue(undefined);

        const result = await (handler as any).handleSellOrderDone(sellTx);

        expect(result).toBe(true);
        expect(completeSpy).toHaveBeenCalledWith(77, sellTx);
    });

    it("keeps SELL payout in processing until the configured provider confirms and sends no completion notification", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: null });
        jest.spyOn(handler as any, "initiateFiatPayout").mockResolvedValue(undefined);
        prisma.order.update.mockResolvedValue(
            makeTransaction({
                status: OrderStatus.processing,
                streamlinedStatus: OrderStreamlinedStatus.pending,
                paymentStatus: TransactionStatus.PENDING,
                fulfilled: false,
            })
        );

        const result = await (handler as any).handleSellOrderDone(sellTx);

        expect(result).toBe(true);
        expect(prisma.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: OrderStatus.processing,
                    streamlinedStatus: OrderStreamlinedStatus.pending,
                    paymentStatus: TransactionStatus.PENDING,
                    fulfilled: false,
                }),
            })
        );
        // No completion notification — Nomba webhook will send it on success
        expect(notificationMessage.sellTransactionSuccess).not.toHaveBeenCalled();
        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        expect(wsGateway.notifyWalletUpdate).not.toHaveBeenCalled();
    });

    it("marks SELL payout path as failed and triggers compensating actions", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: null });
        jest.spyOn(handler as any, "initiateFiatPayout").mockRejectedValue(new Error("bank outage"));
        prisma.order.update.mockResolvedValue(
            makeTransaction({ status: OrderStatus.failed, streamlinedStatus: OrderStreamlinedStatus.failed })
        );
        const failedNotifySpy = jest.spyOn(handler as any, "handleWithdrawalFailed").mockResolvedValue(undefined);
        const refundSpy = jest.spyOn(handler as any, "refundSellOrder").mockResolvedValue(undefined);

        const result = await (handler as any).handleSellOrderDone(sellTx);

        expect(result).toBe(false);
        expect(failedNotifySpy).toHaveBeenCalledWith(sellTx);
        expect(refundSpy).toHaveBeenCalledWith(sellTx);
    });

    it("settles or releases SEND holds", async () => {
        const sendTx = makeTransaction({ orderCategory: OrderCategory.SEND });

        await (handler as any).settleOrReleaseSendHold(sendTx, true);
        await (handler as any).settleOrReleaseSendHold(sendTx, false);

        expect(ledgerService.releaseHoldWithPlatformEntry).toHaveBeenCalled();
        expect(ledgerService.releaseHold).toHaveBeenCalled();
    });

    it("completes and fails linked BUY orders with user notifications", async () => {
        const buyOrder = makeTransaction({
            id: 77,
            orderCategory: OrderCategory.BUY,
            transactionId: "buy-tx-77",
            currency: "eth",
            amount: 2,
        });
        prisma.order.findUnique.mockResolvedValue(buyOrder);
        prisma.order.update.mockResolvedValue(buyOrder);

        await (handler as any).completeBuyOrder(77, makeTransaction());
        await (handler as any).failBuyOrder(77, makeTransaction());

        expect(notificationMessage.buyTransactionSuccess).toHaveBeenCalled();
        expect(notificationMessage.buyTransactionFailed).toHaveBeenCalled();
        expect(notificationDispatcher.notify).toHaveBeenCalled();
        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalled();
        expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(buyOrder.user.id);
    });

    it("initiates payout through Fincra", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL });

        await (handler as any).initiateFiatPayout(sellTx);

        expect(fincraService.initializeTransfer).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: sellTx.id,
                userId: sellTx.userId,
                reference: "payout-ref-123",
            })
        );
        expect(nombaService.initializeTransfer).not.toHaveBeenCalled();
    });

    it("initiates payout through Nomba when SELL_PAYOUT_PROVIDER=nomba", async () => {
        const config = require("@/config");
        const original = config.sellPayoutProvider;
        Object.defineProperty(config, "sellPayoutProvider", { value: "nomba", writable: true });
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL });

        await (handler as any).initiateFiatPayout(sellTx);

        expect(nombaService.initializeTransfer).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: sellTx.id,
                userId: sellTx.userId,
                reference: "payout-ref-123",
            })
        );
        expect(fincraService.initializeTransfer).not.toHaveBeenCalled();

        Object.defineProperty(config, "sellPayoutProvider", { value: original, writable: true });
    });

    it("handles withdrawal done and failed notification paths", async () => {
        const tx = makeTransaction({ orderCategory: OrderCategory.SEND });

        await (handler as any).handleWithdrawalDone(tx);
        await (handler as any).handleWithdrawalFailed(tx);

        expect(walletAddressService.syncWallet).toHaveBeenCalledTimes(2);
        expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(tx.user.id);
        expect(notificationDispatcher.notify).toHaveBeenCalledTimes(2);
    });

    // â”€â”€ WebSocket state emission for SELL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("emits notifyTransactionUpdate with streamlinedStatus=pending when sell payout is initiated", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: null });
        jest.spyOn(handler as any, "initiateFiatPayout").mockResolvedValue(undefined);
        const processingOrder = {
            ...sellTx,
            status: OrderStatus.processing,
            streamlinedStatus: OrderStreamlinedStatus.pending,
            paymentStatus: TransactionStatus.PENDING,
            fulfilled: false,
        };
        prisma.order.update.mockResolvedValue(processingOrder);

        await (handler as any).handleSellOrderDone(sellTx);

        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            sellTx.user.id,
            expect.objectContaining({
                type: "transaction_update",
                transaction: expect.objectContaining({
                    id: sellTx.id,
                    transactionId: sellTx.transactionId,
                    streamlinedStatus: OrderStreamlinedStatus.pending,
                    status: OrderStatus.processing,
                }),
            }),
        );
    });

    it("emits notifyTransactionUpdate with streamlinedStatus=failed when sell payout fails", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, transaction_note: null });
        jest.spyOn(handler as any, "initiateFiatPayout").mockRejectedValue(new Error("bank outage"));
        const failedOrder = {
            ...sellTx,
            status: OrderStatus.failed,
            streamlinedStatus: OrderStreamlinedStatus.failed,
        };
        prisma.order.update.mockResolvedValue(failedOrder);
        jest.spyOn(handler as any, "handleWithdrawalFailed").mockResolvedValue(undefined);
        jest.spyOn(handler as any, "refundSellOrder").mockResolvedValue(undefined);

        await (handler as any).handleSellOrderDone(sellTx);

        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            sellTx.user.id,
            expect.objectContaining({
                type: "transaction_update",
                transaction: expect.objectContaining({
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                    status: OrderStatus.failed,
                }),
            }),
        );
    });

    it("retryFiatPayout emits processing status WebSocket while awaiting provider confirmation", async () => {
        const sellTx = makeTransaction({
            orderCategory: OrderCategory.SELL,
            status: OrderStatus.pending,
            streamlinedStatus: OrderStreamlinedStatus.pending,
        });
        prisma.order.findUnique.mockResolvedValue(sellTx);
        const processingOrder = {
            ...sellTx,
            status: OrderStatus.processing,
            streamlinedStatus: OrderStreamlinedStatus.pending,
            paymentStatus: TransactionStatus.PENDING,
        };
        prisma.order.update.mockResolvedValue(processingOrder);
        jest.spyOn(handler as any, "initiateFiatPayout").mockResolvedValue(undefined);

        await handler.retryFiatPayout(sellTx.id);

        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            sellTx.user.id,
            expect.objectContaining({
                type: "transaction_update",
                transaction: expect.objectContaining({
                    streamlinedStatus: OrderStreamlinedStatus.pending,
                    status: OrderStatus.processing,
                }),
            }),
        );
    });

    it("retryFiatPayout emits failed status WebSocket on payout error", async () => {
        const sellTx = makeTransaction({
            orderCategory: OrderCategory.SELL,
            status: OrderStatus.pending,
            streamlinedStatus: OrderStreamlinedStatus.pending,
        });
        prisma.order.findUnique.mockResolvedValue(sellTx);
        jest.spyOn(handler as any, "initiateFiatPayout").mockRejectedValue(new Error("timeout"));
        const failedOrder = {
            ...sellTx,
            status: OrderStatus.failed,
            streamlinedStatus: OrderStreamlinedStatus.failed,
        };
        prisma.order.update.mockResolvedValue(failedOrder);

        await expect(handler.retryFiatPayout(sellTx.id)).rejects.toThrow("timeout");

        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            sellTx.user.id,
            expect.objectContaining({
                type: "transaction_update",
                transaction: expect.objectContaining({
                    streamlinedStatus: OrderStreamlinedStatus.failed,
                    status: OrderStatus.failed,
                }),
            }),
        );
    });

    // â”€â”€ retryFiatPayout guard clauses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("retryFiatPayout throws when transaction is not found", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await expect(handler.retryFiatPayout(999)).rejects.toThrow("Transaction not found");
    });

    it("retryFiatPayout throws when transaction is already completed", async () => {
        prisma.order.findUnique.mockResolvedValue(
            makeTransaction({
                orderCategory: OrderCategory.SELL,
                status: OrderStatus.done,
                streamlinedStatus: OrderStreamlinedStatus.completed,
            })
        );

        await expect(handler.retryFiatPayout(22)).rejects.toThrow("Transaction already completed");
    });

    it("retryFiatPayout throws when payout is already in progress", async () => {
        prisma.order.findUnique.mockResolvedValue(
            makeTransaction({
                orderCategory: OrderCategory.SELL,
                status: OrderStatus.processing,
                streamlinedStatus: OrderStreamlinedStatus.pending,
                paymentStatus: TransactionStatus.PENDING,
            })
        );

        await expect(handler.retryFiatPayout(22)).rejects.toThrow("Payout already in progress");
    });

    it("retryFiatPayout throws when order is not a SELL", async () => {
        prisma.order.findUnique.mockResolvedValue(
            makeTransaction({ orderCategory: OrderCategory.SEND, status: OrderStatus.pending })
        );

        await expect(handler.retryFiatPayout(22)).rejects.toThrow("Only SELL orders can be retried");
    });

    // â”€â”€ refundSellOrderByOrderId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("refundSellOrderByOrderId returns silently when order is not found", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await expect(
            (handler as any).refundSellOrderByOrderId(999)
        ).resolves.toBeUndefined();
    });

    it("refundSellOrderByOrderId delegates to refundSellOrder", async () => {
        const order = makeTransaction({ orderCategory: OrderCategory.SELL });
        prisma.order.findUnique.mockResolvedValue(order);
        const spy = jest.spyOn(handler as any, "refundSellOrder").mockResolvedValue(undefined);

        await (handler as any).refundSellOrderByOrderId(order.id);

        expect(spy).toHaveBeenCalledWith(order);
    });

    // â”€â”€ refundSellOrder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("refundSellOrder credits the user via pairedCredit on success", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, total: 0.5 });
        ledgerService.pairedCredit.mockResolvedValue({ success: true });

        await (handler as any).refundSellOrder(sellTx);

        expect(ledgerService.pairedCredit).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: sellTx.userId,
                currency: "BTC",
                amount: 0.5,
                reference: `refund:${sellTx.orderReference}`,
                createPlatformEntry: true,
            })
        );
    });

    it("refundSellOrder sends Slack alert when pairedCredit fails", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, total: 0.5 });
        ledgerService.pairedCredit.mockResolvedValue({ success: false, error: "insufficient platform balance" });
        const alertSpy = jest.spyOn(handler as any, "sendPayoutAlert").mockResolvedValue(undefined);

        await (handler as any).refundSellOrder(sellTx);

        expect(alertSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: sellTx.id,
                error: expect.stringContaining("REFUND FAILED"),
                isCritical: true,
            })
        );
    });

    it("refundSellOrder catches exceptions and sends critical Slack alert", async () => {
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL, total: 0.5 });
        ledgerService.pairedCredit.mockRejectedValue(new Error("db down"));
        const alertSpy = jest.spyOn(handler as any, "sendPayoutAlert").mockResolvedValue(undefined);

        await (handler as any).refundSellOrder(sellTx);

        expect(alertSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.stringContaining("REFUND EXCEPTION"),
                isCritical: true,
            })
        );
    });

    // â”€â”€ sendPayoutAlert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("sendPayoutAlert sends a Slack message when webhook URL is configured", async () => {
        const config = require("@/config");
        const original = config.slackPayoutAlertWebhookUrl;
        Object.defineProperty(config, "slackPayoutAlertWebhookUrl", { value: "https://hooks.slack.com/test", writable: true });
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, writable: true });

        await (handler as any).sendPayoutAlert({
            orderId: 1,
            userId: 2,
            amount: 50000,
            accountNumber: "123",
            bankName: "Test Bank",
            provider: "Nomba",
            error: "timeout",
            isCritical: true,
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "https://hooks.slack.com/test",
            expect.objectContaining({ method: "POST" })
        );
        Object.defineProperty(globalThis, "fetch", { value: originalFetch, writable: true });
        Object.defineProperty(config, "slackPayoutAlertWebhookUrl", { value: original, writable: true });
    });

    it("sendPayoutAlert skips when webhook URL is not configured", async () => {
        const config = require("@/config");
        const original = config.slackPayoutAlertWebhookUrl;
        Object.defineProperty(config, "slackPayoutAlertWebhookUrl", { value: "", writable: true });
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, writable: true });

        await (handler as any).sendPayoutAlert({
            orderId: 1,
            userId: 2,
            amount: 50000,
            accountNumber: "123",
            bankName: "Test Bank",
            provider: "Nomba",
            error: "timeout",
        });

        expect(fetchMock).not.toHaveBeenCalled();
        Object.defineProperty(globalThis, "fetch", { value: originalFetch, writable: true });
        Object.defineProperty(config, "slackPayoutAlertWebhookUrl", { value: original, writable: true });
    });

    it("sendPayoutAlert swallows fetch errors", async () => {
        const config = require("@/config");
        const original = config.slackPayoutAlertWebhookUrl;
        Object.defineProperty(config, "slackPayoutAlertWebhookUrl", { value: "https://hooks.slack.com/test", writable: true });
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn().mockRejectedValue(new Error("network"));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, writable: true });

        await expect(
            (handler as any).sendPayoutAlert({
                orderId: 1,
                userId: 2,
                amount: 50000,
                accountNumber: "123",
                bankName: "Test Bank",
                provider: "Nomba",
                error: "timeout",
            })
        ).resolves.toBeUndefined();
        Object.defineProperty(globalThis, "fetch", { value: originalFetch, writable: true });
        Object.defineProperty(config, "slackPayoutAlertWebhookUrl", { value: original, writable: true });
    });

    // â”€â”€ settleOrReleaseSendHold error paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("settleOrReleaseSendHold logs error when settle fails", async () => {
        ledgerService.releaseHoldWithPlatformEntry.mockResolvedValue({ success: false, error: "hold not found" });

        await (handler as any).settleOrReleaseSendHold(makeTransaction(), true);

        expect(ledgerService.releaseHoldWithPlatformEntry).toHaveBeenCalled();
    });

    it("settleOrReleaseSendHold logs error when release fails", async () => {
        ledgerService.releaseHold.mockResolvedValue({ success: false, error: "hold not found" });

        await (handler as any).settleOrReleaseSendHold(makeTransaction(), false);

        expect(ledgerService.releaseHold).toHaveBeenCalled();
    });

    it("settleOrReleaseSendHold catches exceptions without throwing", async () => {
        ledgerService.releaseHoldWithPlatformEntry.mockRejectedValue(new Error("redis crash"));

        await expect(
            (handler as any).settleOrReleaseSendHold(makeTransaction(), true)
        ).resolves.toBeUndefined();
    });

    // â”€â”€ completeBuyOrder / failBuyOrder not-found paths â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("completeBuyOrder returns early when buy order is not found", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await (handler as any).completeBuyOrder(999, makeTransaction());

        expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("failBuyOrder returns early when buy order is not found", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await (handler as any).failBuyOrder(999, makeTransaction());

        expect(prisma.order.update).not.toHaveBeenCalled();
    });

    // â”€â”€ processWithdrawerTransaction early returns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("returns early when current status matches incoming status", async () => {
        jest.spyOn(handler as any, "findTransactionOrSkip").mockResolvedValue(
            makeTransaction({ status: OrderStatus.pending })
        );

        await (handler as any).processWithdrawerTransaction({
            orderReference: "wd-ref-22",
            status: OrderStatus.pending,
        });

        expect(prisma.order.update).not.toHaveBeenCalled();
    });

    // â”€â”€ handleCancelledStatus releases SEND holds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("handleCancelledStatus releases SEND hold and notifies failure", async () => {
        const sendTx = makeTransaction({ orderCategory: OrderCategory.SEND });
        jest.spyOn(handler as any, "settleOrReleaseSendHold").mockResolvedValue(undefined);
        jest.spyOn(handler as any, "handleWithdrawalFailed").mockResolvedValue(undefined);

        await (handler as any).handleCancelledStatus(sendTx);

        expect((handler as any).settleOrReleaseSendHold).toHaveBeenCalledWith(sendTx, false);
        expect((handler as any).handleWithdrawalFailed).toHaveBeenCalledWith(sendTx);
    });

    // â€" Fincra payout failure throws with alert â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"â€"

    it("initiateFiatPayout throws and sends Slack alert on Fincra failure", async () => {
        fincraService.initializeTransfer.mockRejectedValue(new Error("gateway timeout"));
        const alertSpy = jest.spyOn(handler as any, "sendPayoutAlert").mockResolvedValue(undefined);
        const sellTx = makeTransaction({ orderCategory: OrderCategory.SELL });

        await expect(
            (handler as any).initiateFiatPayout(sellTx)
        ).rejects.toThrow("Fincra payout failed");

        expect(alertSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                orderId: sellTx.id,
                provider: "Fincra",
                isCritical: true,
            })
        );
    });
});
