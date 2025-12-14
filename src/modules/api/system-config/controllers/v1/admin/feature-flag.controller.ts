import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    ParseIntPipe,
    UseGuards,
} from "@nestjs/common";
import { FeatureFlagService } from "../../../services/feature-flag.service";
import { JwtAuthGuard } from "@/modules/api/auth/guards";
import { RolesGuard } from "@/modules/api/rbac/guards";
import { Roles } from "@/modules/api/rbac/decorators";
import { CurrentUser } from "@/modules/api/auth/decorators";
import { User } from "@prisma/client";
import { FeatureFlagDto, UpdateFeatureFlagDto, FeatureFlagEvaluationContext } from "../../../types";

@Controller("admin/system/feature-flags")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminFeatureFlagController {
    constructor(private readonly flagService: FeatureFlagService) {}

    /**
     * Get all feature flags
     */
    @Get()
    @Roles("view_system_settings", "manage_feature_flags")
    async getAllFlags() {
        return this.flagService.getAllFlags();
    }

    /**
     * Get a feature flag by key
     */
    @Get("key/:key")
    @Roles("view_system_settings", "manage_feature_flags")
    async getFlagByKey(@Param("key") key: string) {
        return this.flagService.getFlagByKey(key);
    }

    /**
     * Create a new feature flag
     */
    @Post()
    @Roles("manage_feature_flags")
    async createFlag(
        @Body() dto: FeatureFlagDto,
        @CurrentUser() user: User
    ) {
        return this.flagService.createFlag(dto, user.id, user.email);
    }

    /**
     * Update a feature flag
     */
    @Put(":id")
    @Roles("manage_feature_flags")
    async updateFlag(
        @Param("id", ParseIntPipe) id: number,
        @Body() body: UpdateFeatureFlagDto & { reason?: string },
        @CurrentUser() user: User
    ) {
        const { reason, ...dto } = body;
        return this.flagService.updateFlag(id, dto, user.id, user.email, reason);
    }

    /**
     * Enable a feature flag
     */
    @Post(":id/enable")
    @Roles("manage_feature_flags")
    async enableFlag(
        @Param("id", ParseIntPipe) id: number,
        @Body() body: { reason?: string },
        @CurrentUser() user: User
    ) {
        return this.flagService.updateFlag(
            id,
            { isEnabled: true },
            user.id,
            user.email,
            body.reason
        );
    }

    /**
     * Disable a feature flag
     */
    @Post(":id/disable")
    @Roles("manage_feature_flags")
    async disableFlag(
        @Param("id", ParseIntPipe) id: number,
        @Body() body: { reason?: string },
        @CurrentUser() user: User
    ) {
        return this.flagService.updateFlag(
            id,
            { isEnabled: false },
            user.id,
            user.email,
            body.reason
        );
    }

    /**
     * Delete a feature flag
     */
    @Delete(":id")
    @Roles("manage_feature_flags")
    async deleteFlag(
        @Param("id", ParseIntPipe) id: number,
        @CurrentUser() user: User
    ) {
        await this.flagService.deleteFlag(id, user.id, user.email);
        return { message: "Feature flag deleted successfully" };
    }

    /**
     * Evaluate a feature flag for a specific context
     */
    @Post("evaluate")
    @Roles("view_system_settings", "manage_feature_flags")
    async evaluateFlag(
        @Body() body: { key: string; context: FeatureFlagEvaluationContext }
    ) {
        const result = await this.flagService.evaluateFlag(body.key, body.context);
        return { key: body.key, enabled: result };
    }

    /**
     * Bulk evaluate multiple feature flags
     */
    @Post("evaluate/bulk")
    @Roles("view_system_settings", "manage_feature_flags")
    async evaluateFlags(
        @Body() body: { keys: string[]; context: FeatureFlagEvaluationContext }
    ) {
        return this.flagService.evaluateFlags(body.keys, body.context);
    }

    /**
     * Get audit log for a specific flag
     */
    @Get(":id/audit-log")
    @Roles("view_system_settings", "manage_feature_flags")
    async getFlagAuditLog(
        @Param("id", ParseIntPipe) id: number,
        @Query("limit", new ParseIntPipe({ optional: true })) limit?: number
    ) {
        return this.flagService.getAuditLog(id, limit || 50);
    }

    /**
     * Get all audit logs
     */
    @Get("audit-log/all")
    @Roles("view_system_settings", "manage_feature_flags")
    async getAllAuditLogs(
        @Query("limit", new ParseIntPipe({ optional: true })) limit?: number
    ) {
        return this.flagService.getAllAuditLogs(limit || 100);
    }
}
