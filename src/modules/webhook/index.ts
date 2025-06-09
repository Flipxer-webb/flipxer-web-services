import { Module } from "@nestjs/common";
import { RouterModule } from "@nestjs/core";
import { QuidaxWebhookModule } from "./quidax";
import { PaystackWebhookModule } from "./paystack";

@Module({
    imports: [
        QuidaxWebhookModule,
        PaystackWebhookModule,
        RouterModule.register([
            {
                path: "webhook",
                module: QuidaxWebhookModule,
            },
            {
                path: "webhook",
                module: PaystackWebhookModule,
            },
        ]),
    ],
})
export class WebhookModule {}
