// admin-user.controller.ts
import {
    Controller,
    Get,
    Post,
    Param,
    ParseIntPipe,
    Query,
    Body,
    UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
    AuthGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { UserType, User as UserModel } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { AdminUserService } from "../../services/admin";
import { GetUserListDto, UnflagUserDto, FlagUserDto, SetLimitOverrideDto, RemoveLimitOverrideDto } from "../../dtos";
import { GetUserTransactionListDto } from "@/modules/api/transactions/dtos";
import { User } from "../../decorators";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiTags("admin")
@Controller({
    path: "admin/user",
})
export class AdminUserController {
    constructor(private readonly adminService: AdminUserService) {}

    @Permissions([PermissionName.ANALYTICS_READ])
    @ApiOperation({ summary: "Admin gets Dashboard analytics overview" })
    @ApiBearerAuth("access-token")
    @Get("analytics-overview")
    async getAnalyticsOverview(
        @Query("period") period?: string,
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
    ) {
        return await this.adminService.getAnalyticsOverview(period, startDate, endDate);
    }

    @Permissions([PermissionName.READ_USERS])
    @ApiOperation({ summary: "Admin gets all users list" })
    @ApiBearerAuth("access-token")
    @Get("all")
    async getAllUsers(@Query() query: GetUserListDto) {
        return await this.adminService.getUserList(query);
    }

    @Permissions([PermissionName.READ_USERS])
    @ApiOperation({ summary: "Admin gets filter-aware user stats" })
    @ApiBearerAuth("access-token")
    @Get("stats")
    async getUserStats(@Query() query: GetUserListDto) {
        return await this.adminService.getUserFilteredStats(query);
    }

    @Permissions([PermissionName.READ_USERS])
    @ApiOperation({ summary: "Admin gets user transactions list" })
    @ApiBearerAuth("access-token")
    @Get("transactions/:userId")
    async getUserTransactionList(
        @Param("userId", ParseIntPipe) userId: number,
        @Query() query: GetUserTransactionListDto
    ) {
        return this.adminService.getUserTransactionList(query, userId);
    }

    @Permissions([PermissionName.READ_USERS])
    @ApiOperation({ summary: "Admin gets user personal info" })
    @ApiBearerAuth("access-token")
    @Get(":userId")
    async getUserInfo(@Param("userId", ParseIntPipe) userId: number) {
        return this.adminService.getUserInfo(userId);
    }

    @Permissions([PermissionName.UPDATE_USERS])
    @ApiOperation({ summary: "Admin unflags a user account" })
    @ApiBearerAuth("access-token")
    @UserTypes([UserType.SUPER_ADMIN])
    @Post("unflag")
    async unflagUser(@Body() dto: UnflagUserDto) {
        return await this.adminService.unflagUser(dto);
    }

    @Permissions([PermissionName.UPDATE_USERS])
    @ApiOperation({ summary: "Admin flags a user account" })
    @ApiBearerAuth("access-token")
    @UserTypes([UserType.SUPER_ADMIN])
    @Post("flag")
    async flagUser(@Body() dto: FlagUserDto) {
        return await this.adminService.flagUser(dto);
    }

    @Permissions([PermissionName.UPDATE_USERS])
    @ApiOperation({ summary: "Admin sets a limit override for a user" })
    @ApiBearerAuth("access-token")
    @UserTypes([UserType.SUPER_ADMIN])
    @Post("limit-override")
    async setLimitOverride(@Body() dto: SetLimitOverrideDto, @User() admin: UserModel) {
        return await this.adminService.setLimitOverride(dto, admin.id);
    }

    @Permissions([PermissionName.UPDATE_USERS])
    @ApiOperation({ summary: "Admin removes a limit override for a user" })
    @ApiBearerAuth("access-token")
    @UserTypes([UserType.SUPER_ADMIN])
    @Post("limit-override/remove")
    async removeLimitOverride(@Body() dto: RemoveLimitOverrideDto) {
        return await this.adminService.removeLimitOverride(dto);
    }

    @Permissions([PermissionName.READ_USERS])
    @ApiOperation({ summary: "Admin gets a user's limit override" })
    @ApiBearerAuth("access-token")
    @Get("limit-override/:userId")
    async getLimitOverride(@Param("userId", ParseIntPipe) userId: number) {
        return await this.adminService.getLimitOverride(userId);
    }
}
