import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {},
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { OrphanedHoldService } from "../orphaned-hold.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "../ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { EntryStatus, HoldResolution } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        ledgerEntry: { findMany: jest.fn() },
        orphanedHoldReview: {
            create: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
            groupBy: jest.fn(),
        },
    };
}

describe("OrphanedHoldService", () => {
    let service: OrphanedHoldService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: { releaseHold: jest.Mock };
    let slackService: { sendAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockLedger = { releaseHold: jest.fn() };
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrphanedHoldService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: mockLedger },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(OrphanedHoldService);
        ledgerService = module.get(LedgerService);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── detectOrphanedHolds ──────────────────────────────────

    describe("detectOrphanedHolds", () => {
        it("should return no detections when no orphaned holds exist", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([]);

            const result = await service.detectOrphanedHolds();

            expect(result.detected).toBe(0);
            expect(result.alerted).toBe(0);
        });

        it("should detect and create review for orphaned holds", async () => {
            const holds = [
                {
                    id: "le-1",
                    userId: 1,
                    currency: "BTC",
                    holdAmount: new Decimal("0.5"),
                    createdAt: new Date("2025-01-01"),
                    status: EntryStatus.HOLD,
                    user: { id: 1, email: "test@test.com" },
                },
            ];
            prisma.ledgerEntry.findMany.mockResolvedValue(holds);
            prisma.orphanedHoldReview.create.mockResolvedValue({ id: "ohr-1" });

            const result = await service.detectOrphanedHolds();

            expect(result.detected).toBe(1);
            expect(result.alerted).toBe(1);
            expect(prisma.orphanedHoldReview.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        ledgerEntryId: "le-1",
                        userId: 1,
                        currency: "BTC",
                    }),
                }),
            );
            expect(slackService.sendAlert).toHaveBeenCalled();
        });

        it("should handle errors creating individual reviews", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([
                { id: "le-1", userId: 1, currency: "BTC", holdAmount: new Decimal("0.5"), status: EntryStatus.HOLD },
            ]);
            prisma.orphanedHoldReview.create.mockRejectedValue(new Error("Duplicate"));

            const result = await service.detectOrphanedHolds();

            expect(result.detected).toBe(1);
            expect(result.errors).toHaveLength(1);
        });
    });

    // ── getPendingReviews ────────────────────────────────────

    describe("getPendingReviews", () => {
        it("should return paginated pending reviews", async () => {
            prisma.orphanedHoldReview.findMany.mockResolvedValue([{ id: "ohr-1" }]);

            const result = await service.getPendingReviews(1, 10);

            expect(result).toHaveLength(1);
            expect(prisma.orphanedHoldReview.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { resolvedAt: null },
                    skip: 0,
                    take: 10,
                }),
            );
        });
    });

    // ── getReviewById ────────────────────────────────────────

    describe("getReviewById", () => {
        it("should return review by ID", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue({ id: "ohr-1" });

            const result = await service.getReviewById("ohr-1");

            expect(result).toBeDefined();
        });
    });

    // ── resolveOrphanedHold ──────────────────────────────────

    describe("resolveOrphanedHold", () => {
        const baseReview = {
            id: "ohr-1",
            resolvedAt: null,
            ledgerEntryId: "le-1",
            ledgerEntry: {
                id: "le-1",
                reference: "ref-1",
                status: EntryStatus.HOLD,
            },
        };

        it("should refund orphaned hold", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue(baseReview);
            ledgerService.releaseHold.mockResolvedValue({ success: true });
            prisma.orphanedHoldReview.update.mockResolvedValue({});

            const result = await service.resolveOrphanedHold("ohr-1", HoldResolution.REFUND, 99);

            expect(result.success).toBe(true);
            expect(ledgerService.releaseHold).toHaveBeenCalledWith("ref-1", false, expect.any(String));
            expect(prisma.orphanedHoldReview.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ resolution: HoldResolution.REFUND }),
                }),
            );
        });

        it("should settle orphaned hold", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue(baseReview);
            ledgerService.releaseHold.mockResolvedValue({ success: true });
            prisma.orphanedHoldReview.update.mockResolvedValue({});

            const result = await service.resolveOrphanedHold("ohr-1", HoldResolution.SETTLE, 99);

            expect(result.success).toBe(true);
            expect(ledgerService.releaseHold).toHaveBeenCalledWith("ref-1", true, expect.any(String));
        });

        it("should dismiss without ledger action", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue(baseReview);
            prisma.orphanedHoldReview.update.mockResolvedValue({});

            const result = await service.resolveOrphanedHold("ohr-1", HoldResolution.DISMISS, 99, "Not an issue");

            expect(result.success).toBe(true);
            expect(ledgerService.releaseHold).not.toHaveBeenCalled();
        });

        it("should return error when review not found", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue(null);

            const result = await service.resolveOrphanedHold("nonexistent", HoldResolution.REFUND, 99);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Review not found");
        });

        it("should return error when already resolved", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue({
                ...baseReview,
                resolvedAt: new Date(),
            });

            const result = await service.resolveOrphanedHold("ohr-1", HoldResolution.REFUND, 99);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Review already resolved");
        });

        it("should return error when ledger entry no longer in HOLD status", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue({
                ...baseReview,
                ledgerEntry: { ...baseReview.ledgerEntry, status: EntryStatus.SETTLED },
            });

            const result = await service.resolveOrphanedHold("ohr-1", HoldResolution.REFUND, 99);

            expect(result.success).toBe(false);
            expect(result.error).toContain("no longer in HOLD status");
        });

        it("should return error when releaseHold fails", async () => {
            prisma.orphanedHoldReview.findUnique.mockResolvedValue(baseReview);
            ledgerService.releaseHold.mockResolvedValue({ success: false, error: "Lock failed" });

            const result = await service.resolveOrphanedHold("ohr-1", HoldResolution.REFUND, 99);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Lock failed");
        });
    });

    // ── getStats ─────────────────────────────────────────────

    describe("getStats", () => {
        it("should return orphaned hold stats", async () => {
            prisma.orphanedHoldReview.count
                .mockResolvedValueOnce(5)   // pending
                .mockResolvedValueOnce(10); // resolved
            prisma.orphanedHoldReview.groupBy.mockResolvedValue([
                { resolution: HoldResolution.REFUND, _count: 6 },
                { resolution: HoldResolution.SETTLE, _count: 3 },
                { resolution: HoldResolution.DISMISS, _count: 1 },
            ]);

            const stats = await service.getStats();

            expect(stats.pending).toBe(5);
            expect(stats.resolved).toBe(10);
            expect(stats.byResolution[HoldResolution.REFUND]).toBe(6);
            expect(stats.byResolution[HoldResolution.SETTLE]).toBe(3);
            expect(stats.byResolution[HoldResolution.DISMISS]).toBe(1);
        });
    });
});
