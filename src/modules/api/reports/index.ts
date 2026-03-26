import { Module } from "@nestjs/common";
import { ReportsService } from "./services/reports.service";
import { AdminReportsController } from "./controllers/v1/admin/reports.controller";
import { SessionModule } from "../session";

@Module({
    imports: [SessionModule],
    controllers: [AdminReportsController],
    providers: [ReportsService],
    exports: [ReportsService],
})
export class ReportsModule {}
