import { Module } from "@nestjs/common";
import { HealthController } from "./controllers/v1";
import { PrismaModule } from "@/modules/core/prisma";
import { RedisCacheModule } from "@/modules/core/redisCache";

@Module({
    imports: [PrismaModule, RedisCacheModule],
    controllers: [HealthController],
})
export class HealthModule {}
