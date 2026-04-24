import {
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Query,
    UseGuards,
} from "@nestjs/common";
import { NotificationService } from "../../services/notification.service";
import { AuthGuard, CountryBlockGuard } from "@/modules/api/auth/guard";
import { User } from "@/modules/api/user/decorators";
import { User as UserModel } from "@prisma/client";
import * as dto from "../../dtos/notification.dto";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("Notifications")
@UseGuards(CountryBlockGuard, AuthGuard)
@ApiBearerAuth("access-token")
@Controller({
    path: "notifications",
})
export class NotificationController {
    constructor(private readonly notificationService: NotificationService) {}

    @Get()
    @ApiOperation({
        summary: "user notifications",
    })
    async getNotifications(
        @User() user: UserModel,
        @Query() dto: dto.GetNotificationsDto
    ) {
        return await this.notificationService.getNotifications(user, dto);
    }

    @Post("mark-all-read")
    @ApiOperation({
        summary: "Mark all notifications as read",
    })
    async markAllUserNotificationsRead(@User() user: UserModel) {
        return await this.notificationService.markAllUserNotificationsRead(
            user
        );
    }

    @Post(":notificationId/mark-read")
    @ApiOperation({
        summary: "Mark single notification as read",
    })
    async markNotificationAsRead(
        @User() user: UserModel,
        @Param("notificationId", ParseIntPipe) notificationId: number
    ) {
        return await this.notificationService.markNotificationAsRead(
            notificationId,
            user.id
        );
    }

    @Post(":notificationId/toggle-status")
    @ApiOperation({
        summary: "Toggle notification read status only",
    })
    async toggleNotificationReadStatus(
        @User() user: UserModel,
        @Param("notificationId", ParseIntPipe) notificationId: number
    ) {
        return await this.notificationService.toggleNotificationReadStatus(
            notificationId,
            user.id
        );
    }

    @Delete(":notificationId")
    @ApiOperation({
        summary: "Delete user notification",
    })
    async deleteUserNotification(
        @User() user: UserModel,
        @Param("notificationId", ParseIntPipe) notificationId: number
    ) {
        return await this.notificationService.deleteUserNotification(
            notificationId,
            user.id
        );
    }
}
