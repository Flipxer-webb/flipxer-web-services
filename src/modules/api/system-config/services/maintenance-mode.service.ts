import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { MaintenanceModeConfig } from "../types";

const MAINTENANCE_CACHE_KEY = "system:maintenance_mode";
const MAINTENANCE_CACHE_TTL = 30; // 30 seconds

@Injectable()
export class MaintenanceModeService {
    private readonly logger = new Logger(MaintenanceModeService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly cacheService: RedisCacheService,
    ) {}

    /**
     * Get current maintenance mode configuration
     */
    async getMaintenanceConfig(): Promise<MaintenanceModeConfig> {
        // Check cache first
        const cached = await this.cacheService.get<MaintenanceModeConfig>(MAINTENANCE_CACHE_KEY);
        if (cached !== null) {
            return cached;
        }

        const setting = await this.prisma.systemSetting.findUnique({
            where: { key: "maintenance_mode" },
        });

        const config: MaintenanceModeConfig = setting?.value as MaintenanceModeConfig || {
            enabled: false,
            message: "We are currently performing maintenance. Please try again later.",
            bypassAdmins: true,
        };

        // Cache the config
        await this.cacheService.set(MAINTENANCE_CACHE_KEY, config, MAINTENANCE_CACHE_TTL);

        return config;
    }

    /**
     * Check if maintenance mode is enabled
     */
    async isMaintenanceEnabled(): Promise<boolean> {
        const config = await this.getMaintenanceConfig();
        return config.enabled;
    }

    /**
     * Enable maintenance mode
     */
    async enableMaintenance(
        message: string,
        adminId: number,
        options: { estimatedEndTime?: string; allowedIps?: string[] } = {}
    ): Promise<MaintenanceModeConfig> {
        const config: MaintenanceModeConfig = {
            enabled: true,
            message,
            estimatedEndTime: options.estimatedEndTime,
            allowedIps: options.allowedIps || [],
            bypassAdmins: true,
        };

        await this.prisma.systemSetting.upsert({
            where: { key: "maintenance_mode" },
            update: {
                value: config as any,
                updatedById: adminId,
            },
            create: {
                key: "maintenance_mode",
                value: config as any,
                description: "Maintenance mode configuration",
                updatedById: adminId,
            },
        });

        // Invalidate cache
        await this.cacheService.del(MAINTENANCE_CACHE_KEY);

        this.logger.warn(`Maintenance mode ENABLED by admin ${adminId}: ${message}`);
        return config;
    }

    /**
     * Disable maintenance mode
     */
    async disableMaintenance(adminId: number): Promise<MaintenanceModeConfig> {
        const config: MaintenanceModeConfig = {
            enabled: false,
            message: "",
            bypassAdmins: true,
        };

        await this.prisma.systemSetting.upsert({
            where: { key: "maintenance_mode" },
            update: {
                value: config as any,
                updatedById: adminId,
            },
            create: {
                key: "maintenance_mode",
                value: config as any,
                description: "Maintenance mode configuration",
                updatedById: adminId,
            },
        });

        // Invalidate cache
        await this.cacheService.del(MAINTENANCE_CACHE_KEY);

        this.logger.log(`Maintenance mode DISABLED by admin ${adminId}`);
        return config;
    }

    /**
     * Update maintenance mode configuration
     */
    async updateMaintenanceConfig(
        updates: Partial<MaintenanceModeConfig>,
        adminId: number
    ): Promise<MaintenanceModeConfig> {
        const current = await this.getMaintenanceConfig();
        const config: MaintenanceModeConfig = {
            ...current,
            ...updates,
        };

        await this.prisma.systemSetting.upsert({
            where: { key: "maintenance_mode" },
            update: {
                value: config as any,
                updatedById: adminId,
            },
            create: {
                key: "maintenance_mode",
                value: config as any,
                description: "Maintenance mode configuration",
                updatedById: adminId,
            },
        });

        // Invalidate cache
        await this.cacheService.del(MAINTENANCE_CACHE_KEY);

        this.logger.log(`Maintenance mode config updated by admin ${adminId}`);
        return config;
    }

    /**
     * Check if a request should bypass maintenance mode
     */
    async shouldBypass(ipAddress: string, isAdmin: boolean): Promise<boolean> {
        const config = await this.getMaintenanceConfig();

        // Not in maintenance mode
        if (!config.enabled) {
            return true;
        }

        // Admin bypass
        if (config.bypassAdmins && isAdmin) {
            return true;
        }

        // IP whitelist bypass
        if (config.allowedIps?.includes(ipAddress)) {
            return true;
        }

        return false;
    }
}
