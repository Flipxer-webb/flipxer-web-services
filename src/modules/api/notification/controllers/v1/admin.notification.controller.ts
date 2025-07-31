import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { AdminNotificationService } from "../../services/admin.notification.service";
import * as dto from "../../dtos/notification.dto";
import { AuthGuard } from "@/modules/api/auth/guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";

@UseGuards(AuthGuard, PermissionGuard)
@Controller({
    path: "admin/notifications",
})
export class AdminNotificationController {
    constructor(
        private readonly adminNotificationService: AdminNotificationService
    ) {}

    @Get(":notificationId")
    async getNotification(@Param() param: dto.NotificationIdParamDto) {
        return await this.adminNotificationService.getNotification(
            param.notificationId
        );
    }

    @Get()
    async getNotifications(@Query() dto: dto.AdminListNotificationDto) {
        return await this.adminNotificationService.getNotifications(dto);
    }
}
