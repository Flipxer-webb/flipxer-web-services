import { QuidaxWebhookGuard } from "@/modules/api/auth/guard";
import {
    Body,
    Controller,
    Post,
    Res,
    UseGuards,
    VERSION_NEUTRAL,
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
    constructor(private readonly quidaxWebhookEvent: QuidaxWebhookEvent) {}

    @Post()
    async processWebhook(@Body() eventBody: EventBody, @Res() res: Response) {
        console.log("data", { eventBody });
        this.quidaxWebhookEvent.emit("process-webhook-event", eventBody);
        res.sendStatus(200);
    }
}
