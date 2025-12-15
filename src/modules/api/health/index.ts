import { Module } from "@nestjs/common";
import { HealthController } from "./controllers/v1";
import { PrismaModule } from "@/modules/core/prisma";
import { CachingModule } from "@/modules/core/redisCache";

@Module({
    imports: [PrismaModule, CachingModule],
    controllers: [HealthController],
})
export class HealthModule {}
