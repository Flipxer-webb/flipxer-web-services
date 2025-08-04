import { forwardRef, Module } from "@nestjs/common";
import { TradingService } from "./services";
import { TradingController } from "./controllers/v1";
export * from "./interfaces";
export * from "./errors";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { TradingEvent } from "./events";
import { BullModule } from "@nestjs/bull";
import { BullBoardModule } from "@bull-board/nestjs";
import { quidaxBoardQueueConfig, quidaxQueueConfig } from "./queues";
import { CryptoAccountQueueProducer } from "./queues/producers/producer.service";
import { QuidaxTradingCryptoAccountInitQueueProcessor } from "./queues/processors/account_init_processor";
import { QuidaxTradingBalanceSyncProcessor } from "./queues/processors/sync_balance";
import { BankFactoryModule } from "@/modules/factory/bank/bank.module";
import { UserModule } from "../user";
import { WsGateway } from "./gateway/v1";
import { WsService } from "./services/websocket.service";

@Module({
    imports: [
        BullModule.registerQueue(...quidaxQueueConfig),
        BullBoardModule.forFeature(...quidaxBoardQueueConfig),
        TradingFactoryModule,
        BankFactoryModule,
        forwardRef(() => UserModule),
    ],
    controllers: [TradingController],
    providers: [
        TradingService,
        TradingEvent,
        QuidaxTradingCryptoAccountInitQueueProcessor,
        CryptoAccountQueueProducer,
        QuidaxTradingBalanceSyncProcessor,
        WsGateway,
        WsService,
    ],
    exports: [
        TradingService,
        CryptoAccountQueueProducer,
        QuidaxTradingBalanceSyncProcessor,
        WsGateway,
        WsService,
    ],
})
export class TradingModule {}
