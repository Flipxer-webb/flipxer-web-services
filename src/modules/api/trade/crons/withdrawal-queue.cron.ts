import { Injectable, Logger, Inject } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { WithdrawalQueueService } from "../services/ledger/withdrawal-queue.service";
import { LedgerService } from "../services/ledger/ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { WsGateway } from "../gateway/v1";
import { Decimal } from "@prisma/client/runtime/library";
import { OrderCategory, OrderStatus, OrderStreamlinedStatus } from "@prisma/client";
import { getStreamlinedStatus } from "../interfaces/trade";

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
        private readonly lockService: DistributedLockService,
        private readonly wsGateway: WsGateway
    ) { }

    /**
     * Main cron job - runs every 5 minutes
     *
     * FIX: WQ-001 — Protected by a distributed Redis job lock so only one
     * pod processes the queue per cron cycle. Mirrors the pattern used by
     * SweepService.processPendingSweeps(). Without this lock, multiple pods
     * could call getNextForProcessing() concurrently and execute the same
     * Quidax withdrawal twice (double-withdrawal risk).
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async processQueue(): Promise<void> {
        const jobLockKey = "job:withdrawal-queue:process";

        try {
            await this.lockService.withLock(
                jobLockKey,
                async () => this._processQueueInner(),
                // ttlMs: 240s covers worst-case processing of multiple currencies.
                // maxWaitMs: 0 means skip if another pod holds the lock.
                // strict: false — if Redis is down, we still want to attempt processing
                // (individual ledger ops have their own strict locks).
                { ttlMs: 240000, maxWaitMs: 0, strict: false }
            );
        } catch (error) {
            if (error.message?.includes("Failed to acquire lock")) {
                this.logger.debug("Queue processing already running on another pod — skipping");
                return;
            }
            this.logger.error(`Queue processing failed: ${error.message}`, error.stack);
            await this.sendProcessingErrorAlert(error);
        }
    }

    /**
     * Inner implementation of processQueue, called within the job lock.
     */
    private async _processQueueInner(): Promise<void> {
        this.logger.log("Starting withdrawal queue processing...");

        try {
            // Check if processing is paused
            const isPaused = await this.withdrawalQueueService.isProcessingPaused();
            if (isPaused) {
                this.logger.warn("Queue processing is PAUSED - skipping");
                return;
            }

            // 1. Get queue stats for monitoring
            const stats = await this.withdrawalQueueService.getQueueStats();

            // 2. Process currency queues FIRST — timed-out entries with available
            // liquidity get fulfilled normally before the timeout refund runs
            if (stats.totalQueued > 0) {
                this.logger.log(`Queue stats: ${JSON.stringify(stats)}`);

                const pendingCurrencies = await this.prisma.withdrawalQueue.groupBy({
                    by: ['currency'],
                    where: {
                        processedAt: null,
                        releasedAt: null,
                    },
                });

                let totalProcessed = 0;
                for (const { currency } of pendingCurrencies) {
                    const processed = await this.processCurrencyQueue(currency);
                    totalProcessed += processed;
                }

                if (totalProcessed > 0) {
                    this.logger.log(`Processed ${totalProcessed} queued withdrawals`);
                }

                await this.checkQueueHealth(stats);
            }

            // 3. Process timed-out entries AFTER queue processing —
            // only entries that couldn't be fulfilled get refunded
            const timeoutCount = await this.withdrawalQueueService.processTimeouts();
            if (timeoutCount > 0) {
                this.logger.log(`Processed ${timeoutCount} timed-out queue entries`);
                await this.sendTimeoutAlert(timeoutCount);
            }

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
                    } else {
                        // Data issue (e.g., missing hold metadata). Stop this run to avoid tight-loop log spam.
                        break;
                    }
                } catch (error) {
                    this.logger.error(
                        `Failed to process queued withdrawal: ${JSON.stringify({
                            queueId: queueEntry.id,
                            error: error.message,
                        })}`
                    );
                    // Stop this run to avoid retrying same failing entry in a tight loop.
                    break;
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
            await this.withdrawalQueueService.markReleased(queueEntry.id);
            return false;
        }

        // Get the user's withdrawal destination from the original hold metadata
        // The destination address should be stored in the hold entry's metadata
        const metadata = holdEntry.metadata as Record<string, any> || {};
        let destinationAddress = metadata.destinationAddress;
        let network = metadata.network;

        // Backward compatibility for legacy queue entries created before
        // hold metadata persisted destination/network values.
        let linkedOrderReference: string | null = null;
        if (!destinationAddress) {
            const linkedOrder = await this.prisma.order.findFirst({
                where: {
                    ledgerEntryId: holdEntry.id,
                    orderCategory: OrderCategory.SEND,
                },
                select: {
                    recipient: true,
                    destinationTag: true,
                    orderReference: true,
                },
                orderBy: { createdAt: "desc" },
            });

            if (linkedOrder?.recipient) {
                destinationAddress = linkedOrder.recipient;
                metadata.destinationTag = metadata.destinationTag ?? linkedOrder.destinationTag;
                linkedOrderReference = linkedOrder.orderReference ?? null;
            }
        }

        if (!destinationAddress) {
            this.logger.error(`No destination address for queue entry ${queueEntry.id}`);

            const releaseResult = await this.ledgerService.releaseHold(
                holdEntry.reference,
                false,
                `Queue release: missing destination for queue entry ${queueEntry.id}`
            );

            if (!releaseResult.success) {
                this.logger.error(
                    `Failed to release hold for queue entry ${queueEntry.id} with missing destination: ${releaseResult.error}`
                );
                return false;
            }

            await this.withdrawalQueueService.markReleased(queueEntry.id);
            return false;
        }

        // Derive the original order reference from the hold reference so that
        // the Quidax on-chain webhook can match back to our Order record.
        // Hold reference format: "withdrawal:{orderReference}"
        // Without this, the webhook fires with reference="queue:N" which
        // doesn't match any Order.orderReference → Order stuck as pending forever.
        const orderReferenceFromHold = holdEntry.reference?.startsWith('withdrawal:')
            ? holdEntry.reference.slice('withdrawal:'.length)
            : (linkedOrderReference ?? null);

        // Fallback: query the linked order if still not found
        let resolvedOrderReference = orderReferenceFromHold;
        if (!resolvedOrderReference) {
            const fallbackOrder = await this.prisma.order.findFirst({
                where: { ledgerEntryId: holdEntry.id, orderCategory: OrderCategory.SEND },
                select: { orderReference: true },
                orderBy: { createdAt: 'desc' },
            });
            resolvedOrderReference = fallbackOrder?.orderReference ?? null;
        }

        if (!resolvedOrderReference) {
            this.logger.error(
                `Cannot resolve order reference for queue entry ${queueEntry.id} — webhook will not be able to complete the order`
            );
        }

        try {
            // Execute withdrawal from main wallet
            // Note: For external withdrawals, we need to use fund_uid for the destination address
            const withdrawalRes = await this.quidaxService.createWithdrawerRequest({
                user_id: "me", // Main wallet
                currency: queueEntry.currency.toLowerCase(),
                amount: queueEntry.amount.toString(),
                fund_uid: destinationAddress, // wallet address
                fund_uid2: metadata.destinationTag,
                narration: `Queued withdrawal processed: ${queueEntry.id}`,
                transaction_note: `Queue ID: ${queueEntry.id}`,
                // Use the original order reference so Quidax's on-chain webhook
                // can match back to the Order record in WithdrawalWebhookHandler.
                // Previously used 'queue:${queueEntry.id}' which caused
                // TransactionNotFoundException on every webhook → Order stuck as pending.
                reference: resolvedOrderReference ?? `queue:${queueEntry.id}`,
                network: network,
            });

            if (withdrawalRes.status !== "success") {
                throw new Error(`Quidax withdrawal failed: ${withdrawalRes.message}`);
            }

            // Update Order to submitted so user can see progress immediately.
            // The webhook handler will advance it to done/failed when on-chain confirmation arrives.
            if (resolvedOrderReference) {
                await this.prisma.order.update({
                    where: { orderReference: resolvedOrderReference },
                    data: {
                        status: OrderStatus.submitted,
                        streamlinedStatus: getStreamlinedStatus(OrderStatus.submitted),
                    },
                }).catch((err) =>
                    this.logger.error(`Failed to update order status to submitted for ${resolvedOrderReference}: ${err.message}`)
                );
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
                // FIX: WQ-004 — Withdrawal succeeded on Quidax but the ledger
                // hold was NOT settled. This is a critical inconsistency:
                // funds have left the main wallet but the user's ledger still
                // shows a hold. Alert admins immediately so they can manually
                // settle or reconcile.
                this.logger.error(
                    `CRITICAL: Withdrawal executed but hold settlement failed | ${JSON.stringify({
                        queueId: queueEntry.id,
                        userId: queueEntry.userId,
                        currency: queueEntry.currency,
                        amount: queueEntry.amount.toString(),
                        quidaxId: withdrawalRes.data.id,
                        holdReference: holdEntry.reference,
                        settleError: settleResult.error,
                    })}`
                );

                await this.slackWebhookService.sendSystemAlert(
                    "withdrawal_queue",
                    "CRITICAL: Dangling Hold After Withdrawal",
                    `Withdrawal executed on Quidax (${withdrawalRes.data.id}) but hold settlement failed. ` +
                    `Ledger is inconsistent — manual intervention required.`,
                    {
                        queueId: queueEntry.id,
                        userId: queueEntry.userId,
                        currency: queueEntry.currency,
                        amount: queueEntry.amount.toString(),
                        quidaxId: withdrawalRes.data.id,
                        holdReference: holdEntry.reference,
                        settleError: settleResult.error,
                    },
                    "error"
                );

                this.wsGateway.notifyQueueHealthAlert({
                    category: "withdrawal_queue",
                    title: "CRITICAL: Dangling Hold After Withdrawal",
                    message: `Hold settlement failed after successful withdrawal (Queue: ${queueEntry.id})`,
                    severity: "error",
                });

                // Still return true — the withdrawal DID happen, so the queue
                // entry should be marked as processed to prevent re-execution.
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
     *
     * FIX: WQ-005 — Added starvation detection for large withdrawals.
     * The smallest-first strategy can indefinitely defer withdrawals that
     * are always larger than the available balance. We alert when an entry
     * has been queued for >24h without being processed so admins can top up
     * the main wallet or manually intervene.
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

            this.wsGateway.notifyQueueHealthAlert({
                category: "withdrawal_queue",
                title: "Queue Size Warning",
                message: "Withdrawal queue is large - may need attention",
                severity: "warning",
            });
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

                this.wsGateway.notifyQueueHealthAlert({
                    category: "withdrawal_queue",
                    title: "Timeout Warning",
                    message: `Withdrawals approaching 72h timeout: ${hoursInQueue.toFixed(1)}h in queue`,
                    severity: "warning",
                });
            }
        }

        // FIX: WQ-005 — Starvation detection: find entries that have been
        // in the queue for >24h. These are likely large withdrawals that are
        // consistently skipped by the smallest-first strategy because the
        // main wallet never has enough balance to cover them.
        const starvationThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const starvedEntries = await this.prisma.withdrawalQueue.findMany({
            where: {
                processedAt: null,
                releasedAt: null,
                queuedAt: { lt: starvationThreshold },
            },
            select: {
                id: true,
                userId: true,
                currency: true,
                amount: true,
                queuedAt: true,
            },
            orderBy: { queuedAt: "asc" },
            take: 10,
        });

        if (starvedEntries.length > 0) {
            const entries = starvedEntries.map((e) => ({
                queueId: e.id,
                userId: e.userId,
                currency: e.currency,
                amount: e.amount.toString(),
                hoursInQueue: (
                    (Date.now() - e.queuedAt.getTime()) /
                    (1000 * 60 * 60)
                ).toFixed(1),
            }));

            await this.slackWebhookService.sendSystemAlert(
                "withdrawal_queue",
                "Starvation Warning",
                `${starvedEntries.length} withdrawal(s) queued >24h — may need wallet top-up or manual processing`,
                { entries },
                "warning"
            );

            this.wsGateway.notifyQueueHealthAlert({
                category: "withdrawal_queue",
                title: "Starvation Warning",
                message: `${starvedEntries.length} withdrawal(s) queued >24h — possible starvation by smallest-first strategy`,
                severity: "warning",
            });
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

        this.wsGateway.notifyQueueHealthAlert({
            category: "withdrawal_queue",
            title: "Timeout Refunds",
            message: `${count} withdrawal(s) timed out and refunded after 72h`,
            severity: "warning",
        });
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

        this.wsGateway.notifyQueueHealthAlert({
            category: "withdrawal_queue",
            title: "Processing Error",
            message: `Queue processing error: ${error.message}`,
            severity: "error",
        });
    }
}
