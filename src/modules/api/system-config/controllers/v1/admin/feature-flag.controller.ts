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
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes } from "@/modules/api/authorize/decorator";
import { User } from "@/modules/api/user";
import { User as UserModel, UserType } from "@prisma/client";
import { FeatureFlagDto, UpdateFeatureFlagDto, FeatureFlagEvaluationContext } from "../../../types";

@Controller("admin/feature-flags")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN])
export class AdminFeatureFlagController {
    constructor(private readonly flagService: FeatureFlagService) {}

    /**
     * Get all feature flags
     */
    @Get()
    async getAllFlags() {
        return this.flagService.getAllFlags();
    }

    /**
     * Get a feature flag by key
     */
    @Get("key/:key")
    async getFlagByKey(@Param("key") key: string) {
        return this.flagService.getFlagByKey(key);
    }

    /**
     * Create a new feature flag
     */
    @Post()
    async createFlag(
        @Body() dto: FeatureFlagDto,
        @User() user: UserModel
    ) {
        return this.flagService.createFlag(dto, user.id);
    }

    /**
     * Update a feature flag
     */
    @Put(":id")
    async updateFlag(
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: UpdateFeatureFlagDto,
        @User() user: UserModel
    ) {
        return this.flagService.updateFlag(id, dto, user.id);
    }

    /**
     * Delete a feature flag
     */
    @Delete(":id")
    async deleteFlag(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        await this.flagService.deleteFlag(id, user.id);
        return { message: "Feature flag deleted successfully" };
    }

    /**
     * Enable a feature flag
     */
    @Put(":id/enable")
    async enableFlag(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        return this.flagService.updateFlag(id, { isEnabled: true }, user.id);
    }

    /**
     * Disable a feature flag
     */
    @Put(":id/disable")
    async disableFlag(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        return this.flagService.updateFlag(id, { isEnabled: false }, user.id);
    }

    /**
     * Get feature flag audit log
     */
    @Get(":id/audit")
    async getFlagAuditLog(
        @Param("id", ParseIntPipe) id: number,
        @Query("limit", new ParseIntPipe({ optional: true })) limit?: number
    ) {
        return this.flagService.getAuditLog(id, limit || 50);
    }

    /**
     * Evaluate a feature flag for a specific context
     */
    @Post("evaluate/:key")
    async evaluateFlag(
        @Param("key") key: string,
        @Body() context: FeatureFlagEvaluationContext
    ) {
        const isEnabled = await this.flagService.evaluateFlag(key, context);
        return { key, enabled: isEnabled, context };
    }

    /**
     * Evaluate multiple feature flags at once
     */
    @Post("evaluate-batch")
    async evaluateFlagsBatch(
        @Body() body: { keys: string[]; context: FeatureFlagEvaluationContext }
    ) {
        const results = await this.flagService.evaluateFlags(body.keys, body.context);
        return { flags: results, context: body.context };
    }

    /**
     * Get feature flag statistics overview
     */
    @Get("statistics/overview")
    async getFlagStatistics() {
        const flags = await this.flagService.getAllFlags();
        const enabledCount = flags.filter(f => f.isEnabled).length;
        return {
            total: flags.length,
            enabled: enabledCount,
            disabled: flags.length - enabledCount,
        };
    }
}
