import { forwardRef, Module } from "@nestjs/common";
import { TradingService } from "./services";
import { TradeHelpersService } from "./services/trade-helpers.service";
import { WalletAddressService } from "./services/wallet-address.service";
import { BuyOrderService } from "./services/buy-order.service";
import { SellOrderService } from "./services/sell-order.service";
import { SwapService } from "./services/swap.service";
import { SendService } from "./services/send.service";
import { WebhookHandlerService } from "./services/webhook-handler.service";
import { DepositWebhookHandler } from "./services/webhook-handlers/deposit-webhook.handler";
import { SwapWebhookHandler } from "./services/webhook-handlers/swap-webhook.handler";
import { WithdrawalWebhookHandler } from "./services/webhook-handlers/withdrawal-webhook.handler";
import { PriceAlertService } from "./services/price-alert.service";
import { TradingController } from "./controllers/v1";
import { PriceAlertController } from "./controllers/v1/price-alert.controller";
import { TradingFactoryModule } from "@/modules/factory/trading";
import { TradingEvent } from "./events";
import { BullModule } from "@nestjs/bull";
// Bull Board disabled due to path-to-regexp compatibility issue with Express 4.x
// import { BullBoardModule } from "@bull-board/nestjs";
import { quidaxQueueConfig } from "./queues";
import { CryptoAccountQueueProducer } from "./queues/producers/producer.service";
import { QuidaxTradingCryptoAccountInitQueueProcessor } from "./queues/processors/account_init_processor";
import { QuidaxTradingBalanceSyncProcessor } from "./queues/processors/sync_balance";
import { BankFactoryModule } from "@/modules/factory/bank/bank.module";
import { UserModule } from "../user";
import { WsGateway } from "./gateway/v1";
import { WsService } from "./services/websocket.service";
import { AuthModule } from "@/modules/api/auth";
import { PrismaModule } from "@/modules/core/prisma";
import { EmailModule } from "@/modules/core/email";
import { TransactionAmountGuard } from "@/modules/api/auth/guard";
import { CoinGeckoService } from "@/modules/factory/trading/providers/coingecko/services";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { TransactionService } from "../auth/services/transaction.service";
import { TierService } from "../auth/services/tier.service";
import { OperationsModule } from "../operations";
import { NotificationModule } from "../notification/notification.module";
import { CachingModule } from "@/modules/core/redisCache";
export * from "./interfaces";
export * from "./errors";

@Module({
    imports: [
        BullModule.registerQueue(...quidaxQueueConfig),
        // Bull Board disabled due to path-to-regexp compatibility issue with Express 4.x
        // BullBoardModule.forFeature(...quidaxBoardQueueConfig),
        TradingFactoryModule,
        BankFactoryModule,
        forwardRef(() => UserModule),
        forwardRef(() => AuthModule),
        PrismaModule,
        EmailModule,
        OperationsModule,
        NotificationModule,
        CachingModule,
    ],
    controllers: [TradingController, PriceAlertController],
    providers: [
        TradingService,
        TradeHelpersService,
        WalletAddressService,
        BuyOrderService,
        SellOrderService,
        SwapService,
        SendService,
        WebhookHandlerService,
        DepositWebhookHandler,
        SwapWebhookHandler,
        WithdrawalWebhookHandler,
        PriceAlertService,
        TradingEvent,
        QuidaxTradingCryptoAccountInitQueueProcessor,
        CryptoAccountQueueProducer,
        QuidaxTradingBalanceSyncProcessor,
        WsGateway,
        WsService,
        TransactionService,
        TierService,
        TransactionAmountGuard,
        {
            provide: TradingInjectionToken.COINGECKO,
            useClass: CoinGeckoService,
        },
        {
            provide: TradingInjectionToken.LIVECOINWATCH,
            useClass: LiveCoinWatchService,
        },
    ],
    exports: [
        TradingService,
        TradeHelpersService,
        WalletAddressService,
        BuyOrderService,
        SellOrderService,
        SwapService,
        SendService,
        WebhookHandlerService,
        CryptoAccountQueueProducer,
        QuidaxTradingBalanceSyncProcessor,
        WsGateway,
        WsService,
        TierService,
    ],
})
export class TradingModule {}

