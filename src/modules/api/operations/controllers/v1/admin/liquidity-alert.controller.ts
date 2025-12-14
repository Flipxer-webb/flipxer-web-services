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
import { JwtAuthGuard } from "@/modules/api/auth/guards";
import { RolesGuard } from "@/modules/api/rbac/guards";
import { Roles } from "@/modules/api/rbac/decorators";
import { CurrentUser } from "@/modules/api/auth/decorators";
import { User } from "@prisma/client";
import { 
    CreateLiquidityAlertDto, 
    ResolveLiquidityAlertDto, 
    LiquidityAlertFilters 
} from "../../../types";

@Controller("admin/operations/liquidity-alerts")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminLiquidityAlertController {
    constructor(private readonly alertService: LiquidityAlertService) {}

    /**
     * Get all liquidity alerts with filters
     */
    @Get()
    @Roles("view_wallets", "manage_wallets")
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
    @Roles("view_wallets", "manage_wallets")
    async getPendingAlertsSummary() {
        return this.alertService.getPendingAlertsSummary();
    }

    /**
     * Get alert statistics
     */
    @Get("statistics")
    @Roles("view_wallets", "manage_wallets", "view_analytics")
    async getAlertStatistics(
        @Query("days", new ParseIntPipe({ optional: true })) days?: number
    ) {
        return this.alertService.getAlertStatistics(days || 30);
    }

    /**
     * Create a new liquidity alert manually
     */
    @Post()
    @Roles("manage_wallets")
    async createAlert(@Body() dto: CreateLiquidityAlertDto) {
        return this.alertService.createAlert(dto);
    }

    /**
     * Run automated liquidity check
     */
    @Post("check")
    @Roles("manage_wallets")
    async runLiquidityCheck() {
        return this.alertService.runLiquidityCheck();
    }

    /**
     * Acknowledge an alert
     */
    @Put(":id/acknowledge")
    @Roles("manage_wallets")
    async acknowledgeAlert(
        @Param("id", ParseIntPipe) id: number,
        @CurrentUser() user: User
    ) {
        return this.alertService.acknowledgeAlert(id, user.id);
    }

    /**
     * Resolve an alert
     */
    @Put(":id/resolve")
    @Roles("manage_wallets")
    async resolveAlert(
        @Param("id", ParseIntPipe) id: number,
        @CurrentUser() user: User,
        @Body() dto: ResolveLiquidityAlertDto
    ) {
        return this.alertService.resolveAlert(id, user.id, dto);
    }

    /**
     * Escalate an alert
     */
    @Put(":id/escalate")
    @Roles("manage_wallets")
    async escalateAlert(@Param("id", ParseIntPipe) id: number) {
        return this.alertService.escalateAlert(id);
    }
}
