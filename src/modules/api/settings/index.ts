import { Module } from "@nestjs/common";
import { SettingService } from "./services";
import { SettingController } from "./controllers/v1";
import { AdminSettingController } from "./controllers/v1/admin";
import { SmsModule } from "@/modules/core/sms";
import { EmailModule } from "@/modules/core/email";

@Module({
    imports: [SmsModule, EmailModule],
    controllers: [SettingController, AdminSettingController],
    providers: [SettingService],
    exports: [SettingService],
})
export class SettingModule {}
