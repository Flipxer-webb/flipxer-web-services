import { Module } from "@nestjs/common";
import { EmailModule } from "./email";
import { PrismaModule } from "./prisma";
import { UploadModule } from "./upload";
import { CachingModule } from "./redisCache";
import { MessageModule } from "./messages/message.module";
import { GeoIpModule } from "./geoip";

@Module({
    imports: [
        EmailModule,
        PrismaModule,
        UploadModule,
        CachingModule,
        MessageModule,
        GeoIpModule,
    ],
})
export class CoreModule {}
