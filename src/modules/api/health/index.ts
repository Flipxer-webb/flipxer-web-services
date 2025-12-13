import { Module } from "@nestjs/common";
import { HealthController } from "./controllers/v1";

@Module({
    controllers: [HealthController],
})
export class HealthModule {}
