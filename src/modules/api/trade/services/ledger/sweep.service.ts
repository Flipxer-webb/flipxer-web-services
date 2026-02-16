import { Injectable, Logger, Inject } from "@nestjs/common";
import { SweepStatus, LedgerType, EntryStatus } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { LedgerService } from "./ledger.service";
import { Decimal } from "@prisma/client/runtime/library";

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
 * 3. Initiates transfer from sub-account to main wallet
 * 4. Updates sweepStatus to IN_PROGRESS
 * 5. Webhook confirms sweep, updates to COMPLETED
 * 6. User can now withdraw
 *
 * NOTE: In the new omnibus model, users don't have separate blockchain addresses.
 * All deposits go to shared addresses. This service is for the transition period
 * where existing sub-accounts need to be swept, or for platforms that still use
 * per-user deposit addresses with a sweep model.
 */
@Injectable()
export class SweepService {
    private readonly logger = new Logger(SweepService.name);

    // Sweep batch size
    private readonly BATCH_SIZE = 10;

    // Minimum amount to sweep (avoid dust)
    private readonly MIN_SWEEP_AMOUNTS: Record<string, Decimal> = {
        BTC: new Decimal(0.0001),
        ETH: new Decimal(0.001),
        USDT: new Decimal(1),
        USDC: new Decimal(1),
        BNB: new Decimal(0.01),
        SOL: new Decimal(0.1),
    };

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly lockService: DistributedLockService,
        private readonly ledgerService: LedgerService
    ) {}

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
    async initiateSweep(ledgerEntryId: string): Promise<SweepResult> {
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
     */
    private async executeSweep(ledgerEntryId: string): Promise<SweepResult> {
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
            this.logger.warn(
                `User has no sub-account | userId: ${entry.userId}`
            );
            // Mark as not applicable since there's no sub-account to sweep from
            await this.updateSweepStatus(
                ledgerEntryId,
                SweepStatus.NOT_APPLICABLE
            );
            return { success: true, ledgerEntryId };
        }

        // Check minimum sweep amount
        const minAmount =
            this.MIN_SWEEP_AMOUNTS[entry.currency] ?? new Decimal(0);
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
            await this.updateSweepStatus(
                ledgerEntryId,
                SweepStatus.IN_PROGRESS
            );

            // Get main wallet deposit address for this currency
            const mainWalletAddress = await this.getMainWalletAddress(
                entry.currency
            );
            if (!mainWalletAddress) {
                throw new Error(
                    `Could not get main wallet address for ${entry.currency}`
                );
            }

            // Generate unique reference for this sweep
            const sweepReference = `sweep-${ledgerEntryId}-${Date.now()}`;

            // Initiate withdrawal from sub-account to main wallet address
            // This is essentially an internal transfer using the withdrawal API
            const transferResult =
                await this.quidaxService.createWithdrawerRequest({
                    user_id: entry.user.cryptoSubAccountId,
                    currency: entry.currency.toLowerCase(),
                    amount: entry.credit.toString(),
                    fund_uid: mainWalletAddress,
                    transaction_note: `Sweep from sub-account to main wallet`,
                    narration: `Ledger sweep: ${ledgerEntryId}`,
                    reference: sweepReference,
                });

            if (!transferResult?.data?.id) {
                throw new Error(
                    "No transaction ID returned from sweep withdrawal"
                );
            }

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
            this.logger.error(
                `Sweep failed | ${JSON.stringify({
                    ledgerEntryId,
                    error: error.message,
                })}`
            );

            // Mark as failed
            await this.updateSweepStatus(ledgerEntryId, SweepStatus.FAILED);

            return { success: false, ledgerEntryId, error: error.message };
        }
    }

    /**
     * Gets the main wallet deposit address for a currency
     *
     * @param currency Currency symbol
     * @returns Deposit address for main wallet
     */
    private async getMainWalletAddress(
        currency: string
    ): Promise<string | null> {
        try {
            // Get main account ("me") wallet for this currency
            // The wallet contains deposit_address
            const walletData = await this.quidaxService.getUserWallet({
                user_id: "me",
                currency: currency.toLowerCase(),
            });

            return walletData?.data?.deposit_address ?? null;
        } catch (error) {
            this.logger.error(
                `Failed to get main wallet address | ${JSON.stringify({
                    currency,
                    error: error.message,
                })}`
            );
            return null;
        }
    }

    /**
     * Updates sweep status for a ledger entry
     *
     * @param ledgerEntryId Ledger entry ID
     * @param status New sweep status
     */
    async updateSweepStatus(
        ledgerEntryId: string,
        status: SweepStatus
    ): Promise<void> {
        await this.ledgerService.updateSweepStatus(ledgerEntryId, status);
    }

    /**
     * Handles sweep confirmation webhook
     * Called when the internal transfer from sub-account to main is confirmed
     *
     * @param transactionId Quidax transaction ID
     * @param status Confirmation status
     */
    async handleSweepConfirmation(
        transactionId: string,
        status: "completed" | "failed"
    ): Promise<void> {
        // Find the entry by reference (would need to store transactionId in metadata)
        // For now, this is a placeholder - actual implementation would depend on
        // how Quidax webhooks provide the correlation ID

        this.logger.log(
            `Sweep confirmation received | transactionId: ${transactionId}, status: ${status}`
        );

        // In production, would:
        // 1. Look up ledger entry by transactionId in metadata
        // 2. Update sweep status to COMPLETED or FAILED
        // 3. If COMPLETED, user can now withdraw
    }

    /**
     * Processes all pending sweeps
     * Called by cron job
     *
     * @returns Number of sweeps processed
     */
    async processPendingSweeps(): Promise<number> {
        const pending = await this.getPendingSweeps();

        if (pending.length === 0) {
            return 0;
        }

        this.logger.log(`Processing ${pending.length} pending sweeps`);

        let processed = 0;

        for (const sweep of pending) {
            try {
                const result = await this.initiateSweep(sweep.ledgerEntryId);
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
     */
    async retryFailedSweeps(maxRetries = 5): Promise<number> {
        const failed = await this.prisma.ledgerEntry.findMany({
            where: {
                type: LedgerType.DEPOSIT,
                sweepStatus: SweepStatus.FAILED,
                status: EntryStatus.SETTLED,
            },
            orderBy: { updatedAt: "asc" },
            take: maxRetries,
        });

        if (failed.length === 0) {
            return 0;
        }

        this.logger.log(`Retrying ${failed.length} failed sweeps`);

        let retried = 0;

        for (const entry of failed) {
            // Reset to PENDING to allow retry
            await this.updateSweepStatus(entry.id, SweepStatus.PENDING);

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
     * In omnibus mode (no per-user sub-accounts), deposits go directly
     * to shared addresses and there is nothing to sweep. For users without
     * a cryptoSubAccountId, all PENDING sweeps are auto-resolved as
     * NOT_APPLICABLE so they never block withdrawals.
     *
     * For users WITH sub-accounts, only sweeps created within the last
     * SWEEP_BLOCK_WINDOW_HOURS are considered blocking. Older entries are
     * auto-marked as FAILED to prevent permanent withdrawal blocks when
     * the sweep pipeline stalls.
     *
     * @param userId User ID
     * @param currency Currency to check
     * @returns True if user has recent, actionable pending sweeps
     */
    private readonly SWEEP_BLOCK_WINDOW_HOURS = 2;

    async hasPendingSweeps(userId: number, currency: string): Promise<boolean> {
        // Check if user has a sub-account that actually needs sweeping
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { cryptoSubAccountId: true },
        });

        if (!user?.cryptoSubAccountId) {
            // Omnibus mode: no sub-account means nothing to sweep.
            // Auto-resolve any lingering PENDING entries in the background.
            const staleCount = await this.prisma.ledgerEntry.count({
                where: {
                    userId,
                    currency: currency.toUpperCase(),
                    type: LedgerType.DEPOSIT,
                    sweepStatus: {
                        in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS],
                    },
                },
            });

            if (staleCount > 0) {
                this.logger.log(
                    `Auto-resolving ${staleCount} stale sweep entries for omnibus user ${userId} (${currency}) — no sub-account to sweep from`
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
            }

            return false;
        }

        // User has a sub-account: only block for recent sweeps
        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - this.SWEEP_BLOCK_WINDOW_HOURS);

        // Auto-mark old stale entries as FAILED so they don't block forever
        const staleResolved = await this.prisma.ledgerEntry.updateMany({
            where: {
                userId,
                currency: currency.toUpperCase(),
                type: LedgerType.DEPOSIT,
                sweepStatus: {
                    in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS],
                },
                createdAt: { lt: cutoff },
            },
            data: { sweepStatus: SweepStatus.FAILED },
        });

        if (staleResolved.count > 0) {
            this.logger.warn(
                `Auto-failed ${staleResolved.count} stale sweep entries (>${
                    this.SWEEP_BLOCK_WINDOW_HOURS
                }h) for user ${userId} (${currency})`
            );
        }

        // Now count only recent blocking sweeps
        const pendingCount = await this.prisma.ledgerEntry.count({
            where: {
                userId,
                currency: currency.toUpperCase(),
                type: LedgerType.DEPOSIT,
                sweepStatus: {
                    in: [SweepStatus.PENDING, SweepStatus.IN_PROGRESS],
                },
                createdAt: { gte: cutoff },
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
