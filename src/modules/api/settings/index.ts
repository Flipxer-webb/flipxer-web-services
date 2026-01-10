import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { SettingService } from "./services";
import { SettingController } from "./controllers/v1";
import { AdminSettingController } from "./controllers/v1/admin";
import { AdminSwapPairController } from "./controllers/v1/admin-swap-pairs.controller";
import { SmsModule } from "@/modules/core/sms";
import { EmailModule } from "@/modules/core/email";
import { jwtSecret } from "@/config";

@Module({
    imports: [
        SmsModule,
        EmailModule,
        JwtModule.register({
            secret: jwtSecret,
            signOptions: { expiresIn: "5m" },
        }),
    ],
    controllers: [SettingController, AdminSettingController, AdminSwapPairController],
    providers: [SettingService],
    exports: [SettingService],
})
export class SettingModule { }
