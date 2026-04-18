import { forwardRef, Module } from "@nestjs/common";
import { FincraWebhookController } from "./controllers";
import { FincraWebhookService } from "./services";
import { BankModule } from "@/modules/api/banks";
import { OperationsModule } from "@/modules/api/operations";
import { TradingModule } from "@/modules/api/trade";
import { NotificationModule } from "@/modules/api/notification/notification.module";

@Module({
    imports: [BankModule, OperationsModule, forwardRef(() => TradingModule), NotificationModule],
    providers: [FincraWebhookService],
    controllers: [FincraWebhookController],
})
export class FincraWebhookModule { }
