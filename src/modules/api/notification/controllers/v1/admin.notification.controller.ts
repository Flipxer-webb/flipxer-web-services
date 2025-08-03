import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { AdminNotificationService } from "../../services/admin.notification.service";
import * as dto from "../../dtos/notification.dto";
import { AuthGuard, CountryBlockGuard } from "@/modules/api/auth/guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("admin")
@UseGuards(CountryBlockGuard, AuthGuard, PermissionGuard)
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/notifications",
})
export class AdminNotificationController {
    constructor(
        private readonly adminNotificationService: AdminNotificationService
    ) {}

    @ApiOperation({ summary: "Notification detail" })
    @Get(":notificationId")
    async getNotification(@Param() param: dto.NotificationIdParamDto) {
        return await this.adminNotificationService.getNotification(
            param.notificationId
        );
    }

    @ApiOperation({ summary: "Notifications" })
    @Get()
    async getNotifications(@Query() dto: dto.AdminListNotificationDto) {
        return await this.adminNotificationService.getNotifications(dto);
    }
}
