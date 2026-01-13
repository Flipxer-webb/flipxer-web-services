# Virtual Balance/Ledger System Implementation Plan

> **Created**: January 12, 2026  
> **Status**: ✅ Complete  
> **Last Updated**: January 13, 2026

## Overview

Replace per-user Quidax sub-accounts with omnibus main wallet backed by double-entry ledger. Users see virtual balances; platform holds all crypto centrally.

---

## ⚠️ Critical Rules

- **NEVER use `prisma db push`** — Always use `prisma migrate dev` (local) and `prisma migrate deploy` (production)
- **User balance can NEVER go negative**
- **Platform account (userId=0) CAN go negative** (inventory tracking)
- **All balance operations require SERIALIZABLE isolation + SELECT FOR UPDATE**

---

## Implementation Phases

### Phase 1: Database Schema
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 1.1 | Create `LedgerEntry` model | ✅ Complete | Core ledger with balanceAfter optimization |
| 1.2 | Create `FloatConfig` model | ✅ Complete | Per-currency thresholds |
| 1.3 | Create `WithdrawalQueue` model | ✅ Complete | Queue with position, reason, queuedAt |
| 1.4 | Create `ReconciliationLog` model | ✅ Complete | Hourly snapshots |
| 1.5 | Create `AdjustmentRequest` model | ✅ Complete | Super-admin approval workflow |
| 1.6 | Create `WebhookLog` model | ✅ Complete | Idempotency tracking |
| 1.7 | Create `MigrationRun` model | ✅ Complete | Resume tracking |
| 1.8 | Create `AdminQueueSeen` model | ✅ Complete | Badge tracking per admin |
| 1.9 | Create enums | ✅ Complete | LedgerType, EntryStatus, SweepStatus, QueueReason |
| 1.10 | Modify `Order` model | ✅ Complete | Add ledgerEntryId |
| 1.11 | Run migration | ✅ Complete | Migration `20260112172309_virtual_balance_ledger_system` deployed |
| 1.12 | Generate Prisma client | ✅ Complete | All new types available |

### Phase 2: Core Services
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 2.1 | Create `LedgerService` | ✅ Complete | credit(), debit(), hold(), release(), getBalance(), transfer() |
| 2.2 | Create `WithdrawalQueueService` | ✅ Complete | 72h timeout, smallest-first, addToQueue(), processTimeouts() |
| 2.3 | Create `FloatConfigService` | ✅ Complete | Alerting only via Slack, checkAndAlert() |
| 2.4 | Create `ReconciliationService` | ✅ Complete | Hourly reconcile, auto-pause on >0.1% discrepancy |
| 2.5 | Create `SweepService` | ✅ Complete | Async sweep via withdrawal to main wallet address |

### Phase 3: Security Fixes
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 3.1 | Fix Redis lock fallback | ✅ Complete | Added `strict` option, ledger uses `strict: true` |
| 3.2 | Fix payment address mismatch | ✅ Complete | Reject 403 + Slack alert on mismatch |
| 3.3 | Add webhook timestamp validation | ✅ Complete | Reject >5 min old webhooks |
| 3.4 | Add withdrawal rate limits | ✅ Complete | 5/hour/user, 1 pending/currency, RateLimitExceededException |
| 3.5 | Add admin endpoint guards | ✅ Complete | AdminLedgerController with AuthGuard, RoleGuard, ADMIN UserType |

### Phase 4: Modify Trade Services
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 4.1 | Modify deposit flow | ✅ Complete | Credit ledger with sweepStatus=PENDING, link to order |
| 4.2 | Modify withdrawal flow | ✅ Complete | HOLD → check sweep → check liquidity → execute/queue |
| 4.3 | Modify buy service | ✅ Complete | Credit ledger when buy completes, link to order |
| 4.4 | Modify sell service | ✅ Complete | HOLD → settle (debit) ledger when sell initiated |
| 4.5 | Modify swap service | ✅ Complete | SWAP_OUT (debit source), SWAP_IN (credit target) |
| 4.6 | Modify send service | ✅ Complete | Integrated with 4.2 |
| 4.7 | Update balance sync cron | ✅ Complete | Added documentation, still syncs for backwards compatibility |

### Phase 5: Queue & Notifications
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 5.1 | Add queue processing cron | ✅ Complete | WithdrawalQueueCron - every 5 min, 72h timeout, smallest-first |
| 5.2 | Add Slack alerts | ✅ Complete | sendSystemAlert - amount, user, queue position, severity |
| 5.3 | Add WebSocket events | ✅ Complete | notifyWithdrawalQueued, notifyWithdrawalProcessed |
| 5.4 | Add reconciliation auto-halt | ✅ Complete | Auto-pause at 0.1% discrepancy, alerts at 0.01% |

### Phase 6: Frontend Changes
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 6.1 | Map queued to pending | ✅ Complete | Added statusHint field to ITransaction |
| 6.2 | Update Transaction component | ✅ Complete | Display statusHint banner & tooltip |
| 6.3 | Add admin queue tab | ✅ Complete | /admin/withdrawal-queue with Process button |
| 6.4 | Add admin notifications | ✅ Complete | Queue count badge in sidebar |
| 6.5 | Extend thresholds API | ✅ Complete | Added floatPercentage & absoluteReserve |
| 6.6 | Add reconciliation section | ✅ Complete | /admin/reconciliation page |

### Phase 7: Migration
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 7.1 | Create migration script | ✅ Complete | scripts/migrate-to-ledger.ts - atomic per-user, resumable |
| 7.2 | Test migration (staging) | ✅ Complete | Dry-run verified 6 balances |
| 7.3 | Run migration (production) | ✅ Complete | 23 users, 6 ledger entries, 0 errors, 46s duration |

---

## Schema Design

### LedgerEntry
```prisma
model LedgerEntry {
  id                 String       @id @default(uuid())
  userId             Int          // 0 = platform, -1 = network fees
  currency           String
  type               LedgerType
  debit              Decimal      @db.Decimal(20, 8)
  credit             Decimal      @db.Decimal(20, 8)
  balanceAfter       Decimal      @db.Decimal(20, 8)
  status             EntryStatus  @default(PENDING)
  sweepStatus        SweepStatus?
  holdAmount         Decimal?     @db.Decimal(20, 8)
  reference          String
  tradeGroupId       String?
  exchangeRate       Decimal?     @db.Decimal(20, 8)
  counterpartyUserId Int?
  paymentReference   String?
  metadata           Json?
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  user               User?        @relation(fields: [userId], references: [id])
  
  @@unique([type, reference])
  @@index([userId, currency])
  @@index([status])
  @@index([sweepStatus])
  @@index([tradeGroupId])
}
```

### Enums
```prisma
enum LedgerType {
  DEPOSIT
  WITHDRAWAL
  HOLD
  RELEASE
  BUY
  SELL
  SWAP_IN
  SWAP_OUT
  SEND
  RECEIVE
  FEE
  SWEEP
  ADJUSTMENT
}

enum EntryStatus {
  PENDING
  COMPLETED
  FAILED
}

enum SweepStatus {
  PENDING
  COMPLETED
  FAILED
}

enum QueueReason {
  DEPOSIT_SETTLING
  LOW_LIQUIDITY
}
```

### WithdrawalQueue
```prisma
model WithdrawalQueue {
  id           String      @id @default(uuid())
  userId       Int
  currency     String
  amount       Decimal     @db.Decimal(20, 8)
  holdEntryId  String      @unique
  reason       QueueReason
  position     Int
  queuedAt     DateTime    @default(now())
  processedAt  DateTime?
  releasedAt   DateTime?
  
  user         User        @relation(fields: [userId], references: [id])
  holdEntry    LedgerEntry @relation(fields: [holdEntryId], references: [id])
  
  @@index([currency, position])
  @@index([queuedAt])
}
```

### FloatConfig
```prisma
model FloatConfig {
  id              String   @id @default(uuid())
  currency        String   @unique
  floatAllowance  Decimal  @db.Decimal(20, 8)
  alertThreshold  Decimal  @db.Decimal(5, 2)  // percentage (e.g., 80.00)
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

### ReconciliationLog
```prisma
model ReconciliationLog {
  id                String   @id @default(uuid())
  currency          String
  ledgerTotal       Decimal  @db.Decimal(20, 8)
  blockchainTotal   Decimal  @db.Decimal(20, 8)
  discrepancy       Decimal  @db.Decimal(20, 8)
  discrepancyPct    Decimal  @db.Decimal(10, 4)
  isWithinTolerance Boolean
  pausedWithdrawals Boolean  @default(false)
  resolvedAt        DateTime?
  resolvedBy        Int?
  notes             String?
  createdAt         DateTime @default(now())
  
  @@index([currency, createdAt])
}
```

### AdjustmentRequest
```prisma
model AdjustmentRequest {
  id            String           @id @default(uuid())
  userId        Int
  currency      String
  amount        Decimal          @db.Decimal(20, 8)
  type          AdjustmentType   // CREDIT or DEBIT
  reason        String
  status        ApprovalStatus   @default(PENDING)
  requestedBy   Int
  approvedBy    Int?
  rejectedBy    Int?
  approvedAt    DateTime?
  rejectedAt    DateTime?
  ledgerEntryId String?
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt
  
  user          User             @relation("AdjustmentUser", fields: [userId], references: [id])
  requester     User             @relation("AdjustmentRequester", fields: [requestedBy], references: [id])
  approver      User?            @relation("AdjustmentApprover", fields: [approvedBy], references: [id])
  
  @@index([status])
}

enum AdjustmentType {
  CREDIT
  DEBIT
}

enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
}
```

### WebhookLog
```prisma
model WebhookLog {
  id           String   @id @default(uuid())
  provider     String   // quidax, nomba, fincra
  eventType    String
  externalId   String
  payload      Json
  processedAt  DateTime @default(now())
  
  @@unique([provider, eventType, externalId])
  @@index([provider, processedAt])
}
```

### MigrationRun
```prisma
model MigrationRun {
  id            String    @id @default(uuid())
  name          String
  lastUserId    Int       @default(0)
  totalUsers    Int       @default(0)
  processedUsers Int      @default(0)
  status        MigrationStatus @default(RUNNING)
  errorMessage  String?
  startedAt     DateTime  @default(now())
  completedAt   DateTime?
  
  @@index([name, status])
}

enum MigrationStatus {
  RUNNING
  COMPLETED
  FAILED
  PAUSED
}
```

### AdminQueueSeen
```prisma
model AdminQueueSeen {
  id              String   @id @default(uuid())
  adminUserId     Int      @unique
  lastSeenQueueId String?
  lastSeenAt      DateTime @default(now())
  
  admin           User     @relation(fields: [adminUserId], references: [id])
}
```

---

## Decisions Log

| Category | Decision | Date |
|----------|----------|------|
| Database | Never use `db push`; always use `prisma migrate` | Jan 12, 2026 |
| Float | Per-crypto, alerting only, always credit | Jan 12, 2026 |
| Withdrawals | Queue smallest-first, 72h timeout, no user cancel | Jan 12, 2026 |
| Platform account | Can go negative (inventory tracking) | Jan 12, 2026 |
| User balance | Never negative | Jan 12, 2026 |
| NGN | Platform account only (users don't hold NGN) | Jan 12, 2026 |
| Balance storage | Ledger with `balanceAfter` optimization | Jan 12, 2026 |
| HOLD flow | Reduces balance immediately, release reverses | Jan 12, 2026 |
| Sweep | Block withdrawal until sweep confirms | Jan 12, 2026 |
| Migration | Atomic per-user, stop on error, resume | Jan 12, 2026 |
| Adjustments | Super-admin approval only | Jan 12, 2026 |
| Queue visibility | Hidden from users (show as "pending") | Jan 12, 2026 |
| User messaging | Subtle hint: "Your withdrawal is being processed" | Jan 12, 2026 |
| Slack alerts | Full details (amount, user, position, reason) | Jan 12, 2026 |
| Admin alerts | Toast + badge, explicit "Mark as Seen" | Jan 12, 2026 |
| API approach | Extend existing endpoints | Jan 12, 2026 |
| Wallet | Single main wallet (no hot/cold split for now) | Jan 12, 2026 |

---

## Security Checklist

- [ ] SERIALIZABLE isolation on all balance operations
- [ ] SELECT FOR UPDATE locks on ledger reads
- [ ] Redis lock throws exception when unavailable
- [ ] Payment address mismatch rejected (not warned)
- [ ] Webhook timestamp validated (<5 min)
- [ ] Withdrawal rate limits enforced
- [ ] All admin endpoints have guards
- [ ] Reconciliation auto-halts on discrepancy
- [ ] Multi-sig on main wallet (future)

---

## Migration Script Usage

**Location**: `scripts/migrate-to-ledger.ts`

### Commands

```bash
# Dry run - preview what will be migrated (no changes)
npx ts-node scripts/migrate-to-ledger.ts --dry-run

# Full migration
npx ts-node scripts/migrate-to-ledger.ts

# Resume from last checkpoint (if interrupted)
npx ts-node scripts/migrate-to-ledger.ts --resume

# Verify migration integrity
npx ts-node scripts/migrate-to-ledger.ts --verify-only
```

### Migration Process

1. **Preparation**: Creates/resumes `MigrationRun` record for checkpoint tracking
2. **Per-User Processing**: For each user (batches of 100):
   - Fetch all AssetWallet records
   - Create `MIGRATION` type entry for available balance (credit)
   - Create `MIGRATION_HOLD` type entry for locked balance (hold)
   - Uses SERIALIZABLE isolation for atomicity
3. **Progress Tracking**: Updates `lastUserId` after each batch for resume capability
4. **Verification**: Compares total AssetWallet balances against sum of LedgerEntry balances

### Entry Types Created

| LedgerType | Purpose | Status |
|------------|---------|--------|
| `MIGRATION` | Available balance from AssetWallet | `SETTLED` |
| `MIGRATION_HOLD` | Locked balance from AssetWallet | `HOLD` |

### Rollback

If migration fails mid-way:
```sql
-- Delete all migration entries
DELETE FROM "LedgerEntry" WHERE type IN ('MIGRATION', 'MIGRATION_HOLD');

-- Reset migration run
UPDATE "MigrationRun" SET status = 'FAILED' WHERE name = 'ledger_initial_migration_v1';
```

---

## Testing Checklist

- [ ] Race condition test: concurrent withdrawals
- [ ] Race condition test: concurrent deposits
- [ ] Queue timeout test: 72h release
- [ ] Sweep failure test: withdrawal blocked
- [ ] Float alert test: over-threshold deposit
- [ ] Reconciliation test: discrepancy detection
- [x] Migration test: verify totals match (via --verify-only)
- [ ] Rollback test: migration failure recovery

---

## Files to Create

### Services ✅
- `src/modules/api/trade/services/ledger/ledger.service.ts` ✅
- `src/modules/api/trade/services/ledger/ledger.module.ts` ✅
- `src/modules/api/trade/services/withdrawal-queue/withdrawal-queue.service.ts` ✅
- `src/modules/api/trade/services/withdrawal-queue/withdrawal-queue.module.ts` ✅
- `src/modules/api/trade/services/float/float-config.service.ts` ✅
- `src/modules/api/trade/services/float/float-config.module.ts` ✅
- `src/modules/api/trade/services/reconciliation/reconciliation.service.ts` ✅
- `src/modules/api/trade/services/reconciliation/reconciliation.module.ts` ✅
- `src/modules/api/trade/services/sweep/sweep.service.ts` ✅
- `src/modules/api/trade/services/sweep/sweep.module.ts` ✅

### Migration ✅
- `scripts/migrate-to-ledger.ts` ✅ (atomic per-user, resumable, verifiable)

### Frontend ✅
- `src/app/(admin)/admin/(dashboard)/transactions/queue-tab.tsx` ✅
- `src/services/admin/queue.api.ts` ✅

---

## Files to Modify

### Backend
- `prisma/schema.prisma`
- `src/modules/shared/services/distributed-lock/distributed-lock.service.ts`
- `src/modules/api/trade/services/deposit-webhook/deposit-webhook.handler.ts`
- `src/modules/api/trade/services/buy-order/buy-order.service.ts`
- `src/modules/api/trade/services/sell-order/sell-order.service.ts`
- `src/modules/api/trade/services/swap/swap.service.ts`
- `src/modules/api/trade/services/send/send.service.ts`
- `src/modules/api/trade/services/ws/ws.gateway.ts`
- `src/modules/api/admin/controllers/auth.controller.ts`

### Frontend
- `src/components/assets/Transaction.tsx`
- `src/app/(admin)/admin/(dashboard)/transactions/page.tsx`
- `src/app/(admin)/admin/(dashboard)/wallets/page.tsx`
- `src/app/(admin)/admin/(dashboard)/layout.tsx`
- `src/services/admin/admin-client.api.ts`
- `src/types/transactions/types.ts`
