import { OrderCategory, OrderStatus } from "@prisma/client";

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

import { SwapWebhookHandler } from "../webhook-handlers/swap-webhook.handler";

const makeTransaction = (overrides: Record<string, any> = {}) => ({
    id: 12,
    providerOrderId: "swap-provider-12",
    transactionId: "swap-tx-12",
    status: OrderStatus.pending,
    orderCategory: OrderCategory.SWAP,
    fromAmount: 1.25,
    fromCurrency: "btc",
    toAmount: 54,
    toCurrency: "usdt",
    amount: 1.25,
    currency: "btc",
    streamlinedStatus: "pending",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    user: {
        id: 77,
        email: "swap@example.com",
    },
    ...overrides,
});

describe("SwapWebhookHandler", () => {
    let handler: SwapWebhookHandler;

    let prisma: {
        order: {
            findUnique: jest.Mock;
            update: jest.Mock;
        };
    };
    let notificationMessage: { swapTransactionSuccess: jest.Mock };
    let wsGateway: { notifyWalletUpdate: jest.Mock; notifyTransactionUpdate: jest.Mock };
    let lockService: { withLock: jest.Mock };
    let walletAddressService: { syncWallet: jest.Mock };
    let notificationDispatcher: { notify: jest.Mock };

    beforeEach(() => {
        prisma = {
            order: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
        };
        notificationMessage = {
            swapTransactionSuccess: jest.fn().mockReturnValue("swap completed"),
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
        notificationDispatcher = {
            notify: jest.fn().mockResolvedValue(undefined),
        };

        handler = new SwapWebhookHandler(
            prisma as any,
            notificationMessage as any,
            wsGateway as any,
            lockService as any,
            walletAddressService as any,
            notificationDispatcher as any
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("uses a distributed lock keyed by orderId", async () => {
        lockService.withLock.mockResolvedValue({ ok: true });

        const result = await handler.handle({ orderId: "OID-100", status: OrderStatus.completed });

        expect(result).toEqual({ ok: true });
        expect(lockService.withLock).toHaveBeenCalledWith(
            "swap:OID-100",
            expect.any(Function),
            expect.any(Object)
        );
    });

    it("returns silently when lock acquisition fails", async () => {
        lockService.withLock.mockRejectedValue(new Error("Failed to acquire lock for swap"));

        await expect(handler.handle({ orderId: "OID-100", status: OrderStatus.completed })).resolves.toBeUndefined();
    });

    it("rethrows non-lock errors from handle", async () => {
        lockService.withLock.mockRejectedValue(new Error("redis down"));

        await expect(handler.handle({ orderId: "OID-100", status: OrderStatus.completed })).rejects.toThrow("redis down");
    });

    it("throws when transaction does not exist", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await expect(
            (handler as any).processSwapTransaction({ orderId: "missing", status: OrderStatus.completed })
        ).rejects.toThrow("Transaction not found");
    });

    it("throws when transaction is already completed", async () => {
        prisma.order.findUnique.mockResolvedValue(makeTransaction({ status: OrderStatus.completed }));

        await expect(
            (handler as any).processSwapTransaction({ orderId: "OID-100", status: OrderStatus.failed })
        ).rejects.toThrow("Transaction already completed");
    });

    it("returns without updates when incoming status is unchanged", async () => {
        prisma.order.findUnique.mockResolvedValue(makeTransaction({ status: OrderStatus.pending }));

        await (handler as any).processSwapTransaction({ orderId: "OID-100", status: OrderStatus.pending });

        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(wsGateway.notifyTransactionUpdate).not.toHaveBeenCalled();
    });

    it("updates the order and handles completed swaps", async () => {
        const existing = makeTransaction();
        const updated = makeTransaction({ status: OrderStatus.completed, streamlinedStatus: "completed" });
        prisma.order.findUnique.mockResolvedValue(existing);
        prisma.order.update.mockResolvedValue(updated);

        await (handler as any).processSwapTransaction({ orderId: "OID-100", status: OrderStatus.completed });

        expect(prisma.order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: existing.id },
                data: expect.objectContaining({ status: OrderStatus.completed }),
            })
        );
        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            existing.user.id,
            expect.objectContaining({ type: "transaction_update" })
        );
        expect(walletAddressService.syncWallet).toHaveBeenCalledTimes(2);
        expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(existing.user.id);
        expect(notificationMessage.swapTransactionSuccess).toHaveBeenCalled();
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Your swap transaction is completed" })
        );
    });

    it.each([
        [OrderStatus.reversed, "Swap reversed"],
        [OrderStatus.cancelled, "Swap cancelled"],
        [OrderStatus.failed, "Swap failed"],
    ])("handles %s status and dispatches a failure notification", async (status, expectedTitle) => {
        const existing = makeTransaction();
        const updated = makeTransaction({ status, streamlinedStatus: "failed" });
        prisma.order.findUnique.mockResolvedValue(existing);
        prisma.order.update.mockResolvedValue(updated);

        await (handler as any).processSwapTransaction({ orderId: "OID-100", status });

        expect(walletAddressService.syncWallet).toHaveBeenCalledTimes(2);
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({ title: expectedTitle })
        );
    });
});