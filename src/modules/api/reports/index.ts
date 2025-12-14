import { Module } from "@nestjs/common";
import { ReportsService } from "./services/reports.service";
import { AdminReportsController } from "./controllers/v1/admin/reports.controller";

@Module({
    imports: [],
    controllers: [AdminReportsController],
    providers: [ReportsService],
    exports: [ReportsService],
})
export class ReportsModule {}
