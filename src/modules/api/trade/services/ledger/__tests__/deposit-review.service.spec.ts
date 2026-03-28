import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {},
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { DepositReviewService } from "../deposit-review.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "../ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { DepositReviewStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    const tx = {
        depositReviewQueue: {
            create: jest.fn(),
            findUnique: jest.fn(),
            updateMany: jest.fn(),
        },
        $queryRaw: jest.fn(),
    };
    return {
        floatConfig: { findUnique: jest.fn() },
        depositReviewQueue: {
            create: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            count: jest.fn(),
        },
        user: { findUnique: jest.fn() },
        $transaction: jest.fn().mockImplementation(async (cb: any) => {
            if (typeof cb === "function") return cb(tx);
            return cb;
        }),
        _tx: tx,
    };
}

describe("DepositReviewService", () => {
    let service: DepositReviewService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: { pairedCreditInTransaction: jest.Mock };
    let slackService: { sendSystemAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockLedger = { pairedCreditInTransaction: jest.fn() };
        const mockSlack = { sendSystemAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DepositReviewService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: mockLedger },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(DepositReviewService);
        ledgerService = module.get(LedgerService);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── checkAndQueueIfNeeded ────────────────────────────────

    describe("checkAndQueueIfNeeded", () => {
        it("should allow deposit when no float config exists", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue(null);

            const result = await service.checkAndQueueIfNeeded(1, "BTC", new Decimal("0.5"), "addr1");

            expect(result.allowed).toBe(true);
            expect(result.queued).toBe(false);
            expect(result.floatPercentage).toBe(0);
        });

        it("should allow deposit when float config is inactive", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue({ isActive: false });

            const result = await service.checkAndQueueIfNeeded(1, "BTC", new Decimal("0.5"), "addr1");

            expect(result.allowed).toBe(true);
            expect(result.queued).toBe(false);
        });

        it("should allow deposit when below block threshold", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue({
                isActive: true,
                blockThreshold: new Decimal("80"),
                alertThreshold: new Decimal("60"),
                floatAllowance: new Decimal("1000"),
            });
            // Float at 50% (500 / 1000)
            prisma._tx.$queryRaw.mockResolvedValue([{ total_balance: "500" }]);

            const result = await service.checkAndQueueIfNeeded(1, "BTC", new Decimal("0.5"), "addr1");

            expect(result.allowed).toBe(true);
            expect(result.queued).toBe(false);
            expect(result.floatPercentage).toBe(50);
        });

        it("should queue deposit when above block threshold", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue({
                isActive: true,
                blockThreshold: new Decimal("80"),
                alertThreshold: new Decimal("60"),
                floatAllowance: new Decimal("1000"),
                autoApproveHours: 24,
            });
            // Float at 90% (900 / 1000)
            prisma._tx.$queryRaw.mockResolvedValue([{ total_balance: "900" }]);
            prisma._tx.depositReviewQueue.create.mockResolvedValue({
                id: "drq-1",
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                status: DepositReviewStatus.PENDING,
            });
            prisma.user.findUnique.mockResolvedValue({ email: "test@test.com", firstName: "John", lastName: "Doe" });

            const result = await service.checkAndQueueIfNeeded(1, "BTC", new Decimal("0.5"), "addr1", "txhash1");

            expect(result.allowed).toBe(false);
            expect(result.queued).toBe(true);
            expect(result.queueId).toBe("drq-1");
            expect(result.floatPercentage).toBe(90);
        });

        it("should handle zero float allowance", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue({
                isActive: true,
                blockThreshold: new Decimal("80"),
                alertThreshold: new Decimal("60"),
                floatAllowance: new Decimal("0"),
            });

            // computeFloatPercentage returns 0 when floatAllowance is 0
            // In the tx variant, calculateFloatPercentageInTx checks floatAllowance.eq(0) and returns 0
            const result = await service.checkAndQueueIfNeeded(1, "BTC", new Decimal("0.5"), "addr1");

            expect(result.allowed).toBe(true);
            expect(result.floatPercentage).toBe(0);
        });
    });

    // ── getReviews ───────────────────────────────────────────

    describe("getReviews", () => {
        it("should return pending reviews by default", async () => {
            const reviews = [{ id: "drq-1", status: DepositReviewStatus.PENDING }];
            prisma.depositReviewQueue.findMany.mockResolvedValue(reviews);
            prisma.depositReviewQueue.count.mockResolvedValue(1);

            const result = await service.getReviews();

            expect(result.reviews).toEqual(reviews);
            expect(result.count).toBe(1);
            expect(prisma.depositReviewQueue.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { status: DepositReviewStatus.PENDING },
                }),
            );
        });

        it("should filter by status and currency", async () => {
            prisma.depositReviewQueue.findMany.mockResolvedValue([]);
            prisma.depositReviewQueue.count.mockResolvedValue(0);

            await service.getReviews(1, 10, DepositReviewStatus.APPROVED, "ETH");

            expect(prisma.depositReviewQueue.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { status: DepositReviewStatus.APPROVED, currency: "ETH" },
                }),
            );
        });

        it("should handle pagination", async () => {
            prisma.depositReviewQueue.findMany.mockResolvedValue([]);
            prisma.depositReviewQueue.count.mockResolvedValue(25);

            await service.getReviews(3, 5);

            expect(prisma.depositReviewQueue.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    skip: 10, // (3-1) * 5
                    take: 5,
                }),
            );
        });
    });

    // ── approveDeposit ───────────────────────────────────────

    describe("approveDeposit", () => {
        it("should approve a pending deposit and credit user", async () => {
            const queueEntry = {
                id: "drq-1",
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                txHash: "txhash1",
                status: DepositReviewStatus.PENDING,
            };
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 1 });
            prisma._tx.depositReviewQueue.findUnique.mockResolvedValue(queueEntry);
            ledgerService.pairedCreditInTransaction.mockResolvedValue({
                success: true,
                userEntry: { id: "le-1" },
            });

            const result = await service.approveDeposit("drq-1", 99, "Approved by admin");

            expect(result.success).toBe(true);
            expect(result.entry).toEqual(queueEntry);
            expect(ledgerService.pairedCreditInTransaction).toHaveBeenCalledWith(
                prisma._tx,
                expect.objectContaining({
                    userId: 1,
                    currency: "BTC",
                    amount: new Decimal("0.5"),
                    reference: "txhash1",
                }),
            );
        });

        it("should return error when deposit already processed (count=0)", async () => {
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 0 });
            prisma._tx.depositReviewQueue.findUnique.mockResolvedValue({
                status: DepositReviewStatus.APPROVED,
            });

            const result = await service.approveDeposit("drq-1", 99);

            expect(result.success).toBe(false);
            expect(result.error).toContain("already approved");
        });

        it("should return error when queue entry not found", async () => {
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 0 });
            prisma._tx.depositReviewQueue.findUnique.mockResolvedValue(null);

            const result = await service.approveDeposit("drq-nonexistent", 99);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Queue entry not found");
        });

        it("should throw if ledger credit fails (rolls back transaction)", async () => {
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 1 });
            prisma._tx.depositReviewQueue.findUnique.mockResolvedValue({
                id: "drq-1",
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                txHash: null,
            });
            ledgerService.pairedCreditInTransaction.mockResolvedValue({
                success: false,
                error: "Duplicate reference",
            });

            await expect(service.approveDeposit("drq-1", 99)).rejects.toThrow("Failed to credit user ledger");
        });

        it("should use queue ID as reference fallback when no txHash", async () => {
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 1 });
            prisma._tx.depositReviewQueue.findUnique.mockResolvedValue({
                id: "drq-1",
                userId: 1,
                currency: "BTC",
                amount: new Decimal("0.5"),
                txHash: null,
            });
            ledgerService.pairedCreditInTransaction.mockResolvedValue({
                success: true,
                userEntry: { id: "le-1" },
            });

            await service.approveDeposit("drq-1", 99);

            expect(ledgerService.pairedCreditInTransaction).toHaveBeenCalledWith(
                prisma._tx,
                expect.objectContaining({
                    reference: "deposit-review-approved:drq-1",
                }),
            );
        });
    });

    // ── rejectDeposit ────────────────────────────────────────

    describe("rejectDeposit", () => {
        it("should reject a pending deposit", async () => {
            prisma.depositReviewQueue.updateMany.mockResolvedValue({ count: 1 });

            const result = await service.rejectDeposit("drq-1", 99, "Suspicious");

            expect(result.success).toBe(true);
        });

        it("should return error when already processed", async () => {
            prisma.depositReviewQueue.updateMany.mockResolvedValue({ count: 0 });
            prisma.depositReviewQueue.findUnique.mockResolvedValue({
                status: DepositReviewStatus.REJECTED,
            });

            const result = await service.rejectDeposit("drq-1", 99);

            expect(result.success).toBe(false);
            expect(result.error).toContain("already rejected");
        });

        it("should return error when not found", async () => {
            prisma.depositReviewQueue.updateMany.mockResolvedValue({ count: 0 });
            prisma.depositReviewQueue.findUnique.mockResolvedValue(null);

            const result = await service.rejectDeposit("drq-1", 99);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Queue entry not found");
        });
    });

    // ── processAutoApprovals ─────────────────────────────────

    describe("processAutoApprovals", () => {
        it("should auto-approve deposits past timeout and credit users", async () => {
            const pastDue = [
                {
                    id: "drq-1",
                    userId: 1,
                    currency: "BTC",
                    amount: new Decimal("0.5"),
                    txHash: "txhash1",
                    status: DepositReviewStatus.PENDING,
                    autoApproveAt: new Date("2025-01-01"),
                },
            ];
            prisma.depositReviewQueue.findMany.mockResolvedValue(pastDue);
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 1 });
            ledgerService.pairedCreditInTransaction.mockResolvedValue({
                success: true,
                userEntry: { id: "le-1" },
            });

            const count = await service.processAutoApprovals();

            expect(count).toBe(1);
            expect(ledgerService.pairedCreditInTransaction).toHaveBeenCalled();
        });

        it("should skip already-processed entries (count=0)", async () => {
            prisma.depositReviewQueue.findMany.mockResolvedValue([
                {
                    id: "drq-1",
                    userId: 1,
                    currency: "BTC",
                    amount: new Decimal("0.5"),
                    txHash: "txhash1",
                    status: DepositReviewStatus.PENDING,
                    autoApproveAt: new Date("2025-01-01"),
                },
            ]);
            prisma._tx.depositReviewQueue.updateMany.mockResolvedValue({ count: 0 });

            const count = await service.processAutoApprovals();

            expect(count).toBe(0);
            expect(ledgerService.pairedCreditInTransaction).not.toHaveBeenCalled();
        });

        it("should return 0 when no pending auto-approvals", async () => {
            prisma.depositReviewQueue.findMany.mockResolvedValue([]);

            const count = await service.processAutoApprovals();

            expect(count).toBe(0);
        });

        it("should continue processing when one entry fails", async () => {
            prisma.depositReviewQueue.findMany.mockResolvedValue([
                { id: "drq-1", userId: 1, currency: "BTC", amount: new Decimal("0.5"), txHash: "tx1", autoApproveAt: new Date("2025-01-01") },
                { id: "drq-2", userId: 2, currency: "ETH", amount: new Decimal("1.0"), txHash: "tx2", autoApproveAt: new Date("2025-01-01") },
            ]);
            // First entry: updateMany succeeds but credit fails
            prisma._tx.depositReviewQueue.updateMany
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 1 });
            ledgerService.pairedCreditInTransaction
                .mockRejectedValueOnce(new Error("Credit failed"))
                .mockResolvedValueOnce({ success: true, userEntry: { id: "le-2" } });

            const count = await service.processAutoApprovals();

            // First throws → 0 counted; second succeeds → 1 counted
            expect(count).toBe(1);
        });
    });

    // ── getStats ─────────────────────────────────────────────

    describe("getStats", () => {
        it("should return all status counts when no filter", async () => {
            prisma.depositReviewQueue.count
                .mockResolvedValueOnce(20)  // total
                .mockResolvedValueOnce(5)   // pending
                .mockResolvedValueOnce(10)  // approved
                .mockResolvedValueOnce(2)   // rejected
                .mockResolvedValueOnce(3);  // auto_approved

            const stats = await service.getStats();

            expect(stats).toEqual({
                pending: 5,
                approved: 10,
                rejected: 2,
                autoApproved: 3,
                total: 20,
            });
        });

        it("should filter by status", async () => {
            prisma.depositReviewQueue.count.mockResolvedValue(5);

            const stats = await service.getStats(DepositReviewStatus.PENDING);

            expect(stats.pending).toBe(5);
            expect(stats.approved).toBe(0);
        });

        it("should filter by currency", async () => {
            prisma.depositReviewQueue.count
                .mockResolvedValueOnce(4)  // total
                .mockResolvedValueOnce(3)  // pending
                .mockResolvedValueOnce(1)  // approved
                .mockResolvedValueOnce(0)  // rejected
                .mockResolvedValueOnce(0); // auto_approved

            const stats = await service.getStats(undefined, "BTC");

            expect(stats.pending).toBe(3);
        });
    });
});
