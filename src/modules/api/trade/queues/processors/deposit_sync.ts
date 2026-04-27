import { InjectQueue, Process, Processor } from "@nestjs/bull";
import { Job, Queue } from "bull";
import { Logger } from "@nestjs/common";
import { TradingService } from "../../services";
import {
    QuidaxTradingJobOptions,
    QuidaxTradingQueue,
    TradingQueue,
} from "../interfaces";
import { withQuidaxThrottleGuard } from "./quidax-throttle-guard";

/**
 * Processes deposit-sync jobs enqueued by the deposit-sync cron and any
 * on-demand triggers. Running this work through a Bull queue with a per-second
 * limiter ensures the fallback sync never fans out enough Quidax calls to
 * trigger provider throttling.
 */
@Processor(TradingQueue.QUIDAX_DEPOSIT_SYNC)
export class QuidaxDepositSyncProcessor {
    private readonly logger = new Logger("QuidaxDepositSyncProcessor");

    constructor(
        private readonly tradingService: TradingService,
        @InjectQueue(TradingQueue.QUIDAX_DEPOSIT_SYNC)
        private readonly depositSyncQueue: Queue<QuidaxTradingJobOptions>
    ) {}

    @Process(QuidaxTradingQueue.SYNC_USER_DEPOSITS)
    async handleSyncDeposits(job: Job<QuidaxTradingJobOptions>) {
        return withQuidaxThrottleGuard(
            this.depositSyncQueue,
            this.logger,
            () => this.runSyncDeposits(job)
        );
    }

    private async runSyncDeposits(job: Job<QuidaxTradingJobOptions>) {
        const { user_id } = job.data;

        try {
            const result = await this.tradingService.syncUserDeposits(user_id);
            const synced = result?.data?.synced ?? 0;

            if (synced > 0) {
                this.logger.log(
                    `[DEPOSIT SYNC] User ${user_id}: synced ${synced} deposits`
                );
            }

            return result;
        } catch (error) {
            this.logger.error(
                `[DEPOSIT SYNC] Error syncing deposits for user ${user_id}: ${error?.message}`
            );
            // Re-throw so Bull's exponential backoff + throttle guard apply.
            throw error;
        }
    }
}
