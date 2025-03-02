import { Module } from "@nestjs/common";
import { APIModule } from "./api";
import { CoreModule } from "./core";
import { ScheduleModule } from "@nestjs/schedule";
import { BullBoardModule } from "@bull-board/nestjs";
import { ExpressAdapter } from "@bull-board/express";
import { FactoryModule } from "./factory";

@Module({
    imports: [
        APIModule,
        CoreModule,
        BullBoardModule.forRoot({
            route: "/queues",
            adapter: ExpressAdapter,
        }),

        ScheduleModule.forRoot(),
        FactoryModule,
    ],
})
export class AppModule {}
