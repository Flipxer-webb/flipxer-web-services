import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    ParseIntPipe,
    Req,
    UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { SlackWebhookService } from "../../../services/slack-webhook.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { CreateSlackWebhookDto, UpdateSlackWebhookDto } from "../../../types";
import { AuditLogService } from "@/modules/api/audit-log";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/slack-webhooks")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminSlackWebhookController {
    constructor(
        private readonly slackService: SlackWebhookService,
        private readonly auditLogService: AuditLogService,
    ) {}

    /**
     * Get all Slack webhooks
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get()
    async getWebhooks() {
        const webhooks = await this.slackService.getWebhooks();
        return buildResponse({
            message: "Slack webhooks retrieved successfully",
            data: webhooks,
        });
    }

    /**
     * Get a specific Slack webhook
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Get(":id")
    async getWebhook(@Param("id", ParseIntPipe) id: number) {
        const webhook = await this.slackService.getWebhookById(id);
        return buildResponse({
            message: "Slack webhook retrieved successfully",
            data: webhook,
        });
    }

    /**
     * Create a new Slack webhook
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post()
    async createWebhook(@Body() dto: CreateSlackWebhookDto, @Req() req: Request) {
        const webhook = await this.slackService.createWebhook(dto);
        await this.auditLogService.log({
            action: "CREATE_SLACK_WEBHOOK",
            resource: "slack_webhook",
            resourceId: webhook.id?.toString(),
            details: { name: dto.name, channel: dto.channel },
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return buildResponse({
            message: "Slack webhook created successfully",
            data: webhook,
        });
    }

    /**
     * Update a Slack webhook
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Put(":id")
    async updateWebhook(
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: UpdateSlackWebhookDto,
        @Req() req: Request
    ) {
        const webhook = await this.slackService.updateWebhook(id, dto);
        await this.auditLogService.log({
            action: "UPDATE_SLACK_WEBHOOK",
            resource: "slack_webhook",
            resourceId: id.toString(),
            details: { ...dto },
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return buildResponse({
            message: "Slack webhook updated successfully",
            data: webhook,
        });
    }

    /**
     * Delete a Slack webhook
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Delete(":id")
    async deleteWebhook(@Param("id", ParseIntPipe) id: number, @Req() req: Request) {
        await this.slackService.deleteWebhook(id);
        await this.auditLogService.log({
            action: "DELETE_SLACK_WEBHOOK",
            resource: "slack_webhook",
            resourceId: id.toString(),
            adminId: (req as any).user?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return buildResponse({
            message: "Webhook deleted successfully",
        });
    }

    /**
     * Test a Slack webhook
     */
    @Permissions([PermissionName.SYSTEM_SETTINGS])
    @Post(":id/test")
    async testWebhook(@Param("id", ParseIntPipe) id: number) {
        const result = await this.slackService.testWebhook(id);
        return buildResponse({
            message: "Webhook test completed",
            data: result,
        });
    }
}
