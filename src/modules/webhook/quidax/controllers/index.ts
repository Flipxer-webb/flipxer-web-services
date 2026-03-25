import { QuidaxWebhookGuard, AuthGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { UserTypes, ADMIN_USER_TYPES } from "@/modules/api/authorize/decorator";
import { UserType } from "@prisma/client";
import {
    Body,
    Controller,
    Get,
    Post,
    Res,
    UseGuards,
    VERSION_NEUTRAL,
    Logger,
} from "@nestjs/common";
import { Response } from "express";
import { QuidaxWebhookEvent } from "../events";
import { EventBody } from "../interfaces";
import { QuidaxWebhookService } from "../services";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";

@ApiTags("Webhooks")
@Controller({
    path: "quidax",
    version: VERSION_NEUTRAL,
})
export class QuidaxWebhookController {
    private readonly logger = new Logger("QuidaxWebhook");
    
    constructor(
        private readonly quidaxWebhookEvent: QuidaxWebhookEvent,
        private readonly quidaxWebhookService: QuidaxWebhookService,
    ) {}

    @UseGuards(QuidaxWebhookGuard)
    @Post()
    async processWebhook(@Body() eventBody: EventBody, @Res() res: Response) {
        // Log all incoming webhooks with detailed information
        this.logger.log(`[WEBHOOK RECEIVED] Event: ${eventBody.event}`);
        this.logger.debug(`[WEBHOOK DATA] ${JSON.stringify(eventBody.data)}`);
        
        try {
            this.quidaxWebhookEvent.emit("process-webhook-event", eventBody);
            this.logger.log(`[WEBHOOK QUEUED] Event: ${eventBody.event} - Processing started`);
            res.sendStatus(200);
        } catch (error) {
            this.logger.error(`[WEBHOOK ERROR] Event: ${eventBody.event} - Error: ${error.message}`);
            res.sendStatus(500);
        }
    }

    @UseGuards(AuthGuard, RoleGuard)
    @UserTypes(ADMIN_USER_TYPES)
    @ApiBearerAuth()
    @Get("metrics")
    @ApiOperation({ summary: "Get webhook processing metrics (Admin only)" })
    getMetrics() {
        return {
            success: true,
            message: "Webhook metrics retrieved",
            data: this.quidaxWebhookService.getMetrics(),
        };
    }
}
