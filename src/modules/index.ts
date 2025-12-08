import { Module } from "@nestjs/common";
import { APIModule } from "./api";
import { CoreModule } from "./core";
import { ScheduleModule } from "@nestjs/schedule";
// Bull Board disabled due to path-to-regexp compatibility issue with Express 4.x
// import { BullBoardModule } from "@bull-board/nestjs";
// import { ExpressAdapter } from "@bull-board/express";
import { FactoryModule } from "./factory";
import { SchedulerModule } from "./scheduler";
import { WebhookModule } from "./webhook";
import { BullModule } from "@nestjs/bull";
import { redisConfig } from "@/config";
import { ConfigModule, ConfigService } from "@nestjs/config";

@Module({
    imports: [
        APIModule,
        CoreModule,
        ScheduleModule.forRoot(),
        SchedulerModule,
        WebhookModule,
        FactoryModule,
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        // Bull Board disabled due to path-to-regexp compatibility issue with Express 4.x
        // Re-enable when upgrading to NestJS 11 / Express 5
        // BullBoardModule.forRoot({
        //     route: "/queues",
        //     adapter: ExpressAdapter,
        // }),
        BullModule.forRootAsync({
            useFactory: async () => {
                return {
                    redis: {
                        port: redisConfig.port,
                        username: redisConfig.user,
                        password: redisConfig.password,
                        host: redisConfig.host,
                        tls: redisConfig.redisOptions.tls,
                    },
                };
            },
            inject: [ConfigService],
        }),
    ],
})
export class AppModule {}
