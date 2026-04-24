import { TransactionStatus } from "@prisma/client";
import { SellPayoutReconciliationService } from "../sell-payout-reconciliation.service";

jest.mock("@nestjs/common", () => {
    const actual = jest.requireActual("@nestjs/common");
    return {
        ...actual,
        Logger: class {
            log = jest.fn();
            error = jest.fn();
            warn = jest.fn();
        },
    };
});

function createOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 100,
        orderCategory: "SELL",
        status: "processing",
        transactionId: "TX-100",
        amount: 0.5,
        currency: "btc",
        totalToReceiveInFiat: 25000,
        destinationBankName: "GTBank",
        destinationBankAccountNumber: "0123456789",
        user: { id: 7, email: "seller@test.com" },
        createdAt: new Date("2026-04-18T12:00:00.000Z"),
        updatedAt: new Date("2026-04-18T12:00:00.000Z"),
        ...overrides,
    };
}

describe("SellPayoutReconciliationService", () => {
    let service: SellPayoutReconciliationService;
    let prisma: { order: { findUnique: jest.Mock; update: jest.Mock }; $transaction: jest.Mock };
    let notificationDispatcher: { notify: jest.Mock };
    let wsGateway: { notifyTransactionUpdate: jest.Mock; notifyWalletUpdate: jest.Mock };
    let withdrawalWebhookHandler: { refundSellOrderByOrderId: jest.Mock };
    let slackWebhookService: { sendWebhookFailureAlert: jest.Mock };

    beforeEach(() => {
        prisma = {
            order: {
                findUnique: jest.fn().mockResolvedValue(null),
                update: jest.fn().mockResolvedValue(createOrder()),
            },
            $transaction: jest.fn(),
        };
        prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => (
            callback({ order: prisma.order })
        ));
        notificationDispatcher = {
            notify: jest.fn().mockResolvedValue(undefined),
        };
        wsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };
        withdrawalWebhookHandler = {
            refundSellOrderByOrderId: jest.fn().mockResolvedValue(undefined),
        };
        slackWebhookService = {
            sendWebhookFailureAlert: jest.fn().mockResolvedValue(undefined),
        };

        service = new SellPayoutReconciliationService(
            prisma as any,
            notificationDispatcher as any,
            wsGateway as any,
            withdrawalWebhookHandler as any,
            slackWebhookService as any,
        );
    });

    it("completes a processing SELL payout and notifies the user", async () => {
        const order = createOrder();
        prisma.order.findUnique.mockResolvedValue(order);
        prisma.order.update.mockResolvedValue(
            createOrder({
                status: "done",
                streamlinedStatus: "completed",
                paymentStatus: "SUCCESS",
                fulfilled: true,
                reason: null,
            })
        );

        const result = await service.reconcileSellPayout({
            orderId: order.id,
            provider: "fincra",
            reference: "payout-ref-1",
            status: TransactionStatus.SUCCESS,
        });

        expect(result).toBe(true);
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(prisma.order.update).toHaveBeenCalledWith({
            where: { id: order.id },
            data: {
                status: "done",
                streamlinedStatus: "completed",
                paymentStatus: "SUCCESS",
                fulfilled: true,
                reason: null,
            },
            select: expect.any(Object),
        });
        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            order.user.id,
            expect.objectContaining({
                type: "transaction_update",
                transaction: expect.objectContaining({ status: "done" }),
            })
        );
        expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(order.user.id);
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({ userId: order.user.id, title: "Sell order completed" })
        );
    });

    it("fails a processing SELL payout, refunds, and alerts", async () => {
        const order = createOrder();
        prisma.order.findUnique.mockResolvedValue(order);
        prisma.order.update.mockResolvedValue(
            createOrder({
                status: "failed",
                streamlinedStatus: "failed",
                paymentStatus: "FAILED",
                fulfilled: false,
                reason: "Nomba payout failed for reference: payout-ref-2",
            })
        );

        const result = await service.reconcileSellPayout({
            orderId: order.id,
            provider: "nomba",
            reference: "payout-ref-2",
            status: TransactionStatus.FAILED,
        });

        expect(result).toBe(true);
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(prisma.order.update).toHaveBeenCalledWith({
            where: { id: order.id },
            data: {
                status: "failed",
                streamlinedStatus: "failed",
                paymentStatus: "FAILED",
                fulfilled: false,
                reason: "Nomba payout failed for reference: payout-ref-2",
            },
            select: expect.any(Object),
        });
        expect(withdrawalWebhookHandler.refundSellOrderByOrderId).toHaveBeenCalledWith(order.id);
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({ userId: order.user.id, title: "Sell order failed" })
        );
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "payout-ref-2",
            expect.stringContaining("payout FAILED"),
            expect.objectContaining({ orderId: order.id, userId: order.user.id })
        );
    });

    it("returns false when the order does not exist", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        await expect(
            service.reconcileSellPayout({
                orderId: 999,
                provider: "fincra",
                reference: "missing-ref",
                status: TransactionStatus.SUCCESS,
            })
        ).resolves.toBe(false);

        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
    });

    it("returns false when the linked order is not a processing SELL", async () => {
        prisma.order.findUnique.mockResolvedValue(
            createOrder({ orderCategory: "BUY", status: "done" })
        );

        await expect(
            service.reconcileSellPayout({
                orderId: 100,
                provider: "fincra",
                reference: "ignored-ref",
                status: TransactionStatus.SUCCESS,
            })
        ).resolves.toBe(false);

        expect(prisma.order.update).not.toHaveBeenCalled();
        expect(withdrawalWebhookHandler.refundSellOrderByOrderId).not.toHaveBeenCalled();
    });
});