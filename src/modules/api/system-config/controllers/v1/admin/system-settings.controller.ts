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
import { UserTypes } from "@/modules/api/authorize/decorator";
import { User } from "@/modules/api/user";
import { User as UserModel, UserType } from "@prisma/client";
import { SystemSettingDto, MaintenanceModeConfig } from "../../../types";

@Controller("admin/settings/system")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN])
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
        return this.settingsService.getAllSettings();
    }

    /**
     * Get a specific setting by key
     */
    @Get(":key")
    async getSetting(@Param("key") key: string) {
        const value = await this.settingsService.getSetting(key);
        return { key, value };
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
        return { message: "Setting saved successfully" };
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
        return { message: `${settings.length} settings updated successfully` };
    }

    /**
     * Delete a setting
     */
    @Delete(":key")
    async deleteSetting(@Param("key") key: string) {
        await this.settingsService.deleteSetting(key);
        return { message: "Setting deleted successfully" };
    }

    /**
     * Get current maintenance mode status
     */
    @Get("maintenance/status")
    async getMaintenanceStatus() {
        return this.maintenanceService.getMaintenanceConfig();
    }

    /**
     * Enable maintenance mode
     */
    @Post("maintenance/enable")
    async enableMaintenanceMode(
        @Body() body: { message: string; estimatedEndTime?: string; allowedIps?: string[] },
        @User() user: UserModel
    ) {
        return this.maintenanceService.enableMaintenance(
            body.message,
            user.id,
            {
                estimatedEndTime: body.estimatedEndTime,
                allowedIps: body.allowedIps,
            }
        );
    }

    /**
     * Disable maintenance mode
     */
    @Post("maintenance/disable")
    async disableMaintenanceMode(@User() user: UserModel) {
        return this.maintenanceService.disableMaintenance(user.id);
    }

    /**
     * Update maintenance mode configuration
     */
    @Put("maintenance")
    async updateMaintenanceConfig(
        @Body() config: Partial<MaintenanceModeConfig>,
        @User() user: UserModel
    ) {
        return this.maintenanceService.updateMaintenanceConfig(config, user.id);
    }
}
