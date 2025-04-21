import { Module } from "@nestjs/common";
import { QuidaxWebhookController } from "./controllers";
import { QuidaxWebhookEvent } from "./events";
import { QuidaxWebhookService } from "./services";
import { TradingModule } from "@/modules/api/trade";
export * from "./interfaces";

@Module({
    imports: [TradingModule],
    providers: [QuidaxWebhookService, QuidaxWebhookEvent],
    controllers: [QuidaxWebhookController],
})
export class QuidaxWebhookModule {}
