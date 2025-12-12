import { Module } from "@nestjs/common";
import { FincraWebhookController } from "./controllers";
import { FincraWebhookService } from "./services";

@Module({
    providers: [FincraWebhookService],
    controllers: [FincraWebhookController],
})
export class FincraWebhookModule {}
