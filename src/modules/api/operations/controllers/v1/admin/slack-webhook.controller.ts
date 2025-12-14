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
import { UserTypes } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import { CreateSlackWebhookDto, UpdateSlackWebhookDto } from "../../../types";

@Controller("admin/slack-webhooks")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes([UserType.ADMIN])
export class AdminSlackWebhookController {
    constructor(private readonly slackService: SlackWebhookService) {}

    /**
     * Get all Slack webhooks
     */
    @Get()
    async getWebhooks() {
        return this.slackService.getWebhooks();
    }

    /**
     * Get a specific Slack webhook
     */
    @Get(":id")
    async getWebhook(@Param("id", ParseIntPipe) id: number) {
        return this.slackService.getWebhookById(id);
    }

    /**
     * Create a new Slack webhook
     */
    @Post()
    async createWebhook(@Body() dto: CreateSlackWebhookDto) {
        return this.slackService.createWebhook(dto);
    }

    /**
     * Update a Slack webhook
     */
    @Put(":id")
    async updateWebhook(
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: UpdateSlackWebhookDto
    ) {
        return this.slackService.updateWebhook(id, dto);
    }

    /**
     * Delete a Slack webhook
     */
    @Delete(":id")
    async deleteWebhook(@Param("id", ParseIntPipe) id: number) {
        await this.slackService.deleteWebhook(id);
        return { message: "Webhook deleted successfully" };
    }

    /**
     * Test a Slack webhook
     */
    @Post(":id/test")
    async testWebhook(@Param("id", ParseIntPipe) id: number) {
        return this.slackService.testWebhook(id);
    }
}
