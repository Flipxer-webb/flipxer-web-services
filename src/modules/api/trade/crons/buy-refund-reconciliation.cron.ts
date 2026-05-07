import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { BuyRefundReconciliationService } from "../services/buy-refund-reconciliation.service";

@Injectable()
export class BuyRefundReconciliationCron {
    private readonly logger = new Logger(BuyRefundReconciliationCron.name);

    constructor(
        private readonly buyRefundReconciliationService: BuyRefundReconciliationService,
    ) {}

    @Cron(CronExpression.EVERY_10_MINUTES, {
        name: "buyRefundReconciliation",
        timeZone: "Africa/Lagos",
    })
    async run(): Promise<void> {
        try {
            const result =
                await this.buyRefundReconciliationService.verifyPendingRefundAttempts();

            if (result.checked > 0) {
                this.logger.log(
                    `BUY refund verification complete | checked: ${result.checked}, succeeded: ${result.succeeded}, failed: ${result.failed}`,
                );
            }
        } catch (error) {
            this.logger.error(
                `BUY refund verification failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}