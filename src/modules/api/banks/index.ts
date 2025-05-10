import { Module } from "@nestjs/common";
import { BankService } from "./services";
import { BankController } from "./controllers";
import { PrismaService } from "../../core/prisma/services"; // Assumed existing Prisma service
import { BankFactoryModule } from "@/modules/factory/bank/bank.module";
@Module({
    imports: [BankFactoryModule],
    providers: [BankService, PrismaService],
    controllers: [BankController],
})
export class BankModule {}
