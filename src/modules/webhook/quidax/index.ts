import { Module } from "@nestjs/common";
import { QuidaxWebhookController } from "./controllers";
import { QuidaxWebhookEvent } from "./events";
import { QuidaxWebhookService } from "./services";
export * from "./interfaces";

@Module({
    imports: [],
    providers: [QuidaxWebhookService, QuidaxWebhookEvent],
    controllers: [QuidaxWebhookController],
})
export class QuidaxWebhookModule {}
