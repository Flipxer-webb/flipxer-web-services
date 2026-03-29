jest.mock("../../events/notification.event", () => ({
    NotificationEvent: jest.fn(),
    __esModule: true,
}));

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: jest.fn(),
    __esModule: true,
}));

import { NotificationDispatcher } from "../notification-dispatcher.service";

describe("NotificationDispatcher", () => {
    const prisma = {
        notificationPreferences: {
            findUnique: jest.fn(),
        },
        $transaction: jest.fn(),
    };

    const wsGateway = {
        notifyUser: jest.fn(),
        notifyTransactionUpdate: jest.fn(),
        notifyWalletUpdate: jest.fn(),
    };

    const notificationEvent = {
        emit: jest.fn(),
    };

    const pushNotificationService = {
        sendToUser: jest.fn(),
    };

    let service: NotificationDispatcher;

    const setupTransaction = () => {
        const created = {
            id: 1,
            title: "Order Filled",
            body: "Your order was completed",
            userId: 15,
        };
        const list = [created];
        const create = jest.fn().mockResolvedValue(created);
        const findMany = jest.fn().mockResolvedValue(list);

        prisma.$transaction.mockImplementation(async (handler: any) =>
            handler({
                notification: {
                    create,
                    findMany,
                },
            })
        );

        return { create, findMany, created, list };
    };

    beforeEach(() => {
        jest.clearAllMocks();
        service = new NotificationDispatcher(
            prisma as any,
            wsGateway as any,
            notificationEvent as any,
            pushNotificationService as any
        );
        prisma.notificationPreferences.findUnique.mockResolvedValue(null);
        setupTransaction();
    });

    it("maps category to deep-link url", () => {
        expect((service as any).getCategoryUrl("transaction")).toBe("/transactions");
        expect((service as any).getCategoryUrl("security")).toBe("/security");
        expect((service as any).getCategoryUrl("price_alert")).toBe("/price-alerts");
        expect((service as any).getCategoryUrl("marketing")).toBe("/dashboard");
    });

    it("respects push preference toggles", () => {
        const prefs = { pushMarketing: false, pushTransactions: true };

        expect((service as any).shouldSendPush(prefs, "marketing")).toBe(false);
        expect((service as any).shouldSendPush(prefs, "transaction")).toBe(true);
        expect((service as any).shouldSendPush(null, "security")).toBe(true);
    });

    it("sends websocket, email, and push when enabled", async () => {
        pushNotificationService.sendToUser.mockResolvedValue(true);

        await service.notify({
            userId: 15,
            title: "Order Update",
            body: "Order is complete",
            category: "transaction",
            transactionType: "BUY" as any,
            currency: "BTC",
            enableEmail: true,
            emailPayload: {
                email: "user@flipxer.com",
                transactionType: "buy",
                transactionId: "trx-1",
                amount: "10",
                currency: "BTC",
                status: "SUCCESS",
                date: new Date().toISOString(),
            },
            enablePush: true,
        });

        expect(wsGateway.notifyUser).toHaveBeenCalledTimes(1);
        expect(notificationEvent.emit).toHaveBeenCalledWith(
            "transaction_notification",
            expect.objectContaining({ notice: "Order is complete" })
        );
        expect(pushNotificationService.sendToUser).toHaveBeenCalledWith(
            15,
            expect.objectContaining({
                title: "Order Update",
                body: "Order is complete",
                data: expect.objectContaining({
                    category: "transaction",
                    url: "/transactions",
                }),
            })
        );
    });

    it("suppresses email and push during quiet hours for non-security category", async () => {
        prisma.notificationPreferences.findUnique.mockResolvedValue({
            quietHoursEnabled: true,
            quietHoursStart: "00:00",
            quietHoursEnd: "23:59",
            emailTransactions: true,
            pushTransactions: true,
        });

        await service.notify({
            userId: 88,
            title: "Trade Update",
            body: "Quiet-hours test",
            category: "transaction",
            enableEmail: true,
            emailPayload: {
                email: "user@flipxer.com",
                transactionType: "buy",
                transactionId: "trx-quiet",
                amount: "1",
                currency: "USDT",
                status: "SUCCESS",
                date: new Date().toISOString(),
            },
            enablePush: true,
        });

        expect(wsGateway.notifyUser).toHaveBeenCalledTimes(1);
        expect(notificationEvent.emit).not.toHaveBeenCalled();
        expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
    });

    it("allows security notifications during quiet hours", async () => {
        prisma.notificationPreferences.findUnique.mockResolvedValue({
            quietHoursEnabled: true,
            quietHoursStart: "00:00",
            quietHoursEnd: "23:59",
            emailSecurityAlerts: true,
            pushSecurityAlerts: true,
        });

        await service.notify({
            userId: 99,
            title: "Security Alert",
            body: "New login detected",
            category: "security",
            enableEmail: true,
            emailPayload: {
                email: "user@flipxer.com",
                transactionType: "buy",
                transactionId: "sec-1",
                amount: "0",
                currency: "N/A",
                status: "INFO",
                date: new Date().toISOString(),
            },
            enablePush: true,
        });

        expect(notificationEvent.emit).toHaveBeenCalledTimes(1);
        expect(pushNotificationService.sendToUser).toHaveBeenCalledTimes(1);
    });

    it("does not throw when websocket notification fails", async () => {
        wsGateway.notifyUser.mockImplementation(() => {
            throw new Error("socket down");
        });

        await expect(
            service.notify({
                userId: 20,
                title: "ws fail",
                body: "still continue",
            })
        ).resolves.toBeUndefined();
    });

    it("does not throw when preference lookup fails", async () => {
        prisma.notificationPreferences.findUnique.mockRejectedValue(new Error("db unavailable"));

        await expect(
            service.notify({
                userId: 30,
                title: "safe failure",
                body: "service should swallow errors",
            })
        ).resolves.toBeUndefined();
    });

    it("swallows websocket transaction update errors", () => {
        wsGateway.notifyTransactionUpdate.mockImplementation(() => {
            throw new Error("ws tx fail");
        });

        expect(() =>
            service.notifyTransactionUpdate(1, {
                id: 1,
                transactionId: "trx-99",
                status: "SUCCESS",
                streamlinedStatus: "COMPLETED",
                orderCategory: "BUY" as any,
                amount: 42,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            })
        ).not.toThrow();
    });

    it("swallows websocket wallet update errors", () => {
        wsGateway.notifyWalletUpdate.mockImplementation(() => {
            throw new Error("ws wallet fail");
        });

        expect(() => service.notifyWalletUpdate(1)).not.toThrow();
    });
});