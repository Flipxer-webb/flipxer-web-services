import { forwardRef, Module } from "@nestjs/common";
import { PaystackWebhookController } from "./controllers";
import { PaystackWebhookEvent } from "./events";
import { PaystackWebhookService } from "./services";
import { BankModule } from "@/modules/api/banks";
export * from "./interfaces";

@Module({
    imports: [forwardRef(() => BankModule)],
    providers: [PaystackWebhookService, PaystackWebhookEvent],
    controllers: [PaystackWebhookController],
})
export class PaystackWebhookModule {}
