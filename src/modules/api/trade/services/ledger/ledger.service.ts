import { Injectable, Logger } from "@nestjs/common";
import { Prisma, LedgerType, EntryStatus, SweepStatus, AuditAction } from "@prisma/client";
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
 * Result of a paired ledger operation (user + platform)
 */
export interface PairedLedgerResult {
    success: boolean;
    userEntry?: {
        id: string;
        balanceAfter: Decimal;
        reference: string;
    };
    platformEntry?: {
        id: string;
        balanceAfter: Decimal;
        reference: string;
    };
    error?: string;
    userBalanceAfter?: Decimal;
    platformBalanceAfter?: Decimal;
}

/**
 * Options for paired credit operation
 */
export interface PairedCreditOptions extends CreateLedgerEntryOptions {
    createPlatformEntry?: boolean; // Default true (creates platform debit)
}

/**
 * Options for paired debit operation
 */
export interface PairedDebitOptions extends CreateLedgerEntryOptions {
    createPlatformEntry?: boolean; // Default true (creates platform credit)
    networkFee?: Decimal | number | string; // Optional network fee to deduct
}

/**
 * Options for releasing hold with platform entry
 */
export interface ReleaseHoldWithPlatformOptions {
    holdReference: string;
    settle: boolean;
    description?: string;
    tradeGroupId?: string;
    createPlatformEntry?: boolean; // Default true if settle=true
    networkFee?: Decimal | number | string; // Optional network fee to capture upon release
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

    // Network fee account ID (accumulates fees charged to users)
    static readonly NETWORK_FEE_USER_ID = -1;

    // Decimal precision for crypto
    private readonly DECIMAL_PLACES = 8;

    constructor(
        private readonly prisma: PrismaService,
        private readonly lockService: DistributedLockService
    ) { }

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

                // --- Audit Log ---
                this.logAudit(
                    entry.id,
                    AuditAction.CREATED,
                    'system',
                    description,
                    metadata
                ).catch(e => this.logger.error(`Failed to audit credit ${entry.id}: ${e.message}`));
                // -----------------

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
     * Execute arbitrary code within the distributed lock scope for a user/currency pair.
     * 
     * This allows external services (like TransactionMonitorService) to run their 
     * validation checks atomically with ledger operations, preventing race conditions
     * where conditions change between validation and execution.
     * 
     * Use cases:
     * - Running TransactionMonitorService.validateBeforeExecution() before hold()
     * - Executing multi-step validation that needs consistent state
     * 
     * @param userId - User ID to lock
     * @param currency - Currency to lock
     * @param callback - Function to execute while holding the lock
     * @returns Result from the callback
     */
    async runWithLock<T>(
        userId: number,
        currency: string,
        callback: () => Promise<T>
    ): Promise<T> {
        const lockKey = `ledger:${userId}:${currency.toUpperCase()}`;

        try {
            return await this.lockService.withLock(
                lockKey,
                async () => {
                    // Execute callback with exclusive access to this user/currency pair
                    return await callback();
                },
                { ttlMs: 15000, maxWaitMs: 20000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `runWithLock failed | ${JSON.stringify({
                    userId,
                    currency,
                    error: error.message,
                })}`
            );
            throw error;
        }
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

                // --- Audit Log ---
                this.logAudit(
                    entry.id,
                    AuditAction.CREATED,
                    'system',
                    description
                ).catch(e => this.logger.error(`Failed to audit debit ${entry.id}: ${e.message}`));
                // -----------------

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

                // --- Audit Log ---
                this.logAudit(
                    entry.id,
                    AuditAction.HOLD_PLACED,
                    'system',
                    description
                ).catch(e => this.logger.error(`Failed to audit hold ${entry.id}: ${e.message}`));
                // -----------------

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

                let result: LedgerOperationResult;
                if (settle) {
                    // Convert hold to debit - balance decreases
                    const newBalance = holdEntry.balanceAfter.minus(
                        holdEntry.holdAmount
                    );

                    const updatedEntry = await tx.ledgerEntry.update({
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

                    // --- Audit Log ---
                    this.logAudit(
                        updatedEntry.id,
                        AuditAction.SETTLED,
                        'system',
                        description
                    ).catch(e => this.logger.error(`Failed to audit hold settlement ${updatedEntry.id}: ${e.message}`));
                    // -----------------

                    result = {
                        success: true,
                        entryId: updatedEntry.id,
                        balanceAfter: newBalance,
                    };
                } else {
                    // Release hold without debit - funds become available again
                    const updatedEntry = await tx.ledgerEntry.update({
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

                    // --- Audit Log ---
                    this.logAudit(
                        updatedEntry.id,
                        AuditAction.HOLD_RELEASED,
                        'system',
                        description
                    ).catch(e => this.logger.error(`Failed to audit hold release ${updatedEntry.id}: ${e.message}`));
                    // -----------------

                    result = {
                        success: true,
                        entryId: updatedEntry.id,
                        balanceAfter: holdEntry.balanceAfter,
                    };
                }
                return result;
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                timeout: 10000,
            }
        );
    }

    /**
     * Executes an atomic internal transfer between two users
     *
     * @param fromUserId Sender User ID
     * @param toUserId Recipient User ID
     * @param currency Currency symbol
     * @param amount Amount to transfer
     * @param reference Unique reference for the transfer
     * @param description Optional description
     */
    async internalTransfer(
        fromUserId: number,
        toUserId: number,
        currency: string,
        amount: Decimal | number | string,
        reference: string,
        description?: string
    ): Promise<LedgerOperationResult> {
        const transferAmount = this.toDecimal(amount);

        if (transferAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Transfer amount must be positive" };
        }

        if (fromUserId === toUserId) {
            return { success: false, error: "Cannot transfer to self" };
        }

        const upperCurrency = currency.toUpperCase();

        // Sort locks to prevent deadlocks
        const firstLockUser = fromUserId < toUserId ? fromUserId : toUserId;
        const secondLockUser = fromUserId < toUserId ? toUserId : fromUserId;

        const lockKey1 = `ledger:${firstLockUser}:${upperCurrency}`;
        const lockKey2 = `ledger:${secondLockUser}:${upperCurrency}`;

        try {
            // Acquire locks sequentially (nested)
            return await this.lockService.withLock(
                lockKey1,
                async () => {
                    return await this.lockService.withLock(
                        lockKey2,
                        async () => {
                            return await this.executeInternalTransfer(
                                fromUserId,
                                toUserId,
                                upperCurrency,
                                transferAmount,
                                reference,
                                description
                            );
                        },
                        { ttlMs: 10000, maxWaitMs: 15000, strict: true }
                    );
                },
                { ttlMs: 10000, maxWaitMs: 15000, strict: true }
            );
        } catch (error) {
            this.logger.error(
                `Internal transfer failed | ${JSON.stringify({
                    fromUserId,
                    toUserId,
                    currency,
                    amount: transferAmount.toString(),
                    reference,
                    error: error.message,
                })}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Internal transfer execution
     */
    private async executeInternalTransfer(
        fromUserId: number,
        toUserId: number,
        currency: string,
        amount: Decimal,
        reference: string,
        description?: string
    ): Promise<LedgerOperationResult> {
        return await this.prisma.$transaction(
            async (tx) => {
                // 1. Idempotency Check
                const existing = await tx.ledgerEntry.findUnique({
                    where: {
                        type_reference: {
                            type: LedgerType.SEND,
                            reference: `send:${reference}`,
                        },
                    },
                });

                if (existing) {
                    this.logger.warn(
                        `Duplicate internal transfer detected | Ref: ${reference}`
                    );
                    return {
                        success: true,
                        entryId: existing.id,
                        balanceAfter: existing.balanceAfter,
                    };
                }

                // 2. Sender Balance Check & Debit
                const senderBalance = await this.getBalanceInTransaction(
                    tx,
                    fromUserId,
                    currency
                );

                if (
                    fromUserId !== LedgerService.PLATFORM_USER_ID &&
                    senderBalance.available.lessThan(amount)
                ) {
                    throw new Error(
                        `Insufficient balance. Available: ${senderBalance.available.toString()}, Requested: ${amount.toString()}`
                    );
                }

                const senderNewBalance = senderBalance.total.minus(amount);

                // Debit Sender
                const debitEntry = await tx.ledgerEntry.create({
                    data: {
                        userId: fromUserId,
                        currency,
                        type: LedgerType.SEND,
                        debit: amount,
                        credit: new Decimal(0),
                        balanceAfter: senderNewBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference: `send:${reference}`,
                        counterpartyUserId: toUserId,
                        description: description || `Transfer to user ${toUserId}`,
                    },
                });

                // 3. Recipient Credit
                // Get recipient balance (locked by findFirst in getBalanceInTransaction)
                const recipientBalance = await this.getBalanceInTransaction(
                    tx,
                    toUserId,
                    currency
                );
                const recipientNewBalance = recipientBalance.total.plus(amount);

                // Credit Recipient
                const creditEntry = await tx.ledgerEntry.create({
                    data: {
                        userId: toUserId,
                        currency,
                        type: LedgerType.RECEIVE,
                        credit: amount,
                        debit: new Decimal(0),
                        balanceAfter: recipientNewBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE, // Internal transfer doesn't need external sweep
                        holdAmount: new Decimal(0),
                        reference: `recv:${reference}`,
                        counterpartyUserId: fromUserId,
                        description: description || `Transfer from user ${fromUserId}`,
                    },
                });

                this.logger.log(
                    `Internal transfer successful | ${JSON.stringify({
                        fromUserId,
                        toUserId,
                        currency,
                        amount: amount.toString(),
                        ref: reference,
                    })}`
                );

                // --- Audit Logs (Both sides) ---
                Promise.all([
                    this.logAudit(debitEntry.id, AuditAction.CREATED, 'system', `Transfer sent to ${toUserId}`, { counterparty: toUserId }),
                    this.logAudit(creditEntry.id, AuditAction.CREATED, 'system', `Transfer received from ${fromUserId}`, { counterparty: fromUserId })
                ]).catch(e => this.logger.error(`Failed to audit internal transfer: ${e.message}`));
                // -------------------------------

                return {
                    success: true,
                    entryId: debitEntry.id, // Return sender's entry ID main
                    balanceAfter: senderNewBalance,
                };
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
     * @returns Map of currency (uppercase) to balance info
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
                // Store with uppercase key for consistent lookup
                balances.set(currency.toUpperCase(), balance);
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
                const creditEntry = await tx.ledgerEntry.create({
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

                // --- Audit Logs ---
                Promise.all([
                    this.logAudit(debitEntry.id, AuditAction.CREATED, 'system', `Transfer from ${fromUserId} to ${toUserId}`, { counterparty: toUserId }),
                    this.logAudit(creditEntry.id, AuditAction.CREATED, 'system', `Transfer from ${fromUserId} to ${toUserId}`, { counterparty: fromUserId })
                ]).catch(e => this.logger.error(`Failed to audit transfer: ${e.message}`));
                // ------------------

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

    // =========================================================================
    // AUDIT LOGGING METHODS
    // =========================================================================

    /**
     * Logs an audit entry for a ledger operation
     *
     * @param ledgerEntryId The ledger entry being audited
     * @param action The audit action
     * @param actor Who performed the action (e.g., "system", "user:123", "admin:1")
     * @param reason Optional reason for the action
     * @param metadata Optional additional data
     */
    async logAudit(
        ledgerEntryId: string,
        action: AuditAction,
        actor: string,
        reason?: string,
        metadata?: Record<string, any>
    ): Promise<void> {
        try {
            await this.prisma.ledgerAuditLog.create({
                data: {
                    ledgerEntryId,
                    action,
                    actor,
                    reason,
                    metadata: metadata ? metadata : undefined,
                },
            });
        } catch (error) {
            // Don't fail the main operation if audit logging fails
            this.logger.error(
                `Failed to create audit log | ${JSON.stringify({
                    ledgerEntryId,
                    action,
                    actor,
                    error: error.message,
                })}`
            );
        }
    }

    /**
     * Gets the audit trail for a ledger entry
     *
     * @param ledgerEntryId The ledger entry ID
     * @returns Array of audit log entries
     */
    async getAuditTrail(ledgerEntryId: string) {
        return this.prisma.ledgerAuditLog.findMany({
            where: { ledgerEntryId },
            orderBy: { createdAt: "asc" },
        });
    }

    /**
     * Gets recent audit logs across all entries
     *
     * @param limit Maximum number of entries to return
     * @param action Optional filter by action type
     * @returns Array of audit log entries with ledger entry details
     */
    async getRecentAuditLogs(pageNumber: number = 1, pageSize: number = 100, action?: AuditAction) {
        return this.prisma.ledgerAuditLog.findMany({
            where: action ? { action } : undefined,
            orderBy: { createdAt: "desc" },
            skip: (pageNumber - 1) * pageSize,
            take: pageSize,
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
            },
        });
    }

    /**
     * Backfills audit logs for ledger entries that don't have them.
     * @param limit Max entries to process in one run
     */
    async backfillAuditLogs(limit: number = 1000): Promise<number> {
        this.logger.log(`Starting audit log backfill (limit: ${limit})...`);
        const entries = await this.prisma.ledgerEntry.findMany({
            where: {
                auditLogs: {
                    none: {}
                }
            },
            take: limit,
            orderBy: { createdAt: 'desc' }
        });

        if (entries.length === 0) {
            this.logger.log("Audit log backfill: No matching entries found.");
            return 0;
        }

        this.logger.log(`Audit log backfill: Found ${entries.length} entries. Processing...`);
        let count = 0;

        for (const entry of entries) {
            let action: AuditAction = AuditAction.CREATED;
            // Map status/type to Action
            // If entry is HOLD -> HOLD_PLACED
            // If entry is SETTLED and was originally a HOLD -> We can't easily know history without looking at updates, 
            // but for backfill we assume the current state represents the last action.
            // Ideally we'd log the creation. 
            // All entries are CREATED at least.
            // If it's a HOLD entry, it was HOLD_PLACED.
            // If it's SETTLED, it was CREATED (or SETTLED if it came from a hold, but simpler to just say CREATED for backfill of existence)

            // Simple mapping:
            if (entry.status === EntryStatus.HOLD) {
                action = AuditAction.HOLD_PLACED;
            } else if (entry.status === EntryStatus.CANCELLED) {
                // If it's cancelled, it was probably a hold that got released or a failed tx.
                action = AuditAction.CANCELLED;
            } else if (entry.status === EntryStatus.FAILED) {
                action = AuditAction.FAILED;
            } else {
                // Default to CREATED for SETTLED/PENDING
                action = AuditAction.CREATED;
            }

            try {
                await this.prisma.ledgerAuditLog.create({
                    data: {
                        ledgerEntryId: entry.id,
                        action,
                        actor: 'system:backfill',
                        reason: 'Backfilled audit log',
                        createdAt: entry.createdAt // Backdate to actual entry time
                    }
                });
                count++;
            } catch (error) {
                this.logger.error(`Failed to backfill audit for entry ${entry.id}: ${error.message}`);
            }
        }

        this.logger.log(`Audit log backfill: Completed ${count} entries.`);
        return count;
    }

    // ==========================================
    // DOUBLE ENTRY (PAIRED) METHODS
    // ==========================================

    /**
     * Helper to acquire multiple locks sequentially
     */
    private async withLocks<T>(keys: string[], callback: () => Promise<T>): Promise<T> {
        if (keys.length === 0) {
            return callback();
        }

        const [currentKey, ...restKeys] = keys;

        return this.lockService.withLock(
            currentKey,
            () => this.withLocks(restKeys, callback),
            { ttlMs: 20000, maxWaitMs: 30000, strict: true }
        );
    }

    /**
     * Credits a user and debits the platform (creates liability)
     * 
     * @param options Credit options
     */
    async pairedCredit(options: PairedCreditOptions): Promise<PairedLedgerResult> {
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
            createPlatformEntry = true
        } = options;

        // Platform User ID check to prevent infinite loops if crediting platform
        if (userId === LedgerService.PLATFORM_USER_ID) {
            return { success: false, error: "Cannot use pairedCredit for platform user" };
        }

        const creditAmount = this.toDecimal(amount);
        if (creditAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Amount must be positive" };
        }

        // Lock ordering: Platform (0) then User (>0)
        // Since 0 < Any User ID, we lock Platform first
        const userLockKey = `ledger:${userId}:${currency.toUpperCase()}`;
        const platformLockKey = `ledger:${LedgerService.PLATFORM_USER_ID}:${currency.toUpperCase()}`;

        const locks = createPlatformEntry
            ? [platformLockKey, userLockKey] // 0 comes before UserID
            : [userLockKey];

        try {
            return await this.withLocks(
                locks,
                async () => this.executePairedCredit(options, creditAmount)
            );
        } catch (error) {
            this.logger.error(`Paired credit failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async executePairedCredit(
        options: PairedCreditOptions,
        amount: Decimal
    ): Promise<PairedLedgerResult> {
        const {
            userId,
            currency,
            type,
            reference,
            tradeGroupId,
            description,
            metadata,
            sweepStatus,
            createPlatformEntry = true
        } = options;

        return await this.prisma.$transaction(async (tx) => {
            // 1. Check idempotency for User Entry
            const existingUserEntry = await tx.ledgerEntry.findUnique({
                where: { type_reference: { type, reference } },
            });

            if (existingUserEntry) {
                // If user entry exists, platform should also exist if requested
                return {
                    success: true,
                    userEntry: {
                        id: existingUserEntry.id,
                        balanceAfter: existingUserEntry.balanceAfter,
                        reference: existingUserEntry.reference
                    },
                    userBalanceAfter: existingUserEntry.balanceAfter
                };
            }

            // 2. Process User Credit
            // Get user current balance
            const userLastEntry = await tx.ledgerEntry.findFirst({
                where: { userId, currency, status: { not: EntryStatus.FAILED } },
                orderBy: { createdAt: "desc" },
                select: { balanceAfter: true },
            });
            const userCurrentBalance = userLastEntry?.balanceAfter ?? new Decimal(0);
            const userNewBalance = userCurrentBalance.plus(amount);

            const userEntry = await tx.ledgerEntry.create({
                data: {
                    userId,
                    currency,
                    type,
                    debit: new Decimal(0),
                    credit: amount,
                    balanceAfter: userNewBalance,
                    status: EntryStatus.SETTLED,
                    sweepStatus: sweepStatus ?? (type === LedgerType.DEPOSIT ? SweepStatus.PENDING : SweepStatus.NOT_APPLICABLE),
                    holdAmount: new Decimal(0),
                    reference,
                    tradeGroupId,
                    description,
                    metadata: metadata ?? Prisma.JsonNull,
                },
            });

            // 3. Process Platform Debit (if requested)
            let platformEntryResult = null;
            let platformNewBalance = null;

            if (createPlatformEntry) {
                const platformRef = `platform:${reference}`;

                // Get platform balance
                const platformLastEntry = await tx.ledgerEntry.findFirst({
                    where: { userId: LedgerService.PLATFORM_USER_ID, currency },
                    orderBy: { createdAt: "desc" },
                    select: { balanceAfter: true },
                });
                const platformCurrentBalance = platformLastEntry?.balanceAfter ?? new Decimal(0);

                // User Credit = Platform Debit (Liability increases)
                platformNewBalance = platformCurrentBalance.minus(amount);

                const platformEntry = await tx.ledgerEntry.create({
                    data: {
                        userId: LedgerService.PLATFORM_USER_ID,
                        currency,
                        type,
                        debit: amount,
                        credit: new Decimal(0),
                        balanceAfter: platformNewBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference: platformRef,
                        tradeGroupId, // Link by same tradeGroupId
                        counterpartyUserId: userId,
                        description: `Platform debit (User credit): ${description || type}`,
                    },
                });

                platformEntryResult = {
                    id: platformEntry.id,
                    balanceAfter: platformNewBalance,
                    reference: platformRef
                };
            }

            this.logger.log(`Paired credit success | User: ${userId} (+${amount}) | Platform: ${createPlatformEntry ? `Debited` : 'Skipped'}`);

            // --- Audit Logs ---
            const audits = [
                this.logAudit(userEntry.id, AuditAction.CREATED, 'system', description, { type, platformEntry: platformEntryResult?.id })
            ];
            if (platformEntryResult) {
                audits.push(this.logAudit(platformEntryResult.id, AuditAction.CREATED, 'system', description, { type, userEntry: userEntry.id }));
            }
            Promise.all(audits).catch(e => this.logger.error(`Failed to audit paired credit: ${e.message}`));
            // ------------------

            return {
                success: true,
                userEntry: {
                    id: userEntry.id,
                    balanceAfter: userNewBalance,
                    reference
                },
                platformEntry: platformEntryResult,
                userBalanceAfter: userNewBalance,
                platformBalanceAfter: platformNewBalance
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 });
    }

    /**
     * Credits a user and debits the platform within an EXISTING transaction.
     * 
     * IMPORTANT: This method does NOT create its own transaction - the caller MUST:
     * 1. Acquire distributed locks BEFORE starting the transaction
     * 2. Pass the transaction client from their own prisma.$transaction()
     * 
     * Use this when you need atomicity across multiple operations (e.g., BuyOrderService
     * needs to credit ledger AND update order status in one atomic operation).
     * 
     * @param tx - The Prisma transaction client from the caller's transaction
     * @param options - Credit options (same as pairedCredit)
     * @returns PairedLedgerResult
     */
    async pairedCreditInTransaction(
        tx: Prisma.TransactionClient,
        options: PairedCreditOptions
    ): Promise<PairedLedgerResult> {
        const creditAmount = this.toDecimal(options.amount);

        if (creditAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Amount must be positive" };
        }

        if (options.userId === LedgerService.PLATFORM_USER_ID) {
            return { success: false, error: "Cannot use pairedCredit for platform user" };
        }

        try {
            return await this.executePairedCreditWithClient(tx, options, creditAmount);
        } catch (error) {
            this.logger.error(`Paired credit in transaction failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Execute paired credit logic using a provided transaction client.
     * This is the core logic shared between pairedCredit and pairedCreditInTransaction.
     */
    private async executePairedCreditWithClient(
        tx: Prisma.TransactionClient,
        options: PairedCreditOptions,
        amount: Decimal
    ): Promise<PairedLedgerResult> {
        const {
            userId,
            currency,
            type,
            reference,
            tradeGroupId,
            description,
            metadata,
            sweepStatus,
            createPlatformEntry = true
        } = options;

        // 1. Check idempotency for User Entry
        const existingUserEntry = await tx.ledgerEntry.findUnique({
            where: { type_reference: { type, reference } },
        });

        if (existingUserEntry) {
            return {
                success: true,
                userEntry: {
                    id: existingUserEntry.id,
                    balanceAfter: existingUserEntry.balanceAfter,
                    reference: existingUserEntry.reference
                },
                userBalanceAfter: existingUserEntry.balanceAfter
            };
        }

        // 2. Process User Credit
        const userLastEntry = await tx.ledgerEntry.findFirst({
            where: { userId, currency, status: { not: EntryStatus.FAILED } },
            orderBy: { createdAt: "desc" },
            select: { balanceAfter: true },
        });
        const userCurrentBalance = userLastEntry?.balanceAfter ?? new Decimal(0);
        const userNewBalance = userCurrentBalance.plus(amount);

        const userEntry = await tx.ledgerEntry.create({
            data: {
                userId,
                currency,
                type,
                debit: new Decimal(0),
                credit: amount,
                balanceAfter: userNewBalance,
                status: EntryStatus.SETTLED,
                sweepStatus: sweepStatus ?? (type === LedgerType.DEPOSIT ? SweepStatus.PENDING : SweepStatus.NOT_APPLICABLE),
                holdAmount: new Decimal(0),
                reference,
                tradeGroupId,
                description,
                metadata: metadata ?? Prisma.JsonNull,
            },
        });

        // 3. Process Platform Debit (if requested)
        let platformEntryResult = null;
        let platformNewBalance = null;

        if (createPlatformEntry) {
            const platformRef = `platform:${reference}`;

            const platformLastEntry = await tx.ledgerEntry.findFirst({
                where: { userId: LedgerService.PLATFORM_USER_ID, currency },
                orderBy: { createdAt: "desc" },
                select: { balanceAfter: true },
            });
            const platformCurrentBalance = platformLastEntry?.balanceAfter ?? new Decimal(0);

            platformNewBalance = platformCurrentBalance.minus(amount);

            const platformEntry = await tx.ledgerEntry.create({
                data: {
                    userId: LedgerService.PLATFORM_USER_ID,
                    currency,
                    type,
                    debit: amount,
                    credit: new Decimal(0),
                    balanceAfter: platformNewBalance,
                    status: EntryStatus.SETTLED,
                    sweepStatus: SweepStatus.NOT_APPLICABLE,
                    holdAmount: new Decimal(0),
                    reference: platformRef,
                    tradeGroupId,
                    counterpartyUserId: userId,
                    description: `Platform debit (User credit): ${description || type}`,
                },
            });

            platformEntryResult = {
                id: platformEntry.id,
                balanceAfter: platformNewBalance,
                reference: platformRef
            };
        }

        this.logger.log(`Paired credit (in-tx) success | User: ${userId} (+${amount}) | Platform: ${createPlatformEntry ? `Debited` : 'Skipped'}`);

        // Audit logs (fire-and-forget, outside the critical path)
        const audits = [
            this.logAudit(userEntry.id, AuditAction.CREATED, 'system', description, { type, platformEntry: platformEntryResult?.id })
        ];
        if (platformEntryResult) {
            audits.push(this.logAudit(platformEntryResult.id, AuditAction.CREATED, 'system', description, { type, userEntry: userEntry.id }));
        }
        Promise.all(audits).catch(e => this.logger.error(`Failed to audit paired credit: ${e.message}`));

        return {
            success: true,
            userEntry: {
                id: userEntry.id,
                balanceAfter: userNewBalance,
                reference
            },
            platformEntry: platformEntryResult,
            userBalanceAfter: userNewBalance,
            platformBalanceAfter: platformNewBalance
        };
    }

    /**
     * Debits a user and credits the platform (reduces liability)
     * Optional network fee handling
     */
    async pairedDebit(options: PairedDebitOptions): Promise<PairedLedgerResult> {
        const {
            userId,
            currency,
            type,
            amount,
            reference,
            tradeGroupId,
            description,
            metadata,
            createPlatformEntry = true,
            networkFee = 0
        } = options;

        if (userId === LedgerService.PLATFORM_USER_ID) {
            return { success: false, error: "Cannot use pairedDebit for platform user" };
        }

        const debitAmount = this.toDecimal(amount);
        const feeAmount = this.toDecimal(networkFee);

        if (debitAmount.lessThanOrEqualTo(0)) {
            return { success: false, error: "Amount must be positive" };
        }

        const lockKeys = [
            `ledger:${LedgerService.NETWORK_FEE_USER_ID}:${currency.toUpperCase()}`, // -1 (First)
            `ledger:${LedgerService.PLATFORM_USER_ID}:${currency.toUpperCase()}`,     // 0 (Second)
            `ledger:${userId}:${currency.toUpperCase()}`                              // User (Third)
        ];

        try {
            return await this.withLocks(
                lockKeys,
                async () => this.executePairedDebit(options, debitAmount, feeAmount)
            );
        } catch (error) {
            this.logger.error(`Paired debit failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async executePairedDebit(
        options: PairedDebitOptions,
        debitAmount: Decimal,
        feeAmount: Decimal
    ): Promise<PairedLedgerResult> {
        return await this.prisma.$transaction(async (tx) => {
            const { userId, currency, type, reference, tradeGroupId, description } = options;
            const totalRequired = debitAmount.plus(feeAmount);

            // 1. Check User Balance
            const userBalanceInfo = await this.getBalanceInTransaction(tx, userId, currency);
            if (userBalanceInfo.available.lessThan(totalRequired)) {
                return {
                    success: false,
                    error: `Insufficient balance. Available: ${userBalanceInfo.available}, Required: ${totalRequired}`
                };
            }

            // 2. Check Idempotency (User Entry)
            const existing = await tx.ledgerEntry.findUnique({
                where: { type_reference: { type, reference } },
            });
            if (existing) {
                return {
                    success: true,
                    userEntry: { id: existing.id, balanceAfter: existing.balanceAfter, reference },
                    userBalanceAfter: existing.balanceAfter
                };
            }

            // 3. Create User Debit
            const userNewBalance = userBalanceInfo.total.minus(debitAmount);
            const userEntry = await tx.ledgerEntry.create({
                data: {
                    userId,
                    currency,
                    type,
                    debit: debitAmount,
                    credit: new Decimal(0),
                    balanceAfter: userNewBalance,
                    status: EntryStatus.SETTLED,
                    sweepStatus: SweepStatus.NOT_APPLICABLE,
                    holdAmount: new Decimal(0),
                    reference,
                    tradeGroupId,
                    description,
                },
            });

            // 4. Create Platform Credit (if requested)
            let platformEntryResult = null;
            let platformNewBalance = null;
            let platformEntryId: string | undefined;

            if (options.createPlatformEntry) {
                const platformRef = `platform:${reference}`;
                const platformLast = await tx.ledgerEntry.findFirst({
                    where: { userId: LedgerService.PLATFORM_USER_ID, currency },
                    orderBy: { createdAt: "desc" },
                    select: { balanceAfter: true }
                });
                const platformCurrent = platformLast?.balanceAfter ?? new Decimal(0);
                platformNewBalance = platformCurrent.plus(debitAmount); // User Debit = Platform Credit

                const platformEntry = await tx.ledgerEntry.create({
                    data: {
                        userId: LedgerService.PLATFORM_USER_ID,
                        currency,
                        type,
                        debit: new Decimal(0),
                        credit: debitAmount,
                        balanceAfter: platformNewBalance,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference: platformRef,
                        tradeGroupId,
                        counterpartyUserId: userId,
                        description: `Platform credit (User debit): ${description || type}`,
                    },
                });

                platformEntryResult = { id: platformEntry.id, balanceAfter: platformNewBalance, reference: platformRef };
                platformEntryId = platformEntry.id;
            }

            // 5. Handle Network Fee (if any)
            if (feeAmount.greaterThan(0)) {
                // 5a. Debit User for Fee
                const feeRef = `userfee:${reference}`;
                // We must subtract from the already updated state (userNewBalance was just the main debit)
                const userBalanceAfterFee = userNewBalance.minus(feeAmount);

                const userFeeEntry = await tx.ledgerEntry.create({
                    data: {
                        userId,
                        currency,
                        type: LedgerType.FEE,
                        debit: feeAmount,
                        credit: new Decimal(0),
                        balanceAfter: userBalanceAfterFee,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference: feeRef,
                        tradeGroupId,
                        description: `Network fee for ${description || type}`,
                    }
                });

                // 5b. Credit Fee Account (userId = -1)
                const feeAccountRef = `fee:${reference}`;
                const feeAccountLast = await tx.ledgerEntry.findFirst({
                    where: { userId: LedgerService.NETWORK_FEE_USER_ID, currency },
                    orderBy: { createdAt: "desc" },
                    select: { balanceAfter: true }
                });
                const feeAccountCurrent = feeAccountLast?.balanceAfter ?? new Decimal(0);
                const feeAccountNew = feeAccountCurrent.plus(feeAmount);

                const feeAccountEntry = await tx.ledgerEntry.create({
                    data: {
                        userId: LedgerService.NETWORK_FEE_USER_ID,
                        currency,
                        type: LedgerType.FEE,
                        debit: new Decimal(0),
                        credit: feeAmount,
                        balanceAfter: feeAccountNew,
                        status: EntryStatus.SETTLED,
                        sweepStatus: SweepStatus.NOT_APPLICABLE,
                        holdAmount: new Decimal(0),
                        reference: feeAccountRef,
                        tradeGroupId,
                        counterpartyUserId: userId,
                        description: `Fee collected from User ${userId}`,
                    },
                });

                // --- Audit Logs for Fees ---
                Promise.all([
                    this.logAudit(userFeeEntry.id, AuditAction.CREATED, 'system', `User fee debit for ${type}`, { relatedTo: userEntry.id, feeTo: feeAccountEntry.id }),
                    this.logAudit(feeAccountEntry.id, AuditAction.CREATED, 'system', `Fee collected from User ${userId} for ${type}`, { relatedTo: userEntry.id, feeFrom: userFeeEntry.id })
                ]).catch(e => this.logger.error(`Failed to audit fee entries: ${e.message}`));
                // ---------------------------
            }

            // --- Audit Logs for main entries ---
            const audits = [
                this.logAudit(userEntry.id, AuditAction.CREATED, 'system', description, { type, platformEntry: platformEntryId })
            ];
            if (platformEntryResult) {
                audits.push(this.logAudit(platformEntryResult.id, AuditAction.CREATED, 'system', description, { type, userEntry: userEntry.id }));
            }
            Promise.all(audits).catch(e => this.logger.error(`Failed to audit paired debit: ${e.message}`));
            // ------------------

            return {
                success: true,
                userEntry: { id: userEntry.id, balanceAfter: userNewBalance, reference },
                platformEntry: platformEntryResult
            };

        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 });
    }

    /**
     * Releases a hold and creates platform entries if settling
     */
    async releaseHoldWithPlatformEntry(options: ReleaseHoldWithPlatformOptions): Promise<PairedLedgerResult> {
        const { holdReference, settle, description, tradeGroupId, createPlatformEntry = true, networkFee = 0 } = options;

        const holdEntry = await this.prisma.ledgerEntry.findFirst({
            where: { reference: holdReference, status: EntryStatus.HOLD },
        });

        if (!holdEntry) {
            return { success: false, error: "Hold entry not found" };
        }

        const lockKeys = [
            `ledger:${LedgerService.NETWORK_FEE_USER_ID}:${holdEntry.currency}`, // -1
            `ledger:${LedgerService.PLATFORM_USER_ID}:${holdEntry.currency}`,     // 0
            `ledger:${holdEntry.userId}:${holdEntry.currency}`                    // User
        ];

        try {
            return await this.withLocks(
                lockKeys,
                async () => this.executeReleaseHoldWithPlatform(options, holdEntry)
            );
        } catch (error) {
            this.logger.error(`Release hold paired failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    private async executeReleaseHoldWithPlatform(
        options: ReleaseHoldWithPlatformOptions,
        holdEntry: any
    ): Promise<PairedLedgerResult> {
        const { settle, description, tradeGroupId, createPlatformEntry = true } = options;
        const feeAmount = this.toDecimal(options.networkFee ?? 0);

        return await this.prisma.$transaction(async (tx) => {
            const currentHold = await tx.ledgerEntry.findUnique({ where: { id: holdEntry.id } });
            if (!currentHold || currentHold.status !== EntryStatus.HOLD) {
                return { success: false, error: "Hold entry not valid or already released" };
            }

            // Variable to hold the updated user entry (either form)
            let userEntryResult: any = null;
            let platformEntryResult: any = null;
            let userNewBalance: Decimal = currentHold.balanceAfter; // Default if not settling

            if (settle) {
                // 1. Convert Hold to Debit for User
                userNewBalance = currentHold.balanceAfter.minus(currentHold.holdAmount);
                const updatedUserEntry = await tx.ledgerEntry.update({
                    where: { id: currentHold.id },
                    data: {
                        debit: currentHold.holdAmount,
                        holdAmount: new Decimal(0),
                        balanceAfter: userNewBalance,
                        status: EntryStatus.SETTLED,
                        description: description ?? currentHold.description,
                        updatedAt: new Date(),
                        tradeGroupId: tradeGroupId ?? currentHold.tradeGroupId
                    }
                });

                // 2. Create Platform Credit (if requested)
                if (createPlatformEntry) {
                    // Platform Credit = HoldAmount - FeeAmount
                    const effectivePlatformCredit = currentHold.holdAmount.minus(feeAmount);

                    const platformRef = `platform:${currentHold.reference}`;
                    const platformLast = await tx.ledgerEntry.findFirst({
                        where: { userId: LedgerService.PLATFORM_USER_ID, currency: currentHold.currency },
                        orderBy: { createdAt: "desc" },
                        select: { balanceAfter: true }
                    });
                    const platformCurrent = platformLast?.balanceAfter ?? new Decimal(0);
                    const platformNewBalance = platformCurrent.plus(effectivePlatformCredit);

                    const platformEntry = await tx.ledgerEntry.create({
                        data: {
                            userId: LedgerService.PLATFORM_USER_ID,
                            currency: currentHold.currency,
                            type: currentHold.type,
                            debit: new Decimal(0),
                            credit: effectivePlatformCredit,
                            balanceAfter: platformNewBalance,
                            status: EntryStatus.SETTLED,
                            sweepStatus: SweepStatus.NOT_APPLICABLE,
                            holdAmount: new Decimal(0),
                            reference: platformRef,
                            tradeGroupId: tradeGroupId ?? currentHold.tradeGroupId,
                            counterpartyUserId: currentHold.userId,
                            description: `Platform credit (User settled): ${description || currentHold.type}`,
                        }
                    });
                    platformEntryResult = { id: platformEntry.id, balanceAfter: platformNewBalance, reference: platformRef };

                    if (feeAmount.greaterThan(0)) {
                        const feeRef = `fee:${currentHold.reference}`;
                        const feeLast = await tx.ledgerEntry.findFirst({
                            where: { userId: LedgerService.NETWORK_FEE_USER_ID, currency: currentHold.currency },
                            orderBy: { createdAt: "desc" },
                            select: { balanceAfter: true }
                        });
                        const feeCurrent = feeLast?.balanceAfter ?? new Decimal(0);
                        const feeNew = feeCurrent.plus(feeAmount);

                        await tx.ledgerEntry.create({
                            data: {
                                userId: LedgerService.NETWORK_FEE_USER_ID,
                                currency: currentHold.currency,
                                type: LedgerType.FEE,
                                debit: new Decimal(0),
                                credit: feeAmount,
                                balanceAfter: feeNew,
                                status: EntryStatus.SETTLED,
                                sweepStatus: SweepStatus.NOT_APPLICABLE,
                                holdAmount: new Decimal(0),
                                reference: feeRef,
                                tradeGroupId: tradeGroupId ?? currentHold.tradeGroupId,
                                counterpartyUserId: currentHold.userId,
                                description: `Network fee for ${description || currentHold.type}`,
                            }
                        });
                    }
                }

                // --- Audit Logs (Settle) ---
                const audits = [
                    this.logAudit(updatedUserEntry.id, AuditAction.SETTLED, 'system', description)
                ];
                if (platformEntryResult) {
                    audits.push(this.logAudit(platformEntryResult.id, AuditAction.CREATED, 'system', description, { relatedTo: updatedUserEntry.id }));
                }
                Promise.all(audits).catch(e => this.logger.error(`Failed to audit hold settlement ${updatedUserEntry.id}: ${e.message}`));
                // ---------------------------

                userEntryResult = { id: updatedUserEntry.id, balanceAfter: userNewBalance, reference: updatedUserEntry.reference };

            } else {
                // REFUND (Release without Settle)
                const updatedEntry = await tx.ledgerEntry.update({
                    where: { id: currentHold.id },
                    data: {
                        holdAmount: new Decimal(0),
                        status: EntryStatus.CANCELLED,
                        description: description ?? currentHold.description,
                        updatedAt: new Date()
                    }
                });

                // --- Audit Logs (Refund) ---
                this.logAudit(
                    updatedEntry.id,
                    AuditAction.HOLD_RELEASED,
                    'system',
                    description
                ).catch(e => this.logger.error(`Failed to audit hold release ${updatedEntry.id}: ${e.message}`));
                // ---------------------------

                userEntryResult = {
                    id: updatedEntry.id,
                    balanceAfter: currentHold.balanceAfter,
                    reference: updatedEntry.reference
                };
            }

            return {
                success: true,
                userEntry: userEntryResult,
                platformEntry: platformEntryResult,
                userBalanceAfter: settle ? userNewBalance : currentHold.balanceAfter
            };

        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 });
    }
}
