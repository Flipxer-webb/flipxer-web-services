import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { StuckOrderReconciliationService } from "../stuck-order-reconciliation.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { BuyOrderService } from "../buy-order.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { OrderCategory, TransactionStatus } from "@prisma/client";

function makePrisma() {
    return {
        payment: {
            findMany: jest.fn(),
            update: jest.fn(),
        },
        order: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
        },
        ledgerEntry: { findMany: jest.fn() },
        webhookLog: { findFirst: jest.fn() },
    };
}

describe("StuckOrderReconciliationService", () => {
    let service: StuckOrderReconciliationService;
    let prisma: ReturnType<typeof makePrisma>;
    let buyOrderService: { fulfillBuyOrder: jest.Mock };
    let slackService: { sendWebhookFailureAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockBuyOrder = { fulfillBuyOrder: jest.fn().mockResolvedValue(undefined) };
        const mockSlack = { sendWebhookFailureAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StuckOrderReconciliationService,
                { provide: PrismaService, useValue: prisma },
                { provide: BuyOrderService, useValue: mockBuyOrder },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(StuckOrderReconciliationService);
        buyOrderService = module.get(BuyOrderService);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── reconcile (full) ─────────────────────────────────────

    describe("reconcile", () => {
        it("should return clean result when no stuck orders", async () => {
            prisma.payment.findMany.mockResolvedValue([]);
            prisma.order.findMany.mockResolvedValue([]);

            const result = await service.reconcile();

            expect(result.stuckBuyOrders.detected).toBe(0);
            expect(result.brokenLedgerOrders.detected).toBe(0);
            expect(result.preLedgerBackfill.detected).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it("should detect and retry stuck buy orders with webhook proof", async () => {
            const stuckPayment = {
                id: 1,
                reference: "pay-ref-1",
                externalReference: "ext-ref-1",
                status: TransactionStatus.SUCCESS,
                createdAt: new Date("2025-01-01"),
                order: {
                    id: 10,
                    amount: 100,
                    currency: "BTC",
                    transactionId: "txn-1",
                    userId: 1,
                },
            };
            prisma.payment.findMany.mockResolvedValue([stuckPayment]);
            prisma.webhookLog.findFirst.mockResolvedValue({ id: "wh-1" });
            prisma.payment.update.mockResolvedValue({});
            // No broken ledger or pre-ledger orders
            prisma.order.findMany.mockResolvedValue([]);

            const result = await service.reconcile();

            expect(result.stuckBuyOrders.detected).toBe(1);
            expect(result.stuckBuyOrders.autoRetried).toBe(1);
            expect(buyOrderService.fulfillBuyOrder).toHaveBeenCalledWith("pay-ref-1");
        });

        it("should skip stuck orders without webhook proof", async () => {
            prisma.payment.findMany.mockResolvedValue([{
                id: 1,
                reference: "pay-ref-1",
                externalReference: null,
                status: TransactionStatus.SUCCESS,
                createdAt: new Date("2025-01-01"),
                order: { id: 10, amount: 100, currency: "BTC", transactionId: "txn-1", userId: 1 },
            }]);
            prisma.webhookLog.findFirst.mockResolvedValue(null); // No proof
            prisma.order.findMany.mockResolvedValue([]);

            const result = await service.reconcile();

            expect(result.stuckBuyOrders.skippedNoWebhook).toBe(1);
            expect(buyOrderService.fulfillBuyOrder).not.toHaveBeenCalled();
        });

        it("should detect broken ledger links", async () => {
            prisma.payment.findMany.mockResolvedValue([]);
            // First call: broken ledger candidates, second call: pre-ledger backfill
            prisma.order.findMany
                .mockResolvedValueOnce([{
                    id: 20,
                    transactionId: "txn-2",
                    orderCategory: OrderCategory.BUY,
                    ledgerEntryId: "le-failed",
                }])
                .mockResolvedValueOnce([]); // no pre-ledger
            prisma.ledgerEntry.findMany.mockResolvedValue([
                { id: "le-failed", status: "FAILED" },
            ]);

            const result = await service.reconcile();

            expect(result.brokenLedgerOrders.detected).toBe(1);
            expect(result.brokenLedgerOrders.alerted).toBe(true);
            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalled();
        });

        it("should backfill pre-ledger orders", async () => {
            prisma.payment.findMany.mockResolvedValue([]);
            prisma.order.findMany
                .mockResolvedValueOnce([]) // no broken ledger candidates
                .mockResolvedValueOnce([{ id: 30 }, { id: 31 }]); // pre-ledger
            prisma.ledgerEntry.findMany.mockResolvedValue([]);
            prisma.order.updateMany.mockResolvedValue({ count: 2 });

            const result = await service.reconcile();

            expect(result.preLedgerBackfill.detected).toBe(2);
            expect(result.preLedgerBackfill.fixed).toBe(2);
        });

        it("should handle errors gracefully", async () => {
            prisma.payment.findMany.mockRejectedValue(new Error("DB error"));
            prisma.order.findMany.mockResolvedValue([]);
            prisma.ledgerEntry.findMany.mockResolvedValue([]);

            const result = await service.reconcile();

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain("DB error");
        });
    });
});
