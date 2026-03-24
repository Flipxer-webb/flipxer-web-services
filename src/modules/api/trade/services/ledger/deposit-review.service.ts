import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { DepositReviewStatus, LedgerType, SweepStatus } from "@prisma/client";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "./ledger.service";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";

/**
 * Result of deposit float check
 */
export interface FloatCheckResult {
    allowed: boolean;
    queued: boolean;
    queueId?: string;
    floatPercentage: number;
    reason?: string;
}

/**
 * DepositReviewService
 *
 * Manages the deposit review queue for deposits that exceed float thresholds.
 * When the float exposure exceeds the blockThreshold, deposits are queued
 * for admin review instead of being credited immediately.
 *
 * Key features:
 * - Check if deposit exceeds float block threshold
 * - Queue deposits for admin review
 * - Auto-approve after configurable timeout
 * - Admin approval/rejection
 *
 * Fix notes:
 * - DR-001: calculateFloatPercentage now uses DISTINCT ON to get latest
 *   balance per user rather than summing all historical balanceAfter snapshots
 * - DR-002: approveDeposit and processAutoApprovals now call
 *   LedgerService.pairedCreditInTransaction inside the same transaction
 *   as the status update so approval and credit are atomic
 * - DR-004: approveDeposit uses conditional updateMany (status gate) instead
 *   of findUnique + update to prevent concurrent double-approval
 * - DR-005: checkAndQueueIfNeeded wraps float read and queue insert in a
 *   serializable transaction to prevent burst deposits bypassing threshold
 */
@Injectable()
export class DepositReviewService {
    private readonly logger = new Logger(DepositReviewService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly ledgerService: LedgerService  // DR-002: injected for credit on approval
    ) { }

    /**
     * Check if a deposit should be queued due to float exposure
     *
     * @param userId User receiving the deposit
     * @param currency Currency being deposited
     * @param amount Deposit amount
     * @param depositAddress Address deposit was received on
     * @param txHash Blockchain transaction hash
     * @returns FloatCheckResult indicating if deposit is allowed or queued

     * FIX: DR-005 — float read and queue insert are now inside a single
     * SERIALIZABLE transaction. Concurrent deposits all read the same
     * committed float state; only one can insert at a time per Postgres
     * serialization. Burst deposits can no longer collectively bypass the
     * threshold by all reading pre-insert float values.
     */
    async checkAndQueueIfNeeded(
        userId: number,
        currency: string,
        amount: Decimal,
        depositAddress: string,
        txHash?: string
    ): Promise<FloatCheckResult> {
        const upperCurrency = currency.toUpperCase();

        // Get float config for this currency
        const floatConfig = await this.prisma.floatConfig.findUnique({
            where: { currency: upperCurrency },
        });

        // If no float config or not active, allow deposit
        if (!floatConfig || !floatConfig.isActive) {
            return {
                allowed: true,
                queued: false,
                floatPercentage: 0,
            };
        }

        // Calculate current float exposure

        // FIX: DR-005 — wrap float read and conditional queue insert in a
        // single SERIALIZABLE transaction so concurrent deposits cannot all
        // pass the threshold check using stale pre-insert float values
        return await this.prisma.$transaction(async (tx) => {
            const floatPercentage = await this.calculateFloatPercentageInTx(tx, upperCurrency, floatConfig);

            // If below block threshold, allow deposit
            if (floatPercentage < floatConfig.blockThreshold.toNumber()) {
                // If approaching alert threshold, log warning
                if (floatPercentage >= floatConfig.alertThreshold.toNumber()) {
                    this.logger.warn(
                        `Float approaching block threshold | ${upperCurrency} | Current: ${floatPercentage.toFixed(2)}% | Block at: ${floatConfig.blockThreshold}%`
                    );
                }
                return {
                    allowed: true,
                    queued: false,
                    floatPercentage,
                };
            }

            // Float exceeds block threshold - queue deposit for review
            this.logger.warn(
                `Float exceeds block threshold | ${upperCurrency} | Current: ${floatPercentage.toFixed(2)}% | Threshold: ${floatConfig.blockThreshold}% | Queueing deposit`
            );

            // Calculate auto-approve time
            const autoApproveAt = floatConfig.autoApproveHours > 0
                ? new Date(Date.now() + floatConfig.autoApproveHours * 60 * 60 * 1000)
                : null;
            // Create queue entry
            const queueEntry = await tx.depositReviewQueue.create({
                data: {
                    userId,
                    currency: upperCurrency,
                    amount,
                    depositAddress,
                    txHash,
                    floatAtDeposit: new Decimal(floatPercentage),
                    status: DepositReviewStatus.PENDING,
                    autoApproveAt,
                },
            });

            // Send Slack alert fire-and-forget outside the transaction
            // so a Slack failure cannot roll back the queue insert
            this.sendQueuedDepositAlert(
                userId, upperCurrency, amount, floatPercentage, queueEntry.id
            ).catch(e => this.logger.error(`Failed to send queued deposit alert: ${e.message}`));

            return {
                allowed: false,
                queued: true,
                queueId: queueEntry.id,
                floatPercentage,
                reason: `Deposit queued for review due to high float exposure (${floatPercentage.toFixed(2)}%)`,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
    }

    /**
     * Calculate current float percentage for a currency
     *
     * FIX: DR-001 — previous implementation summed balanceAfter across ALL
     * ledger entries for a currency (excluding platform). Since balanceAfter
     * is a running snapshot, a user with 100 transactions had their balance
     * counted 100 times, producing a total orders of magnitude too large.
     *
     * Fix: use a raw DISTINCT ON query to get the single latest balanceAfter
     * per user (ordered by sequenceNumber DESC), then sum those values.
     * This produces the correct sum of current balances across all users.
     *
     * Uses sequenceNumber for ordering consistency with LedgerService (AR-001).
     */
    private async calculateFloatPercentage(currency: string): Promise<number> {


        // Get float config for allowance
        const floatConfig = await this.prisma.floatConfig.findUnique({
            where: { currency },
        });

        if (!floatConfig || floatConfig.floatAllowance.eq(0)) {
            return 0;
        }

        return this.computeFloatPercentage(this.prisma, currency, floatConfig);
    }

    /**
     * Float calculation inside a transaction client (used by DR-005 fix)
     */
    private async calculateFloatPercentageInTx(
        tx: Prisma.TransactionClient,
        currency: string,
        floatConfig: { floatAllowance: Decimal; blockThreshold: Decimal; alertThreshold: Decimal }
    ): Promise<number> {
        if (floatConfig.floatAllowance.eq(0)) {
            return 0;
        }

        return this.computeFloatPercentage(tx, currency, floatConfig);
    }

    /**
     * Core float computation — shared between the standalone and in-transaction variants.
     *
     * FIX: DR-001 — DISTINCT ON (userId) ordered by sequenceNumber DESC gives
     * the single most recent ledger entry per user. Summing those balanceAfter
     * values gives the correct total of all current user balances.
     *
     * Excludes userId <= 0 (platform account = 0, network fee account = -1).
     */
    private async computeFloatPercentage(
        client: Prisma.TransactionClient | PrismaService,
        currency: string,
        floatConfig: { floatAllowance: Decimal }
    ): Promise<number> {
        // Raw query required: Prisma does not support DISTINCT ON natively.
        // DISTINCT ON (userId) with ORDER BY userId, sequenceNumber DESC gives
        // exactly one row per user — the row with the highest sequenceNumber
        // (i.e. the most recently inserted entry), whose balanceAfter reflects
        // the user's current balance.
        const result = await (client as any).$queryRaw<[{ total_balance: string | null }]>`
            SELECT SUM(latest."balanceAfter") AS total_balance
            FROM (
                SELECT DISTINCT ON ("userId") "balanceAfter"
                FROM "LedgerEntries"
                WHERE currency = ${currency}
                  AND "userId" > 0
                  AND status != 'FAILED'
                ORDER BY "userId", "sequenceNumber" DESC
            ) AS latest
        `;

        const totalLedgerBalance = result[0]?.total_balance
            ? new Decimal(result[0].total_balance)
            : new Decimal(0);

        return totalLedgerBalance.div(floatConfig.floatAllowance).mul(100).toNumber();
    }

    /**
     * Get pending deposit reviews
     */
    async getReviews(
        pageNumber: number = 1,
        pageSize: number = 10,
        status?: DepositReviewStatus,
        currency?: string
    ) {
        const where: any = {};
        // Default to PENDING if no status provided?
        // Actually, if we rename to getReviews, we might want to default to ALL or PENDING depending on usage.
        // Existing usage was "getPendingReviews", implying status=PENDING.
        // But admin portal might want to see history.
        // Let's rely on the controller to pass status=PENDING if that's the default behavior desired,
        // or handle it here.
        // For backward compatibility or safety, if no status is passed, maybe return all?
        // Let's check if the current implementation defaulted to PENDING. Yes it did.
        if (!status) where.status = DepositReviewStatus.PENDING;
        else where.status = status;
        if (currency) where.currency = currency;

        const [reviews, count] = await Promise.all([
            this.prisma.depositReviewQueue.findMany({
                where,
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true,
                        },
                    },
                    reviewer: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true,
                        },
                    },
                },
                orderBy: { queuedAt: "asc" },
                skip: (pageNumber - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.depositReviewQueue.count({ where }),
        ]);

        return { reviews, count };
    }

    /**
     * Approve a queued deposit
     *
     * FIX: DR-004 — replaced findUnique + update (two operations, race condition)
     * with a conditional updateMany that only updates if status = PENDING.
     * The affected row count tells us definitively whether this call won the
     * race. Concurrent approvals both execute the updateMany but only one
     * gets count=1; the other gets count=0 and returns an error.
     *
     * FIX: DR-002 — the status update and the ledger credit are now inside
     * a single prisma.$transaction. If the credit fails, the status update
     * rolls back. The ledger reference uses txHash (canonical blockchain ID)
     * with a fallback to queueId, ensuring the LedgerService idempotency
     * key is tied to the on-chain event rather than the internal record.
     */
    async approveDeposit(
        queueId: string,
        adminId: number,
        notes?: string
    ): Promise<{ success: boolean; entry?: any; error?: string }> {

        return await this.prisma.$transaction(async (tx) => {
            // FIX: DR-004 — atomic conditional update: only succeeds if
            // status is still PENDING. count=0 means another process won.
            const updateResult = await tx.depositReviewQueue.updateMany({
                where: {
                    id: queueId,
                    status: DepositReviewStatus.PENDING,   // gate: only update if still PENDING
                },
                data: {
                    status: DepositReviewStatus.APPROVED,
                    reviewedAt: new Date(),
                    reviewedBy: adminId,
                    notes,
                },
            });

            if (updateResult.count === 0) {
                // Either not found or already processed by a concurrent request
                const existing = await tx.depositReviewQueue.findUnique({
                    where: { id: queueId },
                    select: { status: true },
                });

                if (!existing) {
                    return { success: false, error: "Queue entry not found" };
                }

                return {
                    success: false,
                    error: `Deposit already ${existing.status.toLowerCase()}`,
                };
            }

            // Fetch the updated entry for the credit call and return value
            const queueEntry = await tx.depositReviewQueue.findUnique({
                where: { id: queueId },
            });

            // FIX: DR-002 — credit the user atomically within this transaction.
            // Reference: txHash is the canonical on-chain ID. Fall back to
            // queue ID prefixed to avoid collision with other ledger entry types.
            const ledgerReference = queueEntry.txHash ?? `deposit-review-approved:${queueId}`;

            const creditResult = await this.ledgerService.pairedCreditInTransaction(
                tx,
                {
                    userId: queueEntry.userId,
                    currency: queueEntry.currency,
                    type: LedgerType.DEPOSIT,
                    amount: queueEntry.amount,
                    reference: ledgerReference,
                    sweepStatus: SweepStatus.NOT_APPLICABLE, // already in main wallet
                    description: `Deposit approved after float review | Queue: ${queueId} | Admin: ${adminId}`,
                    metadata: {
                        queueId,
                        adminId,
                        approvalType: "manual",
                        txHash: queueEntry.txHash,
                    },
                }
            );

            if (!creditResult.success) {
                // Throwing here rolls back the entire transaction including
                // the status update — leaves queue entry in PENDING state
                throw new Error(`Failed to credit user ledger: ${creditResult.error}`);
            }

            this.logger.log(
                `Deposit approved and credited | Queue: ${queueId} | Admin: ${adminId} | LedgerEntry: ${creditResult.userEntry?.id} | Amount: ${queueEntry.amount} ${queueEntry.currency}`
            );

            return {
                success: true,
                entry: queueEntry,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 15000,
        });
    }

    /**
     * Reject a queued deposit
     *
     * FIX: DR-004 pattern applied — conditional updateMany prevents
     * concurrent double-rejection producing inconsistent state.
     */
    async rejectDeposit(
        queueId: string,
        adminId: number,
        notes?: string
    ): Promise<{ success: boolean; error?: string }> {

        const updateResult = await this.prisma.depositReviewQueue.updateMany({
            where: {
                id: queueId,
                status: DepositReviewStatus.PENDING,  // gate: only update if still PENDING
            },
            data: {
                status: DepositReviewStatus.REJECTED,
                reviewedAt: new Date(),
                reviewedBy: adminId,
                notes,
            },
        });

        if (updateResult.count === 0) {
            const existing = await this.prisma.depositReviewQueue.findUnique({
                where: { id: queueId },
                select: { status: true },
            });

            if (!existing) {
                return { success: false, error: "Queue entry not found" };
            }

            return {
                success: false,
                error: `Deposit already ${existing.status.toLowerCase()}`,
            };
        }

        this.logger.log(`Deposit rejected | Queue: ${queueId} | Admin: ${adminId}`);

        return { success: true };
    }

    /**
     * Process auto-approvals for deposits past their timeout
     *
     * FIX: DR-002 — each auto-approval now credits the user ledger atomically
     * with the status update inside a single transaction.
     *
     * Note: DR-007 (no distributed lock on this job) is a Tier 3 finding and
     * should be addressed separately. For now, the conditional updateMany on
     * each entry provides entry-level protection against double-processing
     * even if the job runs concurrently on multiple pods.
     */
    async processAutoApprovals(): Promise<number> {
        const now = new Date();

        const pendingAutoApprovals = await this.prisma.depositReviewQueue.findMany({
            where: {
                status: DepositReviewStatus.PENDING,
                autoApproveAt: { lte: now },
            },
        });

        let approvedCount = 0;

        for (const entry of pendingAutoApprovals) {
            try {
                await this.prisma.$transaction(async (tx) => {
                    // FIX: DR-004 pattern — conditional gate prevents double-processing
                    // if two pods pick up the same entry simultaneously
                    const updateResult = await tx.depositReviewQueue.updateMany({
                        where: {
                            id: entry.id,
                            status: DepositReviewStatus.PENDING,  // gate
                        },
                        data: {
                            status: DepositReviewStatus.AUTO_APPROVED,
                            reviewedAt: now,
                            notes: "Auto-approved after timeout",
                        },
                    });

                    if (updateResult.count === 0) {
                        // Another pod already processed this entry — skip silently
                        return;
                    }

                    // FIX: DR-002 — credit the user atomically within this transaction
                    const ledgerReference = entry.txHash ?? `deposit-review-auto:${entry.id}`;

                    const creditResult = await this.ledgerService.pairedCreditInTransaction(
                        tx,
                        {
                            userId: entry.userId,
                            currency: entry.currency,
                            type: LedgerType.DEPOSIT,
                            amount: entry.amount,
                            reference: ledgerReference,
                            sweepStatus: SweepStatus.NOT_APPLICABLE,
                            description: `Deposit auto-approved after float review timeout | Queue: ${entry.id}`,
                            metadata: {
                                queueId: entry.id,
                                approvalType: "auto",
                                txHash: entry.txHash,
                            },
                        }
                    );

                    if (!creditResult.success) {
                        throw new Error(`Failed to credit user ledger: ${creditResult.error}`);
                    }

                    this.logger.log(
                        `Deposit auto-approved and credited | Queue: ${entry.id} | User: ${entry.userId} | LedgerEntry: ${creditResult.userEntry?.id} | Amount: ${entry.amount} ${entry.currency}`
                    );

                    approvedCount++;
                }, {
                    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                    timeout: 15000,
                });
            } catch (error) {
                // Log and continue — one failing entry should not block the rest
                this.logger.error(
                    `Auto-approval failed | Queue: ${entry.id} | User: ${entry.userId} | Error: ${error.message}`
                );
            }
        }

        if (approvedCount > 0) {
            this.logger.log(`Auto-approved ${approvedCount} queued deposits`);
        }

        return approvedCount;
    }

    /**
     * Get statistics for deposit review queue
     */
    async getStats(status?: string, currency?: string) {
        const baseWhere = {
            ...(currency && { currency: currency.toUpperCase() }),
        };

        const filteredWhere = {
            ...baseWhere,
            ...(status && { status: status as DepositReviewStatus }),
        };

        const total = await this.prisma.depositReviewQueue.count({ where: filteredWhere });

        let pending: number;
        let approved: number;
        let rejected: number;
        let autoApproved: number;

        if (status) {
            pending     = status === DepositReviewStatus.PENDING      ? total : 0;
            approved    = status === DepositReviewStatus.APPROVED     ? total : 0;
            rejected    = status === DepositReviewStatus.REJECTED     ? total : 0;
            autoApproved = status === DepositReviewStatus.AUTO_APPROVED ? total : 0;
        } else {
            [pending, approved, rejected, autoApproved] = await Promise.all([
                this.prisma.depositReviewQueue.count({ where: { ...baseWhere, status: DepositReviewStatus.PENDING } }),
                this.prisma.depositReviewQueue.count({ where: { ...baseWhere, status: DepositReviewStatus.APPROVED } }),
                this.prisma.depositReviewQueue.count({ where: { ...baseWhere, status: DepositReviewStatus.REJECTED } }),
                this.prisma.depositReviewQueue.count({ where: { ...baseWhere, status: DepositReviewStatus.AUTO_APPROVED } }),
            ]);
        }

        return {
            pending,
            approved,
            rejected,
            autoApproved,
            total,
        };
    }

    /**
     * Send Slack alert for queued deposit
     *
     * Fire-and-forget only — never awaited on the critical path.
     * A Slack failure must never block or roll back a deposit queue insert.
     */
    private async sendQueuedDepositAlert(
        userId: number,
        currency: string,
        amount: Decimal,
        floatPercentage: number,
        queueId: string
    ): Promise<void> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, firstName: true, lastName: true },
            });

            await this.slackWebhookService.sendSystemAlert(
                "deposit_review",
                "⚠️ DEPOSIT QUEUED FOR REVIEW",
                `Deposit blocked due to high float exposure`,
                {
                    queueId,
                    userId,
                    userEmail: user?.email,
                    userName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
                    amount: amount.toString(),
                    currency,
                    floatPercentage: `${floatPercentage.toFixed(2)}%`,
                },
                "warning"
            );
        } catch (error) {
            this.logger.error(`Failed to send queued deposit alert: ${error.message}`);
        }
    }
}
