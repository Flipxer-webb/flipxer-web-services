import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
    UseGuards,
} from "@nestjs/common";
import { NotificationService } from "../../services/notification.service";
import { AuthGuard, CountryBlockGuard } from "@/modules/api/auth/guard";
import { User } from "@/modules/api/user";
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
}
