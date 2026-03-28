import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { OrderStreamlinedStatus } from "@prisma/client";

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
        },
        auditLog: { create: jest.fn() },
        $transaction: jest.fn(),
    };
}

describe("AdminTransactionService", () => {
    let service: AdminTransactionService;
    let prisma: ReturnType<typeof makePrisma>;

    beforeEach(async () => {
        prisma = makePrisma();
        prisma.$transaction.mockImplementation(async (ops: any[]) => Promise.all(ops));

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AdminTransactionService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: { credit: jest.fn() } },
                { provide: SettingService, useValue: { verify2FACode: jest.fn() } },
                { provide: BuyOrderService, useValue: {} },
                { provide: SwapService, useValue: {} },
                { provide: WithdrawalWebhookHandler, useValue: {} },
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
});