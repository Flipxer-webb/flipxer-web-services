import { Injectable, Logger } from "@nestjs/common";
import {
    QueueReason,
    EntryStatus,
    LedgerType,
    WithdrawalQueue,
    OrderCategory,
    Prisma,
} from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "./ledger.service";
import { Decimal } from "@prisma/client/runtime/library";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { NotificationMessageService } from "@/modules/core/messages/services/notification.service";

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

export interface AdminWithdrawalQueueItem {
    id: string;
    orderId: number | null;
    userId: number;
    currency: string;
    amount: number;
    position: number;
    priority: number;
    reason: string;
    status: "PENDING" | "PROCESSING" | "PROCESSED" | "TIMED_OUT";
    queuedAt: Date;
    processedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    user?: {
        id: number;
        email: string;
        full_name: string;
    };
    order?: {
        id: number | null;
        transactionId: string | null;
        walletAddress: string | null;
        network: string | null;
    };
}

export interface AdminWithdrawalQueueStats {
    totalPending: number;
    totalPendingAmount: Record<string, number>;
    oldestEntry: Date | null;
    averageWaitTime: number;
    currencyBreakdown: Record<string, number>;
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
        private readonly ledgerService: LedgerService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly notificationMessage: NotificationMessageService,
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

            // FIX: WQ-002 — Use try/catch on create instead of findUnique+create
            // to eliminate the race condition where two concurrent requests both
            // pass the uniqueness check before either creates. The @unique
            // constraint on holdEntryId is the authoritative guard.
            let queueEntry: WithdrawalQueue;
            try {
                queueEntry = await this.prisma.withdrawalQueue.create({
                    data: {
                        userId,
                        currency: currency.toUpperCase(),
                        amount: queueAmount,
                        holdEntryId,
                        reason,
                        position: nextPosition,
                    },
                });
            } catch (error) {
                // P2002 = unique constraint violation → entry already queued
                if (
                    error instanceof Prisma.PrismaClientKnownRequestError &&
                    error.code === "P2002"
                ) {
                    const existingQueue =
                        await this.prisma.withdrawalQueue.findUnique({
                            where: { holdEntryId },
                        });

                    this.logger.warn(
                        `Ledger entry already queued (concurrent insert) | ${JSON.stringify({
                            holdEntryId,
                            existingQueueId: existingQueue?.id,
                        })}`
                    );

                    return {
                        success: true,
                        queueEntry: existingQueue ?? undefined,
                    };
                }
                throw error;
            }

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
     * FIX: WQ-003 — Uses an optimistic concurrency gate (updateMany setting
     * releasedAt WHERE releasedAt IS NULL) before calling releaseHold().
     * This prevents multi-pod duplicate refund attempts when processQueue()
     * runs concurrently on multiple pods.
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
                // FIX: WQ-003 — Optimistic concurrency gate: claim the entry
                // by setting releasedAt. If another pod already claimed it,
                // updateMany returns count=0 and we skip.
                const claimResult = await this.prisma.withdrawalQueue.updateMany({
                    where: {
                        id: queueEntry.id,
                        releasedAt: null, // gate: only if not yet released
                    },
                    data: { releasedAt: new Date() },
                });

                if (claimResult.count === 0) {
                    this.logger.debug(
                        `Timeout entry already claimed by another process | queueId: ${queueEntry.id}`
                    );
                    continue;
                }

                // Release the hold (refund to user)
                const result = await this.ledgerService.releaseHold(
                    queueEntry.holdEntry.reference,
                    false, // Don't settle - refund instead
                    `Withdrawal timed out after ${this.QUEUE_TIMEOUT_HOURS}h in queue`
                );

                if (result.success) {
                    this.logger.log(
                        `Timeout refund processed | ${JSON.stringify({
                            queueId: queueEntry.id,
                            userId: queueEntry.userId,
                            currency: queueEntry.currency,
                            amount: queueEntry.amount.toString(),
                            queuedAt: queueEntry.queuedAt,
                        })}`
                    );

                    // Notify user that their queued withdrawal was refunded
                    try {
                        const message = this.notificationMessage.sendWithdrawalRefunded({
                            amount: queueEntry.amount.toString(),
                            currency: queueEntry.currency,
                            transactionId: queueEntry.id,
                        });
                        await this.notificationDispatcher.notify({
                            userId: queueEntry.userId,
                            title: "Withdrawal refunded",
                            body: message,
                            category: "transaction",
                            currency: queueEntry.currency,
                            transactionType: OrderCategory.SEND,
                            enableEmail: true,
                            emailPayload: {
                                email: queueEntry.user?.email || '',
                                transactionType: 'withdrawal',
                                transactionId: queueEntry.id,
                                amount: queueEntry.amount.toString(),
                                currency: queueEntry.currency.toUpperCase(),
                                status: 'refunded',
                                date: new Date().toISOString(),
                            },
                            enablePush: true,
                        });
                    } catch (notifError) {
                        this.logger.error(
                            `Failed to send refund notification for queue entry ${queueEntry.id}: ${notifError.message}`
                        );
                    }

                    processed++;
                } else {
                    // Rollback the optimistic claim so the entry can be
                    // retried on the next cycle
                    await this.prisma.withdrawalQueue.update({
                        where: { id: queueEntry.id },
                        data: { releasedAt: null },
                    });

                    this.logger.error(
                        `Failed to release hold for timeout (claim rolled back) | ${JSON.stringify({
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

    async getAdminQueueStats(): Promise<AdminWithdrawalQueueStats> {
        const activeEntries = await this.prisma.withdrawalQueue.findMany({
            where: {
                processedAt: null,
                releasedAt: null,
            },
            select: {
                currency: true,
                amount: true,
                queuedAt: true,
            },
        });

        const currencyBreakdown: Record<string, number> = {};
        const totalPendingAmount: Record<string, number> = {};

        for (const entry of activeEntries) {
            currencyBreakdown[entry.currency] =
                (currencyBreakdown[entry.currency] ?? 0) + 1;
            totalPendingAmount[entry.currency] =
                (totalPendingAmount[entry.currency] ?? 0) +
                Number(entry.amount.toString());
        }

        let oldestEntry: Date | null = null;
        let totalWaitSeconds = 0;
        const now = Date.now();

        for (const entry of activeEntries) {
            if (!oldestEntry || entry.queuedAt < oldestEntry) {
                oldestEntry = entry.queuedAt;
            }

            totalWaitSeconds += Math.max(
                0,
                (now - entry.queuedAt.getTime()) / 1000
            );
        }

        return {
            totalPending: activeEntries.length,
            totalPendingAmount,
            oldestEntry,
            averageWaitTime:
                activeEntries.length > 0
                    ? totalWaitSeconds / activeEntries.length
                    : 0,
            currencyBreakdown,
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
    async getPendingQueue(currency?: string): Promise<AdminWithdrawalQueueItem[]> {
        const where: any = {
            processedAt: null,
            releasedAt: null,
        };

        if (currency) {
            where.currency = currency.toUpperCase();
        }

        const queueEntries = await this.prisma.withdrawalQueue.findMany({
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

        const holdEntryIds = Array.from(
            new Set(queueEntries.map((entry) => entry.holdEntryId))
        );

        const linkedOrders =
            holdEntryIds.length > 0
                ? await this.prisma.order.findMany({
                      where: {
                          orderCategory: OrderCategory.SEND,
                          ledgerEntryId: { in: holdEntryIds },
                      },
                      select: {
                          id: true,
                          transactionId: true,
                          recipient: true,
                          ledgerEntryId: true,
                          createdAt: true,
                      },
                      orderBy: { createdAt: "desc" },
                  })
                : [];

        const latestOrderByLedgerEntryId = new Map<string, (typeof linkedOrders)[number]>();
        for (const order of linkedOrders) {
            if (order.ledgerEntryId && !latestOrderByLedgerEntryId.has(order.ledgerEntryId)) {
                latestOrderByLedgerEntryId.set(order.ledgerEntryId, order);
            }
        }

        return queueEntries.map((entry) => {
            const metadata = (entry.holdEntry?.metadata ?? {}) as Record<string, unknown>;
            const extractFirstString = (...values: unknown[]): string => {
                for (const value of values) {
                    if (typeof value === "string" && value.trim()) {
                        return value.trim();
                    }
                }
                return "";
            };

            const metadataDestination = extractFirstString(
                metadata.destinationAddress,
                metadata.walletAddress,
                metadata.recipient,
                metadata.address,
                metadata.toAddress
            );
            const metadataNetwork = extractFirstString(
                metadata.network,
                metadata.destinationNetwork,
                metadata.chain,
                metadata.blockchain
            );
            const linkedOrder = latestOrderByLedgerEntryId.get(entry.holdEntryId);

            const firstName = entry.user?.firstName ?? "";
            const lastName = entry.user?.lastName ?? "";
            const fullName = `${firstName} ${lastName}`.trim() || `User #${entry.userId}`;

            const walletAddress =
                metadataDestination || linkedOrder?.recipient?.trim() || "";
            const network = metadataNetwork || "";

            return {
                id: entry.id,
                orderId: linkedOrder?.id ?? null,
                userId: entry.userId,
                currency: entry.currency,
                amount: Number(entry.amount.toString()),
                position: entry.position,
                priority: entry.position,
                reason: String(entry.reason),
                status: "PENDING",
                queuedAt: entry.queuedAt,
                processedAt: null,
                createdAt: entry.queuedAt,
                updatedAt: entry.queuedAt,
                user: entry.user
                    ? {
                          id: entry.user.id,
                          email: entry.user.email,
                          full_name: fullName,
                      }
                    : undefined,
                order:
                    linkedOrder || walletAddress || network
                        ? {
                              id: linkedOrder?.id ?? null,
                              transactionId: linkedOrder?.transactionId ?? null,
                              walletAddress: walletAddress || null,
                              network: network || null,
                          }
                        : undefined,
            };
        });
    }
}
