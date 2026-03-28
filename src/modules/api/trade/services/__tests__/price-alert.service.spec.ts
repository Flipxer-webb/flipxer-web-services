import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { PriceAlertService } from "../price-alert.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { QuidaxCacheService } from "@/modules/core/redisCache/services/quidax-cache.service";
import { PushNotificationService } from "@/modules/api/notification/services/push.notification.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";

function makePrisma() {
    return {
        priceAlert: {
            count: jest.fn(),
            create: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn(),
        },
        notificationPreferences: { findUnique: jest.fn() },
        notification: { create: jest.fn() },
    };
}

const mockUser = {
    id: 1,
    email: "test@flipxer.com",
    firstName: "Test",
    lastName: "User",
    notificationToken: "expo-push-token",
    createdAt: new Date(),
    updatedAt: new Date(),
} as any;

describe("PriceAlertService", () => {
    let service: PriceAlertService;
    let prisma: ReturnType<typeof makePrisma>;
    let quidaxCache: { getMarketTickers: jest.Mock };
    let pushService: { sendToDevice: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockQuidaxCache = { getMarketTickers: jest.fn() };
        const mockPush = { sendToDevice: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PriceAlertService,
                { provide: PrismaService, useValue: prisma },
                { provide: QuidaxCacheService, useValue: mockQuidaxCache },
                { provide: PushNotificationService, useValue: mockPush },
            ],
        }).compile();

        service = module.get(PriceAlertService);
        quidaxCache = module.get(QuidaxCacheService);
        pushService = module.get(PushNotificationService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── createAlert ──────────────────────────────────────────

    describe("createAlert", () => {
        it("should create a price alert", async () => {
            prisma.priceAlert.count.mockResolvedValue(0);
            const alert = { id: 1, currency: "BTC", targetPrice: 50000, direction: "ABOVE" };
            prisma.priceAlert.create.mockResolvedValue(alert);

            const result = await service.createAlert(mockUser, {
                currency: "btc",
                targetPrice: 50000,
                direction: "ABOVE",
            });

            expect(result.data).toEqual(alert);
            expect(prisma.priceAlert.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        userId: 1,
                        currency: "BTC",
                        targetPrice: 50000,
                    }),
                }),
            );
        });

        it("should throw when max alerts reached", async () => {
            prisma.priceAlert.count.mockResolvedValue(10);

            await expect(
                service.createAlert(mockUser, {
                    currency: "btc",
                    targetPrice: 50000,
                    direction: "ABOVE",
                }),
            ).rejects.toThrow(BadRequestException);
        });
    });

    // ── getUserAlerts ────────────────────────────────────────

    describe("getUserAlerts", () => {
        it("should return all alerts for user", async () => {
            const alerts = [{ id: 1 }, { id: 2 }];
            prisma.priceAlert.findMany.mockResolvedValue(alerts);

            const result = await service.getUserAlerts(mockUser);

            expect(result.data).toEqual(alerts);
            expect(prisma.priceAlert.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { userId: 1 },
                }),
            );
        });
    });

    // ── getAlert ─────────────────────────────────────────────

    describe("getAlert", () => {
        it("should return a specific alert", async () => {
            const alert = { id: 5, userId: 1, currency: "ETH" };
            prisma.priceAlert.findFirst.mockResolvedValue(alert);

            const result = await service.getAlert(mockUser, 5);

            expect(result.data).toEqual(alert);
        });

        it("should throw NotFoundException when alert not found", async () => {
            prisma.priceAlert.findFirst.mockResolvedValue(null);

            await expect(service.getAlert(mockUser, 999)).rejects.toThrow(NotFoundException);
        });
    });

    // ── updateAlert ──────────────────────────────────────────

    describe("updateAlert", () => {
        it("should update an alert", async () => {
            prisma.priceAlert.findFirst.mockResolvedValue({ id: 1 });
            const updated = { id: 1, targetPrice: 60000 };
            prisma.priceAlert.update.mockResolvedValue(updated);

            const result = await service.updateAlert(mockUser, 1, { targetPrice: 60000 });

            expect(result.data).toEqual(updated);
        });

        it("should throw NotFoundException when alert not found", async () => {
            prisma.priceAlert.findFirst.mockResolvedValue(null);

            await expect(
                service.updateAlert(mockUser, 999, { targetPrice: 60000 }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    // ── deleteAlert ──────────────────────────────────────────

    describe("deleteAlert", () => {
        it("should delete an alert", async () => {
            prisma.priceAlert.findFirst.mockResolvedValue({ id: 1 });
            prisma.priceAlert.delete.mockResolvedValue({ id: 1 });

            const result = await service.deleteAlert(mockUser, 1);

            expect(result.message).toContain("deleted");
            expect(prisma.priceAlert.delete).toHaveBeenCalledWith({ where: { id: 1 } });
        });

        it("should throw NotFoundException when alert not found", async () => {
            prisma.priceAlert.findFirst.mockResolvedValue(null);

            await expect(service.deleteAlert(mockUser, 999)).rejects.toThrow(NotFoundException);
        });
    });

    // ── checkPriceAlerts (cron) ──────────────────────────────

    describe("checkPriceAlerts", () => {
        it("should skip when no market data", async () => {
            quidaxCache.getMarketTickers.mockResolvedValue(null);

            await service.checkPriceAlerts();

            expect(prisma.priceAlert.findMany).not.toHaveBeenCalled();
        });

        it("should skip when no active alerts", async () => {
            quidaxCache.getMarketTickers.mockResolvedValue({ btcngn: { last: "50000" } });
            prisma.priceAlert.findMany.mockResolvedValue([]);

            await service.checkPriceAlerts();

            expect(prisma.priceAlert.update).not.toHaveBeenCalled();
        });

        it("should trigger alert when ABOVE threshold met", async () => {
            quidaxCache.getMarketTickers.mockResolvedValue({
                btcngn: { last: "55000000" },
            });
            prisma.priceAlert.findMany.mockResolvedValue([
                {
                    id: 1,
                    userId: 1,
                    currency: "BTC",
                    targetPrice: 50000000,
                    direction: "ABOVE",
                    user: mockUser,
                },
            ]);
            prisma.notificationPreferences.findUnique.mockResolvedValue(null);

            await service.checkPriceAlerts();

            expect(prisma.priceAlert.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: expect.objectContaining({ isActive: false }),
                }),
            );
            expect(prisma.notification.create).toHaveBeenCalled();
        });

        it("should trigger alert when BELOW threshold met", async () => {
            quidaxCache.getMarketTickers.mockResolvedValue({
                ethngn: { last: "2000000" },
            });
            prisma.priceAlert.findMany.mockResolvedValue([
                {
                    id: 2,
                    userId: 1,
                    currency: "ETH",
                    targetPrice: 3000000,
                    direction: "BELOW",
                    user: mockUser,
                },
            ]);
            prisma.notificationPreferences.findUnique.mockResolvedValue(null);

            await service.checkPriceAlerts();

            expect(prisma.priceAlert.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 2 },
                    data: expect.objectContaining({ isActive: false }),
                }),
            );
        });

        it("should not trigger when threshold not met", async () => {
            quidaxCache.getMarketTickers.mockResolvedValue({
                btcngn: { last: "40000000" },
            });
            prisma.priceAlert.findMany.mockResolvedValue([
                {
                    id: 3,
                    userId: 1,
                    currency: "BTC",
                    targetPrice: 50000000,
                    direction: "ABOVE",
                    user: mockUser,
                },
            ]);

            await service.checkPriceAlerts();

            expect(prisma.priceAlert.update).not.toHaveBeenCalled();
        });

        it("should skip push during quiet hours", async () => {
            // Set quiet hours that cover current time
            const now = new Date();
            const startHour = now.getHours();
            const endHour = (startHour + 2) % 24;

            quidaxCache.getMarketTickers.mockResolvedValue({
                btcngn: { last: "55000000" },
            });
            prisma.priceAlert.findMany.mockResolvedValue([
                {
                    id: 4,
                    userId: 1,
                    currency: "BTC",
                    targetPrice: 50000000,
                    direction: "ABOVE",
                    user: mockUser,
                },
            ]);
            prisma.notificationPreferences.findUnique.mockResolvedValue({
                quietHoursEnabled: true,
                quietHoursStart: `${String(startHour).padStart(2, "0")}:00`,
                quietHoursEnd: `${String(endHour).padStart(2, "0")}:00`,
                pushPriceAlerts: true,
            });

            await service.checkPriceAlerts();

            // Alert should still be marked triggered
            expect(prisma.priceAlert.update).toHaveBeenCalled();
            // But push should NOT be sent
            expect(pushService.sendToDevice).not.toHaveBeenCalled();
        });
    });

    // ── cleanupExpiredAlerts ─────────────────────────────────

    describe("cleanupExpiredAlerts", () => {
        it("should delete expired alerts", async () => {
            prisma.priceAlert.deleteMany.mockResolvedValue({ count: 5 });

            await service.cleanupExpiredAlerts();

            expect(prisma.priceAlert.deleteMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { expiresAt: { lt: expect.any(Date) } },
                }),
            );
        });
    });
});
