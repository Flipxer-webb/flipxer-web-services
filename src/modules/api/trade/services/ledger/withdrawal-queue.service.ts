import { Injectable, Logger } from "@nestjs/common";
import {
    QueueReason,
    EntryStatus,
    LedgerType,
    WithdrawalQueue,
} from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "./ledger.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Result of a queue operation
 */
export interface QueueOperationResult {
    success: boolean;
    queueEntry?: WithdrawalQueue;
    error?: string;
}

/**
 * Options for adding to queue
 */
export interface AddToQueueOptions {
    holdEntryId: string;
    userId: number;
    currency: string;
    amount: Decimal | number | string;
    reason: QueueReason;
}

/**
 * Queue statistics
 */
export interface QueueStats {
    totalQueued: number;
    byCurrency: Record<string, number>;
    byReason: Record<QueueReason, number>;
    oldestQueuedAt: Date | null;
}

/**
 * WithdrawalQueueService
 *
 * Manages the withdrawal queue for when withdrawals cannot be
 * processed immediately due to:
 * - Deposit still settling (sweep not confirmed)
 * - Low liquidity in main wallet
 *
 * Queue processing strategy:
 * - FIFO within same currency (smallest-first by amount)
 * - 72h timeout - auto-release hold and refund
 * - No user cancellation allowed
 * - Hidden from users (show as "pending" with hint)
 *
 * Design decisions:
 * - Smallest-first: Maximizes throughput, reduces queue depth faster
 * - No user cancel: Prevents gaming/arbitrage during price moves
 * - 72h timeout: Provides predictable SLA, auto-cleans stuck entries
 */
@Injectable()
export class WithdrawalQueueService {
    private readonly logger = new Logger(WithdrawalQueueService.name);

    // Queue timeout in hours
    private readonly QUEUE_TIMEOUT_HOURS = 72;

    constructor(
        private readonly prisma: PrismaService,
        private readonly ledgerService: LedgerService
    ) {}

    /**
     * Adds a withdrawal to the queue
     *
     * @param options Queue entry options
     * @returns Queue entry or error
     */
    async addToQueue(
        options: AddToQueueOptions
    ): Promise<QueueOperationResult> {
        const { holdEntryId, userId, currency, amount, reason } = options;

        try {
            // Verify the ledger entry exists and is in HOLD status
            const ledgerEntry = await this.prisma.ledgerEntry.findUnique({
                where: { id: holdEntryId },
            });

            if (!ledgerEntry) {
                return { success: false, error: "Ledger entry not found" };
            }

            if (ledgerEntry.status !== EntryStatus.HOLD) {
                return {
                    success: false,
                    error: `Ledger entry must be in HOLD status, got: ${ledgerEntry.status}`,
                };
            }

            if (ledgerEntry.type !== LedgerType.WITHDRAWAL) {
                return {
                    success: false,
                    error: `Only WITHDRAWAL entries can be queued, got: ${ledgerEntry.type}`,
                };
            }

            // Check if already queued
            const existingQueue = await this.prisma.withdrawalQueue.findUnique({
                where: { holdEntryId },
            });

            if (existingQueue) {
                this.logger.warn(
                    `Ledger entry already queued | ${JSON.stringify({
                        holdEntryId,
                        existingQueueId: existingQueue.id,
                    })}`
                );
                return { success: true, queueEntry: existingQueue };
            }

            // Get current queue position for this currency
            const maxPosition = await this.prisma.withdrawalQueue.aggregate({
                where: {
                    currency: currency.toUpperCase(),
                    processedAt: null, // Only active queue entries
                },
                _max: { position: true },
            });

            const nextPosition = (maxPosition._max.position ?? 0) + 1;

            // Convert amount to Decimal
            const queueAmount =
                amount instanceof Decimal
                    ? amount
                    : new Decimal(amount.toString());

            // Create queue entry
            const queueEntry = await this.prisma.withdrawalQueue.create({
                data: {
                    userId,
                    currency: currency.toUpperCase(),
                    amount: queueAmount,
                    holdEntryId,
                    reason,
                    position: nextPosition,
                },
            });

            this.logger.log(
                `Withdrawal queued | ${JSON.stringify({
                    queueId: queueEntry.id,
                    holdEntryId,
                    userId,
                    currency,
                    amount: queueAmount.toString(),
                    position: nextPosition,
                    reason,
                })}`
            );

            return { success: true, queueEntry };
        } catch (error) {
            this.logger.error(
                `Failed to add to queue | ${JSON.stringify({
                    holdEntryId,
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Gets the next queued withdrawal to process for a currency
     * Uses smallest-first strategy to maximize throughput
     *
     * @param currency Currency to check
     * @param maxAmount Maximum amount available for processing
     * @returns Queue entry or null
     */
    async getNextForProcessing(
        currency: string,
        maxAmount: Decimal
    ): Promise<(WithdrawalQueue & { holdEntry: any }) | null> {
        // Get all unprocessed queue entries for this currency that we can afford
        // Order by amount ascending (smallest first), then by position (FIFO tiebreaker)
        const candidates = await this.prisma.withdrawalQueue.findMany({
            where: {
                currency: currency.toUpperCase(),
                processedAt: null,
                releasedAt: null,
                amount: { lte: maxAmount },
            },
            include: {
                holdEntry: true,
            },
            orderBy: [{ amount: "asc" }, { position: "asc" }],
            take: 1,
        });

        return candidates[0] ?? null;
    }

    /**
     * Marks a queue entry as processed (withdrawal completed)
     *
     * @param queueId Queue entry ID
     */
    async markProcessed(queueId: string): Promise<void> {
        await this.prisma.withdrawalQueue.update({
            where: { id: queueId },
            data: { processedAt: new Date() },
        });

        this.logger.log(`Queue entry processed | queueId: ${queueId}`);
    }

    /**
     * Marks a queue entry as released (hold refunded)
     *
     * @param queueId Queue entry ID
     */
    async markReleased(queueId: string): Promise<void> {
        await this.prisma.withdrawalQueue.update({
            where: { id: queueId },
            data: { releasedAt: new Date() },
        });

        this.logger.log(`Queue entry released | queueId: ${queueId}`);
    }

    /**
     * Finds and processes timed-out queue entries
     * Releases holds and refunds users for entries older than 72h
     *
     * @returns Number of entries processed
     */
    async processTimeouts(): Promise<number> {
        const timeoutDate = new Date();
        timeoutDate.setHours(timeoutDate.getHours() - this.QUEUE_TIMEOUT_HOURS);

        // Find timed out entries
        const timedOut = await this.prisma.withdrawalQueue.findMany({
            where: {
                queuedAt: { lt: timeoutDate },
                processedAt: null,
                releasedAt: null,
            },
            include: {
                holdEntry: true,
                user: { select: { id: true, email: true } },
            },
        });

        if (timedOut.length === 0) {
            return 0;
        }

        this.logger.warn(
            `Processing ${timedOut.length} timed-out queue entries`
        );

        let processed = 0;

        for (const queueEntry of timedOut) {
            try {
                // Release the hold (refund to user)
                const result = await this.ledgerService.releaseHold(
                    queueEntry.holdEntry.reference,
                    false, // Don't settle - refund instead
                    `Withdrawal timed out after ${this.QUEUE_TIMEOUT_HOURS}h in queue`
                );

                if (result.success) {
                    // Mark as released
                    await this.markReleased(queueEntry.id);

                    this.logger.log(
                        `Timeout refund processed | ${JSON.stringify({
                            queueId: queueEntry.id,
                            userId: queueEntry.userId,
                            currency: queueEntry.currency,
                            amount: queueEntry.amount.toString(),
                            queuedAt: queueEntry.queuedAt,
                        })}`
                    );

                    processed++;
                } else {
                    this.logger.error(
                        `Failed to release hold for timeout | ${JSON.stringify({
                            queueId: queueEntry.id,
                            error: result.error,
                        })}`
                    );
                }
            } catch (error) {
                this.logger.error(
                    `Error processing timeout | ${JSON.stringify({
                        queueId: queueEntry.id,
                        error: error.message,
                    })}`
                );
            }
        }

        return processed;
    }

    /**
     * Gets queue position for a specific hold entry
     *
     * @param holdEntryId Hold entry ID
     * @returns Position in queue, or null if not queued
     */
    async getQueuePosition(holdEntryId: string): Promise<number | null> {
        const queueEntry = await this.prisma.withdrawalQueue.findUnique({
            where: { holdEntryId },
        });

        if (!queueEntry || queueEntry.processedAt || queueEntry.releasedAt) {
            return null;
        }

        // Count entries ahead in queue for same currency
        const ahead = await this.prisma.withdrawalQueue.count({
            where: {
                currency: queueEntry.currency,
                processedAt: null,
                releasedAt: null,
                position: { lt: queueEntry.position },
            },
        });

        return ahead + 1; // 1-based position
    }

    /**
     * Gets all active queue entries for a user
     *
     * @param userId User ID
     * @returns Active queue entries
     */
    async getUserQueuedWithdrawals(userId: number): Promise<WithdrawalQueue[]> {
        return this.prisma.withdrawalQueue.findMany({
            where: {
                userId,
                processedAt: null,
                releasedAt: null,
            },
            include: {
                holdEntry: true,
            },
            orderBy: { queuedAt: "asc" },
        });
    }

    /**
     * Gets queue statistics
     *
     * @returns Queue statistics
     */
    async getQueueStats(): Promise<QueueStats> {
        const activeEntries = await this.prisma.withdrawalQueue.findMany({
            where: {
                processedAt: null,
                releasedAt: null,
            },
            orderBy: { queuedAt: "asc" },
        });

        const byCurrency: Record<string, number> = {};
        const byReason: Record<QueueReason, number> = {
            [QueueReason.DEPOSIT_SETTLING]: 0,
            [QueueReason.LOW_LIQUIDITY]: 0,
        };

        for (const entry of activeEntries) {
            byCurrency[entry.currency] = (byCurrency[entry.currency] ?? 0) + 1;
            byReason[entry.reason]++;
        }

        return {
            totalQueued: activeEntries.length,
            byCurrency,
            byReason,
            oldestQueuedAt: activeEntries[0]?.queuedAt ?? null,
        };
    }

    /**
     * Gets total queued amount for a currency
     *
     * @param currency Currency to check
     * @returns Total amount queued
     */
    async getQueuedAmountByCurrency(currency: string): Promise<Decimal> {
        const result = await this.prisma.withdrawalQueue.aggregate({
            where: {
                currency: currency.toUpperCase(),
                processedAt: null,
                releasedAt: null,
            },
            _sum: { amount: true },
        });

        return result._sum.amount ?? new Decimal(0);
    }

    /**
     * Checks if processing should be paused
     * (e.g., due to reconciliation discrepancy)
     *
     * @returns True if processing is paused
     */
    async isProcessingPaused(): Promise<boolean> {
        // Check system settings for pause flag
        const setting = await this.prisma.systemSetting.findUnique({
            where: { key: "withdrawal_queue_paused" },
        });

        return setting?.value === "true";
    }

    /**
     * Pauses queue processing
     *
     * @param reason Reason for pause
     */
    async pauseProcessing(reason: string): Promise<void> {
        await this.prisma.systemSetting.upsert({
            where: { key: "withdrawal_queue_paused" },
            create: {
                key: "withdrawal_queue_paused",
                value: "true",
            },
            update: { value: "true" },
        });

        this.logger.warn(`Queue processing PAUSED | reason: ${reason}`);
    }

    /**
     * Resumes queue processing
     */
    async resumeProcessing(): Promise<void> {
        await this.prisma.systemSetting.upsert({
            where: { key: "withdrawal_queue_paused" },
            create: {
                key: "withdrawal_queue_paused",
                value: "false",
            },
            update: { value: "false" },
        });

        this.logger.log("Queue processing RESUMED");
    }

    /**
     * Gets all queue entries pending processing, ordered for processing
     *
     * @param currency Optional currency filter
     * @returns Queue entries ready for processing
     */
    async getPendingQueue(currency?: string): Promise<WithdrawalQueue[]> {
        const where: any = {
            processedAt: null,
            releasedAt: null,
        };

        if (currency) {
            where.currency = currency.toUpperCase();
        }

        return this.prisma.withdrawalQueue.findMany({
            where,
            include: {
                holdEntry: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
            orderBy: [{ amount: "asc" }, { position: "asc" }],
        });
    }
}
