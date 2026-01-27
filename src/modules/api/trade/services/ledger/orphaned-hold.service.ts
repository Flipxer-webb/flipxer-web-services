import { Injectable, Logger } from "@nestjs/common";
import { EntryStatus, HoldResolution, LedgerEntry, OrphanedHoldReview } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "./ledger.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Result of orphaned hold detection
 */
export interface OrphanedHoldResult {
    detected: number;
    alerted: number;
    errors: string[];
}

/**
 * Result of orphaned hold resolution
 */
export interface ResolveResult {
    success: boolean;
    error?: string;
}

/**
 * OrphanedHoldService
 *
 * Detects and manages orphaned hold entries - hold entries that have been
 * stuck for longer than expected without being settled or released.
 *
 * Design decisions:
 * - 24h detection threshold: Holds older than 24h are flagged for review
 * - No auto-release: Requires admin approval for all resolutions
 * - Three resolution options: REFUND, SETTLE, or DISMISS
 * - Excludes holds linked to active withdrawal queue entries
 */
@Injectable()
export class OrphanedHoldService {
    private readonly logger = new Logger(OrphanedHoldService.name);

    // Detection threshold in hours
    private readonly DETECTION_THRESHOLD_HOURS = 24;

    constructor(
        private readonly prisma: PrismaService,
        private readonly ledgerService: LedgerService,
        private readonly slackWebhookService: SlackWebhookService
    ) { }

    /**
     * Detects orphaned holds and creates review entries
     * Called by cron job every 15 minutes
     *
     * @returns Detection result with counts
     */
    async detectOrphanedHolds(): Promise<OrphanedHoldResult> {
        const thresholdDate = new Date();
        thresholdDate.setHours(thresholdDate.getHours() - this.DETECTION_THRESHOLD_HOURS);

        const result: OrphanedHoldResult = {
            detected: 0,
            alerted: 0,
            errors: [],
        };

        try {
            // Find HOLD entries older than threshold that:
            // 1. Are still in HOLD status
            // 2. Are NOT linked to an active withdrawal queue entry
            // 3. Are NOT already in OrphanedHoldReview
            const orphanedHolds = await this.prisma.ledgerEntry.findMany({
                where: {
                    status: EntryStatus.HOLD,
                    createdAt: { lt: thresholdDate },
                    // Exclude entries already in review
                    orphanedHoldReview: null,
                    // Either no withdrawal queue OR withdrawal queue is already processed/released
                    OR: [
                        { withdrawalQueue: null },
                        {
                            withdrawalQueue: {
                                OR: [
                                    { processedAt: { not: null } },
                                    { releasedAt: { not: null } },
                                ],
                            },
                        },
                    ],
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true,
                        },
                    },
                    withdrawalQueue: true,
                },
            });

            if (orphanedHolds.length === 0) {
                this.logger.debug("No new orphaned holds detected");
                return result;
            }

            this.logger.log(`Detected ${orphanedHolds.length} new orphaned holds`);
            result.detected = orphanedHolds.length;

            // Create review entries for each orphaned hold
            for (const hold of orphanedHolds) {
                try {
                    await this.createReviewEntry(hold);
                } catch (error) {
                    const msg = `Failed to create review for hold ${hold.id}: ${error.message}`;
                    this.logger.error(msg);
                    result.errors.push(msg);
                }
            }

            // Send Slack alert
            if (orphanedHolds.length > 0) {
                await this.sendOrphanedHoldAlert(orphanedHolds);
                result.alerted = orphanedHolds.length;
            }

            return result;
        } catch (error) {
            this.logger.error(`Error detecting orphaned holds: ${error.message}`, error.stack);
            result.errors.push(error.message);
            return result;
        }
    }

    /**
     * Creates an OrphanedHoldReview entry for admin review
     */
    private async createReviewEntry(hold: LedgerEntry): Promise<OrphanedHoldReview> {
        return this.prisma.orphanedHoldReview.create({
            data: {
                ledgerEntryId: hold.id,
                userId: hold.userId,
                currency: hold.currency,
                amount: hold.holdAmount ?? new Decimal(0),
            },
        });
    }

    /**
     * Sends Slack alert for newly detected orphaned holds
     */
    private async sendOrphanedHoldAlert(holds: any[]): Promise<void> {
        try {
            const summary = holds.map(h =>
                `• User ${h.userId} (${h.user?.email || 'unknown'}): ${h.holdAmount?.toString() || '0'} ${h.currency} - Hold since ${h.createdAt.toISOString()}`
            ).join('\n');

            const messageText = [
                `🔒 *Orphaned Holds Detected: ${holds.length} entries*`,
                ``,
                `The following hold entries have been stuck for >${this.DETECTION_THRESHOLD_HOURS}h:`,
                ``,
                summary,
                ``,
                `⚠️ Admin review required at /admin/orphaned-holds`,
            ].join('\n');

            await this.slackWebhookService.sendAlert(
                "ORPHANED_HOLD",
                { text: messageText },
                { alertKey: `orphaned:${Date.now()}` }
            );
        } catch (error) {
            this.logger.error(`Failed to send orphaned hold alert: ${error.message}`);
        }
    }

    /**
     * Gets all pending orphaned holds awaiting review
     *
     * @returns List of pending reviews with related data
     */
    async getPendingReviews(pageNumber: number = 1, pageSize: number = 10): Promise<any> {
        return this.prisma.orphanedHoldReview.findMany({
            where: { resolvedAt: null },
            include: {
                ledgerEntry: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                email: true,
                                firstName: true,
                                lastName: true,
                            },
                        },
                    },
                },
                resolver: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
            orderBy: { detectedAt: "asc" },
            skip: (pageNumber - 1) * pageSize,
            take: pageSize,
        });
    }

    /**
     * Gets a single orphaned hold review by ID
     */
    async getReviewById(id: string): Promise<OrphanedHoldReview | null> {
        return this.prisma.orphanedHoldReview.findUnique({
            where: { id },
            include: {
                ledgerEntry: true,
                resolver: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });
    }

    /**
     * Resolves an orphaned hold with admin approval
     *
     * @param reviewId OrphanedHoldReview ID
     * @param resolution Resolution action (REFUND, SETTLE, DISMISS)
     * @param adminUserId Admin user performing the resolution
     * @param notes Optional notes for audit trail
     * @returns Resolution result
     */
    async resolveOrphanedHold(
        reviewId: string,
        resolution: HoldResolution,
        adminUserId: number,
        notes?: string
    ): Promise<ResolveResult> {
        const review = await this.prisma.orphanedHoldReview.findUnique({
            where: { id: reviewId },
            include: { ledgerEntry: true },
        });

        if (!review) {
            return { success: false, error: "Review not found" };
        }

        if (review.resolvedAt) {
            return { success: false, error: "Review already resolved" };
        }

        if (review.ledgerEntry.status !== EntryStatus.HOLD) {
            return { success: false, error: `Ledger entry is no longer in HOLD status: ${review.ledgerEntry.status}` };
        }

        try {
            // Execute resolution based on type
            switch (resolution) {
                case HoldResolution.REFUND:
                    // Release hold without debit - funds return to available
                    const refundResult = await this.ledgerService.releaseHold(
                        review.ledgerEntry.reference,
                        false, // settle=false means refund
                        `Admin refund: ${notes || 'Orphaned hold resolved'}`
                    );
                    if (!refundResult.success) {
                        return { success: false, error: refundResult.error };
                    }
                    break;

                case HoldResolution.SETTLE:
                    // Convert hold to debit - execute the original operation
                    const settleResult = await this.ledgerService.releaseHold(
                        review.ledgerEntry.reference,
                        true, // settle=true means convert to debit
                        `Admin settle: ${notes || 'Orphaned hold executed'}`
                    );
                    if (!settleResult.success) {
                        return { success: false, error: settleResult.error };
                    }
                    break;

                case HoldResolution.DISMISS:
                    // No ledger action - just mark as reviewed
                    // The hold stays as-is (may have been resolved by other means)
                    break;
            }

            // Update the review record
            await this.prisma.orphanedHoldReview.update({
                where: { id: reviewId },
                data: {
                    resolvedAt: new Date(),
                    resolvedBy: adminUserId,
                    resolution,
                    notes,
                },
            });

            this.logger.log(`Orphaned hold resolved | ${JSON.stringify({
                reviewId,
                resolution,
                adminUserId,
                ledgerEntryId: review.ledgerEntryId,
            })}`);

            return { success: true };
        } catch (error) {
            this.logger.error(`Failed to resolve orphaned hold: ${error.message}`, error.stack);
            return { success: false, error: error.message };
        }
    }

    /**
     * Gets statistics for orphaned holds
     */
    async getStats(): Promise<{
        pending: number;
        resolved: number;
        byResolution: Record<HoldResolution, number>;
    }> {
        const [pending, resolved, byResolution] = await Promise.all([
            this.prisma.orphanedHoldReview.count({ where: { resolvedAt: null } }),
            this.prisma.orphanedHoldReview.count({ where: { resolvedAt: { not: null } } }),
            this.prisma.orphanedHoldReview.groupBy({
                by: ["resolution"],
                where: { resolvedAt: { not: null } },
                _count: true,
            }),
        ]);

        const resolutionCounts: Record<HoldResolution, number> = {
            [HoldResolution.REFUND]: 0,
            [HoldResolution.SETTLE]: 0,
            [HoldResolution.DISMISS]: 0,
        };

        for (const stat of byResolution) {
            if (stat.resolution) {
                resolutionCounts[stat.resolution] = stat._count;
            }
        }

        return {
            pending,
            resolved,
            byResolution: resolutionCounts,
        };
    }
}
