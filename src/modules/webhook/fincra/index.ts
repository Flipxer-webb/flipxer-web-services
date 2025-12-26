import { Module } from "@nestjs/common";
import { FincraWebhookController } from "./controllers";
import { FincraWebhookService } from "./services";
import { BankModule } from "@/modules/api/banks";
import { OperationsModule } from "@/modules/api/operations";

@Module({
    imports: [BankModule, OperationsModule],
    providers: [FincraWebhookService],
    controllers: [FincraWebhookController],
})
export class FincraWebhookModule { }
