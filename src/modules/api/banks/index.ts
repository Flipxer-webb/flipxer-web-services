import { Module } from "@nestjs/common";
import { BankService } from "./services";
import { BankController } from "./controllers";
import { PrismaService } from "../../core/prisma/services"; // Assumed existing Prisma service
import { BankFactoryModule } from "@/modules/factory/bank/bank.module";
import { TradingFactoryModule } from "@/modules/factory/trading";
@Module({
    imports: [BankFactoryModule, TradingFactoryModule],
    providers: [BankService, PrismaService],
    controllers: [BankController],
    exports: [BankService],
})
export class BankModule {}
