import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
} from "@nestjs/common";
import { SystemSettingsService } from "../../../services/system-settings.service";
import { MaintenanceModeService } from "../../../services/maintenance-mode.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { User } from "@/modules/api/user";
import { User as UserModel } from "@prisma/client";
import { SystemSettingDto, MaintenanceModeConfig } from "../../../types";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/settings/system")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminSystemSettingsController {
    constructor(
        private readonly settingsService: SystemSettingsService,
        private readonly maintenanceService: MaintenanceModeService,
    ) {}

    /**
     * Get all system settings
     */
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
    @Get(":key")
    async getSetting(@Param("key") key: string) {
        const value = await this.settingsService.getSetting(key);
        return buildResponse({
            message: "Setting retrieved successfully",
            data: { key, value },
        });
    }

    /**
     * Create or update a setting
     */
    @Post()
    async setSetting(
        @Body() dto: SystemSettingDto,
        @User() user: UserModel
    ) {
        await this.settingsService.setSetting(dto, user.id);
        return buildResponse({
            message: "Setting saved successfully",
        });
    }

    /**
     * Bulk update settings
     */
    @Put("bulk")
    async bulkUpdateSettings(
        @Body() settings: SystemSettingDto[],
        @User() user: UserModel
    ) {
        for (const setting of settings) {
            await this.settingsService.setSetting(setting, user.id);
        }
        return buildResponse({
            message: `${settings.length} settings updated successfully`,
        });
    }

    /**
     * Delete a setting
     */
    @Delete(":key")
    async deleteSetting(@Param("key") key: string) {
        await this.settingsService.deleteSetting(key);
        return buildResponse({
            message: "Setting deleted successfully",
        });
    }

    /**
     * Get current maintenance mode status
     */
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
        return buildResponse({
            message: "Maintenance mode enabled successfully",
            data: result,
        });
    }

    /**
     * Disable maintenance mode
     */
    @Post("maintenance/disable")
    async disableMaintenanceMode(@User() user: UserModel) {
        const result = await this.maintenanceService.disableMaintenance(user.id);
        return buildResponse({
            message: "Maintenance mode disabled successfully",
            data: result,
        });
    }

    /**
     * Update maintenance mode configuration
     */
    @Put("maintenance")
    async updateMaintenanceConfig(
        @Body() config: Partial<MaintenanceModeConfig>,
        @User() user: UserModel
    ) {
        const result = await this.maintenanceService.updateMaintenanceConfig(config, user.id);
        return buildResponse({
            message: "Maintenance configuration updated successfully",
            data: result,
        });
    }
}
