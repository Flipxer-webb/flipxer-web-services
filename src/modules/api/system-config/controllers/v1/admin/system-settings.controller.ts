import {
    BadRequestException,
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    UseGuards,
} from "@nestjs/common";
import { SystemSettingsService } from "../../../services/system-settings.service";
import { MaintenanceModeService } from "../../../services/maintenance-mode.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import { SystemSettingDto, MaintenanceModeConfig } from "../../../types";
import { AuditLogService } from "@/modules/api/audit-log";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/settings/system")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminSystemSettingsController {
    constructor(
        private readonly settingsService: SystemSettingsService,
        private readonly maintenanceService: MaintenanceModeService,
        private readonly auditLogService: AuditLogService,
    ) {}

    /**
     * Get all system settings
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get()
    async getAllSettings() {
        const settings = await this.settingsService.getAllSettings();
        return buildResponse({
            message: "System settings retrieved successfully",
            data: settings,
        });
    }

    /**
     * Get a specific setting by key
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get(":key")
    async getSetting(@Param("key") keyParam: unknown) {
        if (typeof keyParam !== "string") {
            throw new BadRequestException('"key" must be a single string value');
        }

        const key = keyParam;
        const value = await this.settingsService.getSetting(key);
        return buildResponse({
            message: "Setting retrieved successfully",
            data: { key, value },
        });
    }

    /**
     * Create or update a setting
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post()
    async setSetting(
        @Body() dto: SystemSettingDto,
        @User() user: UserModel
    ) {
        await this.settingsService.setSetting(dto, user.id);
        await this.auditLogService.log({
            action: "SET_SYSTEM_SETTING",
            resource: "system_setting",
            resourceId: dto.key,
            details: { key: dto.key },
            adminId: user.id,
        });
        return buildResponse({
            message: "Setting saved successfully",
        });
    }

    /**
     * Bulk update settings
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Put("bulk")
    async bulkUpdateSettings(
        @Body() settings: unknown,
        @User() user: UserModel
    ) {
        if (!Array.isArray(settings)) {
            throw new BadRequestException('"settings" must be an array');
        }

        const typedSettings = settings as SystemSettingDto[];
        for (const setting of typedSettings) {
            await this.settingsService.setSetting(setting, user.id);
        }

        await this.auditLogService.log({
            action: "BULK_UPDATE_SYSTEM_SETTINGS",
            resource: "system_setting",
            details: { count: typedSettings.length, keys: typedSettings.map(s => s.key) },
            adminId: user.id,
        });

        return buildResponse({
            message: `${typedSettings.length} settings updated successfully`,
        });
    }

    /**
     * Delete a setting
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Delete(":key")
    async deleteSetting(@Param("key") keyParam: unknown) {
        if (typeof keyParam !== "string") {
            throw new BadRequestException('"key" must be a single string value');
        }

        const key = keyParam;
        await this.settingsService.deleteSetting(key);
        await this.auditLogService.log({
            action: "DELETE_SYSTEM_SETTING",
            resource: "system_setting",
            resourceId: key,
        });
        return buildResponse({
            message: "Setting deleted successfully",
        });
    }

    /**
     * Get current maintenance mode status
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get("maintenance/status")
    async getMaintenanceStatus() {
        const config = await this.maintenanceService.getMaintenanceConfig();
        return buildResponse({
            message: "Maintenance status retrieved successfully",
            data: config,
        });
    }

    /**
     * Enable maintenance mode
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post("maintenance/enable")
    async enableMaintenanceMode(
        @Body() body: { message: string; estimatedEndTime?: string; allowedIps?: string[] },
        @User() user: UserModel
    ) {
        const result = await this.maintenanceService.enableMaintenance(
            body.message,
            user.id,
            {
                estimatedEndTime: body.estimatedEndTime,
                allowedIps: body.allowedIps,
            }
        );
        await this.auditLogService.log({
            action: "ENABLE_MAINTENANCE_MODE",
            resource: "system_setting",
            details: { message: body.message, estimatedEndTime: body.estimatedEndTime },
            adminId: user.id,
        });
        return buildResponse({
            message: "Maintenance mode enabled successfully",
            data: result,
        });
    }

    /**
     * Disable maintenance mode
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post("maintenance/disable")
    async disableMaintenanceMode(@User() user: UserModel) {
        const result = await this.maintenanceService.disableMaintenance(user.id);
        await this.auditLogService.log({
            action: "DISABLE_MAINTENANCE_MODE",
            resource: "system_setting",
            adminId: user.id,
        });
        return buildResponse({
            message: "Maintenance mode disabled successfully",
            data: result,
        });
    }

    /**
     * Update maintenance mode configuration
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Put("maintenance")
    async updateMaintenanceConfig(
        @Body() config: Partial<MaintenanceModeConfig>,
        @User() user: UserModel
    ) {
        const result = await this.maintenanceService.updateMaintenanceConfig(config, user.id);
        await this.auditLogService.log({
            action: "UPDATE_MAINTENANCE_CONFIG",
            resource: "system_setting",
            details: { configKeys: Object.keys(config) },
            adminId: user.id,
        });
        return buildResponse({
            message: "Maintenance configuration updated successfully",
            data: result,
        });
    }
}
