import { NotificationService } from "../notification.service";
import { NotificationNotFoundException } from "../../errors/notification.error";

describe("NotificationService", () => {
    const prisma = {
        notification: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            count: jest.fn(),
            findMany: jest.fn(),
            delete: jest.fn(),
        },
    };

    let service: NotificationService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new NotificationService(prisma as any);
    });

    it("returns a single notification by id", async () => {
        prisma.notification.findUnique.mockResolvedValue({ id: 1, title: "Hello" });

        const result = await service.getNotification(1);

        expect(prisma.notification.findUnique).toHaveBeenCalledWith({
            where: { id: 1 },
        });
        expect(result.message).toBe("Notification successfully retrieved");
        expect(result.data.id).toBe(1);
    });

    it("throws when notification does not exist", async () => {
        prisma.notification.findUnique.mockResolvedValue(null);

        await expect(service.getNotification(42)).rejects.toBeInstanceOf(
            NotificationNotFoundException
        );
    });

    it("toggles read status for owned notification", async () => {
        prisma.notification.findFirst.mockResolvedValue({ id: 2, userId: 9, isRead: false });
        prisma.notification.update.mockResolvedValue({ id: 2, userId: 9, isRead: true });

        const result = await service.toggleNotificationReadStatus(2, 9);

        expect(prisma.notification.findFirst).toHaveBeenCalledWith({
            where: { id: 2, userId: 9 },
        });
        expect(prisma.notification.update).toHaveBeenCalledWith({
            where: { id: 2 },
            data: { isRead: true },
        });
        expect(result.message).toBe("Notification read status updated");
    });

    it("marks all unread notifications for a user as read", async () => {
        prisma.notification.updateMany.mockResolvedValue({ count: 3 });

        const result = await service.markAllUserNotificationsRead({ id: 77 } as any);

        expect(prisma.notification.updateMany).toHaveBeenCalledWith({
            where: { userId: 77, isRead: false },
            data: { isRead: true },
        });
        expect(result.message).toBe("User Notifications marked as read");
        expect(result.data.count).toBe(3);
    });

    it("returns early when notification is already read", async () => {
        prisma.notification.findFirst.mockResolvedValue({ id: 3, userId: 9, isRead: true });

        const result = await service.markNotificationAsRead(3, 9);

        expect(prisma.notification.update).not.toHaveBeenCalled();
        expect(result.message).toBe("Notification already read");
    });

    it("updates unread notification to read", async () => {
        prisma.notification.findFirst.mockResolvedValue({ id: 4, userId: 9, isRead: false });
        prisma.notification.update.mockResolvedValue({ id: 4, userId: 9, isRead: true });

        const result = await service.markNotificationAsRead(4, 9);

        expect(prisma.notification.update).toHaveBeenCalledWith({
            where: { id: 4 },
            data: { isRead: true },
        });
        expect(result.message).toBe("Notification marked as read");
    });

    it("throws when mark-as-read target is missing", async () => {
        prisma.notification.findFirst.mockResolvedValue(null);

        await expect(service.markNotificationAsRead(404, 9)).rejects.toBeInstanceOf(
            NotificationNotFoundException
        );
    });

    it("builds paginated notification query with search and category", async () => {
        prisma.notification.count.mockResolvedValue(5);
        prisma.notification.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

        const result = await service.getNotifications(
            { id: 11 } as any,
            {
                pageNumber: 2,
                pageSize: 2,
                sortBy: "desc",
                paginated: "true",
                searchText: "btc",
                category: "transaction",
            } as any
        );

        expect(prisma.notification.count).toHaveBeenCalledWith({
            where: expect.objectContaining({
                userId: 11,
                status: "APPROVED",
                category: "transaction",
                AND: [
                    {
                        OR: [
                            { title: { contains: "btc", mode: "insensitive" } },
                            { body: { contains: "btc", mode: "insensitive" } },
                        ],
                    },
                ],
            }),
        });
        expect(prisma.notification.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 2,
                take: 2,
            })
        );
        expect(result.message).toBe("Notifications retrieved successfully");
        expect(result.data.records).toHaveLength(2);
        expect(result.data.meta.totalCount).toBe(5);
    });

    it("deletes a user notification when owned", async () => {
        prisma.notification.findFirst.mockResolvedValue({ id: 8, userId: 13 });
        prisma.notification.delete.mockResolvedValue({ id: 8 });

        const result = await service.deleteUserNotification(8, 13);

        expect(prisma.notification.delete).toHaveBeenCalledWith({
            where: { id: 8 },
        });
        expect(result.message).toBe("Notification deleted successfully");
    });

    it("throws when deleting a missing user notification", async () => {
        prisma.notification.findFirst.mockResolvedValue(null);

        await expect(service.deleteUserNotification(8, 13)).rejects.toBeInstanceOf(
            NotificationNotFoundException
        );
    });
});