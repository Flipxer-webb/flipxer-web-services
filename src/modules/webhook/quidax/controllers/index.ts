import { QuidaxWebhookGuard } from "@/modules/api/auth/guard";
import {
    Body,
    Controller,
    Post,
    Res,
    UseGuards,
    VERSION_NEUTRAL,
    Logger,
} from "@nestjs/common";
import { Response } from "express";
import { QuidaxWebhookEvent } from "../events";
import { EventBody } from "../interfaces";

@UseGuards(QuidaxWebhookGuard)
@Controller({
    path: "quidax",
    version: VERSION_NEUTRAL,
})
export class QuidaxWebhookController {
    private readonly logger = new Logger("QuidaxWebhook");
    
    constructor(private readonly quidaxWebhookEvent: QuidaxWebhookEvent) {}

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
}
