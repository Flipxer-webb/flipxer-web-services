import { forwardRef, Module } from "@nestjs/common";
import { BankService } from "./services";
import { BankController } from "./controllers";
import { FincraWebhookController } from "./controllers/fincra-webhook.controller";
import { AdminOrderController } from "./controllers/admin-order.controller";
import { PrismaService } from "../../core/prisma/services"; // Assumed existing Prisma service
import { BankFactoryModule } from "@/modules/factory/bank/bank.module";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { MessageModule } from "@/modules/core/messages/message.module";
import { TradingModule } from "../trade";

@Module({
    imports: [BankFactoryModule, TradingFactoryModule, MessageModule, forwardRef(() => TradingModule)],
    providers: [BankService, PrismaService],
    controllers: [BankController, FincraWebhookController, AdminOrderController],
    exports: [BankService],
})
export class BankModule { }


