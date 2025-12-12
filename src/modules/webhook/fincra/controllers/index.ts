import { FincraWebhookGuard } from "@/modules/api/auth/guard";
import {
    Body,
    Controller,
    Post,
    Res,
    UseGuards,
    VERSION_NEUTRAL,
} from "@nestjs/common";
import { Response } from "express";
import { FincraWebhookService } from "../services";
import { FincraWebhookPayload } from "../interfaces";

@UseGuards(FincraWebhookGuard)
@Controller({
    path: "fincra",
    version: VERSION_NEUTRAL,
})
export class FincraWebhookController {
    constructor(private readonly fincraWebhookService: FincraWebhookService) {}

    @Post()
    async processWebhook(
        @Body() eventBody: FincraWebhookPayload,
        @Res() res: Response
    ) {
        await this.fincraWebhookService.processWebhookEvent(eventBody);
        res.sendStatus(200);
    }
}
