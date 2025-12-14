import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { SystemSettingDto } from "../types";

const SETTINGS_CACHE_PREFIX = "system:settings:";
const SETTINGS_CACHE_TTL = 60; // 1 minute

@Injectable()
export class SystemSettingsService {
    private readonly logger = new Logger(SystemSettingsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly cacheService: RedisCacheService,
    ) {}

    /**
     * Get a system setting by key
     */
    async getSetting<T = any>(key: string): Promise<T | null> {
        // Check cache first
        const cached = await this.cacheService.get<T>(`${SETTINGS_CACHE_PREFIX}${key}`);
        if (cached !== null) {
            return cached;
        }

        const setting = await this.prisma.systemSetting.findUnique({
            where: { key },
        });

        if (!setting) {
            return null;
        }

        // Cache the value
        await this.cacheService.set(
            `${SETTINGS_CACHE_PREFIX}${key}`,
            setting.value,
            SETTINGS_CACHE_TTL
        );

        return setting.value as T;
    }

    /**
     * Set a system setting
     */
    async setSetting(dto: SystemSettingDto, adminId: number): Promise<void> {
        await this.prisma.systemSetting.upsert({
            where: { key: dto.key },
            update: {
                value: dto.value,
                description: dto.description,
                updatedById: adminId,
            },
            create: {
                key: dto.key,
                value: dto.value,
                description: dto.description,
                updatedById: adminId,
            },
        });

        // Invalidate cache
        await this.cacheService.del(`${SETTINGS_CACHE_PREFIX}${dto.key}`);

        this.logger.log(`System setting "${dto.key}" updated by admin ${adminId}`);
    }

    /**
     * Delete a system setting
     */
    async deleteSetting(key: string): Promise<void> {
        await this.prisma.systemSetting.delete({
            where: { key },
        });

        // Invalidate cache
        await this.cacheService.del(`${SETTINGS_CACHE_PREFIX}${key}`);

        this.logger.log(`System setting "${key}" deleted`);
    }

    /**
     * Get all system settings
     */
    async getAllSettings() {
        return this.prisma.systemSetting.findMany({
            orderBy: { key: "asc" },
        });
    }

    /**
     * Get settings by prefix
     */
    async getSettingsByPrefix(prefix: string) {
        return this.prisma.systemSetting.findMany({
            where: {
                key: { startsWith: prefix },
            },
            orderBy: { key: "asc" },
        });
    }

    /**
     * Bulk update settings
     */
    async bulkUpdateSettings(settings: SystemSettingDto[], adminId: number): Promise<void> {
        await this.prisma.$transaction(
            settings.map((dto) =>
                this.prisma.systemSetting.upsert({
                    where: { key: dto.key },
                    update: {
                        value: dto.value,
                        description: dto.description,
                        updatedById: adminId,
                    },
                    create: {
                        key: dto.key,
                        value: dto.value,
                        description: dto.description,
                        updatedById: adminId,
                    },
                })
            )
        );

        // Invalidate all caches
        for (const dto of settings) {
            await this.cacheService.del(`${SETTINGS_CACHE_PREFIX}${dto.key}`);
        }

        this.logger.log(`Bulk updated ${settings.length} system settings by admin ${adminId}`);
    }
}
