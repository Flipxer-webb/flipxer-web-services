import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { OrphanedHoldService } from "../services/ledger/orphaned-hold.service";

/**
 * OrphanedHoldCron
 *
 * Runs every 15 minutes to detect orphaned hold entries.
 * Orphaned holds are HOLD entries that have been stuck for >24h
 * and are not linked to active withdrawal queue entries.
 *
 * Detection creates OrphanedHoldReview entries for admin approval.
 * No auto-release is performed - all resolutions require admin action.
 */
@Injectable()
export class OrphanedHoldCron {
    private readonly logger = new Logger(OrphanedHoldCron.name);

    constructor(
        private readonly orphanedHoldService: OrphanedHoldService
    ) { }

    /**
     * Main cron job - runs every 15 minutes
     */
    @Cron(CronExpression.EVERY_10_MINUTES) // Using 10 min for more responsive detection
    async detectOrphanedHolds(): Promise<void> {
        this.logger.log("Starting orphaned hold detection...");

        try {
            const result = await this.orphanedHoldService.detectOrphanedHolds();

            if (result.detected > 0) {
                this.logger.warn(`Orphaned hold detection complete | detected: ${result.detected}, alerted: ${result.alerted}`);
            } else {
                this.logger.debug("No orphaned holds detected");
            }

            if (result.errors.length > 0) {
                this.logger.error(`Errors during detection: ${result.errors.join(", ")}`);
            }
        } catch (error) {
            this.logger.error(`Orphaned hold detection failed: ${error.message}`, error.stack);
        }
    }
}
