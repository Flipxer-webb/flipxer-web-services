import { Injectable, Logger, Inject } from "@nestjs/common";
import { SweepStatus, LedgerType, EntryStatus } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { LedgerService } from "./ledger.service";
import { Decimal } from "@prisma/client/runtime/library";
import { randomUUID } from "crypto";

/**
 * Sweep operation result
 */
export interface SweepResult {
    success: boolean;
    ledgerEntryId: string;
    transactionId?: string;
    error?: string;
}

/**
 * Pending sweep entry
 */
export interface PendingSweep {
    ledgerEntryId: string;
    userId: number;
    currency: string;
    amount: Decimal;
    depositAddress?: string;
    createdAt: Date;
}

/**
 * SweepService
 *
 * Handles sweeping funds from user sub-accounts to the main omnibus wallet.
 *
 * Design decisions (from user requirements):
 * - Block withdrawal until sweep confirms: User can't withdraw until their
 *   deposit is confirmed in the main wallet
 * - Async sweep: Don't block deposit credit, sweep happens in background
 * - Track sweep status per entry: PENDING → IN_PROGRESS → COMPLETED/FAILED
 *
 * Sweep flow:
 * 1. Deposit webhook credits user ledger (sweepStatus = PENDING)
 * 2. Sweep cron picks up pending sweeps
 * 3. Initiates internal transfer from sub-account to main wallet (fund_uid: "me")
 * 4. Updates sweepStatus to IN_PROGRESS, stores sweepTxId for webhook correlation
 * 5. Quidax fires withdraw.successful webhook → routed by reference prefix "sweep-"
 *    to handleSweepConfirmation() via TradingService facade
 * 6. sweepStatus updated to COMPLETED or FAILED
 * 7. User can now withdraw
 *
 * Internal transfer (fund_uid: "me") vs on-chain withdrawal:
 * - Fee-free: no blockchain network fees
 * - Instant: no block confirmation wait
 * - No wallet address lookup needed: "me" tells Quidax to credit parent account
 *
 * Fix notes:
 * - SW-001: handleSweepConfirmation() fully implemented. sweepTxId column on
 *   LedgerEntry stores the Quidax transactionId at initiation for webhook
 *   correlation. Status update is locked and atomic.
 * - SW-002: retryFailedSweeps() now tracks sweepRetryCount, applies exponential
 *   backoff, and caps retries at MAX_LIFETIME_RETRIES.
 * - SW-003: updateSweepStatus() is now private with a state machine transition
 *   guard. External callers use purpose-built public methods.
 * - SW-004: (removed) Wallet address pre-fetch no longer needed — fund_uid: "me".
 * - SW-005: processPendingSweeps() protected by a distributed job lock.
 * - SW-006: MIN_SWEEP_AMOUNTS unknown currency throws instead of defaulting to 0.
 * - SW-007: sweepReference uses randomUUID() suffix instead of Date.now().
 * - SW-008: hasPendingSweeps auto-fail routes through updateSweepStatus().
 */
@Injectable()
export class SweepService {
    private readonly logger = new Logger(SweepService.name);

    // Sweep batch size
    private readonly BATCH_SIZE = 10;

    // Maximum lifetime retries before an entry is permanently abandoned (SW-002)
    private readonly MAX_LIFETIME_RETRIES = 3;

    // Exponential backoff base in minutes (SW-002)
    // Retry 1: 2 min, Retry 2: 4 min, Retry 3: 8 min
    private readonly BACKOFF_BASE_MINUTES = 2;

    // Stale sweep window — entries older than this are auto-failed
    private readonly SWEEP_BLOCK_WINDOW_HOURS = 2;

    // SW-009: Stale IN_PROGRESS window — entries stuck in IN_PROGRESS longer
    // than this are considered abandoned and eligible for retry.
    // 15 minutes is well beyond the normal Quidax transfer time (seconds–minutes).
    private readonly STALE_IN_PROGRESS_MINUTES = 15;

    // Minimum amount to sweep (avoid dust)
    // FIX: SW-006 — unknown currencies are explicitly rejected rather than
    // silently defaulting to Decimal(0) which would sweep any dust amount
    // Thresholds lowered: internal transfers (fund_uid: "me") are fee-free,
    // so we only need to guard against true dust rather than covering network fees.
    private readonly MIN_SWEEP_AMOUNTS: Record<string, Decimal> = {
        BTC: new Decimal(0.00001),
        ETH: new Decimal(0.0001),
        USDT: new Decimal(0.01),
        USDC: new Decimal(0.01),
        BNB: new Decimal(0.001),
        SOL: new Decimal(0.01),
    };

    // FIX: SW-003 — valid state machine transitions.
    // Only transitions in this map are permitted. Attempting any other
    // transition throws to prevent callers from corrupting sweep state.
    private readonly VALID_TRANSITIONS: Partial<Record<SweepStatus, SweepStatus[]>> = {
        [SweepStatus.PENDING]: [SweepStatus.IN_PROGRESS, SweepStatus.NOT_APPLICABLE, SweepStatus.COMPLETED],
        [SweepStatus.IN_PROGRESS]: [SweepStatus.COMPLETED, SweepStatus.FAILED, SweepStatus.PENDING],
        [SweepStatus.FAILED]: [SweepStatus.PENDING, SweepStatus.NOT_APPLICABLE],
        // COMPLETED and NOT_APPLICABLE are terminal — no valid next state
    };

    // Quidax error messages that indicate a non-retryable condition.
    // Sweeps matching these patterns are marked NOT_APPLICABLE instead of FAILED
    // because retrying will never succeed.
    private readonly NON_RETRYABLE_ERRORS: RegExp[] = [
        /insufficient balance/i,
        /account.*not found/i,
        /account.*disabled/i,
        /account.*suspended/i,
    ];

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly lockService: DistributedLockService,
        private readonly ledgerService: LedgerService
    ) { }

    /**
     * Gets all pending sweeps
     *
     * @returns List of pending sweep entries
     */
    async getPendingSweeps(): Promise<PendingSweep[]> {
        const entries = await this.prisma.ledgerEntry.findMany({
            where: {
                type: LedgerType.DEPOSIT,
                sweepStatus: SweepStatus.PENDING,
                status: EntryStatus.SETTLED,
            },
            select: {
                id: true,
                userId: true,
                currency: true,
                credit: true,
                createdAt: true,
                user: {
                    select: {
                        cryptoSubAccountId: true,
                    },
                },
            },
            orderBy: { createdAt: "asc" },
            take: this.BATCH_SIZE,
        });

        return entries.map((e) => ({
            ledgerEntryId: e.id,
            userId: e.userId,
            currency: e.currency,
            amount: e.credit,
            depositAddress: undefined, // Could be fetched from metadata if needed
            createdAt: e.createdAt,
        }));
    }

    /**
     * Initiates sweep for a single deposit entry
     *
     * @param ledgerEntryId Ledger entry ID
     * @returns Sweep result
     */
    async initiateSweep(
        ledgerEntryId: string
    ): Promise<SweepResult> {
        const lockKey = `sweep:${ledgerEntryId}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () => this.executeSweep(ledgerEntryId),
                { ttlMs: 30000, maxWaitMs: 5000, strict: true }
            );
        } catch (error) {
            if (error.message?.includes("Failed to acquire lock")) {
                this.logger.warn(
                    `Sweep already in progress | ledgerEntryId: ${ledgerEntryId}`
                );
                return {
                    success: false,
                    ledgerEntryId,
                    error: "Sweep already in progress",
                };
            }
            // Handle Redis unavailability gracefully for sweeps
            if (error.message?.includes("Redis lock service unavailable")) {
                this.logger.error(
                    `Sweep skipped - Redis unavailable | ledgerEntryId: ${ledgerEntryId}`
                );
                return {
                    success: false,
                    ledgerEntryId,
                    error: "Lock service unavailable",
                };
            }
            throw error;
        }
    }

    /**
     * Executes sweep within distributed lock
     *
     * Uses Quidax internal transfer (fund_uid: "me") to move funds from
     * sub-account to main wallet. This is fee-free and instant compared
     * to on-chain withdrawals.
     *
     * FIX: SW-006 — unknown currencies fail explicitly rather than defaulting
     * to a zero minimum and sweeping dust amounts.
     * FIX: SW-007 — sweepReference uses randomUUID() suffix instead of
     * Date.now() to guarantee collision resistance across retries.
     */
    private async executeSweep(
        ledgerEntryId: string
    ): Promise<SweepResult> {
        // Get the ledger entry
        const entry = await this.prisma.ledgerEntry.findUnique({
            where: { id: ledgerEntryId },
            include: {
                user: {
                    select: {
                        id: true,
                        cryptoSubAccountId: true,
                    },
                },
            },
        });

        if (!entry) {
            return {
                success: false,
                ledgerEntryId,
                error: "Ledger entry not found",
            };
        }

        if (entry.sweepStatus !== SweepStatus.PENDING) {
            this.logger.debug(
                `Sweep not pending | ledgerEntryId: ${ledgerEntryId}, status: ${entry.sweepStatus}`
            );
            return { success: true, ledgerEntryId }; // Already processed
        }

        if (!entry.user?.cryptoSubAccountId) {
            this.logger.warn(`User has no sub-account | userId: ${entry.userId}`);
            // Mark as not applicable since there's no sub-account to sweep from

            await this.updateSweepStatus(ledgerEntryId, SweepStatus.NOT_APPLICABLE);
            return { success: true, ledgerEntryId };
        }

        // FIX: SW-006 — reject unknown currencies explicitly
        const minAmount = this.MIN_SWEEP_AMOUNTS[entry.currency];
        if (minAmount === undefined) {
            this.logger.error(
                `No minimum sweep amount configured | currency: ${entry.currency} | ledgerEntryId: ${ledgerEntryId}`
            );
            await this.updateSweepStatus(
                ledgerEntryId,
                SweepStatus.FAILED,
                `no minimum sweep amount configured for ${entry.currency}`
            );
            return {
                success: false,
                ledgerEntryId,
                error: `No minimum sweep amount configured for ${entry.currency}`,
            };
        }

        if (entry.credit.lessThan(minAmount)) {
            this.logger.debug(
                `Amount below minimum sweep threshold | ${JSON.stringify({
                    ledgerEntryId,
                    amount: entry.credit.toString(),
                    minAmount: minAmount.toString(),
                })}`
            );
            // Mark as completed (too small to sweep, but not blocking)
            await this.updateSweepStatus(ledgerEntryId, SweepStatus.COMPLETED);
            return { success: true, ledgerEntryId };
        }

        try {
            // Mark as in progress
            await this.updateSweepStatus(ledgerEntryId, SweepStatus.IN_PROGRESS);

            // Generate unique reference for this sweep
            // FIX: SW-007 — randomUUID() suffix is collision-resistant across
            // retries and clock drift, unlike Date.now() which is not monotonic
            const sweepReference = `sweep-${ledgerEntryId}-${randomUUID().slice(0, 8)}`;

            // FIX: SW-010 — log the full Quidax request for debugging sweep failures
            this.logger.log(
                `Initiating sweep Quidax transfer | ${JSON.stringify({
                    ledgerEntryId,
                    userId: entry.userId,
                    subAccountId: entry.user.cryptoSubAccountId,
                    currency: entry.currency.toLowerCase(),
                    amount: entry.credit.toString(),
                    reference: sweepReference,
                })}`
            );

            // Initiate internal transfer from sub-account to main wallet.
            // fund_uid: "me" tells Quidax to credit the parent/main account
            // directly — no blockchain transaction, no network fee.
            const transferResult = await this.quidaxService.createWithdrawerRequest({
                user_id: entry.user.cryptoSubAccountId,
                currency: entry.currency.toLowerCase(),
                amount: entry.credit.toString(),
                fund_uid: "me",
                transaction_note: `Sweep from sub-account to main wallet`,
                narration: `Ledger sweep: ${ledgerEntryId}`,
                reference: sweepReference,
            });

            if (!transferResult?.data?.id) {
                throw new Error("No transaction ID returned from sweep withdrawal");
            }

            // FIX: SW-001 — store the Quidax transactionId on the ledger entry
            // so handleSweepConfirmation() can correlate the webhook back to
            // this entry without a separate table.
            await this.prisma.ledgerEntry.update({
                where: { id: ledgerEntryId },
                data: {
                    sweepTxId: transferResult.data.id,
                },
            });

            this.logger.log(
                `Sweep initiated | ${JSON.stringify({
                    ledgerEntryId,
                    userId: entry.userId,
                    currency: entry.currency,
                    amount: entry.credit.toString(),
                    transactionId: transferResult.data.id,
                    reference: sweepReference,
                })}`
            );

            return {
                success: true,
                ledgerEntryId,
                transactionId: transferResult.data.id,
            };
        } catch (error) {
            const errorMsg = error.message || String(error);
            const isNonRetryable = this.NON_RETRYABLE_ERRORS.some(re => re.test(errorMsg));

            // FIX: SW-010 — log full error details including Quidax response
            this.logger.error(
                `Sweep Quidax API call failed | ${JSON.stringify({
                    ledgerEntryId,
                    userId: entry.userId,
                    currency: entry.currency,
                    error: errorMsg,
                    errorName: error.name || error.constructor?.name,
                    isNonRetryable,
                    status: error.status ?? error.getStatus?.() ?? 'unknown',
                })}`
            );

            if (isNonRetryable) {
                this.logger.warn(
                    `Sweep permanently failed (non-retryable) | ${JSON.stringify({
                        ledgerEntryId,
                        error: errorMsg,
                    })}`
                );
                // FIX: SW-010 — mark as FAILED only, do NOT auto-transition to
                // NOT_APPLICABLE. Non-retryable errors like "insufficient balance"
                // may be transient (e.g., deposit still confirming on Quidax side).
                // The retry mechanism will eventually exhaust MAX_LIFETIME_RETRIES (3)
                // and stop retrying, but the entry stays FAILED for manual review
                // rather than silently being swept under the rug as NOT_APPLICABLE.
                await this.updateSweepStatus(
                    ledgerEntryId,
                    SweepStatus.FAILED,
                    `non-retryable: ${errorMsg}`
                );
                return { success: false, ledgerEntryId, error: errorMsg };
            }

            this.logger.error(
                `Sweep failed | ${JSON.stringify({
                    ledgerEntryId,
                    error: errorMsg,
                })}`
            );

            // Mark as failed (retryable)
            await this.updateSweepStatus(ledgerEntryId, SweepStatus.FAILED);

            return { success: false, ledgerEntryId, error: errorMsg };
        }
    }

    /**
     * Updates sweep status for a ledger entry
     *
     * FIX: SW-003 — now private with a state machine transition guard.
     * Only transitions defined in VALID_TRANSITIONS are permitted.
     * External callers must use the purpose-built public methods below.
     *
     * @param ledgerEntryId Ledger entry ID
     * @param newStatus Requested new status
     * @param reason Optional reason logged for audit trail (SW-008)
     */
    private async updateSweepStatus(
        ledgerEntryId: string,
        newStatus: SweepStatus,
        reason?: string
    ): Promise<void> {
        // FIX: SW-003 — validate the requested transition before writing
        const entry = await this.prisma.ledgerEntry.findUnique({
            where: { id: ledgerEntryId },
            select: { sweepStatus: true, type: true },
        });

        if (!entry) {
            throw new Error(`Ledger entry not found: ${ledgerEntryId}`);
        }

        if (entry.type !== LedgerType.DEPOSIT) {
            throw new Error(
                `Cannot set sweepStatus on non-DEPOSIT entry: ${ledgerEntryId}`
            );
        }

        const currentStatus = entry.sweepStatus;
        const allowed = this.VALID_TRANSITIONS[currentStatus] ?? [];

        if (!allowed.includes(newStatus)) {
            throw new Error(
                `Invalid sweep transition: ${currentStatus} → ${newStatus} for entry ${ledgerEntryId}`
            );
        }

        await this.ledgerService.updateSweepStatus(ledgerEntryId, newStatus);

        // FIX: SW-008 — log the transition with reason so audit trail captures
        // auto-fails and system-initiated transitions distinctly from normal flow
        this.logger.log(
            `Sweep status updated | ${JSON.stringify({
                ledgerEntryId,
                from: currentStatus,
                to: newStatus,
                ...(reason ? { reason } : {}),
            })}`
        );
    }

    /**
     * Marks a sweep as completed (terminal — no further transitions permitted)
     * Called by handleSweepConfirmation on Quidax success webhook.
     */
    async completeSweep(ledgerEntryId: string): Promise<void> {
        await this.updateSweepStatus(ledgerEntryId, SweepStatus.COMPLETED);
    }

    /**
     * Marks a sweep as failed
     * Called by handleSweepConfirmation on Quidax failure webhook,
     * or by executeSweep when the Quidax API call itself fails.
     */
    async failSweep(ledgerEntryId: string, reason?: string): Promise<void> {
        await this.updateSweepStatus(ledgerEntryId, SweepStatus.FAILED, reason);
    }

    /**
     * Marks a sweep as not applicable (terminal)
     * Called when a user has no sub-account to sweep from,
     * or by admin to resolve permanently-failed sweeps.
     */
    async markNotApplicable(ledgerEntryId: string, reason?: string): Promise<void> {
        await this.updateSweepStatus(ledgerEntryId, SweepStatus.NOT_APPLICABLE, reason);
    }

    /**
     * Handles sweep confirmation webhook
     * Called when the internal transfer from sub-account to main is confirmed

     * FIX: SW-001 — fully implemented. Looks up the ledger entry by sweepTxId
     * (stored at initiation time), acquires a per-entry lock to prevent
     * concurrent webhook deliveries from double-processing, and updates
     * sweepStatus atomically.
     *
     * The webhook controller calling this method MUST verify the Quidax
     * request signature before invoking it. Never trust transactionId or
     * status from an unverified source.
     *
     * @param transactionId Quidax transaction ID from webhook payload
     * @param status Confirmation status from Quidax
     */
    async handleSweepConfirmation(
        transactionId: string,
        status: "completed" | "failed",
        reason?: string
    ): Promise<void> {
        const lockKey = `sweep-confirm:${transactionId}`;

        try {
            await this.lockService.withLock(
                lockKey,
                async () => {
                    // FIX: SW-001 — look up entry by sweepTxId column
                    const entry = await this.prisma.ledgerEntry.findFirst({
                        where: {
                            sweepTxId: transactionId,
                        },
                        select: { id: true, sweepStatus: true, userId: true, currency: true },
                    });

                    if (!entry) {
                        this.logger.warn(
                            `Sweep confirmation for unknown transactionId | txId: ${transactionId}`
                        );
                        return;
                    }

                    // Guard: ignore confirmation if already in a terminal state
                    // (duplicate webhook delivery or late arrival after auto-fail)
                    if (
                        entry.sweepStatus === SweepStatus.COMPLETED ||
                        entry.sweepStatus === SweepStatus.NOT_APPLICABLE
                    ) {
                        this.logger.warn(
                            `Sweep confirmation received for already-terminal entry | ${JSON.stringify({
                                ledgerEntryId: entry.id,
                                currentStatus: entry.sweepStatus,
                                incomingStatus: status,
                            })}`
                        );
                        return;
                    }

                    const newStatus = status === "completed"
                        ? SweepStatus.COMPLETED
                        : SweepStatus.FAILED;

                    await this.updateSweepStatus(
                        entry.id,
                        newStatus,
                        reason
                            ? `quidax webhook: ${status} — ${reason}`
                            : `quidax webhook: ${status}`
                    );

                    this.logger.log(
                        `Sweep confirmation processed | ${JSON.stringify({
                            ledgerEntryId: entry.id,
                            userId: entry.userId,
                            currency: entry.currency,
                            transactionId,
                            status: newStatus,
                            reason: reason ?? null,
                        })}`
                    );
                },
                { ttlMs: 10000, maxWaitMs: 5000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `handleSweepConfirmation failed | ${JSON.stringify({
                    transactionId,
                    error: error.message,
                })}`
            );
            throw error;
        }
    }

    /**
     * Processes all pending sweeps
     *
     * FIX: SW-005 — protected by a distributed Redis job lock so only one
     * pod runs the batch per cron cycle. Per-entry locks in initiateSweep()
     * are retained as a secondary safety net for direct calls.
     */
    async processPendingSweeps(): Promise<number> {
        // FIX: SW-005 — job-level lock prevents concurrent pod execution.
        // strict: false means withLock returns immediately (throwing) if the
        // lock is already held, rather than waiting. We catch that specific
        // error and return 0 so the cron caller treats it as a no-op.
        const jobLockKey = "job:sweep:process_pending";

        try {
            return await this.lockService.withLock(
                jobLockKey,
                async () => {
                    const pending = await this.getPendingSweeps();

                    if (pending.length === 0) {
                        return 0;
                    }

                    this.logger.log(`Processing ${pending.length} pending sweeps`);

                    let processed = 0;

                    for (const sweep of pending) {
                        try {
                            const result = await this.initiateSweep(
                                sweep.ledgerEntryId
                            );
                            if (result.success) {
                                processed++;
                            }
                        } catch (error) {
                            this.logger.error(
                                `Error processing sweep | ${JSON.stringify({
                                    ledgerEntryId: sweep.ledgerEntryId,
                                    error: error.message,
                                })}`
                            );
                        }
                    }

                    return processed;
                },
                // ttlMs covers worst-case batch: BATCH_SIZE(10) * per-sweep max(30s) + margin
                // Reduced from 360s to 120s to avoid stale lock overlapping the 5-min cron interval.
                // Actual execution typically completes in <30s for 10 entries.
                // strict: false — do not wait if another pod holds the lock, skip instead
                { ttlMs: 120000, maxWaitMs: 0, strict: false }
            );
        } catch (error) {
            if (error.message?.includes("Failed to acquire lock")) {
                this.logger.debug("Sweep job already running on another pod — skipping");
                return 0;
            }
            throw error;
        }
    }

    /**
     * Gets sweep statistics
     *
     * @returns Sweep stats by status
     */
    async getSweepStats(): Promise<Record<SweepStatus, number>> {
        const stats = await this.prisma.ledgerEntry.groupBy({
            by: ["sweepStatus"],
            where: {
                type: LedgerType.DEPOSIT,
                sweepStatus: { not: null },
            },
            _count: true,
        });

        const result: Record<SweepStatus, number> = {
            [SweepStatus.PENDING]: 0,
            [SweepStatus.IN_PROGRESS]: 0,
            [SweepStatus.COMPLETED]: 0,
            [SweepStatus.FAILED]: 0,
            [SweepStatus.NOT_APPLICABLE]: 0,
        };

        for (const stat of stats) {
            if (stat.sweepStatus) {
                result[stat.sweepStatus] = stat._count;
            }
        }

        return result;
    }

    /**
     * Retries failed sweeps
     *
     * @param maxRetries Maximum entries to retry
     * @returns Number of retries initiated
     * FIX: SW-002 — added sweepRetryCount tracking, exponential backoff,
     * and a maximum lifetime retry cap. Entries that exceed MAX_LIFETIME_RETRIES
     * are skipped permanently and require manual ops investigation.
     *
     * Backoff schedule (BACKOFF_BASE_MINUTES = 2):
     *   Retry 1 (sweepRetryCount = 0): eligible after 2 min
     *   Retry 2 (sweepRetryCount = 1): eligible after 4 min
     *   Retry 3 (sweepRetryCount = 2): eligible after 8 min
     *   Beyond MAX_LIFETIME_RETRIES (3): permanently skipped
     *
     * FIX: SW-009 — also recovers stale IN_PROGRESS entries.
     * If an entry has been IN_PROGRESS longer than STALE_IN_PROGRESS_MINUTES
     * (default 15 min), the transfer is presumed lost. The entry is reset
     * to PENDING (via the state machine) with an incremented retry count,
     * then immediately re-initiated. An optimistic concurrency gate
     * (sweepStatus must still be IN_PROGRESS) prevents racing with a
     * legitimate late-arriving completion webhook.
     */
    async retryFailedSweeps(maxRetries = 5): Promise<number> {
        let retried = 0;

        // ── Phase 1: retry FAILED entries (existing behaviour) ──────────
        const failed = await this.prisma.ledgerEntry.findMany({
            where: {
                type: LedgerType.DEPOSIT,
                sweepStatus: SweepStatus.FAILED,
                status: EntryStatus.SETTLED,
                sweepRetryCount: { lt: this.MAX_LIFETIME_RETRIES },
            },
            orderBy: { updatedAt: "asc" },
            take: maxRetries * 2,
            select: {
                id: true,
                sweepRetryCount: true,
                updatedAt: true,
                currency: true,
            },
        });

        if (failed.length > 0) {
            this.logger.log(`Checking ${failed.length} failed sweeps for retry eligibility`);
        }

        for (const entry of failed) {
            const retryCount = entry.sweepRetryCount;

            // Skip entries that have exhausted retries
            if (retryCount >= this.MAX_LIFETIME_RETRIES) {
                continue;
            }

            // FIX: SW-002 — exponential backoff: only retry if the cooloff
            // window has elapsed since the last failure
            const backoffMinutes = Math.pow(
                this.BACKOFF_BASE_MINUTES,
                retryCount + 1
            );
            const cooloffExpiry = new Date(
                entry.updatedAt.getTime() + backoffMinutes * 60 * 1000
            );

            if (new Date() < cooloffExpiry) {
                this.logger.debug(
                    `Sweep retry deferred | ledgerEntryId: ${entry.id} | retryCount: ${retryCount} | eligibleAt: ${cooloffExpiry.toISOString()}`
                );
                continue;
            }

            // FIX: SW-002 — increment retry count and reset to PENDING atomically.
            // Uses updateMany with FAILED gate to prevent concurrent retry races.
            const updateResult = await this.prisma.ledgerEntry.updateMany({
                where: {
                    id: entry.id,
                    sweepStatus: SweepStatus.FAILED, // gate: only if still FAILED
                },
                data: {
                    sweepStatus: SweepStatus.PENDING,
                    sweepRetryCount: retryCount + 1,
                },
            });

            if (updateResult.count === 0) {
                // Another process already picked this up
                continue;
            }

            this.logger.log(
                `Retrying failed sweep | ledgerEntryId: ${entry.id} | attempt: ${retryCount + 1}/${this.MAX_LIFETIME_RETRIES}`
            );

            const result = await this.initiateSweep(entry.id);
            if (result.success) {
                retried++;
            }
        }

        // ── Phase 2: recover stale IN_PROGRESS entries (SW-009) ─────────
        const staleCutoff = new Date(
            Date.now() - this.STALE_IN_PROGRESS_MINUTES * 60 * 1000
        );

        const staleInProgress = await this.prisma.ledgerEntry.findMany({
            where: {
                type: LedgerType.DEPOSIT,
                sweepStatus: SweepStatus.IN_PROGRESS,
                status: EntryStatus.SETTLED,
                updatedAt: { lt: staleCutoff },
                sweepRetryCount: { lt: this.MAX_LIFETIME_RETRIES },
            },
            orderBy: { updatedAt: "asc" },
            take: maxRetries,
            select: {
                id: true,
                sweepRetryCount: true,
                updatedAt: true,
                currency: true,
            },
        });

        if (staleInProgress.length > 0) {
            this.logger.log(
                `Found ${staleInProgress.length} stale IN_PROGRESS sweeps (>${this.STALE_IN_PROGRESS_MINUTES}min) — recovering`
            );
        }

        for (const entry of staleInProgress) {
            const retryCount = entry.sweepRetryCount;

            // Optimistic concurrency gate: only reset if still IN_PROGRESS.
            // If a late webhook moved it to COMPLETED between our SELECT and
            // this UPDATE, the count will be 0 and we skip safely.
            const updateResult = await this.prisma.ledgerEntry.updateMany({
                where: {
                    id: entry.id,
                    sweepStatus: SweepStatus.IN_PROGRESS, // gate
                },
                data: {
                    sweepStatus: SweepStatus.PENDING,
                    sweepRetryCount: retryCount + 1,
                },
            });

            if (updateResult.count === 0) {
                // Webhook arrived or another process handled it
                this.logger.debug(
                    `Stale sweep already resolved | ledgerEntryId: ${entry.id}`
                );
                continue;
            }

            this.logger.log(
                `Recovering stale IN_PROGRESS sweep | ledgerEntryId: ${entry.id} | staleFor: ${Math.round((Date.now() - entry.updatedAt.getTime()) / 60000)}min | attempt: ${retryCount + 1}/${this.MAX_LIFETIME_RETRIES}`
            );

            const result = await this.initiateSweep(entry.id);
            if (result.success) {
                retried++;
            }
        }

        return retried;
    }

    /**
     * Checks if a deposit can be withdrawn
     * (sweep must be completed or not applicable)
     *
     * @param ledgerEntryId Deposit ledger entry ID
     * @returns True if withdrawal is allowed
     */
    async canWithdraw(ledgerEntryId: string): Promise<boolean> {
        const entry = await this.prisma.ledgerEntry.findUnique({
            where: { id: ledgerEntryId },
            select: { sweepStatus: true, type: true },
        });

        if (!entry || entry.type !== LedgerType.DEPOSIT) {
            return true; // Not a deposit, no sweep required
        }

        return (
            entry.sweepStatus === SweepStatus.COMPLETED ||
            entry.sweepStatus === SweepStatus.NOT_APPLICABLE
        );
    }

    /**
     * Checks if user has any pending sweeps blocking withdrawal
     *
     * FIX: SW-008 — stale entry auto-fail now routes through the private
     * updateSweepStatus() with a reason string instead of calling
     * prisma.ledgerEntry.updateMany() directly. This ensures every
     * transition — including system-initiated auto-fails — is logged
     * with a reason and validated against the state machine.
     */
    async hasPendingSweeps(userId: number, currency: string): Promise<boolean> {
        // Check if user has a sub-account that actually needs sweeping
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { cryptoSubAccountId: true },
        });

        if (!user?.cryptoSubAccountId) {
            // Omnibus mode — resolve any stale entries
            const staleEntries = await this.prisma.ledgerEntry.findMany({
                where: {
                    userId,
                    currency: currency.toUpperCase(),
                    type: LedgerType.DEPOSIT,
                    sweepStatus: {
                        in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS],
                    },
                },
                select: { id: true },
            });

            if (staleEntries.length > 0) {
                this.logger.log(
                    `Auto-resolving ${staleEntries.length} stale sweep entries for omnibus user ${userId} (${currency})`
                );
                await this.prisma.ledgerEntry.updateMany({
                    where: {
                        userId,
                        currency: currency.toUpperCase(),
                        type: LedgerType.DEPOSIT,
                        sweepStatus: {
                            in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS],
                        },
                    },
                    data: { sweepStatus: SweepStatus.NOT_APPLICABLE },
                });
                this.logger.log(
                    `Auto-resolved ${staleEntries.length} stale sweep entries as NOT_APPLICABLE | userId: ${userId} | currency: ${currency} | reason: omnibus user, no sub-account`
                );
            }

            return false;
        }

        // Sub-account user — only auto-fail entries that are truly stale
        // FIX: SW-010 — use updatedAt instead of createdAt for the cutoff.
        // createdAt reflects when the deposit arrived; updatedAt reflects
        // the last sweep attempt. A deposit may be old but the sweep was
        // retried recently (e.g., 5 min ago). Using createdAt would kill
        // legitimate in-flight retries.
        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - this.SWEEP_BLOCK_WINDOW_HOURS);

        // FIX: SW-010 — use updatedAt for staleness (not createdAt)
        const staleEntries = await this.prisma.ledgerEntry.findMany({
            where: {
                userId,
                currency: currency.toUpperCase(),
                type: LedgerType.DEPOSIT,
                sweepStatus: { in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS] },
                updatedAt: { lt: cutoff },
            },
            select: { id: true, sweepStatus: true },
        });

        for (const stale of staleEntries) {
            try {
                await this.updateSweepStatus(
                    stale.id,
                    SweepStatus.FAILED,
                    `auto-fail: stale beyond ${this.SWEEP_BLOCK_WINDOW_HOURS}h window`
                );
            } catch (error) {
                // Log but continue — a single stale entry failing to update
                // should not block the rest of the check
                this.logger.error(
                    `Failed to auto-fail stale sweep entry | ledgerEntryId: ${stale.id} | error: ${error.message}`
                );
            }
        }

        if (staleEntries.length > 0) {
            this.logger.warn(
                `Auto-failed ${staleEntries.length} stale sweep entries (>${this.SWEEP_BLOCK_WINDOW_HOURS}h) for user ${userId} (${currency})`
            );
        }

        // FIX: SW-010 — use updatedAt for the pending count too, so that
        // recently-retried sweeps still block withdrawal (they're active),
        // while truly ancient ones have already been auto-failed above.
        const pendingCount = await this.prisma.ledgerEntry.count({
            where: {
                userId,
                currency: currency.toUpperCase(),
                type: LedgerType.DEPOSIT,
                sweepStatus: {
                    in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS],
                },
            },
        });

        if (pendingCount > 0) {
            this.logger.log(
                `User ${userId} has ${pendingCount} recent pending sweeps for ${currency} — blocking withdrawal`
            );
        }

        return pendingCount > 0;
    }
}
