import { Injectable, Logger, Inject } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { WithdrawalQueueService } from "../services/ledger/withdrawal-queue.service";
import { LedgerService } from "../services/ledger/ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { WsGateway } from "../gateway/v1";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * WithdrawalQueueCron
 *
 * Processes the withdrawal queue on a schedule:
 * - Runs every 5 minutes
 * - Checks for timed-out entries (72h) and refunds them
 * - Processes queued withdrawals when liquidity is available
 * - Smallest-first strategy for maximum throughput
 * - Sends Slack alerts for queue status
 * - Sends WebSocket events for real-time updates
 */
@Injectable()
export class WithdrawalQueueCron {
    private readonly logger = new Logger(WithdrawalQueueCron.name);

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly withdrawalQueueService: WithdrawalQueueService,
        private readonly ledgerService: LedgerService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly wsGateway: WsGateway
    ) { }

    /**
     * Main cron job - runs every 5 minutes
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async processQueue(): Promise<void> {
        this.logger.log("Starting withdrawal queue processing...");

        try {
            // Check if processing is paused
            const isPaused = await this.withdrawalQueueService.isProcessingPaused();
            if (isPaused) {
                this.logger.warn("Queue processing is PAUSED - skipping");
                return;
            }

            // 1. Process timed-out entries first
            const timeoutCount = await this.withdrawalQueueService.processTimeouts();
            if (timeoutCount > 0) {
                this.logger.log(`Processed ${timeoutCount} timed-out queue entries`);
                await this.sendTimeoutAlert(timeoutCount);
            }

            // 2. Get queue stats for monitoring
            const stats = await this.withdrawalQueueService.getQueueStats();

            if (stats.totalQueued === 0) {
                this.logger.log("No queued withdrawals to process");
                return;
            }

            this.logger.log(`Queue stats: ${JSON.stringify(stats)}`);

            // 3. Get currencies that have pending withdrawals (dynamic)
            // Pending = not yet processed and not released
            const pendingCurrencies = await this.prisma.withdrawalQueue.groupBy({
                by: ['currency'],
                where: {
                    processedAt: null,
                    releasedAt: null,
                },
            });

            // 4. Process each currency with pending entries
            let totalProcessed = 0;
            for (const { currency } of pendingCurrencies) {
                const processed = await this.processCurrencyQueue(currency);
                totalProcessed += processed;
            }

            if (totalProcessed > 0) {
                this.logger.log(`Processed ${totalProcessed} queued withdrawals`);
            }

            // 4. Check if queue is getting too large
            await this.checkQueueHealth(stats);

        } catch (error) {
            this.logger.error(`Queue processing failed: ${error.message}`, error.stack);
            await this.sendProcessingErrorAlert(error);
        }
    }

    /**
     * Process queue entries for a specific currency
     */
    private async processCurrencyQueue(currency: string): Promise<number> {
        try {
            // Get main wallet balance for this currency
            const mainWalletBalance = await this.getMainWalletBalance(currency);

            if (mainWalletBalance.lte(0)) {
                this.logger.debug(`No balance available for ${currency}`);
                return 0;
            }

            let processed = 0;
            let availableBalance = mainWalletBalance;

            // Process withdrawals until we run out of balance or queue is empty
            while (true) {
                const queueEntry = await this.withdrawalQueueService.getNextForProcessing(
                    currency,
                    availableBalance
                );

                if (!queueEntry) {
                    break; // No more entries we can afford
                }

                try {
                    // Execute the withdrawal
                    const success = await this.executeQueuedWithdrawal(queueEntry);

                    if (success) {
                        processed++;
                        availableBalance = availableBalance.sub(queueEntry.amount);

                        // Mark as processed
                        await this.withdrawalQueueService.markProcessed(queueEntry.id);

                        // Send WebSocket notification
                        this.wsGateway.notifyWithdrawalProcessed(queueEntry.userId, {
                            queueId: queueEntry.id,
                            currency: queueEntry.currency,
                            amount: queueEntry.amount.toString(),
                        });
                    }
                } catch (error) {
                    this.logger.error(
                        `Failed to process queued withdrawal: ${JSON.stringify({
                            queueId: queueEntry.id,
                            error: error.message,
                        })}`
                    );
                    // Continue with next entry
                }
            }

            return processed;
        } catch (error) {
            this.logger.error(`Error processing ${currency} queue: ${error.message}`);
            return 0;
        }
    }

    /**
     * Execute a queued withdrawal from the main wallet
     */
    private async executeQueuedWithdrawal(queueEntry: any): Promise<boolean> {
        const { holdEntry } = queueEntry;

        if (!holdEntry) {
            this.logger.error(`No hold entry found for queue entry ${queueEntry.id}`);
            return false;
        }

        // Get the user's withdrawal destination from the original hold metadata
        // The destination address should be stored in the hold entry's metadata
        const metadata = holdEntry.metadata as Record<string, any> || {};
        const destinationAddress = metadata.destinationAddress;
        const network = metadata.network;

        if (!destinationAddress) {
            this.logger.error(`No destination address for queue entry ${queueEntry.id}`);
            return false;
        }

        try {
            // Execute withdrawal from main wallet
            // Note: For external withdrawals, we need to use fund_uid for the destination address
            const withdrawalRes = await this.quidaxService.createWithdrawerRequest({
                user_id: "me", // Main wallet
                currency: queueEntry.currency.toLowerCase(),
                amount: queueEntry.amount.toString(),
                fund_uid: destinationAddress, // wallet address
                narration: `Queued withdrawal processed: ${queueEntry.id}`,
                transaction_note: `Queue ID: ${queueEntry.id}`,
                reference: `queue:${queueEntry.id}`,
                network: network,
            });

            if (withdrawalRes.status !== "success") {
                throw new Error(`Quidax withdrawal failed: ${withdrawalRes.message}`);
            }

            // Settle the hold (convert to confirmed debit)
            // DOUBLE ENTRY: releaseHoldWithPlatformEntry ensures platform liability (credit) is created (reduced)
            const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
                holdReference: holdEntry.reference,
                settle: true, // settle = true
                description: `Queued withdrawal processed: ${withdrawalRes.data.id}`,
                createPlatformEntry: true
            });

            if (!settleResult.success) {
                this.logger.error(`Failed to settle hold: ${settleResult.error}`);
                // Withdrawal succeeded, so we continue
            }

            this.logger.log(`Queued withdrawal executed: ${JSON.stringify({
                queueId: queueEntry.id,
                userId: queueEntry.userId,
                currency: queueEntry.currency,
                amount: queueEntry.amount.toString(),
                quidaxId: withdrawalRes.data.id,
            })}`);

            return true;
        } catch (error) {
            this.logger.error(`Withdrawal execution failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get main wallet balance for a currency
     */
    private async getMainWalletBalance(currency: string): Promise<Decimal> {
        try {
            const walletRes = await this.quidaxService.getUserWallet({
                user_id: "me",
                currency: currency.toLowerCase(),
            });

            if (walletRes.status !== "success" || !walletRes.data) {
                return new Decimal(0);
            }

            return new Decimal(walletRes.data.balance || "0");
        } catch (error) {
            this.logger.error(`Failed to get main wallet balance for ${currency}: ${error.message}`);
            return new Decimal(0);
        }
    }

    /**
     * Check queue health and send alerts if needed
     */
    private async checkQueueHealth(stats: any): Promise<void> {
        // Alert if queue is growing too large
        if (stats.totalQueued > 50) {
            await this.slackWebhookService.sendSystemAlert(
                "withdrawal_queue",
                "Queue Size Warning",
                "Withdrawal queue is large - may need attention",
                {
                    totalQueued: stats.totalQueued,
                    byCurrency: stats.byCurrency,
                    byReason: stats.byReason,
                    oldestQueuedAt: stats.oldestQueuedAt,
                },
                "warning"
            );
        }

        // Alert if entries are close to timing out (approaching 72h)
        if (stats.oldestQueuedAt) {
            const hoursInQueue = (Date.now() - new Date(stats.oldestQueuedAt).getTime()) / (1000 * 60 * 60);

            if (hoursInQueue > 48) {
                await this.slackWebhookService.sendSystemAlert(
                    "withdrawal_queue",
                    "Timeout Warning",
                    `Withdrawals approaching 72h timeout: ${hoursInQueue.toFixed(1)}h in queue`,
                    {
                        oldestHoursInQueue: hoursInQueue,
                        totalQueued: stats.totalQueued,
                    },
                    "warning"
                );
            }
        }
    }

    /**
     * Send alert for timed-out withdrawals
     */
    private async sendTimeoutAlert(count: number): Promise<void> {
        await this.slackWebhookService.sendSystemAlert(
            "withdrawal_queue",
            "Timeout Refunds",
            `${count} withdrawal(s) timed out and refunded after 72h`,
            { refundedCount: count },
            "warning"
        );
    }

    /**
     * Send alert for processing errors
     */
    private async sendProcessingErrorAlert(error: Error): Promise<void> {
        await this.slackWebhookService.sendSystemAlert(
            "withdrawal_queue",
            "Processing Error",
            `Queue processing error: ${error.message}`,
            { error: error.message, stack: error.stack },
            "error"
        );
    }
}
