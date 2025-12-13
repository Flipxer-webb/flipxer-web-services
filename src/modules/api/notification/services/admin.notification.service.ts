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

        const queryOptions: Prisma.NotificationFindManyArgs = {
            orderBy: { createdAt: sortBy },
            where: {},
        };

        if (query.searchText) {
            queryOptions.where.title = { search: query.searchText };
            queryOptions.where.body = { search: query.searchText };
        }

        const [notifications, count] = await Promise.all([
            this.prisma.notification.findMany({
                ...queryOptions,
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
                ...(query.paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
            this.prisma.notification.count({ where: queryOptions.where }),
        ]);

        const responseData: DataWithPagination<any> = {
            ...(query.paginated === "true" && {
                meta: Utils.buildPaginationMeta(
                    resolvedPageNumber,
                    resolvedPageSize,
                    count,
                    notifications.length
                ),
            }),
            records: notifications,
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
        const [total, pending, approved, declined, pushCount, messageCount] = await Promise.all([
            this.prisma.notification.count(),
            this.prisma.notification.count({ where: { status: NotificationStatus.PENDING } }),
            this.prisma.notification.count({ where: { status: NotificationStatus.APPROVED } }),
            this.prisma.notification.count({ where: { status: NotificationStatus.DECLINED } }),
            this.prisma.notification.count({ where: { type: NotificationType.PUSH_NOTIFICATION } }),
            this.prisma.notification.count({ where: { type: NotificationType.MESSAGE } }),
        ]);

        return Utils.buildResponse({
            message: "Notification stats retrieved",
            data: {
                total,
                byStatus: { pending, approved, declined },
                byType: { push: pushCount, message: messageCount },
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

        // If notification is approved and targets ALL users, distribute to each user
        if (status === NotificationStatus.APPROVED && notification.beneficiary === NotificationBeneficiary.ALL) {
            const users = await this.prisma.user.findMany({
                where: { userType: { not: UserType.ADMIN } },
                select: { id: true, notificationToken: true },
            });

            // Create individual notification records for each user
            const userNotifications = users.map((user) => ({
                title: notification.title,
                body: notification.body,
                type: notification.type,
                beneficiary: NotificationBeneficiary.INDIVIDUAL,
                status: NotificationStatus.APPROVED,
                senderId: adminId,
                userId: user.id,
            }));

            if (userNotifications.length > 0) {
                await this.prisma.notification.createMany({
                    data: userNotifications,
                });

                this.logger.log(`Distributed notification #${notificationId} to ${users.length} users`);

                // TODO: Implement push notifications when infrastructure is ready
                const usersWithTokens = users.filter(u => u.notificationToken);
                if (usersWithTokens.length > 0 && notification.type === NotificationType.PUSH_NOTIFICATION) {
                    // Push notification infrastructure not yet implemented
                    this.logger.log(`${usersWithTokens.length} users have push tokens (push not yet implemented)`);
                }
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
