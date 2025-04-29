import { Module } from "@nestjs/common";
import { RouterModule } from "@nestjs/core";
import { QuidaxWebhookModule } from "./quidax";

@Module({
    imports: [
        QuidaxWebhookModule,
        RouterModule.register([
            {
                path: "webhook",
                module: QuidaxWebhookModule,
            },
        ]),
    ],
})
export class WebhookModule {}
