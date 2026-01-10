import { Test, TestingModule } from "@nestjs/testing";
import { VolatilityMonitorService } from "./volatility-monitor.service";
import { LiveCoinWatchService } from "../../../factory/trading/providers/livecoinwatch/services";
import { RedisCacheService } from "../../../../core/redisCache/services";
import { Logger } from "@nestjs/common";

describe("VolatilityMonitorService", () => {
    let service: VolatilityMonitorService;
    let lcwService: Partial<LiveCoinWatchService>;
    let cacheService: Partial<RedisCacheService>;

    beforeEach(async () => {
        lcwService = {
            getBatchMarketData: jest.fn(),
        };
        cacheService = {
            set: jest.fn(),
            get: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                VolatilityMonitorService,
                { provide: LiveCoinWatchService, useValue: lcwService },
                { provide: RedisCacheService, useValue: cacheService },
            ],
        }).compile();

        service = module.get<VolatilityMonitorService>(VolatilityMonitorService);
        // Mock Logger to avoid clutter
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => { });
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => { });
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => { });
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("isVolatile", () => {
        it("should return false if asset is not cached as volatile", async () => {
            (cacheService.get as jest.Mock).mockResolvedValue(null);
            const result = await service.isVolatile("BTC");
            expect(result.isVolatile).toBe(false);
        });

        it("should return true if asset is cached as volatile", async () => {
            (cacheService.get as jest.Mock).mockResolvedValue({ isVolatile: true, reason: "Testing" });
            const result = await service.isVolatile("BTC");
            expect(result.isVolatile).toBe(true);
            expect(result.reason).toBe("Testing");
        });
    });

    describe("checkVolatility (internal)", () => {
        // Since checkVolatility is private and called by Cron, we can test it if we expose it or just test logic via a public wrapper.
        // But for this MVP, monitoring via Cron is hard to unit test without triggering it.
        // We trust the logic if we could test `checkVolatility`.
        // Alternatively, we can cast to any to call private method.

        it("should flag asset as volatile if drop > 5%", async () => {
            (lcwService.getBatchMarketData as jest.Mock).mockResolvedValue([
                { code: "BTC", delta: { hour: 0.94 } }, // -6% change (0.94 means 6% drop? No, delta is usually factor or percent?)
                // Wait, logic in service: if (data.delta.hour < (1 - THRESHOLD/100))
                // THRESHOLD = 5. So check < 0.95.
            ]);

            // Call private method
            await (service as any).checkVolatility();

            // Expect cache set for BTC
            expect(cacheService.set).toHaveBeenCalledWith(
                "volatile_asset_BTC",
                expect.objectContaining({ isVolatile: true }),
                expect.any(Number)
            );
        });

        it("should not flag asset if drop < 5%", async () => {
            (lcwService.getBatchMarketData as jest.Mock).mockResolvedValue([
                { code: "BTC", delta: { hour: 0.98 } }, // -2%
            ]);

            await (service as any).checkVolatility();
            expect(cacheService.set).not.toHaveBeenCalled();
        });
    });
});
