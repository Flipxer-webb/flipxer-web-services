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
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import { 
    CreateLiquidityAlertDto, 
    ResolveLiquidityAlertDto, 
    LiquidityAlertFilters 
} from "../../../types";
import { AuditLogService } from "@/modules/api/audit-log";

@Controller("admin/liquidity-alerts")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminLiquidityAlertController {
    constructor(
        private readonly alertService: LiquidityAlertService,
        private readonly auditLogService: AuditLogService,
    ) {}

    /**
     * Get all liquidity alerts with filters
     */
    @Permissions([PermissionName.SETTINGS_READ])
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
    @Permissions([PermissionName.SETTINGS_READ])
    @Get("summary/pending")
    async getPendingAlertsSummary() {
        return this.alertService.getPendingAlertsSummary();
    }

    /**
     * Get alert statistics
     */
    @Permissions([PermissionName.SETTINGS_READ])
    @Get("statistics")
    async getAlertStatistics(
        @Query("days", new ParseIntPipe({ optional: true })) days?: number
    ) {
        return this.alertService.getAlertStatistics(days || 30);
    }

    /**
     * Create a new liquidity alert manually
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Post()
    async createAlert(@Body() dto: CreateLiquidityAlertDto, @User() user: UserModel) {
        const result = await this.alertService.createAlert(dto);
        await this.auditLogService.log({
            action: "CREATE_LIQUIDITY_ALERT",
            resource: "liquidity_alert",
            details: { ...dto },
            adminId: user.id,
        });
        return result;
    }

    /**
     * Run automated liquidity check
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Post("check")
    async runLiquidityCheck(@User() user: UserModel) {
        const result = await this.alertService.runLiquidityCheck();
        await this.auditLogService.log({
            action: "RUN_LIQUIDITY_CHECK",
            resource: "liquidity_alert",
            adminId: user.id,
        });
        return result;
    }

    /**
     * Acknowledge an alert
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Put(":id/acknowledge")
    async acknowledgeAlert(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        const result = await this.alertService.acknowledgeAlert(id, user.id);
        await this.auditLogService.log({
            action: "ACKNOWLEDGE_LIQUIDITY_ALERT",
            resource: "liquidity_alert",
            resourceId: id.toString(),
            adminId: user.id,
        });
        return result;
    }

    /**
     * Resolve an alert
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Put(":id/resolve")
    async resolveAlert(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel,
        @Body() dto: ResolveLiquidityAlertDto
    ) {
        const result = await this.alertService.resolveAlert(id, user.id, dto);
        await this.auditLogService.log({
            action: "RESOLVE_LIQUIDITY_ALERT",
            resource: "liquidity_alert",
            resourceId: id.toString(),
            details: { ...dto },
            adminId: user.id,
        });
        return result;
    }

    /**
     * Escalate an alert
     */
    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Put(":id/escalate")
    async escalateAlert(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        const result = await this.alertService.escalateAlert(id);
        await this.auditLogService.log({
            action: "ESCALATE_LIQUIDITY_ALERT",
            resource: "liquidity_alert",
            resourceId: id.toString(),
            adminId: user.id,
        });
        return result;
    }
}
