import { Module } from "@nestjs/common";
import { APIModule } from "./api";
import { CoreModule } from "./core";
import { ScheduleModule } from "@nestjs/schedule";
import { BullBoardModule } from "@bull-board/nestjs";
import { ExpressAdapter } from "@bull-board/express";
import { FactoryModule } from "./factory";
import { SchedulerModule } from "./scheduler";

@Module({
    imports: [
        APIModule,
        CoreModule,
        BullBoardModule.forRoot({
            route: "/queues",
            adapter: ExpressAdapter,
        }),

        ScheduleModule.forRoot(),
        SchedulerModule,
        FactoryModule,
    ],
})
export class AppModule {}
