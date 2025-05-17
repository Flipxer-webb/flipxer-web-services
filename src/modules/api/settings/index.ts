import { Module } from "@nestjs/common";
import { SettingService } from "./services";
import { SettingController } from "./controllers/v1";
import { AdminSettingController } from "./controllers/v1/admin";

@Module({
    imports: [],
    controllers: [SettingController, AdminSettingController],
    providers: [SettingService],
    exports: [SettingService],
})
export class SettingModule {}
