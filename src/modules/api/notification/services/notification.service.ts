import { PrismaService } from "@/modules/core/prisma/services";
import { HttpStatus, Injectable } from "@nestjs/common";
import * as Utils from "@/utils";
import * as dto from "../dtos/notification.dto";
import { Prisma, User } from "@prisma/client";
import * as e from "../errors/notification.error";

@Injectable()
export class NotificationService {
    constructor(private prisma: PrismaService) {}

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

    async toggleNotificationReadStatus(notificationId: number) {
        const notification = await this.prisma.notification.findUnique({
            where: { id: notificationId },
        });

        if (!notification) {
            throw new e.NotificationNotFoundException(
                "Notification not found",
                HttpStatus.NOT_FOUND
            );
        }

        const updatedNotification = await this.prisma.notification.update({
            where: { id: notificationId },
            data: {
                isRead: !notification.isRead,
            },
        });

        return Utils.buildResponse({
            message: "Notification read status updated",
            data: updatedNotification,
        });
    }

    async markAllUserNotificationsRead(user: User) {
        const updatedNotification = await this.prisma.notification.updateMany({
            where: { userId: user.id, isRead: false },
            data: {
                isRead: true,
            },
        });

        return Utils.buildResponse({
            message: "User Notifications marked as read",
            data: updatedNotification,
        });
    }

    async getNotifications(
        user: User,
        query: dto.GetNotificationsDto
    ): Promise<ApiResponse<DataWithPagination>> {
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
            where: {
                userId: user.id,
            },
        };

        if (query.searchText) {
            queryOptions.where.title = { search: query.searchText };
            queryOptions.where.body = { search: query.searchText };
        }

        const [count, notifications] = await Promise.all([
            this.prisma.notification.count({
                where: queryOptions.where,
            }),
            this.prisma.notification.findMany({
                ...queryOptions,
                ...(query.paginated === "true" && {
                    skip: (resolvedPageNumber - 1) * resolvedPageSize,
                    take: resolvedPageSize,
                }),
            }),
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
            message: "Notifications retrieved successfully",
            data: responseData,
        });
    }
}
