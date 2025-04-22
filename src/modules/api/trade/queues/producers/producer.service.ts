import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { Injectable } from "@nestjs/common";
import {
    QuidaxTradingJobOptions,
    QuidaxTradingQueue,
    TradingQueue,
} from "../interfaces";

@Injectable()
export class CryptoAccountQueueProducer {
    constructor(
        @InjectQueue(TradingQueue.QUIDAX_ACCOUNT_INIT)
        private quidaxCryptoQueue: Queue<QuidaxTradingJobOptions>,

        @InjectQueue(TradingQueue.QUIDAX_SYNC_BALANCE)
        private syncBalanceQueue: Queue<QuidaxTradingJobOptions>
    ) {}

    async enqueue(user_id: number) {
        await this.quidaxCryptoQueue.add(
            QuidaxTradingQueue.TRADING_ACCOUNT_INIT,
            { user_id }
        );
    }

    async enqueueSyncBalance(user_id: number) {
        await this.syncBalanceQueue.add(
            QuidaxTradingQueue.SYNC_CRYPTO_BALANCE,
            {
                user_id: user_id,
            }
        );
    }
}
