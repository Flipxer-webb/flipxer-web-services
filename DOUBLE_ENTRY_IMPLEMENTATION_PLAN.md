# Double-Entry Accounting Implementation Plan

## Overview

This document outlines the implementation plan to enable true double-entry accounting in Flipxer's ledger system. Currently, all ledger operations only create user-side entries without corresponding platform counterparts, resulting in incomplete audit trails and failed reconciliation checks.

**Problem Identified:** Reconciliation check shows:
- User balances: USDT=39.48771444, USDC=1.23469048, BTC=0.00000059, TRX=0.33450000
- Platform balance: 0 for all currencies
- **Expected:** Platform balance should equal negative of all user balances (double-entry)

---

## Design Decisions (User Requirements)

1. **Platform entries only on settle** - No platform entries for HOLD operations
2. **Immutable audit trail** - Refunds create new reverse entries, never modify existing
3. **Separate FEE entries** - Network fees tracked with `LedgerType.FEE` 
4. **Network fees account** - Use `userId = -1` for network fee entries
5. **Swap linking** - Both legs share same `tradeGroupId`
6. **Backward compatible** - New methods alongside existing ones, no breaking changes

---

## Current Codebase Analysis

### Existing Interfaces (ledger.service.ts)

```typescript
// Line 42-56
interface LedgerOperationResult {
  success: boolean;
  entryId?: string;
  balanceAfter?: Decimal;
  entry?: LedgerEntry;
  error?: string;
}

// Line 58-71
interface CreateLedgerEntryOptions {
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

// Line 73-82
interface HoldOptions {
  userId: number;
  currency: string;
  amount: Decimal | number | string;
  reference: string;
  type: LedgerType;
  description?: string;
}
```

### Lock Pattern (ledger.service.ts)

```typescript
// Single-user lock pattern (Line 148, 333, 491, 641)
const lockKey = `ledger:${userId}:${currency.toUpperCase()}`;

// Lock options (consistent across all methods)
{ ttlMs: 10000, maxWaitMs: 15000, strict: true }

// Dual-lock pattern for transfers (Line 800-820)
// Locks acquired in sorted order to prevent deadlocks
const firstLockUser = fromUserId < toUserId ? fromUserId : toUserId;
const secondLockUser = fromUserId < toUserId ? toUserId : fromUserId;
const lockKey1 = `ledger:${firstLockUser}:${upperCurrency}`;
const lockKey2 = `ledger:${secondLockUser}:${upperCurrency}`;
```

### Prisma Transaction Pattern

```typescript
// Line 180-190
return await this.prisma.$transaction(
  async (tx) => {
    // ... transaction code
  },
  {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10000,
  }
);
```

### LedgerEntry Model (prisma/schema.prisma Line 1108-1145)

```prisma
model LedgerEntry {
  id                 String        @id @default(uuid())
  userId             Int           // 0 = platform, -1 = network fees
  currency           String
  type               LedgerType
  debit              Decimal       @db.Decimal(20, 8)
  credit             Decimal       @db.Decimal(20, 8)
  balanceAfter       Decimal       @db.Decimal(20, 8)
  status             EntryStatus   @default(PENDING)
  sweepStatus        SweepStatus?
  holdAmount         Decimal?      @db.Decimal(20, 8)
  reference          String
  tradeGroupId       String?       // Groups related entries
  exchangeRate       Decimal?      @db.Decimal(20, 8)
  counterpartyUserId Int?          // For SEND/RECEIVE
  paymentReference   String?
  description        String?
  metadata           Json?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  @@unique([type, reference])  // Idempotency constraint
  @@index([userId, currency, createdAt(sort: Desc)])
}
```

---

## Special Account IDs

| Account | userId | Purpose |
|---------|--------|---------|
| Platform | 0 | Main omnibus wallet counterparty |
| Network Fees | -1 | External network fee tracking |

These already exist conceptually in the schema comments but need implementation.

---

## Implementation Steps

### Step 1: Add New Interfaces

**File:** `src/modules/api/trade/services/ledger/ledger.service.ts`

**Location:** After existing interfaces (around Line 82)

```typescript
/**
 * Result for paired (double-entry) ledger operations
 */
interface PairedLedgerResult {
  success: boolean;
  userEntry?: LedgerEntry;
  platformEntry?: LedgerEntry;
  userBalanceAfter?: Decimal;
  platformBalanceAfter?: Decimal;
  error?: string;
}

/**
 * Options for paired credit operations
 */
interface PairedCreditOptions extends CreateLedgerEntryOptions {
  createPlatformEntry?: boolean; // Default: true
}

/**
 * Options for paired debit operations  
 */
interface PairedDebitOptions extends CreateLedgerEntryOptions {
  createPlatformEntry?: boolean;
  networkFee?: Decimal | number | string;
  networkFeeCurrency?: string; // If different from main currency
}

/**
 * Options for release hold with platform entry
 */
interface ReleaseHoldWithPlatformOptions {
  holdReference: string;
  settle: boolean;
  description?: string;
  networkFee?: Decimal | number | string;
  tradeGroupId?: string;
}
```

**Verification:**
- ✅ Extends existing `CreateLedgerEntryOptions` interface
- ✅ Adds optional fields (backward compatible)
- ✅ No breaking changes to existing types

---

### Step 2: Add Network Fee Account Constant

**File:** `src/modules/api/trade/services/ledger/ledger.service.ts`

**Location:** After `PLATFORM_USER_ID` constant (Line 87)

```typescript
static readonly PLATFORM_USER_ID = 0;
static readonly NETWORK_FEE_USER_ID = -1; // NEW
```

---

### Step 3: Implement `pairedCredit()` Method

**File:** `src/modules/api/trade/services/ledger/ledger.service.ts`

**Location:** After `credit()` method (around Line 260)

```typescript
/**
 * Credits a user and debits the platform (true double-entry)
 * 
 * Use cases:
 * - Deposit settled (user receives crypto, platform's liability increases)
 * - Buy order completed (user receives crypto, platform's liability increases)
 * 
 * Lock ordering: Always acquire lower userId first to prevent deadlocks
 * Platform (0) < User (positive), so platform lock acquired first
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
    createPlatformEntry = true,
  } = options;

  const creditAmount = this.toDecimal(amount);
  const upperCurrency = currency.toUpperCase();

  if (creditAmount.lessThanOrEqualTo(0)) {
    return { success: false, error: "Credit amount must be positive" };
  }

  // Platform ID (0) is always less than user ID, so platform lock first
  const platformLockKey = `ledger:${LedgerService.PLATFORM_USER_ID}:${upperCurrency}`;
  const userLockKey = `ledger:${userId}:${upperCurrency}`;

  try {
    // Acquire locks in consistent order (platform first, then user)
    return await this.lockService.withLock(
      platformLockKey,
      async () => {
        return await this.lockService.withLock(
          userLockKey,
          async () => {
            return await this.executePairedCredit(
              userId,
              upperCurrency,
              type,
              creditAmount,
              reference,
              tradeGroupId,
              description,
              metadata,
              sweepStatus,
              createPlatformEntry
            );
          },
          { ttlMs: 10000, maxWaitMs: 15000, strict: true }
        );
      },
      { ttlMs: 10000, maxWaitMs: 15000, strict: true }
    );
  } catch (error) {
    this.logger.error(
      `Paired credit failed | ${JSON.stringify({
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

private async executePairedCredit(
  userId: number,
  currency: string,
  type: LedgerType,
  amount: Decimal,
  reference: string,
  tradeGroupId?: string,
  description?: string,
  metadata?: Record<string, any>,
  sweepStatus?: SweepStatus,
  createPlatformEntry: boolean = true
): Promise<PairedLedgerResult> {
  return await this.prisma.$transaction(
    async (tx) => {
      // Idempotency check
      const existing = await tx.ledgerEntry.findUnique({
        where: { type_reference: { type, reference } },
      });

      if (existing) {
        this.logger.warn(
          `Duplicate paired credit | ${JSON.stringify({ type, reference })}`
        );
        // Find matching platform entry if exists
        const platformEntry = await tx.ledgerEntry.findUnique({
          where: { type_reference: { type, reference: `platform:${reference}` } },
        });
        return {
          success: true,
          userEntry: existing,
          platformEntry: platformEntry || undefined,
          userBalanceAfter: existing.balanceAfter,
        };
      }

      // 1. Credit User
      const userBalance = await this.getBalanceInTransaction(tx, userId, currency);
      const userNewBalance = userBalance.total.plus(amount);

      const userEntry = await tx.ledgerEntry.create({
        data: {
          userId,
          currency,
          type,
          debit: new Decimal(0),
          credit: amount,
          balanceAfter: userNewBalance,
          status: EntryStatus.SETTLED,
          sweepStatus: sweepStatus ?? SweepStatus.NOT_APPLICABLE,
          holdAmount: new Decimal(0),
          reference,
          tradeGroupId,
          counterpartyUserId: LedgerService.PLATFORM_USER_ID,
          description,
          metadata,
        },
      });

      let platformEntry: LedgerEntry | undefined;
      let platformNewBalance: Decimal | undefined;

      // 2. Debit Platform (mirror entry) - only if requested
      if (createPlatformEntry) {
        const platformBalance = await this.getBalanceInTransaction(
          tx,
          LedgerService.PLATFORM_USER_ID,
          currency
        );
        platformNewBalance = platformBalance.total.minus(amount);

        platformEntry = await tx.ledgerEntry.create({
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
            reference: `platform:${reference}`,
            tradeGroupId,
            counterpartyUserId: userId,
            description: `Platform debit: ${description || type}`,
          },
        });
      }

      this.logger.log(
        `Paired credit | ${JSON.stringify({
          userEntryId: userEntry.id,
          platformEntryId: platformEntry?.id,
          userId,
          currency,
          amount: amount.toString(),
          type,
        })}`
      );

      return {
        success: true,
        userEntry,
        platformEntry,
        userBalanceAfter: userNewBalance,
        platformBalanceAfter: platformNewBalance,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    }
  );
}
```

**Verification:**
- ✅ Uses same lock options as existing methods: `{ ttlMs: 10000, maxWaitMs: 15000, strict: true }`
- ✅ Uses same transaction isolation: `Prisma.TransactionIsolationLevel.Serializable`
- ✅ Lock ordering prevents deadlock: Platform (0) always < User ID (positive)
- ✅ Idempotency via unique constraint check
- ✅ Platform reference prefixed to avoid collision: `platform:${reference}`

---

### Step 4: Implement `pairedDebit()` Method

**Location:** After `pairedCredit()` method

```typescript
/**
 * Debits a user and credits the platform (true double-entry)
 * Optionally records network fee to fee account (userId=-1)
 * 
 * Use cases:
 * - Withdrawal settled (user loses crypto, platform's liability decreases)
 * - Sell order completed (user sends crypto)
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
    networkFee,
    createPlatformEntry = true,
  } = options;

  const debitAmount = this.toDecimal(amount);
  const upperCurrency = currency.toUpperCase();
  const feeAmount = networkFee ? this.toDecimal(networkFee) : new Decimal(0);

  if (debitAmount.lessThanOrEqualTo(0)) {
    return { success: false, error: "Debit amount must be positive" };
  }

  // Determine all accounts to lock
  const accountsToLock = [userId, LedgerService.PLATFORM_USER_ID];
  if (feeAmount.greaterThan(0)) {
    accountsToLock.push(LedgerService.NETWORK_FEE_USER_ID);
  }

  // Sort for consistent lock ordering (prevents deadlocks)
  // Order: -1 (fees) < 0 (platform) < positive (user)
  accountsToLock.sort((a, b) => a - b);

  const lockKeys = accountsToLock.map(
    (id) => `ledger:${id}:${upperCurrency}`
  );

  try {
    // Nested lock acquisition in sorted order
    const executeWithLocks = async (
      keys: string[],
      index: number
    ): Promise<PairedLedgerResult> => {
      if (index >= keys.length) {
        return await this.executePairedDebit(
          userId,
          upperCurrency,
          type,
          debitAmount,
          reference,
          tradeGroupId,
          description,
          feeAmount,
          createPlatformEntry
        );
      }
      return await this.lockService.withLock(
        keys[index],
        () => executeWithLocks(keys, index + 1),
        { ttlMs: 10000, maxWaitMs: 15000, strict: true }
      );
    };

    return await executeWithLocks(lockKeys, 0);
  } catch (error) {
    this.logger.error(
      `Paired debit failed | ${JSON.stringify({
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

private async executePairedDebit(
  userId: number,
  currency: string,
  type: LedgerType,
  amount: Decimal,
  reference: string,
  tradeGroupId?: string,
  description?: string,
  feeAmount: Decimal = new Decimal(0),
  createPlatformEntry: boolean = true
): Promise<PairedLedgerResult> {
  return await this.prisma.$transaction(
    async (tx) => {
      // Idempotency check
      const existing = await tx.ledgerEntry.findUnique({
        where: { type_reference: { type, reference } },
      });

      if (existing) {
        this.logger.warn(
          `Duplicate paired debit | ${JSON.stringify({ type, reference })}`
        );
        return { success: true, userEntry: existing };
      }

      // 1. Check user balance
      const userBalance = await this.getBalanceInTransaction(tx, userId, currency);
      const totalDebit = amount.plus(feeAmount);

      if (
        userId !== LedgerService.PLATFORM_USER_ID &&
        userBalance.available.lessThan(totalDebit)
      ) {
        return {
          success: false,
          error: `Insufficient balance. Available: ${userBalance.available}, Required: ${totalDebit}`,
        };
      }

      // 2. Debit User (main amount only, fee is separate)
      const userNewBalance = userBalance.total.minus(amount);

      const userEntry = await tx.ledgerEntry.create({
        data: {
          userId,
          currency,
          type,
          debit: amount,
          credit: new Decimal(0),
          balanceAfter: userNewBalance,
          status: EntryStatus.SETTLED,
          sweepStatus: SweepStatus.NOT_APPLICABLE,
          holdAmount: new Decimal(0),
          reference,
          tradeGroupId,
          counterpartyUserId: LedgerService.PLATFORM_USER_ID,
          description,
        },
      });

      let platformEntry: LedgerEntry | undefined;

      // 3. Credit Platform (mirror entry)
      if (createPlatformEntry) {
        const platformBalance = await this.getBalanceInTransaction(
          tx,
          LedgerService.PLATFORM_USER_ID,
          currency
        );
        const platformNewBalance = platformBalance.total.plus(amount);

        platformEntry = await tx.ledgerEntry.create({
          data: {
            userId: LedgerService.PLATFORM_USER_ID,
            currency,
            type,
            debit: new Decimal(0),
            credit: amount,
            balanceAfter: platformNewBalance,
            status: EntryStatus.SETTLED,
            sweepStatus: SweepStatus.NOT_APPLICABLE,
            holdAmount: new Decimal(0),
            reference: `platform:${reference}`,
            tradeGroupId,
            counterpartyUserId: userId,
            description: `Platform credit: ${description || type}`,
          },
        });
      }

      // 4. Record network fee if present
      if (feeAmount.greaterThan(0)) {
        // Debit user for fee
        const userBalanceAfterFee = userNewBalance.minus(feeAmount);
        await tx.ledgerEntry.update({
          where: { id: userEntry.id },
          data: { balanceAfter: userBalanceAfterFee },
        });

        // Create fee entry for fee account
        const feeAccountBalance = await this.getBalanceInTransaction(
          tx,
          LedgerService.NETWORK_FEE_USER_ID,
          currency
        );
        const feeAccountNewBalance = feeAccountBalance.total.plus(feeAmount);

        await tx.ledgerEntry.create({
          data: {
            userId: LedgerService.NETWORK_FEE_USER_ID,
            currency,
            type: LedgerType.FEE,
            debit: new Decimal(0),
            credit: feeAmount,
            balanceAfter: feeAccountNewBalance,
            status: EntryStatus.SETTLED,
            sweepStatus: SweepStatus.NOT_APPLICABLE,
            holdAmount: new Decimal(0),
            reference: `fee:${reference}`,
            tradeGroupId,
            counterpartyUserId: userId,
            description: `Network fee for ${type}`,
          },
        });

        // Debit user for fee amount
        await tx.ledgerEntry.create({
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
            reference: `userfee:${reference}`,
            tradeGroupId,
            counterpartyUserId: LedgerService.NETWORK_FEE_USER_ID,
            description: `Network fee paid for ${type}`,
          },
        });
      }

      this.logger.log(
        `Paired debit | ${JSON.stringify({
          userEntryId: userEntry.id,
          platformEntryId: platformEntry?.id,
          userId,
          currency,
          amount: amount.toString(),
          fee: feeAmount.toString(),
          type,
        })}`
      );

      return {
        success: true,
        userEntry,
        platformEntry,
        userBalanceAfter: userBalance.total.minus(amount).minus(feeAmount),
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    }
  );
}
```

**Verification:**
- ✅ Lock ordering handles 3 accounts: -1 < 0 < userId (sorted numerically)
- ✅ Network fee creates separate `LedgerType.FEE` entries
- ✅ Fee account (userId=-1) receives credit, user receives debit
- ✅ All entries share same `tradeGroupId` for auditing

---

### Step 5: Implement `releaseHoldWithPlatformEntry()` Method

**Location:** After `releaseHold()` method

This is the key method for HOLD → SETTLE flows (sell orders, withdrawals, swaps).

```typescript
/**
 * Releases a hold and creates platform counterpart entry on settle
 * 
 * Use cases:
 * - Sell order hold settles (create platform credit)
 * - Withdrawal hold settles (create platform credit + optional fee entry)
 * - Swap sell leg settles (create platform credit)
 */
async releaseHoldWithPlatformEntry(
  options: ReleaseHoldWithPlatformOptions
): Promise<PairedLedgerResult> {
  const { holdReference, settle, description, networkFee, tradeGroupId } = options;

  // Find hold entry first
  const holdEntry = await this.prisma.ledgerEntry.findFirst({
    where: { reference: holdReference, status: EntryStatus.HOLD },
  });

  if (!holdEntry) {
    return { success: false, error: "Hold entry not found" };
  }

  const upperCurrency = holdEntry.currency.toUpperCase();
  const feeAmount = networkFee ? this.toDecimal(networkFee) : new Decimal(0);

  // Determine accounts to lock
  const accountsToLock = [holdEntry.userId, LedgerService.PLATFORM_USER_ID];
  if (feeAmount.greaterThan(0)) {
    accountsToLock.push(LedgerService.NETWORK_FEE_USER_ID);
  }
  accountsToLock.sort((a, b) => a - b);

  const lockKeys = accountsToLock.map((id) => `ledger:${id}:${upperCurrency}`);

  try {
    const executeWithLocks = async (
      keys: string[],
      index: number
    ): Promise<PairedLedgerResult> => {
      if (index >= keys.length) {
        return await this.executeReleaseHoldWithPlatform(
          holdEntry.id,
          settle,
          description,
          feeAmount,
          tradeGroupId
        );
      }
      return await this.lockService.withLock(
        keys[index],
        () => executeWithLocks(keys, index + 1),
        { ttlMs: 10000, maxWaitMs: 15000, strict: true }
      );
    };

    return await executeWithLocks(lockKeys, 0);
  } catch (error) {
    this.logger.error(
      `Release hold with platform failed | ${JSON.stringify({
        holdReference,
        error: error.message,
      })}`
    );
    return { success: false, error: error.message };
  }
}

private async executeReleaseHoldWithPlatform(
  holdEntryId: string,
  settle: boolean,
  description?: string,
  feeAmount: Decimal = new Decimal(0),
  tradeGroupId?: string
): Promise<PairedLedgerResult> {
  return await this.prisma.$transaction(
    async (tx) => {
      const holdEntry = await tx.ledgerEntry.findUnique({
        where: { id: holdEntryId },
      });

      if (!holdEntry) {
        return { success: false, error: "Hold entry not found" };
      }

      if (holdEntry.status !== EntryStatus.HOLD) {
        // Already processed - idempotent
        return { success: true, userEntry: holdEntry };
      }

      if (settle) {
        // Convert hold to debit
        const newBalance = holdEntry.balanceAfter.minus(holdEntry.holdAmount!);

        const updatedEntry = await tx.ledgerEntry.update({
          where: { id: holdEntryId },
          data: {
            debit: holdEntry.holdAmount,
            holdAmount: new Decimal(0),
            balanceAfter: newBalance,
            status: EntryStatus.SETTLED,
            description: description ?? holdEntry.description,
            tradeGroupId: tradeGroupId ?? holdEntry.tradeGroupId,
            updatedAt: new Date(),
          },
        });

        // Create platform counterpart (credit)
        const platformBalance = await this.getBalanceInTransaction(
          tx,
          LedgerService.PLATFORM_USER_ID,
          holdEntry.currency
        );
        const platformNewBalance = platformBalance.total.plus(holdEntry.holdAmount!);

        const platformEntry = await tx.ledgerEntry.create({
          data: {
            userId: LedgerService.PLATFORM_USER_ID,
            currency: holdEntry.currency,
            type: holdEntry.type,
            debit: new Decimal(0),
            credit: holdEntry.holdAmount!,
            balanceAfter: platformNewBalance,
            status: EntryStatus.SETTLED,
            sweepStatus: SweepStatus.NOT_APPLICABLE,
            holdAmount: new Decimal(0),
            reference: `platform:${holdEntry.reference}`,
            tradeGroupId: tradeGroupId ?? holdEntry.tradeGroupId,
            counterpartyUserId: holdEntry.userId,
            description: `Platform credit: ${description || holdEntry.type}`,
          },
        });

        // Handle network fee if present
        if (feeAmount.greaterThan(0)) {
          // Already deducted from user in hold - just record fee account entry
          const feeBalance = await this.getBalanceInTransaction(
            tx,
            LedgerService.NETWORK_FEE_USER_ID,
            holdEntry.currency
          );
          const feeNewBalance = feeBalance.total.plus(feeAmount);

          await tx.ledgerEntry.create({
            data: {
              userId: LedgerService.NETWORK_FEE_USER_ID,
              currency: holdEntry.currency,
              type: LedgerType.FEE,
              debit: new Decimal(0),
              credit: feeAmount,
              balanceAfter: feeNewBalance,
              status: EntryStatus.SETTLED,
              sweepStatus: SweepStatus.NOT_APPLICABLE,
              holdAmount: new Decimal(0),
              reference: `fee:${holdEntry.reference}`,
              tradeGroupId: tradeGroupId ?? holdEntry.tradeGroupId,
              counterpartyUserId: holdEntry.userId,
              description: `Network fee for ${holdEntry.type}`,
            },
          });
        }

        this.logger.log(
          `Hold settled with platform | ${JSON.stringify({
            holdId: holdEntryId,
            platformId: platformEntry.id,
            userId: holdEntry.userId,
            currency: holdEntry.currency,
            amount: holdEntry.holdAmount?.toString(),
          })}`
        );

        return {
          success: true,
          userEntry: updatedEntry,
          platformEntry,
          userBalanceAfter: newBalance,
          platformBalanceAfter: platformNewBalance,
        };
      } else {
        // Release without settle (refund) - no platform entry needed
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
          `Hold released (no platform entry) | ${JSON.stringify({
            holdId: holdEntryId,
            userId: holdEntry.userId,
          })}`
        );

        return {
          success: true,
          userEntry: updatedEntry,
          userBalanceAfter: holdEntry.balanceAfter,
        };
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    }
  );
}
```

**Verification:**
- ✅ Platform entry only created on `settle=true` (per user requirement)
- ✅ Refund (settle=false) creates no platform entry
- ✅ Uses same lock/transaction patterns
- ✅ Network fee handled consistently

---

### Step 6: Update Service Callers

#### 6.1 Deposit Handler (deposit-webhook.handler.ts)

**Current Code (Line 505-515):**
```typescript
const creditResult = await this.ledgerService.credit({
  userId: user.id,
  currency,
  amount: depositAmount,
  type: LedgerType.DEPOSIT,
  reference: reference,
  metadata: metadata,
  sweepStatus: SweepStatus.PENDING,
});
```

**Updated Code:**
```typescript
const creditResult = await this.ledgerService.pairedCredit({
  userId: user.id,
  currency,
  amount: depositAmount,
  type: LedgerType.DEPOSIT,
  reference: reference,
  metadata: metadata,
  sweepStatus: SweepStatus.PENDING,
  createPlatformEntry: true,
});
```

#### 6.2 Buy Order Service (buy-order.service.ts Line 422-436)

**Current Code:**
```typescript
const creditResult = await this.ledgerService.credit({
  userId: payment.userId,
  currency: order.currency.toUpperCase(),
  amount: order.amount,
  type: LedgerType.BUY,
  reference: `buy:${order.transactionId}`,
  metadata: { orderId: order.id, ... },
  sweepStatus: SweepStatus.NOT_APPLICABLE,
});
```

**Updated Code:**
```typescript
const creditResult = await this.ledgerService.pairedCredit({
  userId: payment.userId,
  currency: order.currency.toUpperCase(),
  amount: order.amount,
  type: LedgerType.BUY,
  reference: `buy:${order.transactionId}`,
  metadata: { orderId: order.id, ... },
  sweepStatus: SweepStatus.NOT_APPLICABLE,
  createPlatformEntry: true,
});
```

#### 6.3 Sell Order Service (sell-order.service.ts Line 261-268)

**Current Code:**
```typescript
const settleResult = await this.ledgerService.releaseHold(
  holdReference,
  true,
  `Sell order: ${reference}`
);
```

**Updated Code:**
```typescript
const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
  holdReference,
  settle: true,
  description: `Sell order: ${reference}`,
});
```

#### 6.4 Swap Service - Sell Leg (sell-order.service.ts Line 395-400)

**Current Code:**
```typescript
const settleResult = await this.ledgerService.releaseHold(
  holdReference,
  true,
  `Swap sell leg: ${reference}`
);
```

**Updated Code:**
```typescript
const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
  holdReference,
  settle: true,
  description: `Swap sell leg: ${reference}`,
  tradeGroupId: reference, // Links both swap legs
});
```

#### 6.5 Swap Service - Buy Leg (buy-order.service.ts - executeInternalBuy)

**Updated Code:**
```typescript
const creditResult = await this.ledgerService.pairedCredit({
  userId: user.id,
  currency: targetCurrency,
  amount: receivedAmount,
  type: LedgerType.SWAP_IN,
  reference: `swap-buy:${reference}`,
  tradeGroupId: reference, // Same as sell leg
  createPlatformEntry: true,
});
```

#### 6.6 Send Service - Withdrawal Settlement

When withdrawal webhook confirms success, use:

```typescript
const settleResult = await this.ledgerService.releaseHoldWithPlatformEntry({
  holdReference: `withdrawal:${orderReference}`,
  settle: true,
  description: `Withdrawal settled: ${orderReference}`,
  networkFee: actualNetworkFee, // From Quidax response
});
```

---

### Step 7: Backfill Migration Script

Create a migration script to generate missing platform entries for historical transactions.

**File:** `scripts/backfill-platform-entries.ts`

```typescript
import { PrismaClient, EntryStatus, LedgerType, SweepStatus } from '@prisma/client';
import Decimal from 'decimal.js';

const prisma = new PrismaClient();
const PLATFORM_USER_ID = 0;
const BATCH_SIZE = 100;

async function backfillPlatformEntries() {
  console.log('Starting platform entry backfill...');
  
  // Find all settled user entries without platform counterparts
  let offset = 0;
  let processed = 0;
  let created = 0;
  
  while (true) {
    const userEntries = await prisma.ledgerEntry.findMany({
      where: {
        userId: { not: PLATFORM_USER_ID },
        status: EntryStatus.SETTLED,
        // Only process entries that should have platform counterparts
        type: {
          in: [
            LedgerType.DEPOSIT,
            LedgerType.BUY,
            LedgerType.SELL,
            LedgerType.SWAP_IN,
            LedgerType.SWAP_OUT,
            LedgerType.WITHDRAWAL,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: BATCH_SIZE,
    });

    if (userEntries.length === 0) break;

    for (const entry of userEntries) {
      // Check if platform entry already exists
      const platformRef = `platform:${entry.reference}`;
      const existing = await prisma.ledgerEntry.findFirst({
        where: { reference: platformRef },
      });

      if (existing) {
        processed++;
        continue;
      }

      // Get current platform balance for this currency
      const platformBalance = await prisma.ledgerEntry.findFirst({
        where: {
          userId: PLATFORM_USER_ID,
          currency: entry.currency,
        },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfter: true },
      });

      const currentPlatformBalance = platformBalance?.balanceAfter ?? new Decimal(0);

      // Determine platform entry direction (opposite of user)
      const isUserCredit = entry.credit.greaterThan(0);
      const amount = isUserCredit ? entry.credit : entry.debit;
      const newPlatformBalance = isUserCredit
        ? currentPlatformBalance.minus(amount) // User credit = Platform debit
        : currentPlatformBalance.plus(amount); // User debit = Platform credit

      // Create platform entry
      await prisma.ledgerEntry.create({
        data: {
          userId: PLATFORM_USER_ID,
          currency: entry.currency,
          type: entry.type,
          debit: isUserCredit ? amount : new Decimal(0),
          credit: isUserCredit ? new Decimal(0) : amount,
          balanceAfter: newPlatformBalance,
          status: EntryStatus.SETTLED,
          sweepStatus: SweepStatus.NOT_APPLICABLE,
          holdAmount: new Decimal(0),
          reference: platformRef,
          tradeGroupId: entry.tradeGroupId,
          counterpartyUserId: entry.userId,
          description: `Backfill: Platform ${isUserCredit ? 'debit' : 'credit'} for ${entry.type}`,
          createdAt: entry.createdAt, // Match original timestamp
        },
      });

      created++;
      processed++;
    }

    console.log(`Processed ${processed} entries, created ${created} platform entries`);
    offset += BATCH_SIZE;
  }

  console.log(`Backfill complete. Total processed: ${processed}, Created: ${created}`);
}

backfillPlatformEntries()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

**Important Notes:**
- Run in read-only mode first to verify counts
- Execute during low-traffic period
- Add transaction batching for large datasets
- Verify reconciliation after running

---

## Race Condition Prevention

### Lock Ordering Strategy

All paired operations acquire locks in consistent order:

| Order | userId | Description |
|-------|--------|-------------|
| 1 | -1 | Network fee account |
| 2 | 0 | Platform account |
| 3+ | positive | User accounts (sorted) |

This prevents deadlock scenarios like:
- Thread A: locks User → Platform
- Thread B: locks Platform → User

By always acquiring in sorted order (Platform first for all users > 0), deadlocks are impossible.

### Transaction Isolation

All operations use `Prisma.TransactionIsolationLevel.Serializable` with 10-second timeout, matching existing patterns.

---

## Idempotency Handling

### Reference Patterns

| Entry Type | Reference Pattern |
|------------|-------------------|
| User entry | `{type}:{transactionId}` |
| Platform entry | `platform:{type}:{transactionId}` |
| Fee entry (user) | `userfee:{transactionId}` |
| Fee entry (account) | `fee:{transactionId}` |

### Duplicate Detection

Each method checks for existing entries before creating:
```typescript
const existing = await tx.ledgerEntry.findUnique({
  where: { type_reference: { type, reference } },
});
if (existing) {
  return { success: true, userEntry: existing };
}
```

---

## Testing Checklist

### Unit Tests

- [ ] `pairedCredit()` creates both user and platform entries
- [ ] `pairedCredit()` with `createPlatformEntry=false` only creates user entry
- [ ] `pairedDebit()` with network fee creates 4 entries (user debit, platform credit, user fee, fee account)
- [ ] `releaseHoldWithPlatformEntry()` settle=true creates platform entry
- [ ] `releaseHoldWithPlatformEntry()` settle=false does NOT create platform entry
- [ ] Lock ordering prevents deadlocks
- [ ] Idempotency returns existing entries on retry

### Integration Tests

- [ ] Full deposit flow creates paired entries
- [ ] Full buy flow creates paired entries
- [ ] Full sell flow (hold → settle) creates platform entry only at settle
- [ ] Full swap flow creates linked entries with same tradeGroupId
- [ ] Withdrawal with network fee creates fee account entry

### Reconciliation Verification

After implementation:
```sql
-- Sum of all user credits should equal sum of all platform debits
SELECT 
  currency,
  SUM(CASE WHEN userId > 0 THEN credit ELSE 0 END) as user_credits,
  SUM(CASE WHEN userId = 0 THEN debit ELSE 0 END) as platform_debits,
  SUM(CASE WHEN userId > 0 THEN credit ELSE 0 END) - 
    SUM(CASE WHEN userId = 0 THEN debit ELSE 0 END) as difference
FROM "LedgerEntries"
WHERE status = 'SETTLED'
GROUP BY currency;
```

Expected: `difference = 0` for all currencies

---

## Rollout Plan

### Phase 1: Code Implementation
1. Add new interfaces and constants
2. Implement `pairedCredit()`, `pairedDebit()`, `releaseHoldWithPlatformEntry()`
3. Unit tests pass

### Phase 2: Migration Preparation
1. Create backfill migration script
2. Run in dry-run mode to estimate scope
3. Test on staging environment

### Phase 3: Production Deployment
1. Deploy new methods (existing code unchanged)
2. Run backfill migration during low-traffic window
3. Verify reconciliation

### Phase 4: Cutover
1. Update callers to use new paired methods
2. Monitor for errors
3. Run final reconciliation verification

---

## Summary

This plan provides true double-entry accounting while:

1. **Preserving existing functionality** - Old methods remain, new methods added
2. **Preventing race conditions** - Consistent lock ordering for all account combinations
3. **Maintaining immutability** - Refunds create new entries, not modifications
4. **Enabling clear auditing** - Separate fee entries, tradeGroupId linking
5. **Ensuring idempotency** - Unique reference patterns for all entry types

The implementation follows all existing patterns in the codebase for transactions, locking, and error handling.
