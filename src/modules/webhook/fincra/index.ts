import { Module } from "@nestjs/common";
import { FincraWebhookController } from "./controllers";
import { FincraWebhookService } from "./services";
import { BankModule } from "@/modules/api/banks";

@Module({
    imports: [BankModule],
    providers: [FincraWebhookService],
    controllers: [FincraWebhookController],
})
export class FincraWebhookModule {}
