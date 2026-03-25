import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    ParseIntPipe,
    UseGuards,
} from "@nestjs/common";
import { SlackWebhookService } from "../../../services/slack-webhook.service";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { CreateSlackWebhookDto, UpdateSlackWebhookDto } from "../../../types";
import { buildResponse } from "@/utils/api-response-util";

@Controller("admin/slack-webhooks")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
export class AdminSlackWebhookController {
    constructor(private readonly slackService: SlackWebhookService) {}

    /**
     * Get all Slack webhooks
     */
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
    @Post()
    async createWebhook(@Body() dto: CreateSlackWebhookDto) {
        const webhook = await this.slackService.createWebhook(dto);
        return buildResponse({
            message: "Slack webhook created successfully",
            data: webhook,
        });
    }

    /**
     * Update a Slack webhook
     */
    @Put(":id")
    async updateWebhook(
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: UpdateSlackWebhookDto
    ) {
        const webhook = await this.slackService.updateWebhook(id, dto);
        return buildResponse({
            message: "Slack webhook updated successfully",
            data: webhook,
        });
    }

    /**
     * Delete a Slack webhook
     */
    @Delete(":id")
    async deleteWebhook(@Param("id", ParseIntPipe) id: number) {
        await this.slackService.deleteWebhook(id);
        return buildResponse({
            message: "Webhook deleted successfully",
        });
    }

    /**
     * Test a Slack webhook
     */
    @Post(":id/test")
    async testWebhook(@Param("id", ParseIntPipe) id: number) {
        const result = await this.slackService.testWebhook(id);
        return buildResponse({
            message: "Webhook test completed",
            data: result,
        });
    }
}
