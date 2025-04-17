import { Process, Processor } from "@nestjs/bull";
import {
    TradingQueue,
    QuidaxTradingQueue,
    QuidaxTradingJobOptions,
} from "../interfaces";
import { Job } from "bull";
import { TradingEvent } from "../../events";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingService } from "../../services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { Inject } from "@nestjs/common";

@Processor(TradingQueue.QUIDAX_TRADING)
export class QuidaxTradingQueueProcessor {
    constructor(
        private tradingEvent: TradingEvent,
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private tradingService: TradingService
    ) {}

    @Process(QuidaxTradingQueue.TRADING)
    async processBettingPurchase(options: Job<QuidaxTradingJobOptions>) {
        const { user_id } = options.data;
        try {
            return true;
        } catch (error) {
            switch (true) {
                default: {
                    return false;
                }
            }
        }
    }
}
