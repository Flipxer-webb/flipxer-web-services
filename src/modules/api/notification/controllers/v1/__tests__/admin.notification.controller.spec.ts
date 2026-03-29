jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {
        readonly __stub = true;
    },
    CountryBlockGuard: class {
        readonly __stub = true;
    },
    SocketAuthGuard: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    UserModule: class {
        readonly __stub = true;
    },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

jest.mock("@/modules/api/auth", () => ({
    AuthModule: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

import { AdminNotificationController } from "../admin.notification.controller";

describe("AdminNotificationController", () => {
    let controller: AdminNotificationController;
    let adminNotificationService: {
        getNotificationStats: jest.Mock;
        broadcastNotification: jest.Mock;
        createNotification: jest.Mock;
        getNotification: jest.Mock;
        getNotifications: jest.Mock;
        updateNotificationStatus: jest.Mock;
        deleteNotification: jest.Mock;
    };

    beforeEach(() => {
        adminNotificationService = {
            getNotificationStats: jest.fn(),
            broadcastNotification: jest.fn(),
            createNotification: jest.fn(),
            getNotification: jest.fn(),
            getNotifications: jest.fn(),
            updateNotificationStatus: jest.fn(),
            deleteNotification: jest.fn(),
        };

        controller = new AdminNotificationController(adminNotificationService as never);
    });

    it("delegates stats and list endpoints", async () => {
        adminNotificationService.getNotificationStats.mockResolvedValue({ total: 3 });
        adminNotificationService.getNotifications.mockResolvedValue({ records: [] });

        await expect(controller.getNotificationStats()).resolves.toEqual({ total: 3 });
        await expect(controller.getNotifications({ pageNumber: 1 } as never)).resolves.toEqual({ records: [] });
    });

    it("delegates create and broadcast endpoints", async () => {
        const createDto = { title: "Notice" };
        const broadcastDto = { title: "System update", targetAudience: "all" };
        adminNotificationService.createNotification.mockResolvedValue({ id: 10 });
        adminNotificationService.broadcastNotification.mockResolvedValue({ recipientCount: 1 });

        await expect(controller.createNotification(createDto as never)).resolves.toEqual({ id: 10 });
        await expect(controller.broadcastNotification(broadcastDto as never)).resolves.toEqual({ recipientCount: 1 });
    });

    it("delegates detail, status update, and delete", async () => {
        const param = { notificationId: 55 };
        adminNotificationService.getNotification.mockResolvedValue({ id: 55 });
        adminNotificationService.updateNotificationStatus.mockResolvedValue({ ok: true });
        adminNotificationService.deleteNotification.mockResolvedValue({ deleted: true });

        await expect(controller.getNotification(param as never)).resolves.toEqual({ id: 55 });
        await expect(
            controller.updateNotificationStatus(param as never, { status: "APPROVED" } as never),
        ).resolves.toEqual({ ok: true });
        await expect(controller.deleteNotification(param as never)).resolves.toEqual({ deleted: true });

        expect(adminNotificationService.updateNotificationStatus).toHaveBeenCalledWith(55, "APPROVED");
        expect(adminNotificationService.deleteNotification).toHaveBeenCalledWith(55);
    });
});