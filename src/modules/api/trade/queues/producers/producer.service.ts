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
        private readonly quidaxCryptoQueue: Queue<QuidaxTradingJobOptions>,

        @InjectQueue(TradingQueue.QUIDAX_SYNC_BALANCE)
        private readonly syncBalanceQueue: Queue<QuidaxTradingJobOptions>,

        @InjectQueue(TradingQueue.QUIDAX_DEPOSIT_SYNC)
        private readonly depositSyncQueue: Queue<QuidaxTradingJobOptions>
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
            },
            {
                jobId: `sync-balance:${user_id}`,
            }
        );
    }

    async enqueueDepositSync(user_id: number) {
        await this.depositSyncQueue.add(
            QuidaxTradingQueue.SYNC_USER_DEPOSITS,
            { user_id },
            {
                // Deduplicate: if a deposit sync is already queued for this
                // user it will be reused instead of fanning out.
                jobId: `sync-deposits:${user_id}`,
            }
        );
    }
}
