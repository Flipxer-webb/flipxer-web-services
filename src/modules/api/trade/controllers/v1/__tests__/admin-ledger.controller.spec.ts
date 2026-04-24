import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    CountryBlockGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    QuidaxWebhookGuard: class { isStub() { return true; } },
    FincraWebhookGuard: class { isStub() { return true; } },
    SocketAuthGuard: class { isStub() { return true; } },
    TransactionAmountGuard: class { isStub() { return true; } },
    TwoFactorGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/user/decorators", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    UserModule: class { readonly __stub = true; },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { AdminLedgerController } from "../admin-ledger.controller";
import { ReconciliationService } from "../../../services/ledger/reconciliation.service";
import { WithdrawalQueueService } from "../../../services/ledger/withdrawal-queue.service";
import { FloatConfigService } from "../../../services/ledger/float-config.service";
import { LedgerService } from "../../../services/ledger/ledger.service";
import { SweepService } from "../../../services/ledger/sweep.service";
import { OrphanedHoldService } from "../../../services/ledger/orphaned-hold.service";
import { DepositReviewService } from "../../../services/ledger/deposit-review.service";
import { SolvencyService } from "../../../services/ledger/solvency.service";
import { AuditLogService } from "@/modules/api/audit-log";

type MockFn = jest.Mock<any, any>;

describe("AdminLedgerController", () => {
    let controller: AdminLedgerController;
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };

    let reconciliationService: {
        getLatestReconciliations: MockFn;
        runReconciliation: MockFn;
        acknowledgeAndResume: MockFn;
    };

    let withdrawalQueueService: {
        getPendingQueue: MockFn;
        isProcessingPaused: MockFn;
        pauseProcessing: MockFn;
        resumeProcessing: MockFn;
        processTimeouts: MockFn;
        getAdminQueueStats: MockFn;
    };

    let floatConfigService: {
        getAllFloatConfigs: MockFn;
    };

    let ledgerService: {
        getBalance: MockFn;
        getAllBalances: MockFn;
        getHistory: MockFn;
        getAuditTrail: MockFn;
        getRecentAuditLogs: MockFn;
        backfillAuditLogs: MockFn;
    };

    let sweepService: {
        getPendingSweeps: MockFn;
        processPendingSweeps: MockFn;
        getSweepStats: MockFn;
        markNotApplicable: MockFn;
        retryFailedSweeps: MockFn;
    };

    let orphanedHoldService: {
        getPendingReviews: MockFn;
        getStats: MockFn;
        getReviewById: MockFn;
        resolveOrphanedHold: MockFn;
        detectOrphanedHolds: MockFn;
    };

    let depositReviewService: {
        getReviews: MockFn;
        approveDeposit: MockFn;
        rejectDeposit: MockFn;
        getStats: MockFn;
    };

    let solvencyService: {
        generateReport: MockFn;
        getHistory: MockFn;
        checkAndAlert: MockFn;
    };

    beforeEach(async () => {
        reconciliationService = {
            getLatestReconciliations: jest.fn(),
            runReconciliation: jest.fn(),
            acknowledgeAndResume: jest.fn(),
        };

        withdrawalQueueService = {
            getPendingQueue: jest.fn(),
            isProcessingPaused: jest.fn(),
            pauseProcessing: jest.fn(),
            resumeProcessing: jest.fn(),
            processTimeouts: jest.fn(),
            getAdminQueueStats: jest.fn(),
        };

        floatConfigService = {
            getAllFloatConfigs: jest.fn(),
        };

        ledgerService = {
            getBalance: jest.fn(),
            getAllBalances: jest.fn(),
            getHistory: jest.fn(),
            getAuditTrail: jest.fn(),
            getRecentAuditLogs: jest.fn(),
            backfillAuditLogs: jest.fn(),
        };

        sweepService = {
            getPendingSweeps: jest.fn(),
            processPendingSweeps: jest.fn(),
            getSweepStats: jest.fn(),
            markNotApplicable: jest.fn(),
            retryFailedSweeps: jest.fn(),
        };

        orphanedHoldService = {
            getPendingReviews: jest.fn(),
            getStats: jest.fn(),
            getReviewById: jest.fn(),
            resolveOrphanedHold: jest.fn(),
            detectOrphanedHolds: jest.fn(),
        };

        depositReviewService = {
            getReviews: jest.fn(),
            approveDeposit: jest.fn(),
            rejectDeposit: jest.fn(),
            getStats: jest.fn(),
        };

        solvencyService = {
            generateReport: jest.fn(),
            getHistory: jest.fn(),
            checkAndAlert: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminLedgerController],
            providers: [
                { provide: ReconciliationService, useValue: reconciliationService },
                { provide: WithdrawalQueueService, useValue: withdrawalQueueService },
                { provide: FloatConfigService, useValue: floatConfigService },
                { provide: LedgerService, useValue: ledgerService },
                { provide: SweepService, useValue: sweepService },
                { provide: OrphanedHoldService, useValue: orphanedHoldService },
                { provide: DepositReviewService, useValue: depositReviewService },
                { provide: SolvencyService, useValue: solvencyService },
                { provide: AuditLogService, useValue: mockAuditLogService },
            ],
        }).compile();

        controller = module.get(AdminLedgerController);
    });

    afterEach(() => jest.clearAllMocks());

    it("gets reconciliation status and manual run", async () => {
        reconciliationService.getLatestReconciliations.mockResolvedValue(
            new Map([
                ["BTC", { ok: true }],
                ["USDT", { ok: false }],
            ])
        );
        reconciliationService.runReconciliation.mockResolvedValue({ checked: 3 });

        const status = await controller.getReconciliationStatus();
        const run = await controller.runReconciliation({ id: 1 } as never);

        expect(status.message).toBe("Reconciliation status retrieved");
        expect(status.data).toEqual({ BTC: { ok: true }, USDT: { ok: false } });
        expect(run.data).toEqual({ checked: 3 });
    });

    it("acknowledges discrepancy with uppercased currency", async () => {
        await controller.acknowledgeDiscrepancy(
            { id: 9 } as any,
            { currency: "btc", reason: "validated" }
        );

        expect(reconciliationService.acknowledgeAndResume).toHaveBeenCalledWith("BTC", 9, "validated");
    });

    it("handles withdrawal queue endpoints", async () => {
        withdrawalQueueService.getPendingQueue.mockResolvedValue([{ id: "q1" }]);
        withdrawalQueueService.isProcessingPaused.mockResolvedValue(true);
        withdrawalQueueService.processTimeouts.mockResolvedValue(4);
        withdrawalQueueService.getAdminQueueStats.mockResolvedValue({ pending: 2 });

        const queue = await controller.getWithdrawalQueue("USDT");
        const pause = await controller.pauseWithdrawalQueue({ id: 1 } as never, { reason: "ops" });
        const resume = await controller.resumeWithdrawalQueue({ id: 1 } as never);
        const timeout = await controller.processWithdrawalQueueTimeouts();
        const stats = await controller.getWithdrawalQueueStats("USDT");

        expect(withdrawalQueueService.getPendingQueue).toHaveBeenCalledWith("USDT");
        expect(queue.data).toEqual({ items: [{ id: "q1" }], count: 1, isPaused: true });
        expect(pause.message).toBe("Withdrawal queue processing paused");
        expect(resume.message).toBe("Withdrawal queue processing resumed");
        expect(timeout.data.processedCount).toBe(4);
        expect(stats.data).toEqual({ pending: 2 });
    });

    it("gets float config", async () => {
        floatConfigService.getAllFloatConfigs.mockResolvedValue([{ currency: "BTC" }]);

        const result = await controller.getFloatConfig();

        expect(result.data).toEqual([{ currency: "BTC" }]);
    });

    it("handles user balances and history endpoints", async () => {
        const toNumber = (value: number) => ({ toNumber: () => value });

        ledgerService.getBalance.mockResolvedValue({ available: 10, held: 1, total: 11 });
        ledgerService.getAllBalances.mockResolvedValue(
            new Map([
                ["BTC", { available: toNumber(2), held: toNumber(1), total: toNumber(3) }],
            ])
        );
        ledgerService.getHistory.mockResolvedValue([{ id: "h1" }]);

        const one = await controller.getUserBalance(5, "btc");
        const many = await controller.getUserBalances(5);
        const historyWithDefault = await controller.getUserLedgerHistory(5, "usdt");
        const historyWithLimit = await controller.getUserLedgerHistory(5, "usdt", "25");

        expect(ledgerService.getBalance).toHaveBeenCalledWith(5, "BTC");
        expect(one.data.currency).toBe("BTC");
        expect(many.data).toEqual([
            { userId: 5, currency: "BTC", available: 2, held: 1, total: 3 },
        ]);
        expect(ledgerService.getHistory).toHaveBeenNthCalledWith(1, 5, "USDT", 100);
        expect(ledgerService.getHistory).toHaveBeenNthCalledWith(2, 5, "USDT", 25);
        expect(historyWithDefault.data.count).toBe(1);
        expect(historyWithLimit.data.entries).toEqual([{ id: "h1" }]);
    });

    it("handles sweep endpoints", async () => {
        sweepService.getPendingSweeps.mockResolvedValue([{ id: "s1" }]);
        sweepService.processPendingSweeps.mockResolvedValue(2);
        sweepService.getSweepStats.mockResolvedValue({ total: 7 });

        const pending = await controller.getPendingSweeps();
        const process = await controller.processPendingSweeps({ id: 1 } as never);
        const stats = await controller.getSweepStats();
        const resolve = await controller.resolveSweep("entry-1", { id: 17 } as any, "manual review");
        const retry = await controller.retryFailedSweeps({ id: 1 } as never);

        expect(pending.data.count).toBe(1);
        expect(process.data.processedCount).toBe(2);
        expect(stats.data).toEqual({ total: 7 });
        expect(sweepService.markNotApplicable).toHaveBeenCalledWith("entry-1", "manual review");
        expect(resolve.data.ledgerEntryId).toBe("entry-1");
        expect(retry.message).toBe("Failed sweep retry completed");
    });

    it("handles orphaned hold listing and detail branches", async () => {
        orphanedHoldService.getPendingReviews.mockResolvedValue([{ id: "o1" }]);
        orphanedHoldService.getStats.mockResolvedValue({ pending: 3 });
        orphanedHoldService.getReviewById
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "o2" });

        const list = await controller.getOrphanedHolds(1, 10);
        const missing = await controller.getOrphanedHoldById("unknown");
        const found = await controller.getOrphanedHoldById("o2");

        expect(list.data.count).toBe(1);
        expect(missing.message).toBe("Orphaned hold not found");
        expect(missing.data).toEqual({});
        expect(found.data).toEqual({ id: "o2" });
    });

    it("resolves orphaned holds for both failure and success", async () => {
        orphanedHoldService.resolveOrphanedHold
            .mockResolvedValueOnce({ success: false, error: "No record" })
            .mockResolvedValueOnce({ success: true });
        orphanedHoldService.detectOrphanedHolds.mockResolvedValue({ created: 2 });
        orphanedHoldService.getStats.mockResolvedValue({ pending: 0 });

        const fail = await controller.resolveOrphanedHold(
            { id: 4 } as any,
            "hold-1",
            { resolution: "RELEASED" as any, notes: "n" }
        );
        const pass = await controller.resolveOrphanedHold(
            { id: 4 } as any,
            "hold-1",
            { resolution: "RELEASED" as any }
        );
        const detect = await controller.detectOrphanedHolds();
        const stats = await controller.getOrphanedHoldStats();

        expect(fail.message).toBe("No record");
    expect(fail.data).toEqual({});
        expect(pass.message).toBe("Orphaned hold resolved successfully");
        expect(pass.data).toEqual({ resolution: "RELEASED" });
        expect(detect.data).toEqual({ created: 2 });
        expect(stats.data).toEqual({ pending: 0 });
    });

    it("handles audit endpoints", async () => {
        ledgerService.getAuditTrail.mockResolvedValue([{ id: "a1" }]);
        ledgerService.getRecentAuditLogs.mockResolvedValue({
            logs: [{ id: "a2" }],
            total: 11,
        });
        ledgerService.backfillAuditLogs.mockResolvedValue(77);

        const trail = await controller.getAuditTrail("entry-1");
        const recent = await controller.getRecentAuditLogs(2, 20, "UPDATE", "ops", "2026-01-01", "2026-01-31");
        const backfill = await controller.backfillAuditLogs({ limit: 500 });

        expect(trail.data).toEqual({ entryId: "entry-1", logs: [{ id: "a1" }], count: 1 });
        expect(ledgerService.getRecentAuditLogs).toHaveBeenCalledWith(
            2,
            20,
            "UPDATE",
            "ops",
            "2026-01-01",
            "2026-01-31"
        );
        expect(recent.data.count).toBe(11);
        expect(backfill.data.processedCount).toBe(77);
    });

    it("handles solvency endpoints", async () => {
        solvencyService.generateReport.mockResolvedValue({ healthy: true });
        solvencyService.getHistory.mockResolvedValue([{ at: "2026-01-01" }]);

        const report = await controller.getSolvencyReport();
        const history = await controller.getSolvencyHistory("btc", 14);
        const check = await controller.runSolvencyCheck();

        expect(report.data).toEqual({ healthy: true });
        expect(solvencyService.getHistory).toHaveBeenCalledWith("btc", 14);
        expect(history.data.currency).toBe("BTC");
        expect(history.data.count).toBe(1);
        expect(check.message).toBe("Solvency check completed");
    });

    it("handles deposit review endpoints", async () => {
        depositReviewService.getReviews.mockResolvedValue({ reviews: [{ id: "d1" }], count: 1 });
        depositReviewService.approveDeposit
            .mockResolvedValueOnce({ success: false, error: "Cannot approve" })
            .mockResolvedValueOnce({ success: true, entry: { id: "e1" } });
        depositReviewService.rejectDeposit
            .mockResolvedValueOnce({ success: false })
            .mockResolvedValueOnce({ success: true });
        depositReviewService.getStats.mockResolvedValue({ pending: 2 });

        const list = await controller.getDepositReviews(1, 10, "PENDING", "BTC");
        const approveFail = await controller.approveDeposit("d1", { id: 10 } as any, "note");
        const approvePass = await controller.approveDeposit("d2", { id: 10 } as any);
        const rejectFail = await controller.rejectDeposit("d3", { id: 10 } as any, "bad");
        const rejectPass = await controller.rejectDeposit("d4", { id: 10 } as any);
        const stats = await controller.getDepositReviewStats("PENDING", "USDT");

        expect(list.data.count).toBe(1);
        expect(approveFail.message).toBe("Cannot approve");
        expect(approvePass.message).toBe("Deposit approved successfully");
        expect(approvePass.data).toEqual({ id: "e1" });
        expect(rejectFail.message).toBe("Failed to reject deposit");
        expect(rejectFail.data).toEqual({});
        expect(rejectPass.message).toBe("Deposit rejected");
        expect(stats.data).toEqual({ pending: 2 });
    });
});
