import {
    Controller,
    Get,
    Post,
    Put,
    Body,
    Param,
    Query,
    ParseIntPipe,
    UseGuards,
} from "@nestjs/common";
import { LiquidityAlertService } from "../../../services/liquidity-alert.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { User } from "@/modules/api/user";
import { User as UserModel, UserType } from "@prisma/client";
import { 
    CreateLiquidityAlertDto, 
    ResolveLiquidityAlertDto, 
    LiquidityAlertFilters 
} from "../../../types";

@Controller("admin/liquidity-alerts")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminLiquidityAlertController {
    constructor(private readonly alertService: LiquidityAlertService) {}

    /**
     * Get all liquidity alerts with filters
     */
    @Get()
    async getAlerts(
        @Query("status") status?: string,
        @Query("currency") currency?: string,
        @Query("alertType") alertType?: string,
        @Query("startDate") startDate?: string,
        @Query("endDate") endDate?: string,
        @Query("page", new ParseIntPipe({ optional: true })) page?: number,
        @Query("limit", new ParseIntPipe({ optional: true })) limit?: number
    ) {
        const filters: LiquidityAlertFilters = {
            status: status as any,
            currency,
            alertType,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            page: page || 1,
            limit: limit || 20,
        };

        return this.alertService.getAlerts(filters);
    }

    /**
     * Get pending alerts summary
     */
    @Get("summary/pending")
    async getPendingAlertsSummary() {
        return this.alertService.getPendingAlertsSummary();
    }

    /**
     * Get alert statistics
     */
    @Get("statistics")
    async getAlertStatistics(
        @Query("days", new ParseIntPipe({ optional: true })) days?: number
    ) {
        return this.alertService.getAlertStatistics(days || 30);
    }

    /**
     * Create a new liquidity alert manually
     */
    @Post()
    async createAlert(@Body() dto: CreateLiquidityAlertDto) {
        return this.alertService.createAlert(dto);
    }

    /**
     * Run automated liquidity check
     */
    @Post("check")
    async runLiquidityCheck() {
        return this.alertService.runLiquidityCheck();
    }

    /**
     * Acknowledge an alert
     */
    @Put(":id/acknowledge")
    async acknowledgeAlert(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        return this.alertService.acknowledgeAlert(id, user.id);
    }

    /**
     * Resolve an alert
     */
    @Put(":id/resolve")
    async resolveAlert(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel,
        @Body() dto: ResolveLiquidityAlertDto
    ) {
        return this.alertService.resolveAlert(id, user.id, dto);
    }

    /**
     * Escalate an alert
     */
    @Put(":id/escalate")
    async escalateAlert(@Param("id", ParseIntPipe) id: number) {
        return this.alertService.escalateAlert(id);
    }
}
