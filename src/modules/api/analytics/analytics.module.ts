import { Module } from "@nestjs/common";
import { AnalyticsController } from "./controllers";
import { AnalyticsService } from "./services";

@Module({
    controllers: [AnalyticsController],
    providers: [AnalyticsService],
    exports: [AnalyticsService],
})
export class AnalyticsModule {}
