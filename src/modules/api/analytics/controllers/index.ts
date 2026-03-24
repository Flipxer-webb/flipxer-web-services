import {
    Controller,
    Get,
    Query,
    UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { AnalyticsService } from "../services";
import {
    GetAnalyticsDto,
    GetChartDataDto,
    GetUserGrowthDto,
    GetRevenueAnalyticsDto,
    GetAssetDistributionDto,
} from "../dtos";

@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN, UserType.SUPER_ADMIN])
@ApiTags("admin/analytics")
@Controller({ path: "admin/analytics" })
export class AnalyticsController {
    constructor(private readonly analyticsService: AnalyticsService) {}

    @ApiOperation({ summary: "Get dashboard overview with key metrics" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("overview")
    async getDashboardOverview(@Query() query: GetAnalyticsDto) {
        return await this.analyticsService.getDashboardOverview(query);
    }

    @ApiOperation({ summary: "Get transaction volume chart data" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("transactions/volume")
    async getTransactionVolume(@Query() query: GetChartDataDto) {
        return await this.analyticsService.getTransactionVolume(query);
    }

    @ApiOperation({ summary: "Get transactions grouped by status" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("transactions/status")
    async getTransactionsByStatus(@Query() query: GetAnalyticsDto) {
        return await this.analyticsService.getTransactionsByStatus(query);
    }

    @ApiOperation({ summary: "Get user growth chart data" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("users/growth")
    async getUserGrowth(@Query() query: GetUserGrowthDto) {
        return await this.analyticsService.getUserGrowth(query);
    }

    @ApiOperation({ summary: "Get user activity metrics" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("users/activity")
    async getUserActivity(@Query() query: GetAnalyticsDto) {
        return await this.analyticsService.getUserActivity(query);
    }

    @ApiOperation({ summary: "Get revenue analytics and fee breakdown" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("revenue")
    async getRevenueAnalytics(@Query() query: GetRevenueAnalyticsDto) {
        return await this.analyticsService.getRevenueAnalytics(query);
    }

    @ApiOperation({ summary: "Get asset distribution by balance and volume" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("assets")
    async getAssetDistribution(@Query() query: GetAssetDistributionDto) {
        return await this.analyticsService.getAssetDistribution(query);
    }

    @ApiOperation({ summary: "Get user conversion funnel data" })
    @ApiBearerAuth("access-token")
    @Permissions([PermissionName.ANALYTICS_READ])
    @Get("funnel")
    async getConversionFunnel(@Query() query: GetAnalyticsDto) {
        return await this.analyticsService.getConversionFunnel(query);
    }
}
