import { PrismaService } from "@/modules/core/prisma/services";
import { HttpStatus, Injectable } from "@nestjs/common";
import * as dto from "../dtos/notification.dto";
import { Prisma } from "@prisma/client";
import * as Utils from "@/utils";
import * as e from "../errors/notification.error";

@Injectable()
export class AdminNotificationService {
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
}
