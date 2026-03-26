import { Module } from "@nestjs/common";
import { QuidaxWebhookController } from "./controllers";
import { QuidaxWebhookEvent } from "./events";
import { QuidaxWebhookService } from "./services";
import { TradingModule } from "@/modules/api/trade";
import { SessionModule } from "@/modules/api/session";
export * from "./interfaces";

@Module({
    imports: [TradingModule, SessionModule],
    providers: [QuidaxWebhookService, QuidaxWebhookEvent],
    controllers: [QuidaxWebhookController],
})
export class QuidaxWebhookModule {}
