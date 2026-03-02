import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { StuckOrderReconciliationService } from "../services/stuck-order-reconciliation.service";

/**
 * StuckOrderReconciliationCron
 *
 * Runs every 10 minutes to detect and auto-fix stuck orders where
 * payment was received but fulfillment failed.
 *
 * Categories handled:
 * 1. BUY orders with payment SUCCESS but not fulfilled → auto-retry
 * 2. Orders with broken ledger links (order=done, ledger=FAILED) → Slack alert
 * 3. Pre-ledger completed orders missing fulfilled flag → backfill
 *
 * All operations are idempotent — safe for overlapping runs.
 */
@Injectable()
export class StuckOrderReconciliationCron {
    private readonly logger = new Logger(StuckOrderReconciliationCron.name);

    constructor(
        private readonly reconciliationService: StuckOrderReconciliationService,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES, {
        name: "stuckOrderReconciliation",
        timeZone: "Africa/Lagos",
    })
    async run(): Promise<void> {
        this.logger.log("Starting stuck order reconciliation...");

        try {
            const result = await this.reconciliationService.reconcile();

            const { stuckBuyOrders, brokenLedgerOrders, preLedgerBackfill, errors } = result;

            if (
                stuckBuyOrders.detected > 0 ||
                brokenLedgerOrders.detected > 0 ||
                preLedgerBackfill.fixed > 0
            ) {
                this.logger.warn(
                    `Reconciliation complete | stuck_buy: ${stuckBuyOrders.detected} (retried: ${stuckBuyOrders.autoRetried}, failed: ${stuckBuyOrders.retryFailed}) | broken_ledger: ${brokenLedgerOrders.detected} | backfilled: ${preLedgerBackfill.fixed}`,
                );
            } else {
                this.logger.debug("Reconciliation complete — no issues found");
            }

            if (errors.length > 0) {
                this.logger.error(
                    `Reconciliation errors: ${errors.join("; ")}`,
                );
            }
        } catch (error) {
            this.logger.error(
                `Stuck order reconciliation failed: ${error.message}`,
                error.stack,
            );
        }
    }
}
