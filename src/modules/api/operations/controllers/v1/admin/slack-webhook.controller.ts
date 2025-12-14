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
import { JwtAuthGuard } from "@/modules/api/auth/guards";
import { RolesGuard } from "@/modules/api/rbac/guards";
import { Roles } from "@/modules/api/rbac/decorators";
import { CreateSlackWebhookDto, UpdateSlackWebhookDto } from "../../../types";

@Controller("admin/operations/slack-webhooks")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminSlackWebhookController {
    constructor(private readonly slackService: SlackWebhookService) {}

    /**
     * Get all Slack webhooks
     */
    @Get()
    @Roles("view_system_settings", "manage_system_settings")
    async getWebhooks() {
        return this.slackService.getWebhooks();
    }

    /**
     * Get a specific Slack webhook
     */
    @Get(":id")
    @Roles("view_system_settings", "manage_system_settings")
    async getWebhook(@Param("id", ParseIntPipe) id: number) {
        return this.slackService.getWebhookById(id);
    }

    /**
     * Create a new Slack webhook
     */
    @Post()
    @Roles("manage_system_settings")
    async createWebhook(@Body() dto: CreateSlackWebhookDto) {
        return this.slackService.createWebhook(dto);
    }

    /**
     * Update a Slack webhook
     */
    @Put(":id")
    @Roles("manage_system_settings")
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
    @Roles("manage_system_settings")
    async deleteWebhook(@Param("id", ParseIntPipe) id: number) {
        return this.slackService.deleteWebhook(id);
    }

    /**
     * Test a Slack webhook
     */
    @Post(":id/test")
    @Roles("manage_system_settings")
    async testWebhook(@Param("id", ParseIntPipe) id: number) {
        return this.slackService.testWebhook(id);
    }
}
