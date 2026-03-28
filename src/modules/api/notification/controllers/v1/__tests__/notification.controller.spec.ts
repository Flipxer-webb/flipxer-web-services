import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {},
    CountryBlockGuard: class {},
    EnabledAccountGuard: class {},
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { NotificationController } from "../notification.controller";
import { NotificationService } from "../../../services/notification.service";

describe("NotificationController", () => {
    let controller: NotificationController;
    let notificationService: {
        getNotifications: jest.Mock;
        markAllUserNotificationsRead: jest.Mock;
        markNotificationAsRead: jest.Mock;
        toggleNotificationReadStatus: jest.Mock;
        deleteUserNotification: jest.Mock;
    };

    const user = { id: 15, email: "notify@flipxer.com" } as any;

    beforeEach(async () => {
        notificationService = {
            getNotifications: jest.fn(),
            markAllUserNotificationsRead: jest.fn(),
            markNotificationAsRead: jest.fn(),
            toggleNotificationReadStatus: jest.fn(),
            deleteUserNotification: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [NotificationController],
            providers: [
                { provide: NotificationService, useValue: notificationService },
            ],
        }).compile();

        controller = module.get(NotificationController);
    });

    afterEach(() => jest.clearAllMocks());

    it("should fetch notifications", async () => {
        const dto = { page: 1, limit: 20 } as any;
        notificationService.getNotifications.mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] });

        const result = await controller.getNotifications(user, dto);

        expect(notificationService.getNotifications).toHaveBeenCalledWith(user, dto);
        expect(result.data).toHaveLength(2);
    });

    it("should mark all notifications as read", async () => {
        notificationService.markAllUserNotificationsRead.mockResolvedValue({ message: "ok" });

        const result = await controller.markAllUserNotificationsRead(user);

        expect(notificationService.markAllUserNotificationsRead).toHaveBeenCalledWith(user);
        expect(result.message).toBe("ok");
    });

    it("should mark a notification as read", async () => {
        notificationService.markNotificationAsRead.mockResolvedValue({ message: "read" });

        const result = await controller.markNotificationAsRead(user, 3);

        expect(notificationService.markNotificationAsRead).toHaveBeenCalledWith(3, 15);
        expect(result.message).toBe("read");
    });

    it("should toggle notification status", async () => {
        notificationService.toggleNotificationReadStatus.mockResolvedValue({ message: "toggled" });

        const result = await controller.toggleNotificationReadStatus(user, 4);

        expect(notificationService.toggleNotificationReadStatus).toHaveBeenCalledWith(4, 15);
        expect(result.message).toBe("toggled");
    });

    it("should delete a notification", async () => {
        notificationService.deleteUserNotification.mockResolvedValue({ message: "deleted" });

        const result = await controller.deleteUserNotification(user, 5);

        expect(notificationService.deleteUserNotification).toHaveBeenCalledWith(5, 15);
        expect(result.message).toBe("deleted");
    });
});