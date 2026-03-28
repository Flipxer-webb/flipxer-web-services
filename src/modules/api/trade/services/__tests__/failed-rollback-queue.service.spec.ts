import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { FailedRollbackQueueService } from "../failed-rollback-queue.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "../ledger/ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { RollbackStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        failedRollback: {
            create: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
    };
}

describe("FailedRollbackQueueService", () => {
    let service: FailedRollbackQueueService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: { pairedCredit: jest.Mock };
    let slackService: { sendAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockLedger = { pairedCredit: jest.fn() };
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FailedRollbackQueueService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: mockLedger },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(FailedRollbackQueueService);
        ledgerService = module.get(LedgerService);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── addToQueue ───────────────────────────────────────────

    describe("addToQueue", () => {
        it("should create a pending rollback and alert admins", async () => {
            prisma.failedRollback.create.mockResolvedValue({ id: "rb-1" });

            const result = await service.addToQueue({
                orderId: 100,
                userId: 1,
                currency: "BTC",
                amount: 0.5,
                originalError: "Buy leg failed",
            });

            expect(result).toBe("rb-1");
            expect(prisma.failedRollback.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        orderId: 100,
                        userId: 1,
                        currency: "BTC",
                        status: RollbackStatus.PENDING,
                    }),
                }),
            );
            expect(slackService.sendAlert).toHaveBeenCalledWith(
                "FAILED_ROLLBACK_QUEUED",
                expect.any(Object),
            );
        });

        it("should handle Decimal amounts", async () => {
            prisma.failedRollback.create.mockResolvedValue({ id: "rb-2" });

            await service.addToQueue({
                orderId: 101,
                userId: 2,
                currency: "ETH",
                amount: new Decimal("1.5"),
                originalError: "Network error",
                metadata: { transactionId: "TX-123" },
            });

            expect(prisma.failedRollback.create).toHaveBeenCalled();
        });
    });

    // ── processQueue ─────────────────────────────────────────

    describe("processQueue", () => {
        it("should skip when no pending rollbacks", async () => {
            prisma.failedRollback.findMany.mockResolvedValue([]);

            await service.processQueue();

            expect(prisma.failedRollback.updateMany).not.toHaveBeenCalled();
        });

        it("should process pending rollbacks", async () => {
            const rollback = {
                id: "rb-1",
                orderId: 100,
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                retryCount: 0,
                status: RollbackStatus.PENDING,
                createdAt: new Date(),
            };
            prisma.failedRollback.findMany.mockResolvedValue([rollback]);
            prisma.failedRollback.updateMany.mockResolvedValue({ count: 1 });
            prisma.failedRollback.findUnique.mockResolvedValue(rollback);
            ledgerService.pairedCredit.mockResolvedValue({ success: true, userEntry: { id: 1 } });

            await service.processQueue();

            expect(ledgerService.pairedCredit).toHaveBeenCalled();
            expect(prisma.failedRollback.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RollbackStatus.COMPLETED,
                    }),
                }),
            );
        });
    });

    // ── retryRollback ────────────────────────────────────────

    describe("retryRollback", () => {
        it("should successfully refund and mark completed", async () => {
            prisma.failedRollback.updateMany.mockResolvedValue({ count: 1 });
            prisma.failedRollback.findUnique.mockResolvedValue({
                id: "rb-1",
                orderId: 100,
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                retryCount: 2,
            });
            ledgerService.pairedCredit.mockResolvedValue({ success: true, userEntry: { id: 10 } });

            const result = await service.retryRollback("rb-1");

            expect(result).toBe(true);
            expect(prisma.failedRollback.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RollbackStatus.COMPLETED,
                        retryCount: 3,
                    }),
                }),
            );
            expect(slackService.sendAlert).toHaveBeenCalledWith(
                "FAILED_ROLLBACK_RECOVERED",
                expect.any(Object),
            );
        });

        it("should return false when already being processed", async () => {
            prisma.failedRollback.updateMany.mockResolvedValue({ count: 0 });

            const result = await service.retryRollback("rb-1");

            expect(result).toBe(false);
        });

        it("should return false when rollback not found", async () => {
            prisma.failedRollback.updateMany.mockResolvedValue({ count: 1 });
            prisma.failedRollback.findUnique.mockResolvedValue(null);

            const result = await service.retryRollback("rb-missing");

            expect(result).toBe(false);
        });

        it("should retry and stay PENDING on non-max failure", async () => {
            prisma.failedRollback.updateMany.mockResolvedValue({ count: 1 });
            prisma.failedRollback.findUnique.mockResolvedValue({
                id: "rb-1",
                orderId: 100,
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                retryCount: 3,
            });
            ledgerService.pairedCredit.mockResolvedValue({ success: false, error: "Insufficient" });

            const result = await service.retryRollback("rb-1");

            expect(result).toBe(false);
            expect(prisma.failedRollback.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RollbackStatus.PENDING,
                        retryCount: 4,
                    }),
                }),
            );
        });

        it("should mark FAILED and alert on max retries", async () => {
            prisma.failedRollback.updateMany.mockResolvedValue({ count: 1 });
            prisma.failedRollback.findUnique.mockResolvedValue({
                id: "rb-1",
                orderId: 100,
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                retryCount: 9, // MAX_RETRY_ATTEMPTS = 10, so next = 10
            });
            ledgerService.pairedCredit.mockRejectedValue(new Error("DB down"));

            const result = await service.retryRollback("rb-1");

            expect(result).toBe(false);
            expect(prisma.failedRollback.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: RollbackStatus.FAILED,
                        retryCount: 10,
                    }),
                }),
            );
            expect(slackService.sendAlert).toHaveBeenCalledWith(
                "FAILED_ROLLBACK_PERMANENT",
                expect.any(Object),
            );
        });
    });

    // ── manualRetry ──────────────────────────────────────────

    describe("manualRetry", () => {
        it("should return not found for missing rollback", async () => {
            prisma.failedRollback.findUnique.mockResolvedValue(null);

            const result = await service.manualRetry("rb-missing");

            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");
        });

        it("should return already completed", async () => {
            prisma.failedRollback.findUnique.mockResolvedValue({
                id: "rb-1",
                status: RollbackStatus.COMPLETED,
            });

            const result = await service.manualRetry("rb-1");

            expect(result.success).toBe(false);
            expect(result.message).toContain("already completed");
        });
    });
});
