import { Module } from "@nestjs/common";
import { TradingService } from "./services";
import { TradingController } from "./controllers/v1";
export * from "./interfaces";
export * from "./errors";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { TradingEvent } from "./events";
import { BullModule } from "@nestjs/bull";
import { BullBoardModule } from "@bull-board/nestjs";
import { quidaxBoardQueueConfig, quidaxQueueConfig } from "./queues";

@Module({
    imports: [
        BullModule.registerQueue(...quidaxQueueConfig),
        BullBoardModule.forFeature(...quidaxBoardQueueConfig),
        TradingFactoryModule,
    ],
    controllers: [TradingController],
    providers: [TradingService, TradingEvent],
    exports: [TradingService],
})
export class TradeModule {}
