import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { RollbackStatus, LedgerType, SweepStatus, Prisma } from "@prisma/client";
import { LedgerService } from "./ledger/ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * FailedRollbackQueueService
 * 
 * Provides a durable retry mechanism for swap rollbacks that failed.
 * When a swap fails after debiting the user, we MUST refund them eventually.
 * This service persists failed rollback attempts and retries them automatically.
 * 
 * Key principles:
 * 1. Never lose a failed rollback - always persist to database
 * 2. Retry with exponential backoff
 * 3. Alert admins after max retries
 */
@Injectable()
export class FailedRollbackQueueService {
    private readonly logger = new Logger('FailedRollbackQueueService');

    // Retry configuration
    private readonly MAX_RETRY_ATTEMPTS = 10;
    private readonly RETRY_DELAY_BASE_MS = 60000; // 1 minute

    constructor(
        private readonly prisma: PrismaService,
        private readonly ledgerService: LedgerService,
        private readonly slackWebhookService: SlackWebhookService,
    ) { }

    /**
     * Add a failed rollback to the queue for retry
     */
    async addToQueue(params: {
        orderId: number;
        userId: number;
        currency: string;
        amount: number | string | Decimal;
        originalError: string;
        metadata?: Record<string, any>;
    }): Promise<string> {
        const { orderId, userId, currency, amount, originalError, metadata } = params;

        this.logger.warn(
            `Adding failed rollback to queue | Order: ${orderId} | User: ${userId} | Amount: ${amount} ${currency}`
        );

        const failedRollback = await this.prisma.failedRollback.create({
            data: {
                orderId,
                userId,
                currency,
                amount: new Decimal(String(amount)),
                status: RollbackStatus.PENDING,
                originalError,
                metadata: metadata ?? Prisma.JsonNull,
            },
        });

        // Immediately notify admins of new failed rollback
        await this.slackWebhookService.sendAlert?.('FAILED_ROLLBACK_QUEUED', {
            text: `⚠️ Failed Rollback Queued\n` +
                `Order: ${orderId}\n` +
                `User: ${userId}\n` +
                `Amount: ${amount} ${currency}\n` +
                `Error: ${originalError}\n` +
                `Queue ID: ${failedRollback.id}`,
        });

        return failedRollback.id;
    }

    /**
     * Cron job: Process pending rollbacks every 5 minutes
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async processQueue(): Promise<void> {
        this.logger.log('Processing failed rollback queue...');

        // Find pending rollbacks, ordered by oldest first
        const pendingRollbacks = await this.prisma.failedRollback.findMany({
            where: {
                status: RollbackStatus.PENDING,
                retryCount: { lt: this.MAX_RETRY_ATTEMPTS },
            },
            orderBy: { createdAt: 'asc' },
            take: 10, // Process in batches
        });

        if (pendingRollbacks.length === 0) {
            this.logger.log('No pending rollbacks to process');
            return;
        }

        this.logger.log(`Found ${pendingRollbacks.length} pending rollbacks`);

        for (const rollback of pendingRollbacks) {
            await this.retryRollback(rollback.id);
        }
    }

    /**
     * Retry a specific failed rollback
     */
    async retryRollback(rollbackId: string): Promise<boolean> {
        // Mark as processing atomically
        const updated = await this.prisma.failedRollback.updateMany({
            where: {
                id: rollbackId,
                status: RollbackStatus.PENDING,
            },
            data: {
                status: RollbackStatus.PROCESSING,
                lastAttemptAt: new Date(),
            },
        });

        if (updated.count === 0) {
            this.logger.log(`Rollback ${rollbackId} already being processed`);
            return false;
        }

        const rollback = await this.prisma.failedRollback.findUnique({
            where: { id: rollbackId },
        });

        if (!rollback) {
            this.logger.error(`Rollback ${rollbackId} not found`);
            return false;
        }

        try {
            this.logger.log(
                `Retrying rollback ${rollbackId} (attempt ${rollback.retryCount + 1}/${this.MAX_RETRY_ATTEMPTS})`
            );

            // Attempt the refund
            const refundRef = `swap_rollback_retry:${rollback.orderId}:${rollbackId}`;

            const refundResult = await this.ledgerService.pairedCredit({
                userId: rollback.userId,
                currency: rollback.currency,
                amount: rollback.amount,
                type: LedgerType.REFUND,
                reference: refundRef,
                description: `Failed swap rollback retry - Order ${rollback.orderId}`,
                sweepStatus: SweepStatus.NOT_APPLICABLE,
                createPlatformEntry: true,
            });

            if (!refundResult.success) {
                throw new Error(refundResult.error || 'Refund failed');
            }

            // Success! Mark as completed
            await this.prisma.failedRollback.update({
                where: { id: rollbackId },
                data: {
                    status: RollbackStatus.COMPLETED,
                    completedAt: new Date(),
                    retryCount: rollback.retryCount + 1,
                },
            });

            this.logger.log(
                `Successfully processed rollback ${rollbackId} | User: ${rollback.userId} | Amount: ${rollback.amount} ${rollback.currency}`
            );

            // Notify admins of successful recovery
            await this.slackWebhookService.sendAlert?.('FAILED_ROLLBACK_RECOVERED', {
                text: `✅ Failed Rollback RECOVERED\n` +
                    `Order: ${rollback.orderId}\n` +
                    `User: ${rollback.userId}\n` +
                    `Amount: ${rollback.amount} ${rollback.currency}\n` +
                    `Attempts: ${rollback.retryCount + 1}`,
            });

            return true;

        } catch (error) {
            this.logger.error(
                `Rollback retry failed for ${rollbackId}: ${error.message}`,
                error.stack
            );

            const newRetryCount = rollback.retryCount + 1;
            const isPermanentFailure = newRetryCount >= this.MAX_RETRY_ATTEMPTS;

            await this.prisma.failedRollback.update({
                where: { id: rollbackId },
                data: {
                    status: isPermanentFailure ? RollbackStatus.FAILED : RollbackStatus.PENDING,
                    retryCount: newRetryCount,
                    lastError: error.message,
                },
            });

            if (isPermanentFailure) {
                // CRITICAL: Max retries exceeded - requires manual intervention
                this.logger.error(
                    `🚨 CRITICAL: Rollback ${rollbackId} permanently failed after ${this.MAX_RETRY_ATTEMPTS} attempts`
                );

                await this.slackWebhookService.sendAlert?.('FAILED_ROLLBACK_PERMANENT', {
                    text: `🚨 CRITICAL: Rollback PERMANENTLY FAILED\n` +
                        `Order: ${rollback.orderId}\n` +
                        `User: ${rollback.userId}\n` +
                        `Amount: ${rollback.amount} ${rollback.currency}\n` +
                        `Attempts: ${this.MAX_RETRY_ATTEMPTS}\n` +
                        `Last Error: ${error.message}\n` +
                        `⚠️ MANUAL INTERVENTION REQUIRED`,
                });
            }

            return false;
        }
    }

    /**
     * Manual retry for admin use
     */
    async manualRetry(rollbackId: string): Promise<{ success: boolean; message: string }> {
        const rollback = await this.prisma.failedRollback.findUnique({
            where: { id: rollbackId },
        });

        if (!rollback) {
            return { success: false, message: 'Rollback not found' };
        }

        if (rollback.status === RollbackStatus.COMPLETED) {
            return { success: false, message: 'Rollback already completed' };
        }

        // Reset status to allow retry
        await this.prisma.failedRollback.update({
            where: { id: rollbackId },
            data: { status: RollbackStatus.PENDING },
        });

        const success = await this.retryRollback(rollbackId);

        return {
            success,
            message: success ? 'Rollback successful' : 'Rollback failed, check logs',
        };
    }

    /**
     * Get queue status for monitoring
     */
    async getQueueStatus(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            this.prisma.failedRollback.count({ where: { status: RollbackStatus.PENDING } }),
            this.prisma.failedRollback.count({ where: { status: RollbackStatus.PROCESSING } }),
            this.prisma.failedRollback.count({ where: { status: RollbackStatus.COMPLETED } }),
            this.prisma.failedRollback.count({ where: { status: RollbackStatus.FAILED } }),
        ]);

        return { pending, processing, completed, failed };
    }
}
