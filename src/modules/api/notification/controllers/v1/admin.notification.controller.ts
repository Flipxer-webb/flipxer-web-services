import { 
    Controller, 
    Get, 
    Post, 
    Patch, 
    Delete, 
    Param, 
    Query, 
    Body, 
    Req,
    UseGuards 
} from "@nestjs/common";
import { Request } from "express";
import { AdminNotificationService } from "../../services/admin.notification.service";
import * as dto from "../../dtos/notification.dto";
import { AuthGuard, CountryBlockGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("admin")
@UseGuards(CountryBlockGuard, AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiBearerAuth("access-token")
@Controller({
    path: "admin/notifications",
})
export class AdminNotificationController {
    constructor(
        private readonly adminNotificationService: AdminNotificationService
    ) {}

    @Permissions([PermissionName.NOTIFICATIONS_READ])
    @ApiOperation({ summary: "Get notification statistics" })
    @Get("stats")
    async getNotificationStats() {
        return await this.adminNotificationService.getNotificationStats();
    }

    @Permissions([PermissionName.NOTIFICATIONS_BROADCAST])
    @ApiOperation({ summary: "Broadcast notification to multiple users" })
    @Post("broadcast")
    async broadcastNotification(@Body() broadcastDto: dto.BroadcastNotificationDto, @Req() req: Request) {
        return await this.adminNotificationService.broadcastNotification(broadcastDto, (req as any).user?.id);
    }

    @Permissions([PermissionName.NOTIFICATIONS_CREATE])
    @ApiOperation({ summary: "Create a new notification" })
    @Post()
    async createNotification(@Body() createDto: dto.CreateNotificationDto, @Req() req: Request) {
        return await this.adminNotificationService.createNotification(createDto, (req as any).user?.id);
    }

    @Permissions([PermissionName.NOTIFICATIONS_READ])
    @ApiOperation({ summary: "Notification detail" })
    @Get(":notificationId")
    async getNotification(@Param() param: dto.NotificationIdParamDto) {
        return await this.adminNotificationService.getNotification(
            param.notificationId
        );
    }

    @Permissions([PermissionName.NOTIFICATIONS_READ])
    @ApiOperation({ summary: "Notifications" })
    @Get()
    async getNotifications(@Query() listDto: dto.AdminListNotificationDto) {
        return await this.adminNotificationService.getNotifications(listDto);
    }

    @Permissions([PermissionName.NOTIFICATIONS_UPDATE])
    @ApiOperation({ summary: "Update notification status" })
    @Patch(":notificationId/status")
    async updateNotificationStatus(
        @Param() param: dto.NotificationIdParamDto,
        @Body() statusDto: dto.UpdateNotificationStatusDto,
        @Req() req: Request
    ) {
        return await this.adminNotificationService.updateNotificationStatus(
            param.notificationId,
            statusDto.status,
            (req as any).user?.id
        );
    }

    @Permissions([PermissionName.NOTIFICATIONS_DELETE])
    @ApiOperation({ summary: "Delete notification" })
    @Delete(":notificationId")
    async deleteNotification(@Param() param: dto.NotificationIdParamDto, @Req() req: Request) {
        return await this.adminNotificationService.deleteNotification(
            param.notificationId,
            (req as any).user?.id
        );
    }
}
