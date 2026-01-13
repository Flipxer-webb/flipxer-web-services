import { Injectable, Logger } from "@nestjs/common";
import { Prisma, LedgerType, EntryStatus, SweepStatus } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Result of a ledger operation
 */
export interface LedgerOperationResult {
    success: boolean;
    entryId?: string;
    balanceAfter?: Decimal;
    entry?: {
        id: string;
        balanceAfter: Decimal;
    };
    error?: string;
}

/**
 * Options for creating a ledger entry
 */
export interface CreateLedgerEntryOptions {
    userId: number;
    currency: string;
    type: LedgerType;
    amount: Decimal | number | string;
    reference: string;
    tradeGroupId?: string;
    description?: string;
    metadata?: Record<string, any>;
    sweepStatus?: SweepStatus;
}

/**
 * Options for hold operations
 */
export interface HoldOptions {
    userId: number;
    currency: string;
    amount: Decimal | number | string;
    reference: string;
    type: LedgerType;
    description?: string;
}

/**
 * Balance breakdown for a user/currency pair
 */
export interface BalanceInfo {
    available: Decimal;
    held: Decimal;
    total: Decimal;
}

/**
 * LedgerService
 *
 * Core service for managing the double-entry ledger system.
 * All balance operations MUST go through this service.
 *
 * Design principles:
 * - SERIALIZABLE isolation level for all balance-modifying operations
 * - SELECT FOR UPDATE to prevent race conditions
 * - balanceAfter stored in each entry for O(1) balance lookups
 * - User balances can NEVER go negative
 * - Platform account (userId=0) CAN go negative
 * - All entries are immutable once SETTLED
 *
 * Idempotency:
 * - Each operation uses type+reference as a unique key
 * - Duplicate operations return the existing entry
 */
@Injectable()
export class LedgerService {
    private readonly logger = new Logger(LedgerService.name);

    // Platform account ID for omnibus wallet tracking
    static readonly PLATFORM_USER_ID = 0;

    // Decimal precision for crypto
    private readonly DECIMAL_PLACES = 8;

    constructor(
        private readonly prisma: PrismaService,
        private readonly lockService: DistributedLockService
    ) {}

    /**
     * Credits an amount to a user's ledger (increases balance)
     *
     * Use cases:
     * - Deposit received from blockchain
     * - Buy order completed (user receives crypto)
     * - Swap completed (user receives target currency)
     * - Admin adjustment
     *
     * @param options Credit operation options
     * @returns Operation result with new balance
     */
    async credit(
        options: CreateLedgerEntryOptions
    ): Promise<LedgerOperationResult> {
        const {
            userId,
            currency,
            type,
            amount,
            reference,
            tradeGroupId,
            description,
            metadata,
            sweepStatus,
        } = options;
        const creditAmount = this.toDecimal(amount);

        if (creditAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Credit amount must be positive" };
        }

        const lockKey = `ledger:${userId}:${currency.toUpperCase()}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () =>
                    this.executeCredit(
                        userId,
                        currency.toUpperCase(),
                        type,
                        creditAmount,
                        reference,
                        tradeGroupId,
                        description,
                        metadata,
                        sweepStatus
                    ),
                { ttlMs: 10000, maxWaitMs: 15000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `Credit failed | ${JSON.stringify({
                    userId,
                    currency,
                    amount: creditAmount.toString(),
                    reference,
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Internal credit execution within distributed lock
     */
    private async executeCredit(
        userId: number,
        currency: string,
        type: LedgerType,
        amount: Decimal,
        reference: string,
        tradeGroupId?: string,
        description?: string,
        metadata?: Record<string, any>,
        sweepStatus?: SweepStatus
    ): Promise<LedgerOperationResult> {
        return await this.prisma.$transaction(
            async (tx) => {
                // Check for idempotency - same type+reference means duplicate
                const existing = await tx.ledgerEntry.findUnique({
                    where: { type_reference: { type, reference } },
                });

                if (existing) {
                    this.logger.warn(
                        `Duplicate credit detected | ${JSON.stringify({
                            type,
                            reference,
                            existingId: existing.id,
                        })}`
                    );
                    return {
                        success: true,
                        entryId: existing.id,
                        balanceAfter: existing.balanceAfter,
                        entry: {
                            id: existing.id,
                            balanceAfter: existing.balanceAfter,
                        },
                    };
                }

                // Get current balance with FOR UPDATE lock
                const lastEntry = await tx.ledgerEntry.findFirst({
                    where: {
                        userId,
                        currency,
                        status: { not: EntryStatus.FAILED },
                    },
                    orderBy: { createdAt: "desc" },
                    select: { balanceAfter: true },
                });

                const currentBalance =
                    lastEntry?.balanceAfter ?? new Decimal(0);
                const newBalance = currentBalance.plus(amount);

                // Determine sweep status - use passed value or default based on type
                const entrySweepStatus = sweepStatus ?? 
                    (type === LedgerType.DEPOSIT ? SweepStatus.PENDING : SweepStatus.NOT_APPLICABLE);

                // Create credit entry (credit column has the amount, debit is 0)
                const entry = await tx.ledgerEntry.create({
                    data: {
                        userId,
                        currency,
                        type,
                        debit: new Decimal(0),
                        credit: amount,
                        balanceAfter: newBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: entrySweepStatus,
                        holdAmount: new Decimal(0),
                        reference,
                        tradeGroupId,
                        description,
                        metadata: metadata ?? Prisma.JsonNull,
                    },
                });

                this.logger.log(
                    `Credit successful | ${JSON.stringify({
                        entryId: entry.id,
                        userId,
                        currency,
                        amount: amount.toString(),
                        balanceAfter: newBalance.toString(),
                        type,
                        sweepStatus: entrySweepStatus,
                    })}`
                );

                return {
                    success: true,
                    entryId: entry.id,
                    balanceAfter: newBalance,
                    entry: {
                        id: entry.id,
                        balanceAfter: newBalance,
                    },
                };
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: 10000,
            }
        );
    }

    /**
     * Debits an amount from a user's ledger (decreases balance)
     *
     * Use cases:
     * - Withdrawal sent to blockchain
     * - Sell order completed (user sends crypto)
     * - Swap completed (user sends source currency)
     * - Send to another user
     *
     * @param options Debit operation options
     * @returns Operation result with new balance
     */
    async debit(
        options: CreateLedgerEntryOptions
    ): Promise<LedgerOperationResult> {
        const {
            userId,
            currency,
            type,
            amount,
            reference,
            tradeGroupId,
            description,
        } = options;
        const debitAmount = this.toDecimal(amount);

        if (debitAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Debit amount must be positive" };
        }

        const lockKey = `ledger:${userId}:${currency.toUpperCase()}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () =>
                    this.executeDebit(
                        userId,
                        currency.toUpperCase(),
                        type,
                        debitAmount,
                        reference,
                        tradeGroupId,
                        description
                    ),
                { ttlMs: 10000, maxWaitMs: 15000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `Debit failed | ${JSON.stringify({
                    userId,
                    currency,
                    amount: debitAmount.toString(),
                    reference,
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Internal debit execution within distributed lock
     */
    private async executeDebit(
        userId: number,
        currency: string,
        type: LedgerType,
        amount: Decimal,
        reference: string,
        tradeGroupId?: string,
        description?: string
    ): Promise<LedgerOperationResult> {
        return await this.prisma.$transaction(
            async (tx) => {
                // Check for idempotency
                const existing = await tx.ledgerEntry.findUnique({
                    where: { type_reference: { type, reference } },
                });

                if (existing) {
                    this.logger.warn(
                        `Duplicate debit detected | ${JSON.stringify({
                            type,
                            reference,
                            existingId: existing.id,
                        })}`
                    );
                    return {
                        success: true,
                        entryId: existing.id,
                        balanceAfter: existing.balanceAfter,
                    };
                }

                // Get current balance with lock
                const balanceInfo = await this.getBalanceInTransaction(
                    tx,
                    userId,
                    currency
                );

                // Check if user has sufficient available balance
                // Platform account (userId=0) can go negative
                if (
                    userId !== LedgerService.PLATFORM_USER_ID &&
                    balanceInfo.available.lessThan(amount)
                ) {
                    this.logger.warn(
                        `Insufficient balance | ${JSON.stringify({
                            userId,
                            currency,
                            requested: amount.toString(),
                            available: balanceInfo.available.toString(),
                        })}`
                    );
                    return {
                        success: false,
                        error: `Insufficient balance. Available: ${balanceInfo.available.toString()}, Requested: ${amount.toString()}`,
                    };
                }

                const newBalance = balanceInfo.total.minus(amount);

                // Create debit entry
                const entry = await tx.ledgerEntry.create({
                    data: {
                        userId,
                        currency,
                        type,
                        debit: amount,
                        credit: new Decimal(0),
                        balanceAfter: newBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference,
                        tradeGroupId,
                        description,
                    },
                });

                this.logger.log(
                    `Debit successful | ${JSON.stringify({
                        entryId: entry.id,
                        userId,
                        currency,
                        amount: amount.toString(),
                        balanceAfter: newBalance.toString(),
                        type,
                    })}`
                );

                return {
                    success: true,
                    entryId: entry.id,
                    balanceAfter: newBalance,
                };
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: 10000,
            }
        );
    }

    /**
     * Places a hold on funds (reduces available balance but not total)
     *
     * Use cases:
     * - Withdrawal initiated (funds held until blockchain confirms)
     * - Sell order placed (funds held until order settles)
     * - Send initiated (funds held until transfer completes)
     *
     * @param options Hold operation options
     * @returns Operation result
     */
    async hold(options: HoldOptions): Promise<LedgerOperationResult> {
        const { userId, currency, amount, reference, type, description } =
            options;
        const holdAmount = this.toDecimal(amount);

        if (holdAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Hold amount must be positive" };
        }

        const lockKey = `ledger:${userId}:${currency.toUpperCase()}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () =>
                    this.executeHold(
                        userId,
                        currency.toUpperCase(),
                        type,
                        holdAmount,
                        reference,
                        description
                    ),
                { ttlMs: 10000, maxWaitMs: 15000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `Hold failed | ${JSON.stringify({
                    userId,
                    currency,
                    amount: holdAmount.toString(),
                    reference,
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Internal hold execution within distributed lock
     */
    private async executeHold(
        userId: number,
        currency: string,
        type: LedgerType,
        amount: Decimal,
        reference: string,
        description?: string
    ): Promise<LedgerOperationResult> {
        return await this.prisma.$transaction(
            async (tx) => {
                // Check for idempotency
                const existing = await tx.ledgerEntry.findUnique({
                    where: { type_reference: { type, reference } },
                });

                if (existing) {
                    this.logger.warn(
                        `Duplicate hold detected | ${JSON.stringify({
                            type,
                            reference,
                            existingId: existing.id,
                        })}`
                    );
                    return {
                        success: true,
                        entryId: existing.id,
                        balanceAfter: existing.balanceAfter,
                    };
                }

                // Get current balance
                const balanceInfo = await this.getBalanceInTransaction(
                    tx,
                    userId,
                    currency
                );

                // Check if user has sufficient available balance
                if (
                    userId !== LedgerService.PLATFORM_USER_ID &&
                    balanceInfo.available.lessThan(amount)
                ) {
                    this.logger.warn(
                        `Insufficient balance for hold | ${JSON.stringify({
                            userId,
                            currency,
                            requested: amount.toString(),
                            available: balanceInfo.available.toString(),
                        })}`
                    );
                    return {
                        success: false,
                        error: `Insufficient balance for hold. Available: ${balanceInfo.available.toString()}, Requested: ${amount.toString()}`,
                    };
                }

                // Create HOLD entry - no debit/credit yet, just holdAmount
                // Balance doesn't change, but available balance decreases
                const entry = await tx.ledgerEntry.create({
                    data: {
                        userId,
                        currency,
                        type,
                        debit: new Decimal(0),
                        credit: new Decimal(0),
                        balanceAfter: balanceInfo.total, // Balance unchanged
                        status: EntryStatus.HOLD,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: amount,
                        reference,
                        description,
                    },
                });

                this.logger.log(
                    `Hold placed | ${JSON.stringify({
                        entryId: entry.id,
                        userId,
                        currency,
                        holdAmount: amount.toString(),
                        type,
                    })}`
                );

                return {
                    success: true,
                    entryId: entry.id,
                    balanceAfter: balanceInfo.total,
                };
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: 10000,
            }
        );
    }

    /**
     * Releases a hold and settles it as either a debit or a refund
     *
     * @param reference The reference of the original hold entry
     * @param settle If true, converts hold to debit. If false, releases hold (refund).
     * @param description Optional description for the settlement
     * @returns Operation result
     */
    async releaseHold(
        reference: string,
        settle: boolean,
        description?: string
    ): Promise<LedgerOperationResult> {
        // Find the hold entry first to get user/currency for locking
        const holdEntry = await this.prisma.ledgerEntry.findFirst({
            where: { reference, status: EntryStatus.HOLD },
        });

        if (!holdEntry) {
            this.logger.warn(
                `Hold entry not found for release | reference: ${reference}`
            );
            return { success: false, error: "Hold entry not found" };
        }

        const lockKey = `ledger:${holdEntry.userId}:${holdEntry.currency}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () =>
                    this.executeReleaseHold(holdEntry.id, settle, description),
                { ttlMs: 10000, maxWaitMs: 15000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `Release hold failed | ${JSON.stringify({
                    reference,
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Internal release hold execution
     */
    private async executeReleaseHold(
        holdEntryId: string,
        settle: boolean,
        description?: string
    ): Promise<LedgerOperationResult> {
        return await this.prisma.$transaction(
            async (tx) => {
                // Re-fetch within transaction with lock
                const holdEntry = await tx.ledgerEntry.findUnique({
                    where: { id: holdEntryId },
                });

                if (!holdEntry) {
                    return { success: false, error: "Hold entry not found" };
                }

                if (holdEntry.status !== EntryStatus.HOLD) {
                    this.logger.warn(
                        `Hold already released | ${JSON.stringify({
                            entryId: holdEntryId,
                            currentStatus: holdEntry.status,
                        })}`
                    );
                    return {
                        success: true,
                        entryId: holdEntry.id,
                        balanceAfter: holdEntry.balanceAfter,
                    };
                }

                if (settle) {
                    // Convert hold to debit - balance decreases
                    const newBalance = holdEntry.balanceAfter.minus(
                        holdEntry.holdAmount
                    );

                    await tx.ledgerEntry.update({
                        where: { id: holdEntryId },
                        data: {
                            debit: holdEntry.holdAmount,
                            holdAmount: new Decimal(0),
                            balanceAfter: newBalance,
                            status: EntryStatus.SETTLED,
                            description: description ?? holdEntry.description,
                            updatedAt: new Date(),
                        },
                    });

                    this.logger.log(
                        `Hold settled | ${JSON.stringify({
                            entryId: holdEntryId,
                            userId: holdEntry.userId,
                            currency: holdEntry.currency,
                            debitAmount: holdEntry.holdAmount.toString(),
                            balanceAfter: newBalance.toString(),
                        })}`
                    );

                    return {
                        success: true,
                        entryId: holdEntryId,
                        balanceAfter: newBalance,
                    };
                } else {
                    // Release hold without debit - funds become available again
                    await tx.ledgerEntry.update({
                        where: { id: holdEntryId },
                        data: {
                            holdAmount: new Decimal(0),
                            status: EntryStatus.CANCELLED,
                            description: description ?? holdEntry.description,
                            updatedAt: new Date(),
                        },
                    });

                    this.logger.log(
                        `Hold released (refunded) | ${JSON.stringify({
                            entryId: holdEntryId,
                            userId: holdEntry.userId,
                            currency: holdEntry.currency,
                            releasedAmount: holdEntry.holdAmount.toString(),
                        })}`
                    );

                    return {
                        success: true,
                        entryId: holdEntryId,
                        balanceAfter: holdEntry.balanceAfter,
                    };
                }
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: 10000,
            }
        );
    }

    /**
     * Gets the current balance for a user/currency pair
     *
     * @param userId User ID
     * @param currency Currency symbol (e.g., "BTC", "USDT")
     * @returns Balance breakdown (available, held, total)
     */
    async getBalance(userId: number, currency: string): Promise<BalanceInfo> {
        const upperCurrency = currency.toUpperCase();

        // Get latest balance from most recent non-failed entry
        const lastEntry = await this.prisma.ledgerEntry.findFirst({
            where: {
                userId,
                currency: upperCurrency,
                status: { not: EntryStatus.FAILED },
            },
            orderBy: { createdAt: "desc" },
            select: { balanceAfter: true },
        });

        const total = lastEntry?.balanceAfter ?? new Decimal(0);

        // Calculate total held amount from active HOLD entries
        const holdAggregation = await this.prisma.ledgerEntry.aggregate({
            where: {
                userId,
                currency: upperCurrency,
                status: EntryStatus.HOLD,
            },
            _sum: { holdAmount: true },
        });

        const held = holdAggregation._sum.holdAmount ?? new Decimal(0);
        const available = total.minus(held);

        return {
            available,
            held,
            total,
        };
    }

    /**
     * Internal balance calculation within a transaction (for atomic operations)
     */
    private async getBalanceInTransaction(
        tx: Prisma.TransactionClient,
        userId: number,
        currency: string
    ): Promise<BalanceInfo> {
        // Get latest balance
        const lastEntry = await tx.ledgerEntry.findFirst({
            where: { userId, currency, status: { not: EntryStatus.FAILED } },
            orderBy: { createdAt: "desc" },
            select: { balanceAfter: true },
        });

        const total = lastEntry?.balanceAfter ?? new Decimal(0);

        // Calculate held amount
        const holdAggregation = await tx.ledgerEntry.aggregate({
            where: {
                userId,
                currency,
                status: EntryStatus.HOLD,
            },
            _sum: { holdAmount: true },
        });

        const held = holdAggregation._sum.holdAmount ?? new Decimal(0);
        const available = total.minus(held);

        return {
            available,
            held,
            total,
        };
    }

    /**
     * Gets all balances for a user across all currencies
     *
     * @param userId User ID
     * @returns Map of currency to balance info
     */
    async getAllBalances(userId: number): Promise<Map<string, BalanceInfo>> {
        // Get distinct currencies this user has entries for
        const currencies = await this.prisma.ledgerEntry.findMany({
            where: { userId },
            select: { currency: true },
            distinct: ["currency"],
        });

        const balances = new Map<string, BalanceInfo>();

        for (const { currency } of currencies) {
            const balance = await this.getBalance(userId, currency);
            if (!balance.total.isZero()) {
                balances.set(currency, balance);
            }
        }

        return balances;
    }

    /**
     * Gets the ledger entry history for a user/currency
     *
     * @param userId User ID
     * @param currency Currency symbol
     * @param limit Max entries to return
     * @param offset Pagination offset
     */
    async getHistory(userId: number, currency: string, limit = 50, offset = 0) {
        return this.prisma.ledgerEntry.findMany({
            where: { userId, currency: currency.toUpperCase() },
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset,
        });
    }

    /**
     * Updates the sweep status of a deposit entry
     *
     * @param entryId Ledger entry ID
     * @param status New sweep status
     */
    async updateSweepStatus(
        entryId: string,
        status: SweepStatus
    ): Promise<void> {
        await this.prisma.ledgerEntry.update({
            where: { id: entryId },
            data: { sweepStatus: status, updatedAt: new Date() },
        });

        this.logger.log(
            `Sweep status updated | entryId: ${entryId}, status: ${status}`
        );
    }

    /**
     * Gets all pending sweeps (deposits not yet swept to main wallet)
     */
    async getPendingSweeps() {
        return this.prisma.ledgerEntry.findMany({
            where: {
                type: LedgerType.DEPOSIT,
                sweepStatus: SweepStatus.PENDING,
                status: EntryStatus.SETTLED,
            },
            orderBy: { createdAt: "asc" },
        });
    }

    /**
     * Utility to convert various number types to Decimal
     */
    private toDecimal(value: Decimal | number | string): Decimal {
        if (value instanceof Decimal) {
            return value;
        }
        return new Decimal(value);
    }

    /**
     * Creates a pair of entries for a transfer between users
     * (e.g., user-to-user send, or user-to-platform for trades)
     *
     * @param fromUserId Source user
     * @param toUserId Destination user
     * @param currency Currency
     * @param amount Amount to transfer
     * @param type Ledger type
     * @param reference Unique reference
     * @param tradeGroupId Optional trade group for linking related entries
     */
    async transfer(
        fromUserId: number,
        toUserId: number,
        currency: string,
        amount: Decimal | number | string,
        type: LedgerType,
        reference: string,
        tradeGroupId?: string
    ): Promise<LedgerOperationResult> {
        const transferAmount = this.toDecimal(amount);
        const upperCurrency = currency.toUpperCase();

        if (transferAmount.lessThanOrEqualTo(0)) {
            return {
                success: false,
                error: "Transfer amount must be positive",
            };
        }

        // Lock both users in consistent order to prevent deadlocks
        const [firstId, secondId] =
            fromUserId < toUserId
                ? [fromUserId, toUserId]
                : [toUserId, fromUserId];

        const lockKey1 = `ledger:${firstId}:${upperCurrency}`;
        const lockKey2 = `ledger:${secondId}:${upperCurrency}`;

        try {
            return await this.lockService.withLock(
                lockKey1,
                async () => {
                    return await this.lockService.withLock(
                        lockKey2,
                        async () =>
                            this.executeTransfer(
                                fromUserId,
                                toUserId,
                                upperCurrency,
                                transferAmount,
                                type,
                                reference,
                                tradeGroupId
                            ),
                        { ttlMs: 10000, maxWaitMs: 15000, strict: true }
                    );
                },
                { ttlMs: 15000, maxWaitMs: 20000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `Transfer failed | ${JSON.stringify({
                    fromUserId,
                    toUserId,
                    currency,
                    amount: transferAmount.toString(),
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Internal transfer execution
     */
    private async executeTransfer(
        fromUserId: number,
        toUserId: number,
        currency: string,
        amount: Decimal,
        type: LedgerType,
        reference: string,
        tradeGroupId?: string
    ): Promise<LedgerOperationResult> {
        return await this.prisma.$transaction(
            async (tx) => {
                // Check for idempotency using the debit side
                const existingDebit = await tx.ledgerEntry.findUnique({
                    where: { type_reference: { type, reference } },
                });

                if (existingDebit) {
                    this.logger.warn(
                        `Duplicate transfer detected | ${JSON.stringify({
                            type,
                            reference,
                        })}`
                    );
                    return {
                        success: true,
                        entryId: existingDebit.id,
                        balanceAfter: existingDebit.balanceAfter,
                    };
                }

                // Check source balance
                const sourceBalance = await this.getBalanceInTransaction(
                    tx,
                    fromUserId,
                    currency
                );

                if (
                    fromUserId !== LedgerService.PLATFORM_USER_ID &&
                    sourceBalance.available.lessThan(amount)
                ) {
                    return {
                        success: false,
                        error: `Insufficient balance. Available: ${sourceBalance.available.toString()}, Requested: ${amount.toString()}`,
                    };
                }

                // Get destination current balance
                const destLastEntry = await tx.ledgerEntry.findFirst({
                    where: {
                        userId: toUserId,
                        currency,
                        status: { not: EntryStatus.FAILED },
                    },
                    orderBy: { createdAt: "desc" },
                    select: { balanceAfter: true },
                });

                const destCurrentBalance =
                    destLastEntry?.balanceAfter ?? new Decimal(0);

                // Create debit entry for source
                const newSourceBalance = sourceBalance.total.minus(amount);
                const debitEntry = await tx.ledgerEntry.create({
                    data: {
                        userId: fromUserId,
                        currency,
                        type,
                        debit: amount,
                        credit: new Decimal(0),
                        balanceAfter: newSourceBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference,
                        tradeGroupId,
                        description: `Transfer to user ${toUserId}`,
                    },
                });

                // Create credit entry for destination
                const newDestBalance = destCurrentBalance.plus(amount);
                await tx.ledgerEntry.create({
                    data: {
                        userId: toUserId,
                        currency,
                        type,
                        debit: new Decimal(0),
                        credit: amount,
                        balanceAfter: newDestBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference: `${reference}-credit`,
                        tradeGroupId,
                        description: `Transfer from user ${fromUserId}`,
                    },
                });

                this.logger.log(
                    `Transfer successful | ${JSON.stringify({
                        fromUserId,
                        toUserId,
                        currency,
                        amount: amount.toString(),
                        debitEntryId: debitEntry.id,
                    })}`
                );

                return {
                    success: true,
                    entryId: debitEntry.id,
                    balanceAfter: newSourceBalance,
                };
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: 15000,
            }
        );
    }
}
