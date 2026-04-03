import { HttpStatus } from "@nestjs/common";
import {
    NotificationBeneficiary,
    NotificationStatus,
    NotificationType,
    UserType,
} from "@prisma/client";

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: jest.fn(),
    __esModule: true,
}));

import { AdminNotificationService } from "../admin.notification.service";
import { NotificationNotFoundException } from "../../errors/notification.error";

describe("AdminNotificationService", () => {
    const prisma = {
        notification: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            createMany: jest.fn(),
            count: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        auditLog: {
            create: jest.fn(),
        },
        user: {
            findMany: jest.fn(),
        },
    };

    const notificationEvent = {
        emit: jest.fn(),
    };

    const pushNotificationService = {
        sendToUsers: jest.fn(),
        sendToMultipleDevices: jest.fn(),
        sendToUser: jest.fn(),
    };

    const wsGateway = {
        notifyUser: jest.fn(),
    };

    let service: AdminNotificationService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new AdminNotificationService(
            prisma as any,
            notificationEvent as any,
            pushNotificationService as any,
            wsGateway as any
        );
    });

    it("returns notification by id", async () => {
        prisma.notification.findUnique.mockResolvedValue({ id: 11, title: "Welcome" });

        const result = await service.getNotification(11);

        expect(prisma.notification.findUnique).toHaveBeenCalledWith({
            where: { id: 11 },
        });
        expect(result.message).toBe("Notification successfully retrieved");
        expect(result.data.id).toBe(11);
    });

    it("throws when getNotification cannot find item", async () => {
        prisma.notification.findUnique.mockResolvedValue(null);

        await expect(service.getNotification(1000)).rejects.toBeInstanceOf(
            NotificationNotFoundException
        );
    });

    it("returns merged, sorted, and paginated notifications", async () => {
        prisma.notification.findMany
            .mockResolvedValueOnce([
                {
                    id: 1,
                    title: "Broadcast",
                    body: "For all users",
                    type: NotificationType.PUSH_NOTIFICATION,
                    beneficiary: NotificationBeneficiary.ALL,
                    isRead: false,
                    status: NotificationStatus.APPROVED,
                    createdAt: new Date("2025-09-01T10:00:00.000Z"),
                    updatedAt: new Date("2025-09-01T10:00:00.000Z"),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 2,
                    title: "Direct",
                    body: "For one user",
                    type: NotificationType.PUSH_NOTIFICATION,
                    beneficiary: NotificationBeneficiary.INDIVIDUAL,
                    isRead: false,
                    receiver: { firstName: "Jane", lastName: "Doe" },
                    status: NotificationStatus.APPROVED,
                    createdAt: new Date("2025-09-02T10:00:00.000Z"),
                    updatedAt: new Date("2025-09-02T10:00:00.000Z"),
                },
            ]);

        const result = await service.getNotifications({
            pageNumber: 1,
            pageSize: 1,
            sortBy: "desc",
            paginated: "true",
            searchText: "user",
        } as any);

        expect(prisma.notification.findMany).toHaveBeenCalledTimes(2);
        expect(result.message).toBe("notifications successfully retrieved");
        expect(result.data.records).toHaveLength(1);
        expect(result.data.records[0].id).toBe(2);
        expect(result.data.meta.totalCount).toBe(2);
    });

    it("creates a notification and writes audit log", async () => {
        prisma.notification.create.mockResolvedValue({ id: 9, title: "System Notice" });

        const result = await service.createNotification(
            {
                title: "System Notice",
                body: "Body",
                type: "PUSH_NOTIFICATION",
                beneficiary: "INDIVIDUAL",
                userId: 44,
            } as any,
            7
        );

        expect(prisma.notification.create).toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    adminId: 7,
                    action: "CREATE_NOTIFICATION",
                }),
            })
        );
        expect(result.message).toBe("Notification created successfully");
    });

    it("broadcasts to all non-admin users, notifies websockets, and sends push", async () => {
        prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
        prisma.notification.createMany.mockResolvedValue({ count: 2 });
        prisma.notification.findMany.mockResolvedValue([
            {
                id: 100,
                title: "Promo",
                body: "Body",
            },
        ]);
        pushNotificationService.sendToUsers.mockResolvedValue({
            successCount: 2,
            failureCount: 0,
            failedTokens: [],
        });

        const result = await service.broadcastNotification(
            {
                title: "Promo",
                body: "Body",
                type: "PUSH_NOTIFICATION",
                targetAudience: "all",
            } as any,
            10
        );

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: { userType: { not: UserType.ADMIN } },
            select: { id: true },
        });
        expect(prisma.notification.createMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.any(Array) })
        );
        expect(wsGateway.notifyUser).toHaveBeenCalledTimes(2);
        expect(pushNotificationService.sendToUsers).toHaveBeenCalledWith(
            [1, 2],
            expect.objectContaining({
                title: "Promo",
                body: "Body",
            })
        );
        expect(result.data.recipientCount).toBe(2);
        expect(result.data.pushNotificationsSent).toBe(2);
    });

    it("skips push for non-push broadcast types", async () => {
        prisma.user.findMany.mockResolvedValueOnce([{ id: 5 }]);
        prisma.notification.createMany.mockResolvedValue({ count: 1 });
        prisma.notification.findMany.mockResolvedValue([{ id: 22 }]);

        const result = await service.broadcastNotification(
            {
                title: "Email only",
                body: "Body",
                type: "EMAIL",
                targetAudience: "business",
            } as any,
            3
        );

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: { userType: UserType.BUSINESS },
            select: { id: true },
        });
        expect(pushNotificationService.sendToUsers).not.toHaveBeenCalled();
        expect(result.data.recipientCount).toBe(1);
    });

    it("computes notification stats using grouped counts", async () => {
        prisma.notification.count
            .mockResolvedValueOnce(100)
            .mockResolvedValueOnce(20)
            .mockResolvedValueOnce(60)
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(11);

        const result = await service.getNotificationStats();

        expect(prisma.notification.count).toHaveBeenCalledTimes(5);
        expect(result.message).toBe("Notification stats retrieved");
        expect(result.data).toEqual({
            total: 100,
            pending: 20,
            approved: 60,
            declined: 5,
            sentToday: 11,
        });
    });

    it("throws when updateNotificationStatus target does not exist", async () => {
        prisma.notification.findUnique.mockResolvedValue(null);

        await expect(
            service.updateNotificationStatus(999, NotificationStatus.APPROVED, 1)
        ).rejects.toBeInstanceOf(NotificationNotFoundException);
    });

    it("approves ALL push notification and sends to token holders", async () => {
        prisma.notification.findUnique.mockResolvedValue({
            id: 50,
            title: "All Users",
            body: "Broadcast",
            status: NotificationStatus.PENDING,
            beneficiary: NotificationBeneficiary.ALL,
            type: NotificationType.PUSH_NOTIFICATION,
            userId: null,
        });
        prisma.notification.update.mockResolvedValue({ id: 50, status: NotificationStatus.APPROVED });
        prisma.user.findMany.mockResolvedValue([
            { id: 1, notificationToken: "token-1" },
            { id: 2, notificationToken: "token-2" },
        ]);
        pushNotificationService.sendToMultipleDevices.mockResolvedValue({
            successCount: 2,
            failureCount: 0,
            failedTokens: [],
        });

        const result = await service.updateNotificationStatus(
            50,
            NotificationStatus.APPROVED,
            99
        );

        expect(pushNotificationService.sendToMultipleDevices).toHaveBeenCalledWith(
            ["token-1", "token-2"],
            expect.objectContaining({
                title: "All Users",
                body: "Broadcast",
            })
        );
        expect(prisma.auditLog.create).toHaveBeenCalled();
        expect(result.message).toBe("Notification status updated");
    });

    it("approves INDIVIDUAL push notification and sends to one user", async () => {
        prisma.notification.findUnique.mockResolvedValue({
            id: 70,
            title: "One User",
            body: "Body",
            status: NotificationStatus.PENDING,
            beneficiary: NotificationBeneficiary.INDIVIDUAL,
            type: NotificationType.PUSH_NOTIFICATION,
            userId: 44,
        });
        prisma.notification.update.mockResolvedValue({ id: 70, status: NotificationStatus.APPROVED });
        pushNotificationService.sendToUser.mockResolvedValue(true);

        await service.updateNotificationStatus(70, NotificationStatus.APPROVED, 21);

        expect(pushNotificationService.sendToUser).toHaveBeenCalledWith(
            44,
            expect.objectContaining({
                title: "One User",
                body: "Body",
            })
        );
    });

    it("updates status without push side effects for non-approved states", async () => {
        prisma.notification.findUnique.mockResolvedValue({
            id: 71,
            title: "Later",
            body: "Body",
            status: NotificationStatus.PENDING,
            beneficiary: NotificationBeneficiary.INDIVIDUAL,
            type: NotificationType.PUSH_NOTIFICATION,
            userId: 45,
        });
        prisma.notification.update.mockResolvedValue({ id: 71, status: NotificationStatus.DECLINED });

        const result = await service.updateNotificationStatus(
            71,
            NotificationStatus.DECLINED,
            33
        );

        expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
        expect(pushNotificationService.sendToMultipleDevices).not.toHaveBeenCalled();
        expect(result.message).toBe("Notification status updated");
    });

    it("deletes notification and writes delete audit", async () => {
        prisma.notification.delete.mockResolvedValue({ id: 5 });

        const result = await service.deleteNotification(5, 99);

        expect(prisma.notification.delete).toHaveBeenCalledWith({
            where: { id: 5 },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    adminId: 99,
                    action: "DELETE_NOTIFICATION",
                }),
            })
        );
        expect(result.message).toBe("Notification deleted successfully");
    });

    it("creates NotificationNotFoundException with expected status", async () => {
        prisma.notification.findUnique.mockResolvedValue(null);

        try {
            await service.getNotification(404);
        } catch (error: any) {
            expect(error).toBeInstanceOf(NotificationNotFoundException);
            expect(error.status).toBe(HttpStatus.NOT_FOUND);
        }
    });
});