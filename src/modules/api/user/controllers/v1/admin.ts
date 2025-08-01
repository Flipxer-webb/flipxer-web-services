import {
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Query,
    UseGuards,
    ValidationPipe,
    Post,
    Body
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags, ApiResponse as SwaggerApiResponse } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { AdminUserService } from "../../services/admin";
import { GetUserListDto, UnflagUserDto } from "../../dtos";
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
    async getAnalyticsOverview() {
        return await this.adminService.getAnalyticsOverview();
    }

    @ApiOperation({ summary: "admin gets all users list" })
    @ApiBearerAuth("access-token")
    @Get("all")
    async getAllUsers(@Query() query: GetUserListDto) {
        return await this.adminService.getUserList(query);
    }

    @ApiOperation({ summary: "admin get user transactions list" })
    @ApiBearerAuth("access-token")
    @Get("transactions/:userId")
    async getUserTransactionList(
        @Param("userId", ParseIntPipe) userId: number,
        @Query() query: GetUserTransactionListDto
    ) {
        return this.adminService.getUserTransactionList(query, userId);
    }

    @ApiOperation({ summary: "admin get user personal info" })
    @ApiBearerAuth("access-token")
    @Get(":userId")
    async getUserInfo(@Param("userId", ParseIntPipe) userId: number) {
        return this.adminService.getUserInfo(userId);
    }

    //unflag users
    @ApiOperation({ summary: "Admin unflags a user by ID" })
    @ApiBearerAuth("access-token")
    @Post("unflag/:userId")
    async unflagUser(
        @Param("userId", ParseIntPipe) userId: number
    ): Promise<ApiResponse> {
        return await this.adminService.unflagUser({ id: userId });
    }
}
