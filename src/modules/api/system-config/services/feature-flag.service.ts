import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { 
    FeatureFlagDto, 
    UpdateFeatureFlagDto, 
    FeatureFlagConditions,
    FeatureFlagEvaluationContext,
    FeatureFlagAuditEntry,
} from "../types";
import { FeatureFlagAction } from "@prisma/client";
import * as crypto from "crypto";

const FLAG_CACHE_PREFIX = "system:feature_flag:";
const FLAG_CACHE_TTL = 60; // 1 minute

@Injectable()
export class FeatureFlagService {
    private readonly logger = new Logger(FeatureFlagService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly cacheService: RedisCacheService,
    ) {}

    /**
     * Create a new feature flag
     */
    async createFlag(dto: FeatureFlagDto, adminId: number, adminEmail?: string): Promise<any> {
        const flag = await this.prisma.featureFlag.create({
            data: {
                key: dto.key,
                name: dto.name,
                description: dto.description,
                isEnabled: dto.isEnabled,
                conditions: dto.conditions as any,
            },
        });

        // Log the creation
        await this.logAudit(flag.id, {
            action: "CREATED",
            newValue: dto,
            changedById: adminId,
            changedByEmail: adminEmail,
        });

        this.logger.log(`Feature flag "${dto.key}" created by admin ${adminId}`);
        return flag;
    }

    /**
     * Update a feature flag
     */
    async updateFlag(id: number, dto: UpdateFeatureFlagDto, adminId: number, adminEmail?: string, reason?: string): Promise<any> {
        const previousFlag = await this.prisma.featureFlag.findUnique({
            where: { id },
        });

        if (!previousFlag) {
            throw new Error("Feature flag not found");
        }

        const flag = await this.prisma.featureFlag.update({
            where: { id },
            data: {
                name: dto.name,
                description: dto.description,
                isEnabled: dto.isEnabled,
                conditions: dto.conditions as any,
            },
        });

        // Determine audit action
        let action: FeatureFlagAction = "CONDITIONS_UPDATED";
        if (dto.isEnabled !== undefined && dto.isEnabled !== previousFlag.isEnabled) {
            action = dto.isEnabled ? "ENABLED" : "DISABLED";
        }

        // Log the update
        await this.logAudit(flag.id, {
            action,
            previousValue: {
                isEnabled: previousFlag.isEnabled,
                conditions: previousFlag.conditions,
            },
            newValue: {
                isEnabled: flag.isEnabled,
                conditions: flag.conditions,
            },
            changedById: adminId,
            changedByEmail: adminEmail,
            reason,
        });

        // Invalidate cache
        await this.cacheService.del(`${FLAG_CACHE_PREFIX}${previousFlag.key}`);

        this.logger.log(`Feature flag "${previousFlag.key}" updated by admin ${adminId}`);
        return flag;
    }

    /**
     * Delete a feature flag
     */
    async deleteFlag(id: number, adminId: number, adminEmail?: string): Promise<void> {
        const flag = await this.prisma.featureFlag.findUnique({
            where: { id },
        });

        if (!flag) {
            throw new Error("Feature flag not found");
        }

        // Log deletion before deleting
        await this.logAudit(flag.id, {
            action: "DELETED",
            previousValue: flag,
            changedById: adminId,
            changedByEmail: adminEmail,
        });

        await this.prisma.featureFlag.delete({
            where: { id },
        });

        // Invalidate cache
        await this.cacheService.del(`${FLAG_CACHE_PREFIX}${flag.key}`);

        this.logger.log(`Feature flag "${flag.key}" deleted by admin ${adminId}`);
    }

    /**
     * Get all feature flags
     */
    async getAllFlags() {
        return this.prisma.featureFlag.findMany({
            orderBy: { key: "asc" },
        });
    }

    /**
     * Get a feature flag by key
     */
    async getFlagByKey(key: string) {
        // Check cache first
        const cached = await this.cacheService.get<any>(`${FLAG_CACHE_PREFIX}${key}`);
        if (cached !== null) {
            return cached;
        }

        const flag = await this.prisma.featureFlag.findUnique({
            where: { key },
        });

        if (flag) {
            await this.cacheService.set(`${FLAG_CACHE_PREFIX}${key}`, flag, FLAG_CACHE_TTL);
        }

        return flag;
    }

    /**
     * Evaluate if a feature flag is enabled for a given context
     */
    async evaluateFlag(key: string, context: FeatureFlagEvaluationContext): Promise<boolean> {
        const flag = await this.getFlagByKey(key);

        if (!flag) {
            return false;
        }

        if (!flag.isEnabled) {
            return false;
        }

        const conditions = flag.conditions as FeatureFlagConditions | null;
        
        if (!conditions) {
            // No conditions, flag is globally enabled
            return true;
        }

        return this.evaluateConditions(conditions, context);
    }

    /**
     * Evaluate flag conditions against context
     */
    private evaluateConditions(
        conditions: FeatureFlagConditions, 
        context: FeatureFlagEvaluationContext
    ): boolean {
        // Check excluded users first
        if (conditions.excludeUserIds?.includes(context.userId!)) {
            return false;
        }

        // Check allowed users (override all other conditions)
        if (conditions.allowedUserIds?.includes(context.userId!)) {
            return true;
        }

        // Check date conditions
        if (conditions.startDate) {
            const start = new Date(conditions.startDate);
            if (new Date() < start) return false;
        }

        if (conditions.endDate) {
            const end = new Date(conditions.endDate);
            if (new Date() > end) return false;
        }

        // Check tier conditions
        if (context.userTier !== undefined) {
            if (conditions.tiers && !conditions.tiers.includes(context.userTier)) {
                return false;
            }
            if (conditions.minTier !== undefined && context.userTier < conditions.minTier) {
                return false;
            }
            if (conditions.maxTier !== undefined && context.userTier > conditions.maxTier) {
                return false;
            }
        }

        // Check country conditions
        if (context.userCountry) {
            if (conditions.excludeCountries?.includes(context.userCountry)) {
                return false;
            }
            if (conditions.countries && !conditions.countries.includes(context.userCountry)) {
                return false;
            }
        }

        // Check user type conditions
        if (context.userType && conditions.userTypes) {
            if (!conditions.userTypes.includes(context.userType)) {
                return false;
            }
        }

        // Check percentage rollout
        if (conditions.percentageEnabled !== undefined && context.userId) {
            const percentage = this.getUserPercentage(context.userId);
            if (percentage > conditions.percentageEnabled) {
                return false;
            }
        }

        return true;
    }

    /**
     * Calculate consistent percentage bucket for a user (0-100)
     */
    private getUserPercentage(userId: number): number {
        const hash = crypto.createHash("md5").update(String(userId)).digest("hex");
        const num = parseInt(hash.substring(0, 8), 16);
        return num % 100;
    }

    /**
     * Log an audit entry for feature flag changes
     */
    private async logAudit(flagId: number, entry: FeatureFlagAuditEntry): Promise<void> {
        await this.prisma.featureFlagAuditLog.create({
            data: {
                flagId,
                action: entry.action,
                previousValue: entry.previousValue,
                newValue: entry.newValue,
                changedById: entry.changedById,
                changedByEmail: entry.changedByEmail,
                reason: entry.reason,
            },
        });
    }

    /**
     * Get audit log for a feature flag
     */
    async getAuditLog(flagId: number, limit: number = 50) {
        return this.prisma.featureFlagAuditLog.findMany({
            where: { flagId },
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    }

    /**
     * Get all audit logs
     */
    async getAllAuditLogs(limit: number = 100) {
        return this.prisma.featureFlagAuditLog.findMany({
            include: {
                flag: {
                    select: {
                        key: true,
                        name: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    }

    /**
     * Bulk evaluate multiple flags for a context
     */
    async evaluateFlags(keys: string[], context: FeatureFlagEvaluationContext): Promise<Record<string, boolean>> {
        const results: Record<string, boolean> = {};
        
        for (const key of keys) {
            results[key] = await this.evaluateFlag(key, context);
        }
        
        return results;
    }
}
