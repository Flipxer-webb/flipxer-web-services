import { Module } from "@nestjs/common";
import { RouterModule } from "@nestjs/core";
import { QuidaxWebhookModule } from "./quidax";
import { FincraWebhookModule } from "./fincra";

@Module({
    imports: [
        QuidaxWebhookModule,
        FincraWebhookModule,
        RouterModule.register([
            {
                path: "webhook",
                module: QuidaxWebhookModule,
            },
            {
                path: "webhook",
                module: FincraWebhookModule,
            },
        ]),
    ],
})
export class WebhookModule {}
