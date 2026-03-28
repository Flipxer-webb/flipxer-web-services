import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { FloatConfigService } from "../float-config.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

function makePrisma() {
    return {
        floatConfig: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn(),
        },
    };
}

describe("FloatConfigService", () => {
    let service: FloatConfigService;
    let prisma: ReturnType<typeof makePrisma>;
    let slackService: { sendAlert: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FloatConfigService,
                { provide: PrismaService, useValue: prisma },
                { provide: SlackWebhookService, useValue: mockSlack },
            ],
        }).compile();

        service = module.get(FloatConfigService);
        slackService = module.get(SlackWebhookService);
    });

    afterEach(() => {
        jest.clearAllMocks();
        service.clearCache();
    });

    // ── getConfig ────────────────────────────────────────────

    describe("getConfig", () => {
        it("should return existing config from database", async () => {
            const config = {
                currency: "BTC",
                floatAllowance: new Decimal("1"),
                alertThreshold: new Decimal("80"),
                isActive: true,
            };
            prisma.floatConfig.findUnique.mockResolvedValue(config);

            const result = await service.getConfig("BTC");

            expect(result).toEqual(config);
        });

        it("should create default config if none exists", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue(null);
            const defaultConfig = {
                currency: "BTC",
                floatAllowance: new Decimal("1"),
                alertThreshold: new Decimal("80"),
                isActive: true,
            };
            prisma.floatConfig.create.mockResolvedValue(defaultConfig);

            const result = await service.getConfig("BTC");

            expect(result).toEqual(defaultConfig);
            expect(prisma.floatConfig.create).toHaveBeenCalled();
        });

        it("should use cache on second call", async () => {
            const config = { currency: "BTC", floatAllowance: new Decimal("1") };
            prisma.floatConfig.findUnique.mockResolvedValue(config);

            await service.getConfig("BTC");
            await service.getConfig("BTC");

            // Only one DB call
            expect(prisma.floatConfig.findUnique).toHaveBeenCalledTimes(1);
        });

        it("should uppercase currency", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue({
                currency: "BTC",
                floatAllowance: new Decimal("1"),
            });

            await service.getConfig("btc");

            expect(prisma.floatConfig.findUnique).toHaveBeenCalledWith({
                where: { currency: "BTC" },
            });
        });
    });

    // ── updateConfig ─────────────────────────────────────────

    describe("updateConfig", () => {
        it("should upsert config and invalidate cache", async () => {
            const updated = {
                currency: "BTC",
                floatAllowance: new Decimal("2"),
                alertThreshold: new Decimal("90"),
                isActive: true,
            };
            prisma.floatConfig.upsert.mockResolvedValue(updated);

            const result = await service.updateConfig("btc", {
                floatAllowance: 2,
                alertThreshold: 90,
            });

            expect(result).toEqual(updated);
            expect(prisma.floatConfig.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { currency: "BTC" },
                }),
            );
        });
    });

    // ── checkFloatStatus ─────────────────────────────────────

    describe("checkFloatStatus", () => {
        it("should return status below threshold without alert", async () => {
            const config = {
                currency: "BTC",
                floatAllowance: new Decimal("100"),
                alertThreshold: new Decimal("80"),
                isActive: true,
            };
            prisma.floatConfig.findUnique.mockResolvedValue(config);

            const status = await service.checkFloatStatus("BTC", new Decimal("50"));

            expect(status.usagePercent).toBe(50);
            expect(status.isOverThreshold).toBe(false);
            expect(slackService.sendAlert).not.toHaveBeenCalled();
        });

        it("should send alert when over threshold", async () => {
            const config = {
                currency: "BTC",
                floatAllowance: new Decimal("100"),
                alertThreshold: new Decimal("80"),
                isActive: true,
            };
            prisma.floatConfig.findUnique.mockResolvedValue(config);

            const status = await service.checkFloatStatus("BTC", new Decimal("90"));

            expect(status.usagePercent).toBe(90);
            expect(status.isOverThreshold).toBe(true);
            expect(slackService.sendAlert).toHaveBeenCalled();
        });

        it("should not alert when config is inactive", async () => {
            const config = {
                currency: "BTC",
                floatAllowance: new Decimal("100"),
                alertThreshold: new Decimal("80"),
                isActive: false,
            };
            prisma.floatConfig.findUnique.mockResolvedValue(config);

            await service.checkFloatStatus("BTC", new Decimal("90"));

            expect(slackService.sendAlert).not.toHaveBeenCalled();
        });

        it("should handle zero float allowance", async () => {
            const config = {
                currency: "BTC",
                floatAllowance: new Decimal("0"),
                alertThreshold: new Decimal("80"),
                isActive: true,
            };
            prisma.floatConfig.findUnique.mockResolvedValue(config);

            const status = await service.checkFloatStatus("BTC", new Decimal("10"));

            expect(status.usagePercent).toBe(100);
        });
    });

    // ── getAllFloatConfigs ────────────────────────────────────

    describe("getAllFloatConfigs", () => {
        it("should return all active configs", async () => {
            const configs = [
                { currency: "BTC", isActive: true },
                { currency: "ETH", isActive: true },
            ];
            prisma.floatConfig.findMany.mockResolvedValue(configs);

            const result = await service.getAllFloatConfigs();

            expect(result).toHaveLength(2);
        });
    });

    // ── calculateFloat ───────────────────────────────────────

    describe("calculateFloat", () => {
        it("should calculate float as ledger minus blockchain", () => {
            const result = service.calculateFloat(
                new Decimal("1000"),
                new Decimal("900"),
            );

            expect(result.toString()).toBe("100");
        });

        it("should return negative when blockchain exceeds ledger", () => {
            const result = service.calculateFloat(
                new Decimal("900"),
                new Decimal("1000"),
            );

            expect(result.toString()).toBe("-100");
        });
    });

    // ── clearCache ───────────────────────────────────────────

    describe("clearCache", () => {
        it("should force re-fetch after cache clear", async () => {
            prisma.floatConfig.findUnique.mockResolvedValue({
                currency: "BTC",
                floatAllowance: new Decimal("1"),
            });

            await service.getConfig("BTC");
            service.clearCache();
            await service.getConfig("BTC");

            expect(prisma.floatConfig.findUnique).toHaveBeenCalledTimes(2);
        });
    });
});
