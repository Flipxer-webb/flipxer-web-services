import type { User } from "@prisma/client";
import { PreferencesService } from "../preferences.service";

describe("PreferencesService", () => {
    let service: PreferencesService;
    let prisma: {
        userPreferences: {
            findUnique: jest.Mock;
            create: jest.Mock;
            upsert: jest.Mock;
            update: jest.Mock;
        };
        notificationPreferences: {
            findUnique: jest.Mock;
            create: jest.Mock;
            upsert: jest.Mock;
        };
    };

    const user: User = {
        id: 7,
        email: "user@example.com",
    } as User;

    beforeEach(() => {
        prisma = {
            userPreferences: {
                findUnique: jest.fn(),
                create: jest.fn(),
                upsert: jest.fn(),
                update: jest.fn(),
            },
            notificationPreferences: {
                findUnique: jest.fn(),
                create: jest.fn(),
                upsert: jest.fn(),
            },
        };

        service = new PreferencesService(prisma as any);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should return existing user preferences", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue({ userId: user.id, theme: "dark" });

        const response = await service.getUserPreferences(user);

        expect(response.success).toBe(true);
        expect(response.message).toBe("Preferences retrieved");
        expect(response.data).toEqual({ userId: user.id, theme: "dark" });
        expect(prisma.userPreferences.create).not.toHaveBeenCalled();
    });

    it("should auto-create user preferences when missing", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue(null);
        prisma.userPreferences.create.mockResolvedValue({ userId: user.id, theme: "system" });

        const response = await service.getUserPreferences(user);

        expect(prisma.userPreferences.create).toHaveBeenCalledWith({ data: { userId: user.id } });
        expect(response.data).toEqual({ userId: user.id, theme: "system" });
    });

    it("should update user preferences", async () => {
        prisma.userPreferences.upsert.mockResolvedValue({ userId: user.id, hideZeroBalances: true });

        const response = await service.updateUserPreferences(user, { hideZeroBalances: true });

        expect(prisma.userPreferences.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: user.id },
                create: expect.objectContaining({ userId: user.id, hideZeroBalances: true }),
                update: { hideZeroBalances: true },
            }),
        );
        expect(response.message).toBe("Preferences updated");
    });

    it("should auto-create notification preferences when missing", async () => {
        prisma.notificationPreferences.findUnique.mockResolvedValue(null);
        prisma.notificationPreferences.create.mockResolvedValue({ userId: user.id, emailTransactions: true });

        const response = await service.getNotificationPreferences(user);

        expect(prisma.notificationPreferences.create).toHaveBeenCalledWith({ data: { userId: user.id } });
        expect(response.message).toBe("Notification preferences retrieved");
    });

    it("should update notification preferences", async () => {
        prisma.notificationPreferences.upsert.mockResolvedValue({ userId: user.id, pushTransactions: false });

        const response = await service.updateNotificationPreferences(user, { pushTransactions: false });

        expect(prisma.notificationPreferences.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: user.id },
                create: expect.objectContaining({ userId: user.id, pushTransactions: false }),
                update: { pushTransactions: false },
            }),
        );
        expect(response.message).toBe("Notification preferences updated");
    });

    it("should add favorite asset when not present", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue({ userId: user.id, favoriteAssets: ["BTC"] });
        prisma.userPreferences.upsert.mockResolvedValue({ userId: user.id, favoriteAssets: ["BTC", "ETH"] });

        const response = await service.toggleFavoriteAsset(user, "eth");

        expect(prisma.userPreferences.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: { favoriteAssets: ["BTC", "ETH"] },
            }),
        );
        expect(response.message).toBe("ETH added to favorites");
    });

    it("should remove favorite asset when present", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue({ userId: user.id, favoriteAssets: ["BTC", "ETH"] });
        prisma.userPreferences.upsert.mockResolvedValue({ userId: user.id, favoriteAssets: ["BTC"] });

        const response = await service.toggleFavoriteAsset(user, "ETH");

        expect(prisma.userPreferences.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: { favoriteAssets: ["BTC"] },
            }),
        );
        expect(response.message).toBe("ETH removed from favorites");
    });

    it("should track quick action usage and increment counters safely", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue({
            userId: user.id,
            quickActionUsage: {
                buy: 2,
                sell: "x",
                swap: 0,
                send: null,
                receive: 1,
            },
        });
        prisma.userPreferences.upsert.mockResolvedValue({ userId: user.id });

        await service.trackQuickActionUsage(user.id, "sell");

        expect(prisma.userPreferences.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: {
                    quickActionUsage: {
                        buy: 2,
                        sell: 1,
                        swap: 0,
                        send: 0,
                        receive: 1,
                    },
                },
            }),
        );
    });

    it("should swallow tracking errors", async () => {
        prisma.userPreferences.findUnique.mockRejectedValue(new Error("db error"));

        await expect(service.trackQuickActionUsage(user.id, "buy")).resolves.toBeUndefined();
        expect((service as any).logger.error).toHaveBeenCalled();
    });

    it("should return custom quick action order when configured", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue({
            userId: user.id,
            quickActionOrder: ["swap", "buy", "sell"],
        });

        const response = await service.getSortedQuickActions(user);

        expect(response.data).toEqual({
            actions: ["swap", "buy", "sell"],
            isCustomOrder: true,
        });
    });

    it("should sort quick actions by usage when no custom order exists", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue({
            userId: user.id,
            quickActionUsage: { buy: 1, sell: 8, swap: 3, send: 0, receive: 2 },
            quickActionOrder: [],
        });

        const response = await service.getSortedQuickActions(user);

        expect(response.data).toEqual({
            actions: ["sell", "swap", "receive", "buy", "send"],
            isCustomOrder: false,
            usage: { buy: 1, sell: 8, swap: 3, send: 0, receive: 2 },
        });
    });

    it("should set quick action order with invalid actions filtered out", async () => {
        prisma.userPreferences.upsert.mockResolvedValue({ userId: user.id, quickActionOrder: ["buy", "send"] });

        const response = await service.setQuickActionOrder(user, ["buy", "hack", "send"]);

        expect(prisma.userPreferences.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: { quickActionOrder: ["buy", "send"] },
            }),
        );
        expect(response.message).toBe("Quick action order updated");
    });

    it("should reset quick action order", async () => {
        prisma.userPreferences.update.mockResolvedValue({ userId: user.id, quickActionOrder: [] });

        const response = await service.resetQuickActionOrder(user);

        expect(prisma.userPreferences.update).toHaveBeenCalledWith({
            where: { userId: user.id },
            data: { quickActionOrder: [] },
        });
        expect(response.message).toBe("Quick action order reset to auto-sort");
    });

    it("should return both preference payloads for sync", async () => {
        prisma.userPreferences.findUnique.mockResolvedValue(null);
        prisma.notificationPreferences.findUnique.mockResolvedValue({ userId: user.id, pushTransactions: true });

        const sync = await service.getAllPreferencesForSync(user.id);

        expect(sync).toEqual({
            preferences: null,
            notificationPreferences: { userId: user.id, pushTransactions: true },
        });
    });
});
