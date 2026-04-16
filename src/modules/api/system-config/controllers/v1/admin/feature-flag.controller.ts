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
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { User } from "@/modules/api/user/decorators";
import { User as UserModel } from "@prisma/client";
import { FeatureFlagDto, UpdateFeatureFlagDto, FeatureFlagEvaluationContext } from "../../../types";
import { AuditLogService } from "@/modules/api/audit-log";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/feature-flags")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminFeatureFlagController {
    constructor(
        private readonly flagService: FeatureFlagService,
        private readonly auditLogService: AuditLogService,
    ) {}

    /**
     * Get all feature flags
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get()
    async getAllFlags() {
        const flags = await this.flagService.getAllFlags();
        return buildResponse({
            message: "Feature flags retrieved successfully",
            data: flags,
        });
    }

    /**
     * Get a feature flag by key
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get("key/:key")
    async getFlagByKey(@Param("key") key: string) {
        const flag = await this.flagService.getFlagByKey(key);
        return buildResponse({
            message: "Feature flag retrieved successfully",
            data: flag,
        });
    }

    /**
     * Create a new feature flag
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post()
    async createFlag(
        @Body() dto: FeatureFlagDto,
        @User() user: UserModel
    ) {
        const flag = await this.flagService.createFlag(dto, user.id);
        await this.auditLogService.log({
            action: "CREATE_FEATURE_FLAG",
            resource: "feature_flag",
            resourceId: flag.id?.toString(),
            details: { key: dto.key, isEnabled: dto.isEnabled },
            adminId: user.id,
        });
        return buildResponse({
            message: "Feature flag created successfully",
            data: flag,
        });
    }

    /**
     * Update a feature flag
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Put(":id")
    async updateFlag(
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: UpdateFeatureFlagDto,
        @User() user: UserModel
    ) {
        const flag = await this.flagService.updateFlag(id, dto, user.id);
        await this.auditLogService.log({
            action: "UPDATE_FEATURE_FLAG",
            resource: "feature_flag",
            resourceId: id.toString(),
            details: { ...dto },
            adminId: user.id,
        });
        return buildResponse({
            message: "Feature flag updated successfully",
            data: flag,
        });
    }

    /**
     * Delete a feature flag
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Delete(":id")
    async deleteFlag(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        await this.flagService.deleteFlag(id, user.id);
        await this.auditLogService.log({
            action: "DELETE_FEATURE_FLAG",
            resource: "feature_flag",
            resourceId: id.toString(),
            adminId: user.id,
        });
        return buildResponse({
            message: "Feature flag deleted successfully",
        });
    }

    /**
     * Enable a feature flag
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Put(":id/enable")
    async enableFlag(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        const flag = await this.flagService.updateFlag(id, { isEnabled: true }, user.id);
        await this.auditLogService.log({
            action: "ENABLE_FEATURE_FLAG",
            resource: "feature_flag",
            resourceId: id.toString(),
            adminId: user.id,
        });
        return buildResponse({
            message: "Feature flag enabled successfully",
            data: flag,
        });
    }

    /**
     * Disable a feature flag
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Put(":id/disable")
    async disableFlag(
        @Param("id", ParseIntPipe) id: number,
        @User() user: UserModel
    ) {
        const flag = await this.flagService.updateFlag(id, { isEnabled: false }, user.id);
        await this.auditLogService.log({
            action: "DISABLE_FEATURE_FLAG",
            resource: "feature_flag",
            resourceId: id.toString(),
            adminId: user.id,
        });
        return buildResponse({
            message: "Feature flag disabled successfully",
            data: flag,
        });
    }

    /**
     * Get feature flag audit log
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get(":id/audit")
    async getFlagAuditLog(
        @Param("id", ParseIntPipe) id: number,
        @Query("limit", new ParseIntPipe({ optional: true })) limit?: number
    ) {
        const auditLog = await this.flagService.getAuditLog(id, limit || 50);
        return buildResponse({
            message: "Feature flag audit log retrieved successfully",
            data: auditLog,
        });
    }

    /**
     * Evaluate a feature flag for a specific context
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post("evaluate/:key")
    async evaluateFlag(
        @Param("key") key: string,
        @Body() context: FeatureFlagEvaluationContext
    ) {
        const isEnabled = await this.flagService.evaluateFlag(key, context);
        return buildResponse({
            message: "Feature flag evaluated successfully",
            data: { key, enabled: isEnabled, context },
        });
    }

    /**
     * Evaluate multiple feature flags at once
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post("evaluate-batch")
    async evaluateFlagsBatch(
        @Body() body: { keys: string[]; context: FeatureFlagEvaluationContext }
    ) {
        const results = await this.flagService.evaluateFlags(body.keys, body.context);
        return buildResponse({
            message: "Feature flags evaluated successfully",
            data: { flags: results, context: body.context },
        });
    }

    /**
     * Get feature flag statistics overview
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get("statistics/overview")
    async getFlagStatistics() {
        const flags = await this.flagService.getAllFlags();
        const enabledCount = flags.filter(f => f.isEnabled).length;
        return buildResponse({
            message: "Feature flag statistics retrieved successfully",
            data: {
                total: flags.length,
                enabled: enabledCount,
                disabled: flags.length - enabledCount,
            },
        });
    }
}
