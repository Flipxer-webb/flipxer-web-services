# KYC Stage Consolidation Migration Spec

Status: Implemented / historical record
Last updated: 2026-05-02
Parent baseline branch: temp/kyc-individual-revamp-contract-20260429
Migration branch: temp/kyc-stage-consolidation-cutover-20260502
Backend worktree: c:/Users/magpi/flipxer-workspace/_tmp_kyc_individual_revamp_contract_ws
Atomic deploy requirement: Mandatory
Legacy rollback window: Required
Implementation outcome: Complete as repository and local cutover record

## Purpose

This document is the historical migration spec and implementation record for consolidating KYC onto the stage-attempt model without losing release safety.

Remaining mentions of the legacy model below are preserved only where they are needed for the archived pre-cutover dependency inventory, original task tables, or historical compatibility notes. They do not describe the current runtime on this branch.

The implemented end state is:

- `KycStageAttempt` is the only mutable verification state record;
- a new append-only event ledger stores provider responses, admin actions, rechecks, and history;
- business KYC uses the same stage-based workflow contract as individual KYC;
- runtime reads and writes no longer depend on `KycVerification` after cutover;
- the branch contains the runtime cutover work and the later schema drop that removes the legacy table and bridge columns.

## Final Branch Outcome

- runtime source no longer carries `KycVerification`, `legacyVerificationId`, or `kycVerificationId` outside archived docs and negative assertions in tests;
- `prisma/migrations/20260502120000_drop_legacy_kyc_verifications/migration.sql` removes the legacy table, enum, and bridge columns on this branch;
- `prisma/scripts/backfill-kyc-attempt-history.ts` is retired after imported-history backfill and rewrite;
- branch-local validation on `2026-05-02` covered focused Jest suites, local schema-drop confirmation, and a healthy Docker rebuild from this worktree.

## Why This Was A Separate Migration Branch

At planning start, the parent branch already contained validated compatibility fixes for the individual KYC revamp. That branch remained the baseline.

This child branch existed so the migration could:

- reuse the validated baseline as its starting point;
- carry the higher-risk schema and workflow changes without re-scoping the parent branch;
- support one atomic deployment later without mixing planning and implementation responsibilities.

## Scope

In scope:

- backend schema changes for unified KYC state and history;
- stage-attempt ownership of optimistic locking and decision transitions;
- business KYC migration into the stage model;
- admin queue and detail cutover to attempt-first reads;
- user profile journey and tier calculation cutover to stage-based reads;
- backfill and parity validation for current and historical KYC state;
- single-release runtime cutover with rollback protection.

Out of scope:

- UI restyling or Figma work;
- provider replacement or Dojah redesign;
- policy changes to tier rules or review rules;
- unrelated cleanup outside KYC workflow ownership.

## Planning Constraints At Start

1. The parent branch is the validated baseline and should not absorb this migration work.
2. At planning start, runtime behavior still depended on `KycVerification` for transitions, history, and business verification compatibility.
3. At planning start, business verification was not yet first-class in the stage model.
4. A single production release is required for runtime cutover.
5. Rollback must remain possible after deployment, which means legacy data cannot be physically destroyed during the activation window.

## Pre-Cutover `KycVerification` Dependency Inventory

This inventory captured the backend runtime, support scripts, and test surfaces that depended on `KycVerification` directly or through `legacyVerificationId` links before the final schema cutover on this branch.

### Runtime read paths

| Surface | Archived dependency at planning start | Migration action |
| --- | --- | --- |
| `src/modules/api/user/services/index.ts` | reads active `kycVerifications` for `BVN` and `NIN` pending or rejected state when building profile verification requirements | replace with stage-attempt derived government verification state and remove legacy fallback |
| `src/modules/api/kyc/services/index.ts` admin queue list | reads current stage attempts and attempt events, including canonical attempt version from `KycStageAttempt.version` | completed in current branch pass |
| `src/modules/api/kyc/services/index.ts` admin detail | returns attempt-backed detail payloads only, including canonical attempt version from `KycStageAttempt.version` | completed in current branch pass |
| `src/modules/api/kyc/services/index.ts` lookup-history flow | resolves status, version, and provider metadata from current attempts and latest attempt events before appending `KycAttemptEvent` history | completed in current branch pass |
| `src/modules/api/kyc/services/index.ts` attempt resolution | admin attempt lookup and decision wrappers now resolve stage attempt IDs only; no legacy verification ID fallback remains in `getAttemptSummaryById` or `resolveAttemptContext` | completed in current branch pass |
| `src/modules/api/kyc/services/index.ts` admin optimistic locking | attempt-managed admin decisions now resolve version and current state directly from `KycStageAttempt` with no active-verification bridge read | completed in current branch pass |
| `src/modules/api/kyc/services/index.ts` admin version display | admin summaries now use `KycStageAttempt.version` directly with no legacy-version fallback | completed in current branch pass |
| `src/modules/api/kyc/services/index.ts` queue filters | `buildKycStatusFilter` now resolves `BUSINESS_DOCUMENT` actionable and resolved queue states from business stage attempts, with a temporary fallback to business status flags for pre-backfill records | remove the fallback once M5 backfill lands |
| `src/modules/api/reports/services/reports.service.ts` | no live `BUSINESS_DOCUMENT` report filter remains; reports only keep the legacy BVN/NIN fallback for government-ID snapshots | revisit in M5 only if report scopes expand beyond government ID |
| `src/modules/api/user/services/index.ts` business verification requirements | profile requirements and the `businessVerification` payload now resolve from the current `BUSINESS_DOCUMENT` attempt, with only `businessDocumentVerificationStatus === VERIFIED` retained as a temporary rollback-era mirror; boolean fallback via `businessDocumentsUploaded` and `isDocumentVerified` is gone | remove the remaining status-field mirror once post-backfill parity is signed off |
| `src/modules/api/auth/services/individual-kyc-stage.service.ts` | no live runtime dependency remains; the dormant legacy-shaped decision-mode helpers were removed in the current branch pass | completed in current branch pass |

### Runtime write paths

| Surface | Archived dependency at planning start | Migration action |
| --- | --- | --- |
| `src/modules/api/auth/services/kyc-state-machine.service.ts` | canonical create, update, resubmission, deactivation, legal transition, and optimistic-lock writes now go through `KycStageAttempt` plus `KycAttemptEvent` | completed in M3-1 |
| `src/modules/api/auth/services/index.ts` government-ID mismatch flow | writes stage attempt state directly and appends `KycAttemptEvent` history; no legacy transition path remains in auth | completed in M3-2 |
| `src/modules/api/auth/services/index.ts` dev bypass flow | writes direct stage-attempt approvals on non-production bypass paths with no direct `kycVerification` mutations | completed in M3-3 |
| `src/modules/api/auth/services/index.ts` BVN and NIN success flows | stage attempt is the primary write and approval history is appended as attempt events | completed in M3-2 |
| `src/modules/api/auth/services/index.ts` identity-document submit flows | document upload and base64 submit flows now write attempts plus events; the retired widget helper no longer carries legacy transition logic | completed in M3-2 |
| `src/modules/api/auth/services/index.ts` business submit plus provider-check flows | business submissions now create `BUSINESS_DOCUMENT` attempts and the async Dojah provider check updates that exact attempt plus appends `PROVIDER_CHECK` history | completed in M4-1 and M4-2 |
| `src/modules/api/kyc/services/index.ts` admin decision path | stage-managed individual and business decisions now mutate stage attempts directly; dormant `activeLegacyVerification` helper branches were removed in this slice, and the rollback-era `legacyVerificationId` linkage was removed later in the final schema-drop work | business admin decision migration completed in M4-2 |
| `src/modules/api/kyc/services/index.ts` provider recheck history | investigative provider rechecks now append `KycAttemptEvent` history rows and no longer create inactive `kycVerification` records | completed in M2-1 |

### Support-script dependencies

| Surface | Archived dependency at planning start | Migration action |
| --- | --- | --- |
| `prisma/scripts/setup-income-review-test-user.ts` | updates, reads, and creates legacy `INCOME` verification rows for fixture state | create stage attempt plus event fixtures once cutover begins |

### Test dependencies

Tests that will need coordinated migration updates:

- `src/modules/api/auth/services/__tests__/kyc-state-machine.service.spec.ts`
- `src/modules/api/auth/services/__tests__/auth.service.spec.ts`
- `src/modules/api/auth/services/__tests__/individual-kyc-stage.service.spec.ts`
- `src/modules/api/kyc/services/__tests__/kyc.service.spec.ts`
- `src/modules/api/user/services/__tests__/user.service.spec.ts`
- `src/modules/api/reports/services/__tests__/reports.service.spec.ts`

## Original Migration Task List

These are the first implementation tasks derived directly from the dependency inventory above.

| Task ID | Task | Owner | Depends on | Done when |
| --- | --- | --- | --- | --- |
| F1 | Freeze the legacy dependency inventory and capture baseline snapshots for admin detail, admin queue, user profile, and representative DB rows | Backend | none | inventory and baseline outputs are checked into docs or artifacts |
| F2 | Add the additive Prisma schema slice for business-stage support and the new attempt-event ledger | Backend | F1 | Prisma schema, migration, and generated client compile with no runtime behavior changes |
| F3 | Add parity harness inputs for individual pending, approved, rejected, resubmitted, and business pending states | Backend | F1 | fixtures and comparison outputs are defined and repeatable |
| F4 | Replace lookup-history persistence from `KycVerification` inactive rows to `KycAttemptEvent` writes, keeping runtime behavior unchanged otherwise | Backend | F2, F3 | provider recheck history is readable from events in shadow mode |
| F5 | Introduce a stage-attempt state machine interface alongside the legacy state machine without cutting runtime over yet | Backend | F2 | stage transition API exists and can be exercised in tests |
| F6 | Remove admin queue and detail dependence on legacy version fallback by sourcing version and status from attempts or events in shadow mode | Backend | F4, F5 | admin parity checks compare cleanly against baseline responses |
| F7 | Model `BUSINESS_DOCUMENT` as a real business stage and stop treating business review as a queue-time legacy special case | Backend | F2 | business queue and detail can resolve from attempts or events |
| F8 | Update fixture and setup scripts that still seed legacy verification rows directly | Backend | F2 | local fixtures can represent pending review without `KycVerification` writes |


## Archived Target Architecture

This section preserves the target architecture described at planning time. The branch outcome above records the implemented repository state after cutover.

### Canonical mutable state

`KycStageAttempt` becomes the single mutable state record for a verification attempt.

Target responsibilities:

- current status;
- optimistic locking through `version`;
- attempt lineage through `attemptNo`;
- provider status and provider references;
- reviewer decision metadata;
- current versus superseded attempt lifecycle;
- attempt evidence linkage.

### Immutable history ledger

Add a new append-only table, referred to in this spec as `KycAttemptEvent`.

Target responsibilities:

- submission events;
- provider check results;
- admin recheck events;
- approve, reject, escalate, and resubmit actions;
- raw provider payload snapshots;
- audit-friendly timeline reconstruction.

`KycAttemptEvent` was planned to replace the then-current use of inactive `KycVerification` rows as mixed status history plus provider lookup storage.

### Unified journey model

The target journey model covers both:

- `INDIVIDUAL`;
- `BUSINESS`.

At planning time, the minimum business migration target for this release was a real `BUSINESS_DOCUMENT` stage in the business journey. Business record capture could remain outside the KYC stage engine if needed, but verification review still had to move into the same attempt model.

## Archived Target Schema Direction

This section preserves the planned schema direction and the original additive-step framing used before the final cutover and schema drop.

### Enums

- add `BUSINESS` to `KycJourneyType`;
- add `BUSINESS_DOCUMENT` to `KycStage`;
- keep `KycMethod` values expressive enough for both individual and business document flows.

### `KycStageAttempt`

Final target expectations:

- no `legacyVerificationId` dependency;
- uniqueness that prevents multiple current attempts for the same user, journey, and stage;
- `attemptNo` used only for resubmission generation;
- `version` used only for row-level concurrency control;
- evidence and provider references stored on the current attempt only when they represent current state.

### `KycAttemptEvent`

Planned conceptual fields:

- `id`;
- `attemptId`;
- `userId`;
- `journeyType`;
- `stage`;
- `eventType` such as `SUBMITTED`, `PROVIDER_CHECK`, `ADMIN_RECHECK`, `APPROVED`, `REJECTED`, `ESCALATED`, `RESUBMITTED`;
- `actorType` and `actorId` when applicable;
- `providerName`;
- `providerStatus`;
- `providerRef`;
- `note`;
- `payload` for structured raw provider or decision data;
- `createdAt`.

## Original Additive Prisma Slice

In the original plan, the first schema slice had to be additive only. It could not remove `KycVerification`, could not remove `legacyVerificationId`, and could not require immediate runtime cutover.

### Exact Prisma additions for the first slice

1. Expand the stage model to cover business verification.

```prisma
enum KycJourneyType {
	INDIVIDUAL
	BUSINESS
}

enum KycStage {
	GOVERNMENT_ID
	IDENTITY_DOCUMENT
	ADDRESS
	INCOME
	BUSINESS_DOCUMENT
}
```

2. Add event-ledger enums.

```prisma
enum KycAttemptEventType {
	SUBMITTED
	PROVIDER_CHECK
	ADMIN_RECHECK
	APPROVED
	REJECTED
	ESCALATED
	RESUBMITTED
	IMPORTED_LEGACY_HISTORY
}

enum KycActorType {
	USER
	ADMIN
	SYSTEM
	PROVIDER
	JOB
}
```

3. Add the append-only event model.

```prisma
model KycAttemptEvent {
	id                 Int                 @id @default(autoincrement())
	attemptId          Int
	userId             Int
	journeyType        KycJourneyType
	stage              KycStage
	eventType          KycAttemptEventType
	actorType          KycActorType?
	actorId            Int?
	providerName       KycProviderName?
	providerStatus     KycProviderStatus?
	providerRef        String?
	legacyVerificationId Int?
	note               String?
	payload            Json?
	createdAt          DateTime            @default(now())

	attempt            KycStageAttempt     @relation(fields: [attemptId], references: [id], onDelete: Cascade)
	user               User                @relation(fields: [userId], references: [id], onDelete: Cascade)

	@@index([attemptId, createdAt])
	@@index([userId, createdAt])
	@@index([journeyType, stage, createdAt])
	@@index([eventType, createdAt])
	@@map("KycAttemptEvents")
}
```

4. Add relations and non-destructive indexes.

```prisma
model User {
	// ...existing fields...
	kycAttemptEvents KycAttemptEvent[]
}

model KycStageAttempt {
	// ...existing fields...
	events KycAttemptEvent[]

	@@index([userId, journeyType, stage, isCurrent])
}
```

### Why these additions are first

- `BUSINESS` plus `BUSINESS_DOCUMENT` removes the current schema blocker for business cutover.
- `KycAttemptEvent` creates a new home for lookup history and future audit writes before any legacy deletion.
- the extra `KycStageAttempt` index supports later queue and current-attempt reads without changing semantics yet.
- keeping `legacyVerificationId` in place preserves rollback and incremental refactoring options.

### What is explicitly deferred from the first slice

- removing `KycVerification`;
- removing `legacyVerificationId`;
- changing `@@unique([userId, stage, attemptNo])`;
- adding a partial unique constraint for one current attempt per user, journey, and stage;
- any data backfill;
- any runtime write-path cutover.

### Migration order for the first additive slice

1. Add `BUSINESS` to `KycJourneyType`.
2. Add `BUSINESS_DOCUMENT` to `KycStage`.
3. Add `KycAttemptEventType` and `KycActorType` enums.
4. Add `KycAttemptEvent` table.
5. Add `User.kycAttemptEvents` relation.
6. Add `KycStageAttempt.events` relation and `@@index([userId, journeyType, stage, isCurrent])`.
7. Generate Prisma client.
8. Compile the backend without changing runtime behavior yet.
9. Only after the schema compiles cleanly, start wiring parity or shadow writes in code.

### Suggested migration file order

| Migration | Purpose |
| --- | --- |
| `20260502_add_kyc_attempt_events_and_business_stage_support` | additive enums, `KycAttemptEvent`, new relations, and new non-destructive indexes |
| `20260502_generate_client_only` | no schema change; regenerate client after migration is applied locally and in CI |

## Original Migration Workstreams

### 1. Baseline capture and parity harness

Before behavioral changes start, capture the parent branch baseline:

- focused passing test commands;
- current browser QA outcomes;
- admin detail and user profile API snapshots;
- representative DB snapshots for individual and business KYC rows.

Add a parity harness that can compare old and new outcomes for:

- admin queue rows;
- admin detail responses;
- user profile `kycJourney` responses;
- tier outputs;
- decision side effects.

### 2. Additive schema expansion

The first schema slice in the original plan was additive only:

- add business journey and stage support;
- add `KycAttemptEvent`;
- add supporting indexes and constraints;
- keep runtime behavior unchanged initially.

No legacy deletion was meant to happen in this slice.

### 3. Stage-attempt state machine ownership

Move legal transition rules and concurrency checks from legacy verification rows onto stage attempts.

Target rules:

- decisions apply by `attemptId` plus `expectedVersion`;
- stale version produces a hard conflict;
- resubmission creates a new current attempt with `attemptNo + 1` and `version = 1`;
- old attempts become non-current and are represented historically through events.

### 4. Business verification migration

Bring business verification into the stage model:

- submitting business documents creates or resubmits a business-stage attempt;
- business provider checks emit attempt events;
- admin approve or reject updates the business attempt directly;
- tier calculations derive business verification state from the stage model, not legacy mirrors.

### 5. Read-model cutover

Move these reads to stage-plus-event sources:

- admin queue;
- admin detail;
- user `kycJourney`;
- tier synchronization inputs;
- provider recheck history.

Remove synthetic business attempt mapping and legacy sync behavior only after parity is proven.

### 6. Data backfill

Backfill current and historical state:

- active legacy rows become current stage attempts when no equivalent current attempt exists;
- inactive legacy rows become immutable attempt events;
- business verification state becomes business-stage attempts and events;
- reviewer notes, references, timestamps, and provider payloads are preserved.

Backfill scripts were required to be idempotent.

Local status on this branch:

- `prisma/scripts/backfill-kyc-attempt-history.ts` backfilled legacy `KycVerification` rows into linked `KycStageAttempt` rows and `IMPORTED_LEGACY_HISTORY` events before the schema cutover, and is retired after the legacy table/columns are dropped;
- local dry-run and apply succeeded on `2026-05-02` for 9 legacy rows across 3 stage groups;
- local apply created 1 missing linked stage attempt, updated 7 existing linked attempts, and created 9 imported legacy-history events;
- rerun is idempotent except for intentional conflict reporting when an external current attempt already exists for the same stage;
- the current local conflict is user `6`, legacy verification `3`, `BVN -> GOVERNMENT_ID`, where the script preserves the unlinked current stage attempt instead of overwriting it.

### 7. Atomic runtime cutover

Deploy the new runtime in one release after backfill and parity checks pass.

At cutover:

- runtime reads switch to stage-plus-event only;
- runtime writes stop creating or mutating `KycVerification`;
- rollback remains available because legacy data still exists unchanged.

### 8. Legacy shutdown

After soak:

- remove remaining bridge helpers;
- remove `legacyVerificationId` from schema;
- remove runtime code paths that reference `kycVerification`;
- only then plan the physical drop of `KycVerification`.

## Historical Release Rules

These rules define what "single atomic deploy" means for this migration.

1. The runtime cutover happens in one release window.
2. Schema expansion and backfill may happen in the same release window before traffic is reopened.
3. The deployed application must read and write only the new model after cutover.
4. The legacy table must remain present for a rollback window.
5. Physical legacy table removal is explicitly not part of the activation window.

## Historical Release Gates

The original release plan required all gates below to be green before cutover.

### Functional gates

- individual BVN approve flow;
- individual BVN reject flow;
- individual BVN resubmit flow;
- NIN equivalents where supported;
- identity document approve or reject;
- address approve or reject;
- income approve or reject;
- business document submit, approve, reject, and resubmit;
- provider rechecks for all supported verification types;
- tier recalculation correctness after every decision.

### Consistency gates

- no duplicate current attempt for the same user, journey, and stage;
- no version drift between displayed attempt version and persisted current attempt version;
- admin queue and detail parity between baseline and migrated reads;
- user profile journey parity for representative fixtures;
- backfill scripts rerun safely without duplicate state.

### Operational gates

- rollback rehearsal completed;
- DB backup or snapshot captured before cutover;
- maintenance or write-freeze plan documented;
- smoke tests scripted for immediate post-deploy validation.

## Historical Rollback Strategy

Rollback must be possible without reconstructing lost legacy data.

Rollback strategy:

1. keep `KycVerification` present and untouched after cutover;
2. make the cutover application reversible to the baseline runtime for the rollback window;
3. do not run destructive schema removal during the activation window;
4. preserve cutover logs and parity outputs for diagnosis if rollback is triggered.

## Original Immediate Execution Plan

This branch starts with planning and additive groundwork only.

### Step 1: lock the spec

- confirm the target business-stage scope for this release;
- confirm whether business record capture stays outside the stage engine;
- confirm final event types and payload expectations.

### Step 2: inventory current legacy dependencies

- enumerate every runtime read from `kycVerification`;
- enumerate every runtime write to `kycVerification`;
- enumerate business-only compatibility paths;
- mark each dependency as replace, mirror temporarily, or delete.

### Step 3: implement additive schema slice

- add enums and new tables;
- add indexes and constraints;
- add migration scaffolding and no-op seeds or fixtures if needed.

### Step 4: design parity checks

- define comparable admin and profile snapshots;
- define fixture users for pending, approved, rejected, resubmitted, and business states;
- define pass or fail mismatch rules.

### Step 5: move behavior in thin slices

- state machine first;
- business verification second;
- read-model cutover third;
- legacy shutdown last.

## Historical Ticketed Implementation Sequence

Owners below are role-based so the plan can be staffed without changing the spec.

### Milestone M0: Baseline and parity scaffolding

| Ticket | Scope | Owner |
| --- | --- | --- |
| M0-1 | Freeze the runtime `KycVerification` dependency inventory and sign off on the replacement action for each path | Backend |
| M0-2 | Capture baseline admin queue, admin detail, user profile, and DB snapshots for representative fixtures | Backend |
| M0-3 | Define parity harness outputs and mismatch rules for queue, detail, profile journey, and tier | Backend + QA |

Exit criteria:

- baseline artifacts exist;
- inventory is complete;
- parity harness inputs are defined before code cutover starts.

### Milestone M1: Additive schema slice

| Ticket | Scope | Owner |
| --- | --- | --- |
| M1-1 | Add `BUSINESS` to `KycJourneyType` and `BUSINESS_DOCUMENT` to `KycStage` | Backend |
| M1-2 | Add `KycAttemptEventType`, `KycActorType`, and `KycAttemptEvent` | Backend |
| M1-3 | Add `User.kycAttemptEvents`, `KycStageAttempt.events`, and the new current-attempt read index | Backend |
| M1-4 | Regenerate Prisma client and make runtime compile without behavioral changes | Backend |

Exit criteria:

- additive migration applies cleanly;
- no runtime path is cut over yet;
- local compile and focused tests still pass where unaffected.

### Milestone M2: Event history replacement

| Ticket | Scope | Owner |
| --- | --- | --- |
| M2-1 | Replace provider lookup history writes from inactive `KycVerification` rows to `KycAttemptEvent` shadow writes | Backend |
| M2-2 | Add read helpers for attempt-event history and audit-friendly ordering | Backend |
| M2-3 | Keep legacy history writes temporarily only if parity requires shadow comparison | Backend |

Exit criteria:

- lookup history exists in events;
- admin history can be reconstructed from events in shadow mode.

### Milestone M3: Stage-attempt write ownership

| Ticket | Scope | Owner |
| --- | --- | --- |
| M3-1 | Introduce a stage-attempt state machine with optimistic locking on `KycStageAttempt.version` | Backend |
| M3-2 | Move government-ID and identity-document auth flows to write attempts plus events | Backend |
| M3-3 | Replace dev-bypass direct legacy writes with stage-attempt writes | Backend |
| M3-4 | Move admin approve, reject, and escalate to attempt-ID decisions | Backend |
| M3-5 | Cut admin detail lookup history to attempt-detail payloads and remove the temporary `kycVerifications` / `kycVerificationHistory` aliases in favor of explicit `legacy*` fields | Backend + Frontend |

Historical milestone outcome: M3-1 through M3-5 completed the initial stage-attempt write-ownership cutover. `src/modules/api/auth/services/kyc-state-machine.service.ts` owns canonical stage-attempt transitions and event writes, the admin lookup-history path resolves metadata from attempts and events before appending `KycAttemptEvent` rows, the admin decision bridge resolves directly from current stage attempts, the frontend admin detail page consumes attempt summaries plus attempt details without rebuilding `KycVerificationRecord` compatibility shapes, and admin version display resolves only from `KycStageAttempt.version`.

Exit criteria:

- no runtime write path requires `kycStateMachine.transition(...)` for individual KYC;
- stage attempts become the authoritative mutable state for migrated stages.

### Milestone M4: Business-stage migration

| Ticket | Scope | Owner |
| --- | --- | --- |
| M4-1 | Create the business-stage attempt contract for `BUSINESS_DOCUMENT` | Backend |
| M4-2 | Move business provider checks and admin business review into attempt and event writes | Backend |
| M4-3 | Replace business queue filters and report filters that still read legacy rows | Backend |
| M4-4 | Align business DTOs and frontend-facing status contracts with the new attempt model | Backend + Frontend |

Historical milestone outcome: M4-1, M4-2, M4-3, and M4-4 completed the business-stage migration. Queue filters now use business stage attempts, the reports scan found no live `BUSINESS_DOCUMENT` legacy filter, and the user/business frontend contract now resolves through the attempt-backed `businessVerification` payload.

Exit criteria:

- business verification no longer requires legacy queue or report filters;
- admin and user business state can be read entirely from attempts and events.

### Milestone M5: Read-model cutover and backfill

| Ticket | Scope | Owner |
| --- | --- | --- |
| M5-1 | Backfill active legacy rows into current attempts where needed and import old history into attempt events | Backend + Data |
| M5-2 | Move admin queue and detail to attempt-plus-event reads only | Backend |
| M5-3 | Move user verification requirements and profile journey fallbacks off `kycVerifications` | Backend |
| M5-4 | Update reports and fixtures still reading legacy rows | Backend |

Historical milestone outcome: M5 completed the read-model cutover and local backfill validation. The additive backfill script was dry-run validated, applied against the local database, and rerun idempotently before the final schema-drop work. One intentional local conflict remained during backfill where an unlinked current government-ID attempt already existed, so the script reported it instead of forcing a relink.

Archived read-model outcomes from M5:

- admin queue/detail now read from `KycStageAttempt` plus `KycAttemptEvent` data, and the frontend admin page consumes `activeAttempts` plus `attemptDetailsByVerificationType` directly with no `KycVerificationRecord` or `legacyKycVerification*` compatibility aliases;
- user profile journey and business verification requirements now read from current attempts instead of `user.kycVerifications`, and the business path no longer infers review state from `businessDocumentsUploaded` or `isDocumentVerified` booleans;
- reports and KYC stats no longer read raw `user.kycVerifications` for government-ID or business-document snapshots;
- the dormant legacy-shaped decision-mode helpers in `src/modules/api/auth/services/individual-kyc-stage.service.ts` and the dormant `activeLegacyVerification` helper branches in `src/modules/api/kyc/services/index.ts` are now removed;
- focused validation passed locally via `npx jest src/modules/api/kyc/services/__tests__/kyc.service.spec.ts --runInBand`, `npx jest src/modules/api/user/services/__tests__/user.service.spec.ts --runInBand`, `npx jest src/modules/api/auth/services/__tests__/individual-kyc-stage.service.spec.ts --runInBand`, and `npx jest src/modules/api/reports/services/__tests__/reports.service.spec.ts --runInBand`.

The admin read-model bridge was fully cut over in this milestone. `src/modules/api/kyc/services/index.ts` no longer used active-verification bridge reads for admin detail, lookup-history, decision-bridge resolution, or version display, and the admin frontend no longer rebuilt legacy-shaped verification aliases.

Subsequent post-cutover cleanup on this branch finished the rollback-era shutdown work that M5 had originally deferred:

- runtime source no longer carries `KycVerification`, `legacyVerificationId`, or `kycVerificationId` outside archived docs and negative assertions in tests;
- support scripts no longer seed or update legacy verification rows directly; the only remaining script mention is the retired `prisma/scripts/backfill-kyc-attempt-history.ts` stub;
- the final schema drop removed the legacy table, enum, and bridge columns via `20260502120000_drop_legacy_kyc_verifications`.

Exit criteria:

- parity checks pass for representative individual and business users;
- runtime reads no longer require `kycVerification`.

### Milestone M6: Atomic cutover rehearsal and release

| Ticket | Scope | Owner |
| --- | --- | --- |
| M6-1 | Rehearse schema expansion, backfill, app deployment, smoke tests, and rollback on a production-like snapshot | Data + QA + Release |
| M6-2 | Execute the single-release cutover with legacy table retained for rollback | Release |
| M6-3 | Monitor soak-period parity, conflicts, and queue correctness | Backend + QA |

Exit criteria:

- runtime reads and writes are on attempts and events only;
- rollback remains possible during soak;
- no recurring version drift or queue mismatch appears after release.

Historical note: this repository now records local cutover validation and final cleanup state, but it does not attempt to restate any external release-management execution outside the repo.

### Milestone M7: Legacy shutdown after soak

| Ticket | Scope | Owner |
| --- | --- | --- |
| M7-1 | Remove bridge helpers and `legacyVerificationId` runtime usage | Backend |
| M7-2 | Remove obsolete tests and fixture code that only exercised legacy verification paths | Backend |
| M7-3 | Drop `KycVerification` only after soak signoff | Backend + Data + Release |

Historical milestone outcome: M7 cleanup is complete on this branch. Bridge helpers and runtime `legacyVerificationId` usage are gone, obsolete compatibility scaffolding in tests and fixtures was removed, and the legacy table and enum drop landed in `20260502120000_drop_legacy_kyc_verifications`.

Exit criteria:

- the codebase has no runtime dependency on `KycVerification`;
- the physical legacy drop is a cleanup release, not part of cutover day.

## Resolved Questions / Archival Notes

1. Business record completion remained outside the KYC journey on this branch; the verification-review portion moved into the `BUSINESS_DOCUMENT` attempt flow.
2. `BUSINESS_DOCUMENT` was the only business verification stage implemented for this cutover.
3. Current operational metadata stayed on `KycStageAttempt`, while provider-history and imported-legacy payloads moved into `KycAttemptEvent.payload`.
4. Admin analytics, queue/detail reads, and report paths were rewritten to stop depending on `KycVerification` history shape on this branch.

## Branch Completion Outcome

This migration branch is complete as a repository and local cutover record when:

- the runtime no longer depends on `KycVerification` for reads or writes;
- the final schema-drop migration and bridge removal are present on the branch and were validated locally;
- imported legacy history is represented by `KycAttemptEvent`, and the legacy-history backfill script is retired;
- representative focused validation passed locally for the cutover slices touched on this branch;
- the migration, baseline, and pre-cutover planning docs are preserved as archival context rather than active guidance.