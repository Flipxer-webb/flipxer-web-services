import { Module } from "@nestjs/common";
import { EmailModule } from "./email/email.module";
import { PrismaModule } from "./prisma";
import { UploadModule } from "./upload";

@Module({
    imports: [EmailModule, PrismaModule, UploadModule],
})
export class CoreModule {}
