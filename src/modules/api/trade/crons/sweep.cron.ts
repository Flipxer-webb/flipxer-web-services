import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SweepService } from "../services/ledger/sweep.service";

/**
 * SweepCron
 *
 * Processes pending sweeps and retries failed sweeps on a schedule.
 *
 * Sweep flow:
 * 1. Deposit webhook credits user ledger with sweepStatus = PENDING
 * 2. This cron picks up pending sweeps every 5 minutes via processPendingSweeps()
 * 3. SweepService initiates transfer from sub-account to main wallet
 * 4. Quidax webhook confirms sweep completion
 *
 * Retry flow:
 * - Failed sweeps are retried every 10 minutes with exponential backoff
 * - Max 3 lifetime retries per entry before permanent abandonment
 *
 * Both methods are protected by distributed Redis locks inside SweepService
 * to prevent concurrent execution across pods.
 */
@Injectable()
export class SweepCron {
    private readonly logger = new Logger(SweepCron.name);

    constructor(
        private readonly sweepService: SweepService
    ) { }

    /**
     * Process pending sweeps - runs every 5 minutes
     * Picks up PENDING deposit entries and initiates sweep to main wallet
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async processPendingSweeps(): Promise<void> {
        this.logger.log("Starting pending sweep processing...");

        try {
            const processed = await this.sweepService.processPendingSweeps();

            if (processed > 0) {
                this.logger.log(`Sweep processing complete | processed: ${processed}`);
            } else {
                this.logger.debug("No pending sweeps to process");
            }
        } catch (error) {
            this.logger.error(`Sweep processing failed: ${error.message}`, error.stack);
        }
    }

    /**
     * Retry failed sweeps - runs every 10 minutes
     * Retries FAILED entries with exponential backoff (max 3 retries)
     */
    @Cron(CronExpression.EVERY_10_MINUTES)
    async retryFailedSweeps(): Promise<void> {
        this.logger.log("Starting failed sweep retry...");

        try {
            const retried = await this.sweepService.retryFailedSweeps();

            if (retried > 0) {
                this.logger.log(`Failed sweep retry complete | retried: ${retried}`);
            } else {
                this.logger.debug("No failed sweeps eligible for retry");
            }
        } catch (error) {
            this.logger.error(`Failed sweep retry failed: ${error.message}`, error.stack);
        }
    }
}
