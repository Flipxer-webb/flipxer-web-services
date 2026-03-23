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
    CountryBlockGuard,
    EnabledAccountGuard,
} from "@/modules/api/auth/guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { AdminUserService } from "../../services/admin";
import { GetUserListDto, UnflagUserDto, FlagUserDto } from "../../dtos"; // Added FlagUserDto
import { GetUserTransactionListDto } from "@/modules/api/transactions/dtos";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard)
@UserTypes([UserType.ADMIN])
@ApiTags("admin")
@Controller({
    path: "admin/user",
})
export class AdminUserController {
    constructor(private readonly adminService: AdminUserService) {}

    @ApiOperation({ summary: "Admin gets Dashboard analytics overview" })
    @ApiBearerAuth("access-token")
    @Get("analytics-overview")
    async getAnalyticsOverview(@Query("period") period?: string) {
        return await this.adminService.getAnalyticsOverview(period);
    }

    @ApiOperation({ summary: "Admin gets all users list" })
    @ApiBearerAuth("access-token")
    @Get("all")
    async getAllUsers(@Query() query: GetUserListDto) {
        return await this.adminService.getUserList(query);
    }

    @ApiOperation({ summary: "Admin gets user transactions list" })
    @ApiBearerAuth("access-token")
    @Get("transactions/:userId")
    async getUserTransactionList(
        @Param("userId", ParseIntPipe) userId: number,
        @Query() query: GetUserTransactionListDto
    ) {
        return this.adminService.getUserTransactionList(query, userId);
    }

    @ApiOperation({ summary: "Admin gets user personal info" })
    @ApiBearerAuth("access-token")
    @Get(":userId")
    async getUserInfo(@Param("userId", ParseIntPipe) userId: number) {
        return this.adminService.getUserInfo(userId);
    }

    @ApiOperation({ summary: "Admin unflags a user account" })
    @ApiBearerAuth("access-token")
    @Post("unflag")
    async unflagUser(@Body() dto: UnflagUserDto) {
        return await this.adminService.unflagUser(dto);
    }

    @ApiOperation({ summary: "Admin flags a user account" })
    @ApiBearerAuth("access-token")
    @Post("flag")
    async flagUser(@Body() dto: FlagUserDto) {
        return await this.adminService.flagUser(dto);
    }
}
