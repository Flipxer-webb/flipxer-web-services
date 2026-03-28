import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { WithdrawalQueueService } from "../withdrawal-queue.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "../ledger.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";
import { EntryStatus, LedgerType, QueueReason } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        ledgerEntry: {
            findUnique: jest.fn(),
        },
        withdrawalQueue: {
            create: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            count: jest.fn(),
            aggregate: jest.fn(),
            groupBy: jest.fn(),
        },
    };
}

describe("WithdrawalQueueService", () => {
    let service: WithdrawalQueueService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: { releaseHold: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockLedger = { releaseHold: jest.fn() };
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
        const mockNotificationMessage = {
            sendWithdrawalRefunded: jest.fn().mockReturnValue("Withdrawal refunded"),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WithdrawalQueueService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: mockLedger },
                { provide: NotificationDispatcher, useValue: mockNotification },
                { provide: NotificationMessageService, useValue: mockNotificationMessage },
            ],
        }).compile();

        service = module.get(WithdrawalQueueService);
        ledgerService = module.get(LedgerService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── addToQueue ───────────────────────────────────────────

    describe("addToQueue", () => {
        const opts = {
            holdEntryId: "hold-1",
            userId: 1,
            currency: "BTC",
            amount: new Decimal("0.5"),
            reason: QueueReason.DEPOSIT_SETTLING,
        };

        it("should add withdrawal to queue", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                id: "hold-1", status: EntryStatus.HOLD, type: LedgerType.WITHDRAWAL,
            });
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _max: { position: 5 } });
            prisma.withdrawalQueue.create.mockResolvedValue({
                id: "wq-1", position: 6, ...opts,
            });

            const result = await service.addToQueue(opts);

            expect(result.success).toBe(true);
            expect(result.queueEntry).toBeDefined();
            expect(prisma.withdrawalQueue.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        userId: 1, currency: "BTC", holdEntryId: "hold-1", position: 6,
                    }),
                }),
            );
        });

        it("should fail when ledger entry not found", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue(null);

            const result = await service.addToQueue(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("not found");
        });

        it("should fail when ledger entry is not in HOLD status", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                id: "hold-1", status: EntryStatus.SETTLED, type: LedgerType.WITHDRAWAL,
            });

            const result = await service.addToQueue(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("HOLD status");
        });

        it("should fail when ledger entry is not WITHDRAWAL type", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                id: "hold-1", status: EntryStatus.HOLD, type: LedgerType.DEPOSIT,
            });

            const result = await service.addToQueue(opts);

            expect(result.success).toBe(false);
            expect(result.error).toContain("WITHDRAWAL");
        });
    });

    // ── getNextForProcessing ─────────────────────────────────

    describe("getNextForProcessing", () => {
        it("should return the next pending entry for currency", async () => {
            const queueEntry = { id: "wq-1", currency: "BTC", position: 1, holdEntry: {} };
            prisma.withdrawalQueue.findMany.mockResolvedValue([queueEntry]);

            const result = await service.getNextForProcessing("BTC", new Decimal("100"));

            expect(result).toEqual(queueEntry);
        });

        it("should return null when no pending entries", async () => {
            prisma.withdrawalQueue.findMany.mockResolvedValue([]);

            const result = await service.getNextForProcessing("BTC", new Decimal("100"));

            expect(result).toBeNull();
        });
    });

    // ── markProcessed / markReleased ─────────────────────────

    describe("markProcessed", () => {
        it("should update queue entry with processedAt", async () => {
            prisma.withdrawalQueue.update.mockResolvedValue({ id: "wq-1" });

            await service.markProcessed("wq-1");

            expect(prisma.withdrawalQueue.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "wq-1" },
                    data: expect.objectContaining({
                        processedAt: expect.any(Date),
                    }),
                }),
            );
        });
    });

    // ── getQueuePosition ─────────────────────────────────────

    describe("getQueuePosition", () => {
        it("should return position of queued entry", async () => {
            prisma.withdrawalQueue.findUnique.mockResolvedValue({
                id: "wq-1", position: 3, currency: "BTC", processedAt: null, releasedAt: null,
            });
            prisma.withdrawalQueue.count.mockResolvedValue(2); // 2 ahead

            const position = await service.getQueuePosition("hold-1");

            expect(position).toBe(3); // 2 + 1
        });

        it("should return null when not queued", async () => {
            prisma.withdrawalQueue.findUnique.mockResolvedValue(null);

            const position = await service.getQueuePosition("hold-missing");

            expect(position).toBeNull();
        });
    });

    // ── getUserQueuedWithdrawals ─────────────────────────────

    describe("getUserQueuedWithdrawals", () => {
        it("should return all queued withdrawals for user", async () => {
            prisma.withdrawalQueue.findMany.mockResolvedValue([
                { id: "wq-1", userId: 1 },
                { id: "wq-2", userId: 1 },
            ]);

            const result = await service.getUserQueuedWithdrawals(1);

            expect(result).toHaveLength(2);
        });
    });

    // ── getQueueStats ────────────────────────────────────────

    describe("getQueueStats", () => {
        it("should return queue statistics", async () => {
            prisma.withdrawalQueue.findMany.mockResolvedValue([
                { currency: "BTC", reason: QueueReason.DEPOSIT_SETTLING, queuedAt: new Date("2026-01-01") },
                { currency: "ETH", reason: QueueReason.LOW_LIQUIDITY, queuedAt: new Date("2026-01-02") },
            ]);

            const stats = await service.getQueueStats();

            expect(stats.totalQueued).toBe(2);
            expect(stats.byCurrency["BTC"]).toBe(1);
            expect(stats.oldestQueuedAt).toEqual(new Date("2026-01-01"));
        });
    });

    // ── processTimeouts ──────────────────────────────────────

    describe("processTimeouts", () => {
        it("should release holds for timed-out entries", async () => {
            const timedOut = [
                {
                    id: "wq-1", holdEntryId: "hold-1", userId: 1, currency: "BTC",
                    amount: new Decimal("0.5"), queuedAt: new Date("2026-01-01"),
                    holdEntry: { reference: "hold-ref-1" },
                    user: { id: 1, email: "test@example.com" },
                },
            ];
            prisma.withdrawalQueue.findMany.mockResolvedValue(timedOut);
            prisma.withdrawalQueue.updateMany.mockResolvedValue({ count: 1 });
            ledgerService.releaseHold.mockResolvedValue({ success: true });

            const count = await service.processTimeouts();

            expect(count).toBe(1);
            expect(ledgerService.releaseHold).toHaveBeenCalledWith("hold-ref-1", false, expect.any(String));
        });

        it("should return 0 when no timed-out entries", async () => {
            prisma.withdrawalQueue.findMany.mockResolvedValue([]);

            const count = await service.processTimeouts();

            expect(count).toBe(0);
        });
    });
});
