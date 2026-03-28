import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {},
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { TransactionMonitorService } from "../transaction-monitor.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "../ledger.service";
import { ReconciliationService } from "../reconciliation.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        systemSetting: { findUnique: jest.fn() },
        cryptoRate: { findUnique: jest.fn() },
        reconciliationLog: { findMany: jest.fn() },
        user: { findUnique: jest.fn() },
    };
}

describe("TransactionMonitorService", () => {
    let service: TransactionMonitorService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: { getBalance: jest.Mock };
    let slackService: { sendSystemAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockLedger = { getBalance: jest.fn() };
        const mockRecon = {};
        const mockSlack = { sendSystemAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TransactionMonitorService,
                { provide: PrismaService, useValue: prisma },
                { provide: LedgerService, useValue: mockLedger },
                { provide: ReconciliationService, useValue: mockRecon },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(TransactionMonitorService);
        ledgerService = module.get(LedgerService);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── getThreshold ─────────────────────────────────────────

    describe("getThreshold", () => {
        it("should return configured threshold", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue({
                key: "transaction_monitor_threshold_usdt",
                value: { threshold: 10000 },
            });

            const threshold = await service.getThreshold();

            expect(threshold).toBe(10000);
        });

        it("should return default 5000 when no setting", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue(null);

            const threshold = await service.getThreshold();

            expect(threshold).toBe(5000);
        });
    });

    // ── isEnabled ────────────────────────────────────────────

    describe("isEnabled", () => {
        it("should return true when enabled", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue({
                key: "transaction_monitor_enabled",
                value: { enabled: true },
            });

            expect(await service.isEnabled()).toBe(true);
        });

        it("should return true by default when no setting", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue(null);

            expect(await service.isEnabled()).toBe(true);
        });

        it("should return false when disabled", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue({
                key: "transaction_monitor_enabled",
                value: { enabled: false },
            });

            expect(await service.isEnabled()).toBe(false);
        });
    });

    // ── getUsdtEquivalent ────────────────────────────────────

    describe("getUsdtEquivalent", () => {
        it("should return same amount for USDT", async () => {
            const result = await service.getUsdtEquivalent("USDT", new Decimal("1000"));

            expect(result.toString()).toBe("1000");
        });

        it("should convert via NGN rate", async () => {
            // BTC sell rate = 50,000,000 NGN, USDT sell rate = 1600 NGN
            // 0.1 BTC * 50M = 5M NGN / 1600 = 3125 USDT
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1600 });

            const result = await service.getUsdtEquivalent("BTC", new Decimal("0.1"));

            expect(result.toNumber()).toBe(3125);
        });

        it("should return high value when no rate found", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);

            const result = await service.getUsdtEquivalent("XYZ", new Decimal("1"));

            expect(result.toNumber()).toBeGreaterThan(5000);
        });
    });

    // ── exceedsThreshold ─────────────────────────────────────

    describe("exceedsThreshold", () => {
        it("should return true for high-value USDT transaction", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue(null); // default 5000

            const result = await service.exceedsThreshold("USDT", new Decimal("6000"));

            expect(result).toBe(true);
        });

        it("should return false for small USDT transaction", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue(null);

            const result = await service.exceedsThreshold("USDT", new Decimal("100"));

            expect(result).toBe(false);
        });
    });

    // ── validateBeforeExecution ──────────────────────────────

    describe("validateBeforeExecution", () => {
        it("should skip validation when monitoring disabled", async () => {
            prisma.systemSetting.findUnique.mockResolvedValue({
                value: { enabled: false },
            });

            const result = await service.validateBeforeExecution({
                userId: 1,
                currency: "BTC",
                amount: new Decimal("100"),
                operationType: "WITHDRAWAL",
            });

            expect(result.success).toBe(true);
            expect(result.blocked).toBe(false);
        });

        it("should skip detailed checks for small transactions", async () => {
            // enabled
            prisma.systemSetting.findUnique
                .mockResolvedValueOnce({ value: { enabled: true } })  // isEnabled
                .mockResolvedValueOnce(null);  // getThreshold (default 5000)

            const result = await service.validateBeforeExecution({
                userId: 1,
                currency: "USDT",
                amount: new Decimal("100"),
                operationType: "SELL",
            });

            expect(result.success).toBe(true);
            expect(result.checks.thresholdBreached).toBe(false);
        });

        it("should block when critical reconciliation discrepancy exists", async () => {
            // enabled + threshold
            prisma.systemSetting.findUnique
                .mockResolvedValueOnce({ value: { enabled: true } })
                .mockResolvedValueOnce(null); // default 5000

            // Balance sufficient
            ledgerService.getBalance.mockResolvedValue({
                available: new Decimal("10000"),
            });

            // Recent reconciliation with blocking discrepancy (>0.1%)
            prisma.reconciliationLog.findMany.mockResolvedValue([{
                currency: "USDT",
                discrepancyPct: new Decimal("0.5"),
                pausedWithdrawals: false,
                resolvedAt: null,
            }]);

            // User for alert
            prisma.user.findUnique.mockResolvedValue({ email: "user@test.com" });

            const result = await service.validateBeforeExecution({
                userId: 1,
                currency: "USDT",
                amount: new Decimal("6000"),
                operationType: "WITHDRAWAL",
            });

            expect(result.success).toBe(false);
            expect(result.blocked).toBe(true);
            expect(result.checks.blockingDiscrepancy).toBe(true);
        });

        it("should allow high-value transaction when all checks pass", async () => {
            prisma.systemSetting.findUnique
                .mockResolvedValueOnce({ value: { enabled: true } })
                .mockResolvedValueOnce(null);

            ledgerService.getBalance.mockResolvedValue({
                available: new Decimal("10000"),
            });

            // No discrepancy
            prisma.reconciliationLog.findMany.mockResolvedValue([{
                currency: "USDT",
                discrepancyPct: new Decimal("0.001"),
                pausedWithdrawals: false,
            }]);

            const result = await service.validateBeforeExecution({
                userId: 1,
                currency: "USDT",
                amount: new Decimal("6000"),
                operationType: "SELL",
            });

            expect(result.success).toBe(true);
            expect(result.blocked).toBe(false);
        });
    });

    // ── getStats ─────────────────────────────────────────────

    describe("getStats", () => {
        it("should return monitoring stats", async () => {
            prisma.systemSetting.findUnique
                .mockResolvedValueOnce({ value: { enabled: true } })
                .mockResolvedValueOnce({ value: { threshold: 10000 } });

            const stats = await service.getStats();

            expect(stats.enabled).toBe(true);
            expect(stats.thresholdUsdt).toBe(10000);
            expect(stats.recentBlockedCount).toBe(0);
        });
    });
});
