import { Module } from "@nestjs/common";
import { WalletManagementService } from "./services/wallet-management.service";
import { SlackWebhookService } from "./services/slack-webhook.service";
import { LiquidityAlertService } from "./services/liquidity-alert.service";
import { AdminWalletController } from "./controllers/v1/admin/wallet.controller";
import { AdminSlackWebhookController } from "./controllers/v1/admin/slack-webhook.controller";
import { AdminLiquidityAlertController } from "./controllers/v1/admin/liquidity-alert.controller";

@Module({
    imports: [],
    controllers: [
        AdminWalletController,
        AdminSlackWebhookController,
        AdminLiquidityAlertController,
    ],
    providers: [
        WalletManagementService,
        SlackWebhookService,
        LiquidityAlertService,
    ],
    exports: [
        WalletManagementService,
        SlackWebhookService,
        LiquidityAlertService,
    ],
})
export class OperationsModule {}
