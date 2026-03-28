import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {},
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { SolvencyService } from "../solvency.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        ledgerEntry: { findMany: jest.fn() },
        withdrawalQueue: { aggregate: jest.fn() },
        solvencyLog: { create: jest.fn(), findMany: jest.fn() },
        $queryRaw: jest.fn(),
    };
}

describe("SolvencyService", () => {
    let service: SolvencyService;
    let prisma: ReturnType<typeof makePrisma>;
    let quidaxService: { getUserWallet: jest.Mock };
    let slackService: { sendSystemAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockQuidax = { getUserWallet: jest.fn() };
        const mockSlack = { sendSystemAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SolvencyService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidax },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(SolvencyService);
        quidaxService = module.get(TradingInjectionToken.QUIDAX);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── generateReport ───────────────────────────────────────

    describe("generateReport", () => {
        it("should generate healthy report when fully backed", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            // User liabilities: 100 BTC
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            // Platform reserves: 110 BTC (110% ratio)
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "110" } });
            // Pending withdrawals: 0
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _sum: { amount: null } });
            prisma.solvencyLog.create.mockResolvedValue({});

            const report = await service.generateReport();

            expect(report.overallStatus).toBe("HEALTHY");
            expect(report.currencies).toHaveLength(1);
            expect(report.currencies[0].reserveRatio).toBe(110);
            expect(report.currencies[0].status).toBe("HEALTHY");
        });

        it("should report WARNING when undercollateralized", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            // Liabilities: 100, Reserves: 75 → 75%
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "75" } });
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _sum: { amount: null } });
            prisma.solvencyLog.create.mockResolvedValue({});

            const report = await service.generateReport();

            expect(report.overallStatus).toBe("WARNING");
            expect(report.currencies[0].status).toBe("WARNING");
        });

        it("should report CRITICAL when severely undercollateralized", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            // Liabilities: 100, Reserves: 20 → 20%
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "20" } });
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _sum: { amount: null } });
            prisma.solvencyLog.create.mockResolvedValue({});

            const report = await service.generateReport();

            expect(report.overallStatus).toBe("CRITICAL");
        });

        it("should handle zero liabilities as HEALTHY", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("0") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "10" } });
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _sum: { amount: null } });
            prisma.solvencyLog.create.mockResolvedValue({});

            const report = await service.generateReport();

            expect(report.currencies[0].reserveRatio).toBe(100);
            expect(report.currencies[0].status).toBe("HEALTHY");
        });

        it("should handle errors for individual currencies", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            prisma.$queryRaw.mockRejectedValue(new Error("DB error"));

            const report = await service.generateReport();

            expect(report.currencies[0].status).toBe("CRITICAL");
        });

        it("should include pending withdrawals in effective ratio", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            // Liabilities: 100, Reserves: 100 (100% ratio)
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "100" } });
            // Pending withdrawals: 50 → effective ratio = 100 / (100 + 50) * 100 = 66.67%
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _sum: { amount: new Decimal("50") } });
            prisma.solvencyLog.create.mockResolvedValue({});

            const report = await service.generateReport();

            expect(report.currencies[0].reserveRatio).toBe(100);
            expect(report.currencies[0].effectiveReserveRatio).toBeCloseTo(66.67, 1);
        });
    });

    // ── getHistory ───────────────────────────────────────────

    describe("getHistory", () => {
        it("should return solvency history", async () => {
            const snapshots = [{
                id: "s1",
                createdAt: new Date(),
                currency: "BTC",
                userLiabilities: new Decimal("100"),
                platformReserves: new Decimal("110"),
                reserveRatio: new Decimal("110"),
                status: "HEALTHY",
            }];
            prisma.solvencyLog.findMany.mockResolvedValue(snapshots);

            const result = await service.getHistory("BTC", 7);

            expect(result).toHaveLength(1);
            expect(result[0].currency).toBe("BTC");
            expect(result[0].reserveRatio).toBe(110);
        });
    });

    // ── checkAndAlert ────────────────────────────────────────

    describe("checkAndAlert", () => {
        it("should send alerts for unhealthy currencies", async () => {
            prisma.ledgerEntry.findMany.mockResolvedValue([{ currency: "BTC" }]);
            // 40% ratio → WARNING
            prisma.$queryRaw.mockResolvedValue([{ total: new Decimal("100") }]);
            quidaxService.getUserWallet.mockResolvedValue({ data: { balance: "40" } });
            prisma.withdrawalQueue.aggregate.mockResolvedValue({ _sum: { amount: null } });
            prisma.solvencyLog.create.mockResolvedValue({});

            await service.checkAndAlert();

            expect(slackService.sendSystemAlert).toHaveBeenCalled();
        });
    });
});
