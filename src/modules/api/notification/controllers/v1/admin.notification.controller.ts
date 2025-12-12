import { 
    Controller, 
    Get, 
    Post, 
    Patch, 
    Delete, 
    Param, 
    Query, 
    Body, 
    UseGuards 
} from "@nestjs/common";
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

    @ApiOperation({ summary: "Get notification statistics" })
    @Get("stats")
    async getNotificationStats() {
        return await this.adminNotificationService.getNotificationStats();
    }

    @ApiOperation({ summary: "Broadcast notification to multiple users" })
    @Post("broadcast")
    async broadcastNotification(@Body() broadcastDto: dto.BroadcastNotificationDto) {
        return await this.adminNotificationService.broadcastNotification(broadcastDto);
    }

    @ApiOperation({ summary: "Create a new notification" })
    @Post()
    async createNotification(@Body() createDto: dto.CreateNotificationDto) {
        return await this.adminNotificationService.createNotification(createDto);
    }

    @ApiOperation({ summary: "Notification detail" })
    @Get(":notificationId")
    async getNotification(@Param() param: dto.NotificationIdParamDto) {
        return await this.adminNotificationService.getNotification(
            param.notificationId
        );
    }

    @ApiOperation({ summary: "Notifications" })
    @Get()
    async getNotifications(@Query() listDto: dto.AdminListNotificationDto) {
        return await this.adminNotificationService.getNotifications(listDto);
    }

    @ApiOperation({ summary: "Update notification status" })
    @Patch(":notificationId/status")
    async updateNotificationStatus(
        @Param() param: dto.NotificationIdParamDto,
        @Body() statusDto: dto.UpdateNotificationStatusDto
    ) {
        return await this.adminNotificationService.updateNotificationStatus(
            param.notificationId,
            statusDto.status
        );
    }

    @ApiOperation({ summary: "Delete notification" })
    @Delete(":notificationId")
    async deleteNotification(@Param() param: dto.NotificationIdParamDto) {
        return await this.adminNotificationService.deleteNotification(
            param.notificationId
        );
    }
}
