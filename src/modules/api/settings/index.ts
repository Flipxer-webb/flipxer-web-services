import { Module } from "@nestjs/common";
import { SettingService } from "./services";
import { SettingController } from "./controllers/v1";
import { AdminSettingController } from "./controllers/v1/admin";
import { SmsModule } from "@/modules/core/sms";
import { MailModule } from "@/modules/core/mail";

@Module({
    imports: [SmsModule, MailModule],
    controllers: [SettingController, AdminSettingController],
    providers: [SettingService],
    exports: [SettingService],
})
export class SettingModule {}
