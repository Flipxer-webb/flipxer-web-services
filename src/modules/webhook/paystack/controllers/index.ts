import { PaystackWebhookGuard } from "@/modules/api/auth/guard";
import {
    Body,
    Controller,
    Post,
    Res,
    UseGuards,
    VERSION_NEUTRAL,
} from "@nestjs/common";
import { Response } from "express";
import { PaystackWebhookEvent } from "../events";
import { EventBody } from "../interfaces";

@UseGuards(PaystackWebhookGuard)
@Controller({
    path: "paystack",
    version: VERSION_NEUTRAL,
})
export class PaystackWebhookController {
    constructor(private readonly paystackWebhookEvent: PaystackWebhookEvent) {}

    @Post()
    async processWebhook(@Body() eventBody: EventBody, @Res() res: Response) {
        this.paystackWebhookEvent.emit("process-webhook-event", eventBody);
        res.sendStatus(200);
    }
}
