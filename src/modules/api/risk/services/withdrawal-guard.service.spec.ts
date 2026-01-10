import { Test, TestingModule } from "@nestjs/testing";
import { WithdrawalGuardService } from "./withdrawal-guard.service";
import { PrismaService } from "../../../../core/prisma/services";
import { VolatilityMonitorService } from "./volatility-monitor.service";
import { LiveCoinWatchService } from "../../../factory/trading/providers/livecoinwatch/services";
import { Logger } from "@nestjs/common";

describe("WithdrawalGuardService", () => {
    let service: WithdrawalGuardService;
    let prisma: any;
    let volatilityService: Partial<VolatilityMonitorService>;
    let lcwService: Partial<LiveCoinWatchService>;

    beforeEach(async () => {
        prisma = {
            order: {
                findMany: jest.fn(),
            },
        };
        volatilityService = {
            isVolatile: jest.fn().mockResolvedValue({ isVolatile: false }),
        };
        lcwService = {
            getBatchPrices: jest.fn().mockResolvedValue({ "btc": 50000 }), // $50k per BTC
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WithdrawalGuardService,
                { provide: PrismaService, useValue: prisma },
                { provide: VolatilityMonitorService, useValue: volatilityService },
                { provide: LiveCoinWatchService, useValue: lcwService },
            ],
        }).compile();

        service = module.get<WithdrawalGuardService>(WithdrawalGuardService);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => { });
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("checkWithdrawalRisk", () => {
        it("should block if asset is volatile", async () => {
            (volatilityService.isVolatile as jest.Mock).mockResolvedValue({ isVolatile: true, reason: "Dump" });
            const result = await service.checkWithdrawalRisk(1, "BTC", 0.1);
            expect(result.safe).toBe(false);
            expect(result.reason).toContain("volatile");
        });

        it("should block if user exceeds daily limit ($10k)", async () => {
            // Mock past orders sum >= 10k
            // Mock prisma.order.findMany returning orders worth > 10k
            // getBatchPrices returns 50000.
            // If user has 0.2 BTC withdrawn previously = 10k.
            (prisma.order.findMany as jest.Mock).mockResolvedValueOnce([
                { currency: "BTC", amount: 0.2 } // $10,000
            ]);
            // Global check mock (empty)
            (prisma.order.findMany as jest.Mock).mockResolvedValueOnce([]);

            // Try to withdraw another 0.01 BTC ($500)
            const result = await service.checkWithdrawalRisk(1, "BTC", 0.01);
            expect(result.safe).toBe(false);
            expect(result.reason).toContain("daily withdrawal limit");
        });

        it("should block if global hourly limit exceeds $50k", async () => {
            // User check passes
            (prisma.order.findMany as jest.Mock).mockResolvedValueOnce([]);

            // Global check returns > 50k
            (prisma.order.findMany as jest.Mock).mockResolvedValueOnce([
                { currency: "BTC", amount: 1.1 } // $55,000
            ]);

            const result = await service.checkWithdrawalRisk(1, "BTC", 0.01);
            expect(result.safe).toBe(false);
            expect(result.reason).toContain("Platform temporary safety limit");
        });

        it("should allow if all checks pass", async () => {
            (prisma.order.findMany as jest.Mock).mockResolvedValue([]);
            const result = await service.checkWithdrawalRisk(1, "BTC", 0.1); // $5000
            expect(result.safe).toBe(true);
        });
    });
});
