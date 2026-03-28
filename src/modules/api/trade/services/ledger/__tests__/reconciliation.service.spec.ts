import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {},
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { ReconciliationService } from "../reconciliation.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { FloatConfigService } from "../float-config.service";
import { WithdrawalQueueService } from "../withdrawal-queue.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        ledgerEntry: { findMany: jest.fn() },
        reconciliationLog: {
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        $queryRaw: jest.fn(),
    };
}

describe("ReconciliationService", () => {
    let service: ReconciliationService;
    let prisma: ReturnType<typeof makePrisma>;
    let quidaxService: { getUserWallet: jest.Mock };
    let slackService: { sendAlert: jest.Mock };
    let withdrawalQueueService: { pauseProcessing: jest.Mock; resumeProcessing: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockQuidax = { getUserWallet: jest.fn() };
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };
        const mockFloatConfig = {};
        const mockWithdrawalQueue = {
            pauseProcessing: jest.fn().mockResolvedValue(undefined),
            resumeProcessing: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ReconciliationService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidax },
                { provide: SlackWebhookService, useValue: mockSlack },
                { provide: FloatConfigService, useValue: mockFloatConfig },
                { provide: WithdrawalQueueService, useValue: mockWithdrawalQueue },
            ],
        }).compile();

        service = module.get(ReconciliationService);
        quidaxService = module.get(TradingInjectionToken.QUIDAX);
        slackService = module.get(SlackWebhookService);
        withdrawalQueueService = module.get(WithdrawalQueueService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── reconcileCurrency ────────────────────────────────────

    describe("reconcileCurrency", () => {
        it("should return ok when balances match", async () => {
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValue({
                data: { balance: "100" },
            });

            const result = await service.reconcileCurrency("BTC");

            expect(result.currency).toBe("BTC");
            expect(result.ledgerTotal.toString()).toBe("100");
            expect(result.blockchainTotal.toString()).toBe("100");
            expect(result.discrepancy.toString()).toBe("0");
            expect(result.isWithinTolerance).toBe(true);
            expect(result.action).toBe("none");
        });

        it("should alert when discrepancy exceeds alert threshold (>0.01%)", async () => {
            // Ledger: 10000, Blockchain: 9998 → discrepancy 2, pct 0.02%
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("10000") }]);
            quidaxService.getUserWallet.mockResolvedValue({
                data: { balance: "9998" },
            });

            const result = await service.reconcileCurrency("BTC");

            expect(result.action).toBe("alert");
            expect(result.isWithinTolerance).toBe(false);
        });

        it("should pause when discrepancy exceeds pause threshold (>0.1%)", async () => {
            // Ledger: 10000, Blockchain: 9980 → discrepancy 20, pct 0.2%
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("10000") }]);
            quidaxService.getUserWallet.mockResolvedValue({
                data: { balance: "9980" },
            });

            const result = await service.reconcileCurrency("BTC");

            expect(result.action).toBe("pause");
        });

        it("should handle zero ledger total", async () => {
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("0") }]);
            quidaxService.getUserWallet.mockResolvedValue({
                data: { balance: "0" },
            });

            const result = await service.reconcileCurrency("BTC");

            expect(result.discrepancyPct.toString()).toBe("0");
            expect(result.action).toBe("none");
        });

        it("should handle missing wallet data", async () => {
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: null });

            const result = await service.reconcileCurrency("BTC");

            expect(result.blockchainTotal.toString()).toBe("0");
            expect(result.action).toBe("pause"); // 100% discrepancy
        });
    });

    // ── runReconciliation ────────────────────────────────────

    describe("runReconciliation", () => {
        it("should reconcile all active currencies", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([
                { currency: "BTC" },
                { currency: "ETH" },
            ]);
            // BTC - matching
            prisma.$queryRaw.mockResolvedValueOnce([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValueOnce({ data: { balance: "100" } });
            prisma.reconciliationLog.create.mockResolvedValueOnce({});
            // ETH - matching
            prisma.$queryRaw.mockResolvedValueOnce([{ total: new Decimal("200") }]);
            quidaxService.getUserWallet.mockResolvedValueOnce({ data: { balance: "200" } });
            prisma.reconciliationLog.create.mockResolvedValueOnce({});

            const report = await service.runReconciliation();

            expect(report.results).toHaveLength(2);
            expect(report.overallStatus).toBe("ok");
            expect(report.pausedQueues).toEqual([]);
        });

        it("should pause queue and alert on critical discrepancy", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            // Big discrepancy
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("10000") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "9000" } });
            prisma.reconciliationLog.create.mockResolvedValue({});

            const report = await service.runReconciliation();

            expect(report.overallStatus).toBe("critical");
            expect(report.pausedQueues).toContain("BTC");
            expect(withdrawalQueueService.pauseProcessing).toHaveBeenCalled();
            expect(slackService.sendAlert).toHaveBeenCalled();
        });

        it("should handle errors for individual currencies", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            prisma.$queryRaw.mockRejectedValue(new Error("DB error"));

            const report = await service.runReconciliation();

            expect(report.results).toHaveLength(1);
            expect(report.results[0].action).toBe("alert");
        });
    });

    // ── getRecentLogs ────────────────────────────────────────

    describe("getRecentLogs", () => {
        it("should return logs from last 24h by default", async () => {
            const logs = [{ id: "log-1", currency: "BTC" }];
            prisma.reconciliationLog.findMany.mockResolvedValue(logs);

            const result = await service.getRecentLogs();

            expect(result).toEqual(logs);
            expect(prisma.reconciliationLog.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        createdAt: expect.any(Object),
                    }),
                    orderBy: { createdAt: "desc" },
                }),
            );
        });

        it("should filter by currency", async () => {
            prisma.reconciliationLog.findMany.mockResolvedValue([]);

            await service.getRecentLogs(12, "ETH");

            expect(prisma.reconciliationLog.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        currency: "ETH",
                    }),
                }),
            );
        });
    });

    // ── getLatestReconciliations ─────────────────────────────

    describe("getLatestReconciliations", () => {
        it("should return latest reconciliation per currency", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([
                { currency: "BTC" },
                { currency: "ETH" },
            ]);
            prisma.reconciliationLog.findFirst
                .mockResolvedValueOnce({ currency: "BTC", discrepancy: "0" })
                .mockResolvedValueOnce({ currency: "ETH", discrepancy: "1" });

            const result = await service.getLatestReconciliations();

            expect(result.size).toBe(2);
            expect(result.get("BTC")).toBeDefined();
            expect(result.get("ETH")).toBeDefined();
        });
    });

    // ── acknowledgeAndResume ─────────────────────────────────

    describe("acknowledgeAndResume", () => {
        it("should resume processing and send slack notification", async () => {
            await service.acknowledgeAndResume("BTC", 99, "Verified manually");

            expect(withdrawalQueueService.resumeProcessing).toHaveBeenCalled();
            expect(slackService.sendAlert).toHaveBeenCalledWith(
                "RECONCILIATION_ACKNOWLEDGED",
                expect.objectContaining({ text: expect.stringContaining("Admin 99") }),
                expect.any(Object),
            );
        });
    });
});
