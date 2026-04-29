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

        it("should sweep newly configured XRP deposits instead of treating them as unknown currency", async () => {
            prisma.ledgerEntry.findUnique
                .mockResolvedValueOnce({ ...entry, currency: "XRP", credit: new Decimal("5") })
                .mockResolvedValueOnce({ sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT })
                .mockResolvedValue({ ...entry, currency: "XRP", credit: new Decimal("5") });
            prisma.ledgerEntry.update.mockResolvedValue(entry);
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);
            quidaxService.createWithdrawerRequest.mockResolvedValue({
                data: { id: "quidax-tx-xrp-1" },
            });

            const result = await service.initiateSweep("le-1");

            expect(result).toEqual(
                expect.objectContaining({
                    success: true,
                    ledgerEntryId: "le-1",
                    transactionId: "quidax-tx-xrp-1",
                }),
            );
            expect(quidaxService.createWithdrawerRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    currency: "xrp",
                    amount: "5",
                }),
            );
        });

        it.each([
            { currency: "ADA", amount: "5" },
            { currency: "DOGE", amount: "5" },
            { currency: "LTC", amount: "0.5" },
            { currency: "SHIB", amount: "1000" },
        ])(
            "should sweep newly configured $currency deposits instead of treating them as unknown currency",
            async ({ currency, amount }) => {
                prisma.ledgerEntry.findUnique
                    .mockResolvedValueOnce({ ...entry, currency, credit: new Decimal(amount) })
                    .mockResolvedValueOnce({ sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT })
                    .mockResolvedValue({ ...entry, currency, credit: new Decimal(amount) });
                prisma.ledgerEntry.update.mockResolvedValue(entry);
                ledgerService.updateSweepStatus.mockResolvedValue(undefined);
                quidaxService.createWithdrawerRequest.mockResolvedValue({
                    data: { id: `quidax-tx-${currency.toLowerCase()}-1` },
                });

                const result = await service.initiateSweep("le-1");

                expect(result).toEqual(
                    expect.objectContaining({
                        success: true,
                        ledgerEntryId: "le-1",
                        transactionId: `quidax-tx-${currency.toLowerCase()}-1`,
                    }),
                );
                expect(quidaxService.createWithdrawerRequest).toHaveBeenCalledWith(
                    expect.objectContaining({
                        currency: currency.toLowerCase(),
                        amount,
                    }),
                );
            },
        );

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

        it("should throw when failSweep transition is invalid", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                id: "le-1", sweepStatus: SweepStatus.COMPLETED, type: LedgerType.DEPOSIT,
            });

            await expect(service.failSweep("le-1", "late fail")).rejects.toThrow(
                "Invalid sweep transition",
            );
        });
    });

    // ── handleSweepConfirmation ─────────────────────────────

    describe("handleSweepConfirmation", () => {
        it("should ignore unknown sweep transaction IDs", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);

            await expect(
                service.handleSweepConfirmation("unknown-tx", "completed"),
            ).resolves.toBeUndefined();

            expect(ledgerService.updateSweepStatus).not.toHaveBeenCalled();
        });

        it("should skip terminal sweep entries", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue({
                id: "le-1",
                sweepStatus: SweepStatus.COMPLETED,
                userId: 1,
                currency: "BTC",
            });

            await expect(
                service.handleSweepConfirmation("quidax-tx-1", "failed", "late webhook"),
            ).resolves.toBeUndefined();

            expect(ledgerService.updateSweepStatus).not.toHaveBeenCalled();
        });

        it("should mark IN_PROGRESS sweep as COMPLETED", async () => {
            prisma.ledgerEntry.findFirst.mockResolvedValue({
                id: "le-1",
                sweepStatus: SweepStatus.IN_PROGRESS,
                userId: 1,
                currency: "BTC",
            });
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.IN_PROGRESS,
                type: LedgerType.DEPOSIT,
            });
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            await service.handleSweepConfirmation("quidax-tx-1", "completed");

            expect(ledgerService.updateSweepStatus).toHaveBeenCalledWith(
                "le-1",
                SweepStatus.COMPLETED,
            );
        });
    });

    // ── processPendingSweeps ────────────────────────────────

    describe("processPendingSweeps", () => {
        it("should return 0 when another pod holds the job lock", async () => {
            lockService.withLock.mockRejectedValueOnce(new Error("Failed to acquire lock"));

            const result = await service.processPendingSweeps();

            expect(result).toBe(0);
        });

        it("should process pending sweeps and count successful initiations", async () => {
            jest.spyOn(service, "getPendingSweeps").mockResolvedValue([
                { ledgerEntryId: "le-1" } as any,
                { ledgerEntryId: "le-2" } as any,
            ]);
            jest.spyOn(service, "initiateSweep")
                .mockResolvedValueOnce({ success: true, ledgerEntryId: "le-1" })
                .mockResolvedValueOnce({ success: false, ledgerEntryId: "le-2", error: "boom" });

            const result = await service.processPendingSweeps();

            expect(result).toBe(1);
            expect(service.initiateSweep).toHaveBeenCalledTimes(2);
        });
    });

    // ── retryFailedSweeps ───────────────────────────────────

    describe("retryFailedSweeps", () => {
        it("should return 0 when retry job lock is already held", async () => {
            lockService.withLock.mockRejectedValueOnce(new Error("Failed to acquire lock"));

            const result = await service.retryFailedSweeps();

            expect(result).toBe(0);
        });

        it("should delegate to inner retry implementation under lock", async () => {
            jest
                .spyOn(service as any, "_retryFailedSweepsInner")
                .mockResolvedValueOnce(2);

            const result = await service.retryFailedSweeps(5);

            expect(result).toBe(2);
            expect(lockService.withLock).toHaveBeenCalledWith(
                "job:sweep:retry_failed",
                expect.any(Function),
                expect.objectContaining({ ttlMs: 120000, maxWaitMs: 0, strict: false }),
            );
        });
    });

    // ── executeSweep edge cases ─────────────────────────────

    describe("executeSweep edge cases", () => {
        const baseEntry = {
            id: "le-unknown",
            userId: 1,
            currency: "XYZ",
            credit: new Decimal("1"),
            sweepStatus: SweepStatus.PENDING,
            user: { id: 1, cryptoSubAccountId: "sub-1" },
        };

        it("should mark unknown currencies as failed without rethrowing a transition error", async () => {
            prisma.ledgerEntry.findUnique
                .mockResolvedValueOnce(baseEntry)
                .mockResolvedValueOnce({ sweepStatus: SweepStatus.PENDING, type: LedgerType.DEPOSIT });
            prisma.ledgerEntry.update.mockResolvedValue(baseEntry);
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            const result = await service.initiateSweep("le-unknown");

            expect(result).toEqual(
                expect.objectContaining({
                    success: false,
                    ledgerEntryId: "le-unknown",
                    error: "No minimum sweep amount configured for XYZ",
                }),
            );
            expect(ledgerService.updateSweepStatus).toHaveBeenCalledWith(
                "le-unknown",
                SweepStatus.FAILED,
            );
            expect(quidaxService.createWithdrawerRequest).not.toHaveBeenCalled();
        });
    });

    // ── canWithdraw ──────────────────────────────────────────

    describe("canWithdraw", () => {
        it("should return true when entry is missing", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue(null);

            const result = await service.canWithdraw("le-missing");
            expect(result).toBe(true);
        });

        it("should return true when entry is not a deposit", async () => {
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.PENDING,
                type: LedgerType.WITHDRAWAL,
            });

            const result = await service.canWithdraw("le-1");
            expect(result).toBe(true);
        });

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

        it("should auto-fail stale pending sweeps for sub-account users", async () => {
            prisma.user.findUnique.mockResolvedValue({ cryptoSubAccountId: "sub-1" });
            prisma.ledgerEntry.findMany.mockResolvedValue([
                { id: "stale-1", sweepStatus: SweepStatus.PENDING },
            ]);
            prisma.ledgerEntry.findUnique.mockResolvedValue({
                sweepStatus: SweepStatus.PENDING,
                type: LedgerType.DEPOSIT,
            });
            prisma.ledgerEntry.count.mockResolvedValue(0);
            ledgerService.updateSweepStatus.mockResolvedValue(undefined);

            const result = await service.hasPendingSweeps(1, "BTC");

            expect(result).toBe(false);
            expect(ledgerService.updateSweepStatus).toHaveBeenCalledWith(
                "stale-1",
                SweepStatus.FAILED,
            );
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
