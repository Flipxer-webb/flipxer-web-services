import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { OrderCategory, OrderStatus, OrderStreamlinedStatus, TransactionStatus } from "@prisma/client";

import { AdminTransactionService } from "../admin-transaction.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "@/modules/api/trade/services/ledger/ledger.service";
import { SettingService } from "@/modules/api/settings/services";
import { BuyOrderService } from "@/modules/api/trade/services/buy-order.service";
import { SwapService } from "@/modules/api/trade/services/swap.service";
import { WithdrawalWebhookHandler } from "@/modules/api/trade/services/webhook-handlers/withdrawal-webhook.handler";

function makePrisma() {
    return {
        order: {
            findMany: jest.fn(),
            count: jest.fn(),
            aggregate: jest.fn(),
            groupBy: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        payment: {
            updateMany: jest.fn(),
        },
        ledgerEntry: {
            findFirst: jest.fn(),
        },
        auditLog: { create: jest.fn(), findMany: jest.fn() },
        $transaction: jest.fn(),
    };
}

describe("AdminTransactionService", () => {
    let service: AdminTransactionService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: { credit: jest.Mock; runWithLock: jest.Mock };
    let settingService: { verify2FACode: jest.Mock };
    let buyOrderService: { fulfillBuyOrder: jest.Mock };
    let swapService: { retryPendingSwap: jest.Mock };
    let withdrawalWebhookHandler: { retryFiatPayout: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        prisma.$transaction.mockImplementation(async (ops: any[]) => Promise.all(ops));
        ledgerService = {
            credit: jest.fn(),
            runWithLock: jest.fn().mockImplementation(async (_u: number, _c: string, cb: () => any) => cb()),
        };
        settingService = { verify2FACode: jest.fn() };
        buyOrderService = { fulfillBuyOrder: jest.fn() };
        swapService = { retryPendingSwap: jest.fn() };
        withdrawalWebhookHandler = { retryFiatPayout: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AdminTransactionService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: ledgerService },
                { provide: SettingService, useValue: settingService },
                { provide: BuyOrderService, useValue: buyOrderService },
                { provide: SwapService, useValue: swapService },
                { provide: WithdrawalWebhookHandler, useValue: withdrawalWebhookHandler },
            ],
        }).compile();

        service = module.get(AdminTransactionService);
    });

    afterEach(() => jest.clearAllMocks());

    it("should return paginated pending transactions", async () => {
        prisma.order.findMany.mockResolvedValue([
            { id: 1, transactionId: "TX-1", firstName: "A", lastName: "B", user: { id: 1, firstName: "A", lastName: "B", email: "a@b.com" } },
        ]);
        prisma.order.count.mockResolvedValue(1);

        const result = await service.getPendingTransactions({ pageNumber: 1, pageSize: 20 } as any);

        expect(result.message).toContain("Pending transactions retrieved");
        expect(result.data.records).toHaveLength(1);
        expect(prisma.order.findMany).toHaveBeenCalled();
    });

    it("should return failed transactions", async () => {
        prisma.order.findMany.mockResolvedValue([
            { id: 2, transactionId: "TX-2", user: { id: 2, firstName: "C", lastName: "D", email: "c@d.com" } },
        ]);
        prisma.order.count.mockResolvedValue(1);

        const result = await service.getFailedTransactions({ pageNumber: 1, pageSize: 20 } as any);

        expect(result.message).toContain("Failed transactions retrieved");
        expect(result.data.records).toHaveLength(1);
    });

    it("should compute transaction stats without status filter", async () => {
        prisma.order.count
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(6)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(2);
        prisma.order.aggregate.mockResolvedValue({ _sum: { amountInFiat: 500000 } });
        prisma.order.findMany.mockResolvedValue([{ fee: 10, rateAtConversion: 100 }]);
        prisma.order.groupBy.mockResolvedValue([{ orderCategory: "BUY", _count: 6, _sum: { amountInFiat: 500000 } }]);

        const result = await service.getTransactionStats("month");

        expect(result.data.overview.total).toBe(10);
        expect(result.data.overview.completed).toBe(6);
        expect(result.data.volume.total).toBe(500000);
        expect(result.data.volume.fees).toBe(1000);
    });

    it("should compute stats with status filter and skip completed volume branch", async () => {
        prisma.order.count.mockResolvedValue(4);

        const result = await service.getTransactionStats("month", OrderStreamlinedStatus.pending);

        expect(result.data.overview.total).toBe(4);
        expect(result.data.overview.pending).toBe(4);
        expect(result.data.volume.total).toBe(0);
    });

    it("should return not found when updating missing transaction", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        const result = await service.updateTransactionStatus("TX-missing", { status: OrderStreamlinedStatus.completed } as any, 1);

        expect(result.message).toContain("not found");
    });

    it("should update transaction status and create audit log", async () => {
        prisma.order.findUnique.mockResolvedValue({ transactionId: "TX-1", streamlinedStatus: OrderStreamlinedStatus.pending, reason: null });
        prisma.order.update.mockResolvedValue({ transactionId: "TX-1", streamlinedStatus: OrderStreamlinedStatus.completed, user: { firstName: "A", lastName: "B" } });

        const result = await service.updateTransactionStatus(
            "TX-1",
            { status: OrderStreamlinedStatus.completed, reason: "verified", note: "manual review" } as any,
            99,
        );

        expect(prisma.order.update).toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalled();
        expect(result.message).toContain("updated successfully");
    });

    it("should reject refund for non-failed transaction", async () => {
        prisma.order.findUnique.mockResolvedValue({ streamlinedStatus: OrderStreamlinedStatus.completed });

        await expect(service.refundTransaction("TX-1", {} as any, 2)).rejects.toThrow(BadRequestException);
    });

    it("manual approve should throw when 2FA is invalid", async () => {
        settingService.verify2FACode.mockResolvedValue(false);

        await expect(
            service.manualApproveTransaction("TX-1", { twoFactorCode: "123456", confirmed: true } as any, { id: 90 } as any),
        ).rejects.toThrow("Invalid 2FA code");
    });

    it("manual approve should return already completed when atomic claim loses", async () => {
        settingService.verify2FACode.mockResolvedValue(true);
        prisma.order.findUnique.mockResolvedValue({
            transactionId: "TX-1",
            orderCategory: OrderCategory.BUY,
            userId: 1,
            currency: "btc",
            amount: 10,
        });
        prisma.order.updateMany.mockResolvedValue({ count: 0 });

        const result = await service.manualApproveTransaction(
            "TX-1",
            { twoFactorCode: "123456", confirmed: true } as any,
            { id: 90 } as any,
        );

        expect(result.message).toContain("already completed");
    });

    it("manual approve should complete BUY with ledger credit", async () => {
        settingService.verify2FACode.mockResolvedValue(true);
        prisma.order.findUnique.mockResolvedValue({
            id: 1,
            transactionId: "TX-1",
            orderCategory: OrderCategory.BUY,
            userId: 22,
            currency: "btc",
            amount: 15,
            amountInFiat: 900000,
        });
        prisma.order.updateMany.mockResolvedValue({ count: 1 });
        ledgerService.credit.mockResolvedValue({ success: true, entryId: "ledger-1" });
        prisma.order.update.mockResolvedValue({
            transactionId: "TX-1",
            status: "confirmed",
            streamlinedStatus: OrderStreamlinedStatus.completed,
            user: { firstName: "A", lastName: "B" },
        });

        const result = await service.manualApproveTransaction(
            "TX-1",
            { twoFactorCode: "123456", confirmed: true } as any,
            { id: 90 } as any,
        );

        expect(ledgerService.credit).toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalled();
        expect(result.message).toContain("manually approved");
    });

    it("manual approve should rollback fulfilled flag when ledger credit fails", async () => {
        settingService.verify2FACode.mockResolvedValue(true);
        prisma.order.findUnique.mockResolvedValue({
            transactionId: "TX-1",
            orderCategory: OrderCategory.BUY,
            userId: 22,
            currency: "btc",
            amount: 15,
        });
        prisma.order.updateMany.mockResolvedValue({ count: 1 });
        ledgerService.credit.mockResolvedValue({ success: false, error: "credit failed" });

        await expect(
            service.manualApproveTransaction(
                "TX-1",
                { twoFactorCode: "123456", confirmed: true } as any,
                { id: 90 } as any,
            ),
        ).rejects.toThrow("Failed to credit ledger");

        expect(prisma.order.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { fulfilled: false } }),
        );
    });

    it("refund should reject when existing refund ledger entry is found", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 1,
            orderReference: "REF-1",
            streamlinedStatus: OrderStreamlinedStatus.failed,
        });
        prisma.ledgerEntry.findFirst.mockResolvedValue({ id: "entry-1" });

        await expect(
            service.refundTransaction("TX-1", { reason: "duplicate" } as any, 7),
        ).rejects.toThrow("already been refunded");
    });

    it("refund should process successfully for failed SELL transaction", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 1,
            transactionId: "TX-1",
            orderReference: "REF-1",
            userId: 12,
            orderCategory: OrderCategory.SELL,
            streamlinedStatus: OrderStreamlinedStatus.failed,
            currency: "btc",
            total: 30,
            amount: 20,
        });
        prisma.ledgerEntry.findFirst.mockResolvedValue(null);
        ledgerService.credit.mockResolvedValue({ success: true, entryId: "ledger-refund-1" });
        prisma.order.update.mockResolvedValue({
            transactionId: "TX-1",
            user: { firstName: "A", lastName: "B" },
        });

        const result = await service.refundTransaction("TX-1", { reason: "manual" } as any, 7);

        expect(ledgerService.runWithLock).toHaveBeenCalled();
        expect(ledgerService.credit).toHaveBeenCalled();
        expect(result.message).toContain("Refund processed successfully");
    });

    it("retry should reject done/completed status", async () => {
        prisma.order.findUnique.mockResolvedValue({
            transactionId: "TX-1",
            status: OrderStatus.done,
            streamlinedStatus: OrderStreamlinedStatus.failed,
        });

        const result = await service.retryTransaction("TX-1", 2);
        expect(result.message).toContain("Cannot retry completed transaction");
    });

    it("retry BUY should invoke payment reset and fulfillBuyOrder", async () => {
        prisma.order.findUnique
            .mockResolvedValueOnce({
                id: 11,
                transactionId: "TX-1",
                streamlinedStatus: OrderStreamlinedStatus.failed,
                status: "failed",
                orderCategory: OrderCategory.BUY,
                orderReference: "ORD-1",
                reason: null,
            })
            .mockResolvedValueOnce({
                transactionId: "TX-1",
                user: { firstName: "A", lastName: "B" },
                status: "confirmed",
                streamlinedStatus: OrderStreamlinedStatus.completed,
            });
        prisma.order.update.mockResolvedValue({});
        prisma.payment.updateMany.mockResolvedValue({ count: 1 });
        buyOrderService.fulfillBuyOrder.mockResolvedValue(undefined);

        const result = await service.retryTransaction("TX-1", 2);

        expect(prisma.payment.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    status: TransactionStatus.PENDING,
                    paymentStatus: TransactionStatus.PENDING,
                },
            }),
        );
        expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith("ORD-1");
        expect(result.message).toContain("retry initiated/completed successfully");
    });

    it("retry SELL should invoke retryFiatPayout", async () => {
        prisma.order.findUnique
            .mockResolvedValueOnce({
                id: 77,
                transactionId: "TX-SELL",
                streamlinedStatus: OrderStreamlinedStatus.failed,
                status: "failed",
                orderCategory: OrderCategory.SELL,
            })
            .mockResolvedValueOnce({
                transactionId: "TX-SELL",
                user: { firstName: "A", lastName: "B" },
            });
        prisma.order.update.mockResolvedValue({});
        withdrawalWebhookHandler.retryFiatPayout.mockResolvedValue(undefined);

        await service.retryTransaction("TX-SELL", 2);

        expect(withdrawalWebhookHandler.retryFiatPayout).toHaveBeenCalledWith(77);
    });

    it("retry SEND should fail with retry not supported", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 88,
            transactionId: "TX-SEND",
            streamlinedStatus: OrderStreamlinedStatus.pending,
            status: "pending",
            orderCategory: OrderCategory.SEND,
            reason: null,
        });
        prisma.order.update.mockResolvedValue({});

        await expect(service.retryTransaction("TX-SEND", 2)).rejects.toThrow("Retry failed");
    });

    it("bulkUpdateStatus should report successful and failed counts", async () => {
        const spy = jest.spyOn(service, "updateTransactionStatus")
            .mockResolvedValueOnce({ message: "ok", data: {} } as any)
            .mockRejectedValueOnce(new Error("boom"));

        const result = await service.bulkUpdateStatus(
            { transactionIds: ["TX-1", "TX-2"], status: OrderStreamlinedStatus.failed, reason: "bulk" } as any,
            3,
        );

        expect(spy).toHaveBeenCalledTimes(2);
        expect(result.data).toEqual({ total: 2, successful: 1, failed: 1 });
    });

    it("getTransactionAuditLogs should return logs", async () => {
        prisma.auditLog.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

        const result = await service.getTransactionAuditLogs("TX-1");

        expect(prisma.auditLog.findMany).toHaveBeenCalled();
        expect(result.data).toHaveLength(2);
    });

    it("exportTransactions should produce csv and json formats", async () => {
        prisma.order.findMany.mockResolvedValue([
            {
                id: 1,
                transactionId: "TX-1",
                orderCategory: OrderCategory.BUY,
                streamlinedStatus: OrderStreamlinedStatus.completed,
                amountInFiat: 2500,
                currency: "BTC",
                fee: 10,
                createdAt: new Date("2026-01-01T00:00:00Z"),
                user: { firstName: "A", lastName: "B", email: "a@b.com" },
            },
        ]);

        const csv = await service.exportTransactions({} as any, "csv");
        const json = await service.exportTransactions({} as any, "json");

        expect(csv.data.format).toBe("csv");
        expect(csv.data.content).toContain("Transaction ID");
        expect(json.data.format).toBe("json");
        expect(json.data.records).toHaveLength(1);
    });

    it("manual approve should return not found when transaction is missing", async () => {
        settingService.verify2FACode.mockResolvedValue(true);
        prisma.order.findUnique.mockResolvedValue(null);

        const result = await service.manualApproveTransaction(
            "TX-missing",
            { twoFactorCode: "123456", confirmed: true } as any,
            { id: 90 } as any,
        );

        expect(result.message).toContain("not found");
    });

    it("manual approve should require explicit confirmation", async () => {
        settingService.verify2FACode.mockResolvedValue(true);
        prisma.order.findUnique.mockResolvedValue({
            transactionId: "TX-1",
            orderCategory: OrderCategory.BUY,
            userId: 1,
            currency: "btc",
            amount: 10,
        });

        const result = await service.manualApproveTransaction(
            "TX-1",
            { twoFactorCode: "123456", confirmed: false } as any,
            { id: 90 } as any,
        );

        expect(result.message).toContain("requires confirmation");
    });

    it("refund should return not found for missing transaction", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        const result = await service.refundTransaction("TX-missing", { reason: "none" } as any, 2);

        expect(result.message).toContain("not found");
    });

    it("refund should reject zero or invalid amount", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 2,
            transactionId: "TX-1",
            orderReference: "REF-1",
            userId: 12,
            orderCategory: OrderCategory.BUY,
            streamlinedStatus: OrderStreamlinedStatus.failed,
            currency: "btc",
            total: 0,
            amount: 0,
        });
        prisma.ledgerEntry.findFirst.mockResolvedValue(null);

        await expect(
            service.refundTransaction("TX-1", { reason: "invalid" } as any, 7),
        ).rejects.toThrow("zero or invalid");
    });

    it("refund should reject when duplicate refund is detected inside lock", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 1,
            transactionId: "TX-1",
            orderReference: "REF-1",
            userId: 12,
            orderCategory: OrderCategory.SELL,
            streamlinedStatus: OrderStreamlinedStatus.failed,
            currency: "btc",
            total: 30,
            amount: 20,
        });
        prisma.ledgerEntry.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "entry-2" });

        await expect(
            service.refundTransaction("TX-1", { reason: "duplicate-lock" } as any, 7),
        ).rejects.toThrow("already been refunded");
    });

    it("refund should throw internal error when credit fails", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 1,
            transactionId: "TX-1",
            orderReference: "REF-1",
            userId: 12,
            orderCategory: OrderCategory.SELL,
            streamlinedStatus: OrderStreamlinedStatus.failed,
            currency: "btc",
            total: 30,
            amount: 20,
        });
        prisma.ledgerEntry.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        ledgerService.credit.mockResolvedValue({ success: false, error: "credit failed" });

        await expect(
            service.refundTransaction("TX-1", { reason: "manual" } as any, 7),
        ).rejects.toThrow("Refund failed: credit failed");
    });

    it("retry should return not found when transaction is missing", async () => {
        prisma.order.findUnique.mockResolvedValue(null);

        const result = await service.retryTransaction("TX-missing", 2);

        expect(result.message).toContain("not found");
    });

    it("retry should reject statuses outside failed or pending", async () => {
        prisma.order.findUnique.mockResolvedValue({
            transactionId: "TX-1",
            streamlinedStatus: OrderStreamlinedStatus.completed,
            status: "pending",
        });

        const result = await service.retryTransaction("TX-1", 2);
        expect(result.message).toContain("Only failed or pending");
    });

    it("retry BUY should fail when order reference is missing", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 11,
            transactionId: "TX-1",
            streamlinedStatus: OrderStreamlinedStatus.failed,
            status: "failed",
            orderCategory: OrderCategory.BUY,
            orderReference: null,
            reason: null,
        });
        prisma.order.update.mockResolvedValue({});

        await expect(service.retryTransaction("TX-1", 2)).rejects.toThrow(
            "Retry failed: Missing order reference required for payment lookup"
        );
    });

    it("retry SWAP should invoke retryPendingSwap", async () => {
        prisma.order.findUnique
            .mockResolvedValueOnce({
                id: 91,
                transactionId: "TX-SWAP",
                streamlinedStatus: OrderStreamlinedStatus.failed,
                status: "failed",
                orderCategory: OrderCategory.SWAP,
                reason: null,
            })
            .mockResolvedValueOnce({
                transactionId: "TX-SWAP",
                user: { firstName: "A", lastName: "B" },
            });
        prisma.order.update.mockResolvedValue({});
        swapService.retryPendingSwap.mockResolvedValue(undefined);

        const result = await service.retryTransaction("TX-SWAP", 2);

        expect(swapService.retryPendingSwap).toHaveBeenCalledWith(91);
        expect(result.message).toContain("retry initiated/completed successfully");
    });

    it("retry should fail for unknown category", async () => {
        prisma.order.findUnique.mockResolvedValue({
            id: 88,
            transactionId: "TX-UNKNOWN",
            streamlinedStatus: OrderStreamlinedStatus.pending,
            status: "pending",
            orderCategory: "UNKNOWN",
            reason: null,
        });
        prisma.order.update.mockResolvedValue({});

        await expect(service.retryTransaction("TX-UNKNOWN", 2)).rejects.toThrow(
            "Retry failed: Retry not implemented for category UNKNOWN"
        );
    });

    it("getTransactionStats should handle all date-range periods", async () => {
        prisma.order.count.mockResolvedValue(0);
        prisma.order.aggregate.mockResolvedValue({ _sum: { amountInFiat: 0 } });
        prisma.order.findMany.mockResolvedValue([]);
        prisma.order.groupBy.mockResolvedValue([]);

        for (const period of ["today", "week", "quarter", "year", "all", "unknown"]) {
            const result = await service.getTransactionStats(period);
            expect(result.data.period.start).toBeDefined();
            expect(result.data.period.end).toBeDefined();
        }
    });
});