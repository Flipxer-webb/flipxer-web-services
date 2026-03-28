import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

// Mock the config module for mainAccountId
jest.mock("@/config", () => ({
    ...jest.requireActual("@/config"),
    quidaxConfig: { mainAccountId: "main-account-uuid" },
}));

import { SweepService } from "../sweep.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "../ledger.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { SweepStatus, LedgerType, EntryStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        ledgerEntry: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            count: jest.fn(),
            groupBy: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
        },
    };
}

describe("SweepService", () => {
    let service: SweepService;
    let prisma: ReturnType<typeof makePrisma>;
    let quidaxService: { createWithdrawerRequest: jest.Mock };
    let lockService: { withLock: jest.Mock };
    let ledgerService: { updateSweepStatus: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockQuidax = { createWithdrawerRequest: jest.fn() };
        const mockLock = {
            withLock: jest.fn().mockImplementation(async (_k: string, fn: () => Promise<any>) => fn()),
        };
        const mockLedger = { updateSweepStatus: jest.fn() };
        const mockSlack = { sendWebhookFailureAlert: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SweepService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidax },
                { provide: DistributedLockService, useValue: mockLock },
                { provide: LedgerService, useValue: mockLedger },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(SweepService);
        quidaxService = module.get(TradingInjectionToken.QUIDAX);
        lockService = module.get(DistributedLockService);
        ledgerService = module.get(LedgerService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── getPendingSweeps ─────────────────────────────────────

    describe("getPendingSweeps", () => {
        it("should return pending deposit entries", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([
                {
                    id: "le-1", userId: 1, currency: "BTC",
                    credit: new Decimal("0.5"), createdAt: new Date(),
                    user: { cryptoSubAccountId: "sub-1" },
                },
            ]);

            const result = await service.getPendingSweeps();

            expect(result).toHaveLength(1);
            expect(result[0].ledgerEntryId).toBe("le-1");
            expect(result[0].amount).toEqual(new Decimal("0.5"));
            expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        type: LedgerType.DEPOSIT,
                        sweepStatus: SweepStatus.PENDING,
                        status: EntryStatus.SETTLED,
                    }),
                }),
            );
        });

        it("should return empty array when no pending sweeps", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([]);

            const result = await service.getPendingSweeps();

            expect(result).toHaveLength(0);
        });
    });

    // ── initiateSweep ────────────────────────────────────────

    describe("initiateSweep", () => {
        const entry = {
            id: "le-1",
            userId: 1,
            currency: "BTC",
            credit: new Decimal("0.5"),
            sweepStatus: SweepStatus.PENDING,
            sweepRetryCount: 0,
            user: { id: 1, cryptoSubAccountId: "sub-1" },
        };

        it("should initiate sweep and store transaction ID", async () => {
            // executeSweep calls findUnique for the entry, then updateSweepStatus
            // calls findUnique to validate transition, etc.
            prisma.ledgerEntry.findUnique
                .mockResolvedValueOnce(entry) // executeSweep: get entry
                .mockResolvedValueOnce({ sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT }) // updateSweepStatus: PENDING → IN_PROGRESS
                .mockResolvedValue(entry); // any subsequent
            prisma.ledgerEntry.update.mockResolvedValue(entry);
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);
            quidaxService.createWithdrawerRequest.mockResolvedValue({
                data: { id: "quidax-tx-1" },
            });

            const result = await service.initiateSweep("le-1");

            expect(result.success).toBe(true);
            expect(result.transactionId).toBe("quidax-tx-1");
            expect(quidaxService.createWithdrawerRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    user_id: "sub-1",
                    currency: "btc",
                    amount: "0.5",
                    fund_uid: "main-account-uuid",
                }),
            );
        });

        it("should skip if entry not found", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue(null);

            const result = await service.initiateSweep("le-missing");

            expect(result.success).toBe(false);
            expect(result.error).toContain("not found");
        });

        it("should skip if sweep not pending", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                ...entry,
                sweepStatus: SweepStatus.COMPLETED,
            });

            const result = await service.initiateSweep("le-1");

            expect(result.success).toBe(true); // Already processed
            expect(quidaxService.createWithdrawerRequest).not.toHaveBeenCalled();
        });

        it("should mark NOT_APPLICABLE when user has no sub-account", async () => {
            prisma.ledgerEntry.findUnique
                .mockResolvedValueOnce({ ...entry, user: { id: 1, cryptoSubAccountId: null } })
                .mockResolvedValueOnce({ sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT });
            prisma.ledgerEntry.update.mockResolvedValue(entry);
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            const result = await service.initiateSweep("le-1");

            expect(result.success).toBe(true);
            expect(ledgerService.updateSweepStatus).toHaveBeenCalled();
        });

        it("should auto-complete dust amounts below minimum", async () => {
            prisma.ledgerEntry.findUnique
                .mockResolvedValueOnce({ ...entry, credit: new Decimal("0.000001") })
                .mockResolvedValueOnce({ sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT });
            prisma.ledgerEntry.update.mockResolvedValue(entry);
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            const result = await service.initiateSweep("le-1");

            expect(result.success).toBe(true);
            expect(quidaxService.createWithdrawerRequest).not.toHaveBeenCalled();
        });

        it("should handle lock already acquired gracefully", async () => {
            lockService.withLock.mockRejectedValue(new Error("Failed to acquire lock"));

            const result = await service.initiateSweep("le-1");

            expect(result.success).toBe(false);
            expect(result.error).toContain("already in progress");
        });
    });

    // ── completeSweep / failSweep ────────────────────────────

    describe("completeSweep", () => {
        it("should update sweep status to COMPLETED", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                id: "le-1", sweepStatus: SweepStatus.IN_PROGRESS, type: LedgerType.DEPOSIT,
            });
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            await service.completeSweep("le-1");

            expect(ledgerService.updateSweepStatus).toHaveBeenCalledWith(
                "le-1", SweepStatus.COMPLETED,
            );
        });
    });

    describe("failSweep", () => {
        it("should update sweep status to FAILED with reason", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                id: "le-1", sweepStatus: SweepStatus.IN_PROGRESS, type: LedgerType.DEPOSIT,
            });
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            await service.failSweep("le-1", "Quidax timeout");

            expect(ledgerService.updateSweepStatus).toHaveBeenCalledWith(
                "le-1", SweepStatus.FAILED,
            );
        });
    });

    // ── canWithdraw ──────────────────────────────────────────

    describe("canWithdraw", () => {
        it("should return true when sweep is COMPLETED", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.COMPLETED, type: LedgerType.DEPOSIT,
            });

            const result = await service.canWithdraw("le-1");
            expect(result).toBe(true);
        });

        it("should return true when sweep is NOT_APPLICABLE", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.NOT_APPLICABLE, type: LedgerType.DEPOSIT,
            });

            const result = await service.canWithdraw("le-1");
            expect(result).toBe(true);
        });

        it("should return false when sweep is PENDING", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT,
            });

            const result = await service.canWithdraw("le-1");
            expect(result).toBe(false);
        });

        it("should return false when sweep is IN_PROGRESS", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.IN_PROGRESS, type: LedgerType.DEPOSIT,
            });

            const result = await service.canWithdraw("le-1");
            expect(result).toBe(false);
        });
    });

    // ── hasPendingSweeps ─────────────────────────────────────

    describe("hasPendingSweeps", () => {
        it("should return true when user has pending sweeps for currency", async () => {
            prisma.user.findUnique.mockResolvedValue({ cryptoSubAccountId: "sub-1" });
            // stale entries check
            prisma.ledgerEntry.findMany.mockResolvedValue([]);
            // pending count
            prisma.ledgerEntry.count.mockResolvedValue(1);

            const result = await service.hasPendingSweeps(1, "BTC");
            expect(result).toBe(true);
        });

        it("should return false when no pending sweeps", async () => {
            prisma.user.findUnique.mockResolvedValue({ cryptoSubAccountId: "sub-1" });
            prisma.ledgerEntry.findMany.mockResolvedValue([]);
            prisma.ledgerEntry.count.mockResolvedValue(0);

            const result = await service.hasPendingSweeps(1, "BTC");
            expect(result).toBe(false);
        });
    });

    // ── getSweepStats ────────────────────────────────────────

    describe("getSweepStats", () => {
        it("should return counts grouped by sweep status", async () => {
            prisma.ledgerEntry.groupBy.mockResolvedValue([
                { sweepStatus: SweepStatus.PENDING, _count: 5 },
                { sweepStatus: SweepStatus.COMPLETED, _count: 100 },
            ]);

            const stats = await service.getSweepStats();

            expect(stats[SweepStatus.PENDING]).toBe(5);
            expect(stats[SweepStatus.COMPLETED]).toBe(100);
        });
    });
});
