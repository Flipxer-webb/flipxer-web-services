import { Module } from "@nestjs/common";
import { AnalyticsController } from "./controllers";
import { AnalyticsService } from "./services";
import { SessionModule } from "../session";

@Module({
    imports: [SessionModule],
    controllers: [AnalyticsController],
    providers: [AnalyticsService],
    exports: [AnalyticsService],
})
export class AnalyticsModule {}
