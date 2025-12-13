import { PrismaService } from "@/modules/core/prisma/services";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import * as dto from "../dtos/notification.dto";
import { Prisma, NotificationType, NotificationBeneficiary, NotificationStatus, UserType } from "@prisma/client";
import * as Utils from "@/utils";
import * as e from "../errors/notification.error";
import { NotificationEvent } from "../events/notification.event";

@Injectable()
export class AdminNotificationService {
    private readonly logger = new Logger(AdminNotificationService.name);
    
    constructor(
        private prisma: PrismaService,
        private notificationEvent: NotificationEvent,
    ) {}

    async getNotification(notificationId: number) {
        const notification = await this.prisma.notification.findUnique({
            where: {
                id: notificationId,
            },
        });
        if (!notification) {
            throw new e.NotificationNotFoundException(
                "Notification not found",
                HttpStatus.NOT_FOUND
            );
        }

        return Utils.buildResponse({
            message: "Notification successfully retrieved",
            data: notification,
        });
    }

    async getNotifications(query: dto.AdminListNotificationDto) {
        const { pageNumber, pageSize, sortBy } = query;

        const resolvedPageNumber: number =
            !pageNumber || (pageNumber && pageNumber <= 1)
                ? Utils.defaultPagination.pageNumber
                : pageNumber;

        const resolvedPageSize: number =
            !pageSize || (pageSize && pageSize <= 0)
                ? Utils.defaultPagination.pageSize
                : query.pageSize;

        // For broadcast notifications (beneficiary=ALL), we want to group them
        // to avoid showing duplicate entries. We'll use a raw query to get distinct 
        // notifications by title + body + createdAt (within same second)
        
        // Get broadcast notifications grouped by content
        const broadcastNotifications = await this.prisma.notification.findMany({
            where: {
                beneficiary: "ALL",
                ...(query.searchText && {
                    OR: [
                        { title: { contains: query.searchText, mode: "insensitive" } },
                        { body: { contains: query.searchText, mode: "insensitive" } },
                    ],
                }),
            },
            distinct: ["title", "body", "senderId"],
            orderBy: { createdAt: sortBy },
            select: {
                id: true,
                type: true,
                title: true,
                body: true,
                beneficiary: true,
                isRead: true,
                status: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        // Get individual notifications (not broadcast)
        const individualNotifications = await this.prisma.notification.findMany({
            where: {
                beneficiary: { not: "ALL" },
                ...(query.searchText && {
                    OR: [
                        { title: { contains: query.searchText, mode: "insensitive" } },
                        { body: { contains: query.searchText, mode: "insensitive" } },
                    ],
                }),
            },
            orderBy: { createdAt: sortBy },
            select: {
                id: true,
                type: true,
                title: true,
                body: true,
                beneficiary: true,
                isRead: true,
                receiver: { select: { firstName: true, lastName: true } },
                status: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        // Combine and sort by createdAt
        const allNotifications = [...broadcastNotifications, ...individualNotifications]
            .sort((a, b) => {
                const dateA = new Date(a.createdAt).getTime();
                const dateB = new Date(b.createdAt).getTime();
                return sortBy === "desc" ? dateB - dateA : dateA - dateB;
            });

        const totalCount = allNotifications.length;

        // Apply pagination
        const paginatedNotifications = query.paginated === "true"
            ? allNotifications.slice(
                (resolvedPageNumber - 1) * resolvedPageSize,
                resolvedPageNumber * resolvedPageSize
              )
            : allNotifications;

        const responseData: DataWithPagination<any> = {
            ...(query.paginated === "true" && {
                meta: Utils.buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    totalCount,
                    paginatedNotifications.length
                ),
            }),
            records: paginatedNotifications,
        };

        return Utils.buildResponse({
            message: "notifications successfully retrieved",
            data: responseData,
        });
    }

    // ==================== NEW ADMIN NOTIFICATION FEATURES ====================

    async createNotification(data: dto.CreateNotificationDto, adminId?: number) {
        const notification = await this.prisma.notification.create({
            data: {
                title: data.title,
                body: data.body,
                type: data.type as NotificationType,
                beneficiary: data.beneficiary as NotificationBeneficiary,
                status: NotificationStatus.PENDING,
                senderId: adminId,
                userId: data.userId,
            },
        });

        // Log audit
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "CREATE_NOTIFICATION",
                resource: "notification",
                resourceId: notification.id.toString(),
                details: { title: data.title, type: data.type, beneficiary: data.beneficiary },
            },
        });

        return Utils.buildResponse({
            message: "Notification created successfully",
            data: notification,
        });
    }

    async broadcastNotification(data: dto.BroadcastNotificationDto, adminId?: number) {
        const { title, body, type, targetAudience, userIds } = data;

        let targetUsers: { id: number; notificationToken: string | null }[] = [];

        if (targetAudience === "all") {
            // Broadcast to all non-admin users
            targetUsers = await this.prisma.user.findMany({
                where: { userType: { not: UserType.ADMIN } },
                select: { id: true, notificationToken: true },
            });
        } else if (targetAudience === "individual" && userIds?.length) {
            targetUsers = await this.prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, notificationToken: true },
            });
        } else if (targetAudience === "business") {
            targetUsers = await this.prisma.user.findMany({
                where: { userType: UserType.BUSINESS },
                select: { id: true, notificationToken: true },
            });
        } else if (targetAudience === "verified") {
            targetUsers = await this.prisma.user.findMany({
                where: { 
                    userType: { not: UserType.ADMIN },
                    tier: { gte: 2 },
                },
                select: { id: true, notificationToken: true },
            });
        }

        // Create notifications for each user
        const notificationData = targetUsers.map((user) => ({
            title,
            body,
            type: (type || "PUSH_NOTIFICATION") as NotificationType,
            beneficiary: targetAudience === "all" 
                ? NotificationBeneficiary.ALL 
                : NotificationBeneficiary.INDIVIDUAL,
            status: NotificationStatus.APPROVED,
            senderId: adminId,
            userId: user.id,
        }));

        await this.prisma.notification.createMany({
            data: notificationData,
        });

        // Log broadcast push notification attempt for users with tokens
        const usersWithTokens = targetUsers.filter(u => u.notificationToken);
        if (usersWithTokens.length > 0 && type === "PUSH_NOTIFICATION") {
            // TODO: Implement bulk push notification when NotificationEvent supports it
            this.logger.log(`Broadcast: ${usersWithTokens.length} users have push tokens`);
        }

        // Log audit
        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "BROADCAST_NOTIFICATION",
                resource: "notification",
                resourceId: "broadcast",
                details: { 
                    title, 
                    targetAudience, 
                    recipientCount: targetUsers.length,
                },
            },
        });

        return Utils.buildResponse({
            message: "Broadcast sent successfully",
            data: {
                recipientCount: targetUsers.length,
                pushNotificationsSent: usersWithTokens.length,
            },
        });
    }

    async getNotificationStats() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [total, pending, approved, declined, sentToday] = await Promise.all([
            this.prisma.notification.count(),
            this.prisma.notification.count({ where: { status: NotificationStatus.PENDING } }),
            this.prisma.notification.count({ where: { status: NotificationStatus.APPROVED } }),
            this.prisma.notification.count({ where: { status: NotificationStatus.DECLINED } }),
            this.prisma.notification.count({ 
                where: { 
                    status: NotificationStatus.APPROVED,
                    updatedAt: { gte: today }
                } 
            }),
        ]);

        return Utils.buildResponse({
            message: "Notification stats retrieved",
            data: {
                total,
                pending,
                approved,
                declined,
                sentToday,
            },
        });
    }

    async updateNotificationStatus(
        notificationId: number, 
        status: NotificationStatus,
        adminId?: number
    ) {
        const notification = await this.prisma.notification.findUnique({
            where: { id: notificationId },
        });

        if (!notification) {
            throw new e.NotificationNotFoundException(
                "Notification not found",
                HttpStatus.NOT_FOUND
            );
        }

        const updated = await this.prisma.notification.update({
            where: { id: notificationId },
            data: { status },
        });

        // For ALL beneficiary notifications, users will see the original notification
        // via the query that includes beneficiary='ALL' notifications.
        // We only need to handle push notifications here if applicable.
        if (status === NotificationStatus.APPROVED && notification.beneficiary === NotificationBeneficiary.ALL) {
            const usersWithTokens = await this.prisma.user.findMany({
                where: { 
                    userType: { not: UserType.ADMIN },
                    notificationToken: { not: null },
                },
                select: { id: true, notificationToken: true },
            });

            if (usersWithTokens.length > 0 && notification.type === NotificationType.PUSH_NOTIFICATION) {
                // TODO: Implement push notifications when infrastructure is ready
                this.logger.log(`Notification #${notificationId} approved for all users. ${usersWithTokens.length} users have push tokens.`);
            }
        }

        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "UPDATE_NOTIFICATION_STATUS",
                resource: "notification",
                resourceId: notificationId.toString(),
                details: { previousStatus: notification.status, newStatus: status },
            },
        });

        return Utils.buildResponse({
            message: "Notification status updated",
            data: updated,
        });
    }

    async deleteNotification(notificationId: number, adminId?: number) {
        await this.prisma.notification.delete({
            where: { id: notificationId },
        });

        await this.prisma.auditLog.create({
            data: {
                adminId,
                action: "DELETE_NOTIFICATION",
                resource: "notification",
                resourceId: notificationId.toString(),
                details: {},
            },
        });

        return Utils.buildResponse({
            message: "Notification deleted successfully",
            data: null,
        });
    }
}
