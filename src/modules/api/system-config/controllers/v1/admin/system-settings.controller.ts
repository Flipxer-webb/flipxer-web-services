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
import { JwtAuthGuard } from "@/modules/api/auth/guards";
import { RolesGuard } from "@/modules/api/rbac/guards";
import { Roles } from "@/modules/api/rbac/decorators";
import { CurrentUser } from "@/modules/api/auth/decorators";
import { User } from "@prisma/client";
import { SystemSettingDto, MaintenanceModeConfig } from "../../../types";

@Controller("admin/system/settings")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminSystemSettingsController {
    constructor(
        private readonly settingsService: SystemSettingsService,
        private readonly maintenanceService: MaintenanceModeService,
    ) {}

    /**
     * Get all system settings
     */
    @Get()
    @Roles("view_system_settings", "manage_system_settings")
    async getAllSettings() {
        return this.settingsService.getAllSettings();
    }

    /**
     * Get a specific setting by key
     */
    @Get(":key")
    @Roles("view_system_settings", "manage_system_settings")
    async getSetting(@Param("key") key: string) {
        const value = await this.settingsService.getSetting(key);
        return { key, value };
    }

    /**
     * Create or update a setting
     */
    @Put(":key")
    @Roles("manage_system_settings")
    async setSetting(
        @Param("key") key: string,
        @Body() body: { value: any; description?: string },
        @CurrentUser() user: User
    ) {
        await this.settingsService.setSetting(
            { key, value: body.value, description: body.description },
            user.id
        );
        return { message: "Setting updated successfully" };
    }

    /**
     * Delete a setting
     */
    @Delete(":key")
    @Roles("manage_system_settings")
    async deleteSetting(@Param("key") key: string) {
        await this.settingsService.deleteSetting(key);
        return { message: "Setting deleted successfully" };
    }

    /**
     * Bulk update settings
     */
    @Post("bulk")
    @Roles("manage_system_settings")
    async bulkUpdateSettings(
        @Body() settings: SystemSettingDto[],
        @CurrentUser() user: User
    ) {
        await this.settingsService.bulkUpdateSettings(settings, user.id);
        return { message: `${settings.length} settings updated successfully` };
    }

    // === Maintenance Mode Endpoints ===

    /**
     * Get current maintenance mode status
     */
    @Get("maintenance/status")
    @Roles("view_system_settings", "manage_system_settings")
    async getMaintenanceStatus() {
        return this.maintenanceService.getMaintenanceConfig();
    }

    /**
     * Enable maintenance mode
     */
    @Post("maintenance/enable")
    @Roles("manage_system_settings")
    async enableMaintenance(
        @Body() body: { message: string; estimatedEndTime?: string; allowedIps?: string[] },
        @CurrentUser() user: User
    ) {
        return this.maintenanceService.enableMaintenance(
            body.message,
            user.id,
            { estimatedEndTime: body.estimatedEndTime, allowedIps: body.allowedIps }
        );
    }

    /**
     * Disable maintenance mode
     */
    @Post("maintenance/disable")
    @Roles("manage_system_settings")
    async disableMaintenance(@CurrentUser() user: User) {
        return this.maintenanceService.disableMaintenance(user.id);
    }

    /**
     * Update maintenance mode configuration
     */
    @Put("maintenance/config")
    @Roles("manage_system_settings")
    async updateMaintenanceConfig(
        @Body() body: Partial<MaintenanceModeConfig>,
        @CurrentUser() user: User
    ) {
        return this.maintenanceService.updateMaintenanceConfig(body, user.id);
    }
}
