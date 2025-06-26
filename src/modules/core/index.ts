import { Module } from "@nestjs/common";
import { EmailModule } from "./email";
import { PrismaModule } from "./prisma";
import { UploadModule } from "./upload";
import { CachingModule } from "./redisCache";

@Module({
    imports: [EmailModule, PrismaModule, UploadModule, CachingModule],
})
export class CoreModule {}
