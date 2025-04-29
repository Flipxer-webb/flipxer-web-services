import { Module } from "@nestjs/common";
import { BankService } from "./services";
import { BankController } from "./controllers";
import { PrismaService } from "../../core/prisma/services"; // Assumed existing Prisma service

@Module({
    providers: [BankService, PrismaService],
    controllers: [BankController],
})
export class BankModule {}
