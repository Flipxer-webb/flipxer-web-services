import { Module } from "@nestjs/common";
import { EmailModule } from "./email";
import { PrismaModule } from "./prisma";
import { UploadModule } from "./upload";
import { CachingModule } from "./redisCache";
import { MessageModule } from "./messages/message.module";
import { GeoIpModule } from "./geoip";
import { SmsModule } from "./sms";

@Module({
    imports: [
        EmailModule,
        PrismaModule,
        UploadModule,
        CachingModule,
        MessageModule,
        GeoIpModule,
        SmsModule,
    ],
})
export class CoreModule {}
