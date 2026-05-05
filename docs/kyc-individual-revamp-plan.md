# Individual KYC Revamp Plan

Status: Archived planning record
Last updated: 2026-05-01
Backend planning branch: temp/kyc-individual-revamp-contract-20260429
Backend planning worktree: c:/Users/magpi/flipxer-workspace/_tmp_kyc_individual_revamp_contract_ws
Frontend planning branch: temp/kyc-individual-revamp-contract-20260429
Frontend planning worktree: c:/Users/magpi/flipxer-workspace/_tmp_kyc_individual_revamp_contract_frontend_ws

## Purpose

This document is an archived planning record for the individual KYC revamp from government ID through income verification.

The immediate goals are:

- unify Dojah-backed identity checks and Flipxer-owned document review into one canonical stage model;
- make admin review operate on stage attempts instead of loosely related user flags;
- make the profile response expose a single backend-derived KYC journey contract;
- cut over before launch to the stage-attempt model directly, resetting disposable pre-launch individual KYC state instead of preserving it through dual-write and backfill.

## Scope

In scope:

- individual KYC only;
- stages: government ID, identity document, address, income;
- profile journey contract;
- submit and preview contracts;
- admin decision and investigative lookup contracts;
- schema, reset, and cutover strategy;
- transition rules from first submit to resubmission.

Out of scope for the first implementation slice:

- business KYC redesign;
- UI restyling or Figma implementation;
- replacing Dojah as the provider;
- changing tier policy itself;
- preserving pre-launch pending, rejected, or resubmitting individual KYC state.

## Working Decisions

These are the default working decisions until product or compliance changes them.

1. The user-facing journey remains four stages: GOVERNMENT_ID, IDENTITY_DOCUMENT, ADDRESS, INCOME.
2. GOVERNMENT_ID is one user-facing stage with two submission methods: BVN or NIN.
3. Address and income stay Flipxer-owned review stages even when OCR is used for auto-decision support.
4. Address starts as manual-review-first at launch, but the contract allows guarded auto-approval later.
5. A rejected submission never mutates back into the same current attempt. Resubmission creates a new attempt number.
6. Pre-launch individual KYC state is disposable. At cutover, pending, rejected, or resubmitting individual users may be reset to NOT_STARTED at Tier 0 instead of being migrated.
7. The launch target for individual users is `kycJourney` as the only workflow contract. `verificationRequirements` is not part of the target launch DTO.

## Planning-Branch Status At Archival

This plan assumed the planning branches were the implementation baseline rather than a blank design exercise.

Already implemented on the planning branches at archival time:

- additive Prisma support for `KycStageAttempt`, `KycEvidenceAsset`, and the new KYC enums;
- profile-side `kycJourney` read model for individual users;
- stage preview and submit endpoints for government ID, identity document, address, and income;
- admin attempt decision and recheck endpoints;
- partial frontend migration to `kycJourney` for route helpers, prompts, generic document flows, and the admin user-detail screen.

Remaining launch blockers recorded at planning time:

- remove individual `verificationRequirements` and legacy flag fallbacks from the remaining frontend user flows;
- remove individual dual-write and backfill behavior from the stage service;
- make the admin KYC queue fully attempt-first and delete the remaining user-first queue compatibility fields.

## Frontend Behavior Constraints At Planning Time

The revamp could not be planned only as a backend redesign because the web app still derived user flow, page guards, and admin review behavior from several existing response shapes.

### User web app

At planning time, frontend behavior depended on these patterns:

1. Route orchestration is driven by `verificationRequirements.nextStep` first, then falls back to legacy booleans and per-stage status fields.
2. Dashboard prompts, tier hero CTAs, and verification triggers all independently infer pending, declined, and next-step state from legacy fields.
3. Address and income pages use a generic document page component that expects simple `PENDING` or `VERIFIED` semantics and redirects away if the backend-derived current route does not match the page.
4. The identity-document page is not a simple submit page. It runs preview automatically after images are selected, auto-fills document number when OCR extracts it, allows submit when the preview is fully valid or has extractable text, and always routes to a success screen after submit.
5. Current success and pending UX is based on toast plus redirect behavior, not only on persisted state.

### Admin web app

At planning time, admin behavior depended on these patterns:

1. The queue is still effectively user-first, not attempt-first.
2. The admin screen derived actionability from pending-verification arrays, actionable verification types, latest review state, current verification version, and legacy per-verification status fields.
3. The detail view expects flattened evidence and comparison data it can render immediately without doing its own provider-specific parsing.
4. The action buttons depend on optimistic locking through the current active verification version.

### Planning implication

The target model must include:

- a backend-derived journey contract for the user app;
- explicit UI-friendly stage display metadata so the frontend stops re-deriving workflow state from booleans;
- removal of individual-only compatibility fields before launch rather than preserving them into production;
- attempt-first admin queue and detail DTOs so the admin page does not need to reconstruct review state from mixed user-level fields.

## Frontend Implementation Breakdown

The revamp still requires frontend work, but because pre-launch individual KYC state is disposable, the plan should optimize for direct cutover instead of carrying adapter-heavy production compatibility.

### Launch-blocking frontend changes

These changes are required before launch so individual KYC can cut over cleanly onto `kycJourney`.

| Surface | Current responsibility | Required change in phase 1 |
| --- | --- | --- |
| `src/lib/verification-flow.ts` | resolves the next user route from `verificationRequirements` and legacy booleans | resolve next route, next label, hero CTA, and completion checks from `kycJourney` only for individual users |
| `src/lib/kycPrompt.ts` | builds dashboard checklist items, prompt banner state, and action labels from legacy flags and statuses | compute requirements and banner state from `kycJourney.stages[]`, `kycJourney.overallStatus`, and `kycJourney.nextAction` only for individual users |
| `src/components/verification/VerificationTrigger.tsx` | decides whether to show the verification CTA and where it routes | drive CTA visibility, pending display, and target route from `kycJourney.nextAction` and remove individual fallback logic |
| `src/app/(main)/(kyc)/_components/UploadDocument.tsx` | entry point for the individual identity-document flow | drive entry behavior from `kycJourney.currentStage` and `kycJourney.nextAction` and remove `verificationRequirements`-based waiting shortcuts |
| `src/components/auth/upload-documents/IndividualUpload.tsx` | identity-document preview, autofill, submit gating, and redirect | consume richer preview outcomes, use backend-provided `canSubmit`, use backend autofill data, and handle structured submit outcomes such as approved, under review, or hard-stop rejection |
| `src/app/(main)/(kyc)/_components/DocumentVerificationPage.tsx` | shared address and income upload flow with simple success and pending handling | use stage display state from `kycJourney.stages[]`, support `UNDER_REVIEW`, `NEEDS_RESUBMISSION`, and `BLOCKED`, and stop assuming `PENDING` or `VERIFIED` are the only meaningful outcomes |
| `src/app/(main)/(kyc)/verify-address/page.tsx` | address page config wrapper around the generic document page | update config expectations to match the richer submit response contract and stage display state |
| `src/app/(main)/(kyc)/verify-income/page.tsx` | income page config wrapper around the generic document page | update config expectations to match the richer submit response contract and stage display state |
| `src/services/auth/auth.client.ts` | identity-document client DTOs | add profile, preview, and submit DTOs for the new journey and preview contract |
| `src/services/user/user.client.ts` | address and income client DTOs | update submit response typing so the generic document page stops treating every response as a loose success blob |
| `src/services/admin/admin-client.api.ts` | admin queue and detail DTO types | promote attempt-first queue, detail, decision, and recheck types to the primary admin KYC contract and delete individual legacy queue types |
| `src/app/(admin)/admin/(dashboard)/kyc/page.tsx` | admin queue, review detail, lookup refresh, and decision UI | move fully from user-first review rows to attempt-first records, use attempt version for optimistic locking, and render normalized stage evidence and comparison data |

### Phase 1 high-value supporting changes

These are not the first blockers, but they will reduce churn and make the cutover safer.

| Surface | Why it should move early |
| --- | --- |
| `src/services/user/user.hooks.ts` | centralize profile invalidation and refetch behavior after submit or review decisions |
| `src/components/verification/KycProgressBanner.tsx` | align dashboard banner copy and state chips with `kycJourney.overallStatus` |
| `src/components/verification/VerificationResult.tsx` | reuse normalized stage outcomes instead of one-off success or pending rendering |
| KYC-related tests under `src/__tests__/app`, `src/__tests__/components`, `src/__tests__/services`, and `src/__tests__/hooks` | lock behavior before legacy fallback removal so routing, prompts, and queue behavior do not silently regress |

### Pre-launch removals

These removals should happen before launch because the launch target is a clean cutover rather than a compatibility-heavy migration.

| Surface | Cleanup goal |
| --- | --- |
| `src/lib/verification-flow.ts` | remove legacy boolean and status fallbacks entirely |
| `src/lib/kycPrompt.ts` | remove direct reads of `isBvnVerified`, `isDocumentVerified`, `addressVerificationStatus`, and `incomeVerificationStatus` |
| `src/components/verification/VerificationTrigger.tsx` | remove legacy `hasNextVerificationStep` boolean logic |
| `src/app/(main)/(kyc)/_components/DocumentVerificationPage.tsx` | replace compatibility mapping with a fully stage-aware page component if the generic abstraction becomes too limiting |
| `src/components/auth/upload-documents/IndividualUpload.tsx` | remove submit behavior that depends on legacy `response.success` plus route-only success handling |
| `src/services/admin/admin-client.api.ts` | remove legacy queue item and verification record DTOs once admin is fully attempt-driven |
| `src/app/(admin)/admin/(dashboard)/kyc/page.tsx` | remove compatibility logic for old pending-verification arrays, legacy per-verification status fields, and user-level status chips |
| current route copy and stale comments referencing mixed widget/manual assumptions | align naming with the final attempt-driven model |

### Frontend cutover rules

1. Preserve current routes only when they map cleanly to `kycJourney.nextAction.route`.
2. No individual user path should require `verificationRequirements.nextStep` or individual legacy booleans at launch.
3. Business may keep its own contract until business KYC redesign starts, but that must not block the individual cutover.
4. Admin KYC must be attempt-first before launch.
5. Resetting pre-launch individual KYC state is preferred over carrying compatibility fields solely to preserve old review state.

## Target Domain Model

### Canonical persisted record

The canonical record is a stage attempt. It replaces the current split between:

- user verification booleans and status columns,
- UserDocument provider extraction fields,
- address and income status fields,
- legacy verification audit records.

Each stage attempt represents one submitted attempt for one user and one stage.

Proposed conceptual entity:

```ts
type KycJourneyType = "INDIVIDUAL";

type KycStage =
  | "GOVERNMENT_ID"
  | "IDENTITY_DOCUMENT"
  | "ADDRESS"
  | "INCOME";

type KycMethod =
  | "BVN"
  | "NIN"
  | "INTERNATIONAL_PASSPORT"
  | "DRIVER_LICENSE"
  | "NIN_SLIP"
  | "UTILITY_BILL"
  | "BANK_STATEMENT"
  | "GOVERNMENT_LETTER"
  | "PAYSLIP"
  | "EMPLOYMENT_LETTER"
  | "CONTRACT"
  | "BANK_STATEMENT_INCOME"
  | "TAX_RETURN"
  | "BUSINESS_REGISTRATION"
  | "OTHER";

type KycAttemptStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "ESCALATED"
  | "EXPIRED";

type KycProviderStatus =
  | "NOT_REQUESTED"
  | "RUNNING"
  | "PASSED"
  | "FAILED"
  | "INCONCLUSIVE"
  | "ERROR";

type KycDecisionMode = "AUTO" | "MANUAL";

interface KycStageAttemptRecord {
  id: number;
  userId: number;
  journeyType: KycJourneyType;
  stage: KycStage;
  method: KycMethod;
  attemptNo: number;
  isCurrent: boolean;
  status: KycAttemptStatus;
  providerName: "DOJAH" | "OCR" | "NONE";
  providerStatus: KycProviderStatus;
  decisionMode: KycDecisionMode;
  providerRef: string | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  reasonDetails: Record<string, unknown> | null;
  extractedFields: Record<string, unknown> | null;
  comparisonSummary: Record<string, unknown> | null;
  evidenceSummary: Record<string, unknown> | null;
  reviewerId: number | null;
  reviewNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  escalatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

### Evidence asset record

Uploaded files should be normalized away from stage state and stored as evidence assets.

```ts
type KycEvidenceKind = "FRONT_IMAGE" | "BACK_IMAGE" | "PDF" | "SUPPORTING_FILE";

interface KycEvidenceAssetRecord {
  id: number;
  attemptId: number;
  kind: KycEvidenceKind;
  storageUrl: string;
  storageFieldId: string | null;
  originalName: string | null;
  mimeType: string;
  checksumSha256: string | null;
  pageCount: number | null;
  side: "FRONT" | "BACK" | null;
  createdAt: string;
}
```

### Journey projection

The profile contract should expose a derived journey object. This is computed from current attempts plus user profile fields needed for comparisons.

```ts
type KycJourneyOverallStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "ACTION_REQUIRED"
  | "VERIFIED";

type KycNextActionType =
  | "START"
  | "SUBMIT"
  | "RESUBMIT"
  | "WAIT"
  | "COMPLETE"
  | "CONTACT_SUPPORT";
```

## Status Model

### Internal attempt statuses

| Status | Meaning | User-facing interpretation |
| --- | --- | --- |
| DRAFT | Upload or input captured but not yet submitted for workflow processing | Not shown outside compose flow |
| SUBMITTED | Submit accepted and workflow processing has started | Submitted |
| PENDING_REVIEW | Human review is required | Under review |
| APPROVED | Stage is complete and counts toward tier eligibility | Verified |
| REJECTED | Attempt failed and user action is required | Needs attention |
| ESCALATED | Attempt requires elevated reviewer or secondary review | Under review |
| EXPIRED | Attempt or draft can no longer be reused | Expired |

### Provider statuses

| Provider status | Meaning |
| --- | --- |
| NOT_REQUESTED | No provider lookup was needed |
| RUNNING | Provider verification or OCR is still processing |
| PASSED | Provider returned a positive result |
| FAILED | Provider returned a negative result |
| INCONCLUSIVE | Provider returned extractable data but not enough for auto-approval |
| ERROR | Provider call failed or timed out |

### Reason codes

Reason codes explain why a stage failed or moved to review. They should not become new statuses.

Recommended initial reason code set:

- DUPLICATE_IDENTITY
- NAME_MISMATCH
- DOB_MISMATCH
- LOW_IMAGE_QUALITY
- DOCUMENT_EXPIRED
- UNSUPPORTED_DOCUMENT
- TEXT_EXTRACTION_FAILED
- ADDRESS_NOT_FOUND
- ADDRESS_MISMATCH
- DOCUMENT_NOT_RECENT
- INCOME_NOT_DETECTED
- PROVIDER_TIMEOUT
- PROVIDER_ERROR
- MANUAL_REVIEW_REQUIRED
- ADMIN_ESCALATED
- ADMIN_REJECTED

### Normalization from current vocabulary

| Current vocabulary | Target vocabulary |
| --- | --- |
| VERIFIED | APPROVED |
| DECLINED | REJECTED |
| PENDING_PROVIDER_CONFIRMATION | SUBMITTED + providerStatus=RUNNING |
| RESUBMITTED | new current attempt with incremented attemptNo |
| WAIT_FOR_VERIFICATION | derived profile state, not a persisted status |

## API Contract Sketch

The launch contract for individual accounts is `kycJourney`-first. `verificationRequirements` may exist in temporary branch code during convergence, but it is not part of the target launch DTO.

### Profile DTO

Suggested response shape added to profile:

```ts
interface KycProfileStageDto {
  stage: KycStage;
  label: string;
  status: KycAttemptStatus | "NOT_STARTED";
  providerStatus: KycProviderStatus | null;
  displayState:
    | "NOT_STARTED"
    | "READY"
    | "UNDER_REVIEW"
    | "VERIFIED"
    | "NEEDS_RESUBMISSION"
    | "BLOCKED";
  currentAttemptId: number | null;
  currentMethod: KycMethod | null;
  blockedBy: KycStage[];
  canSubmit: boolean;
  canResubmit: boolean;
  canEscalate: boolean;
  submittedAt: string | null;
  reviewedAt: string | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  helperText: string | null;
  route: string | null;
  actionLabel: string | null;
}

interface KycNextActionDto {
  type: KycNextActionType;
  stage: KycStage | null;
  route: string | null;
  label: string | null;
  message: string | null;
}

interface KycJourneyDto {
  overallStatus: KycJourneyOverallStatus;
  currentStage: KycStage | null;
  nextStage: KycStage | null;
  completedStages: KycStage[];
  pendingStages: KycStage[];
  blockedStages: KycStage[];
  currentTier: number;
  eligibleTierAfterNextApproval: number | null;
  nextAction: KycNextActionDto;
  stages: KycProfileStageDto[];
}

interface UserProfileResponseDto {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  tier: number;
  kycJourney: KycJourneyDto;
}
```

### Launch route mapping

The launch contract should keep the current public routes but should not keep the old individual compatibility fields.

Recommended first-cut route mapping:

| Stage | Existing route to preserve initially |
| --- | --- |
| GOVERNMENT_ID | `/verify-bvn` |
| IDENTITY_DOCUMENT | `/document-type` as the stage entry route |
| ADDRESS | `/verify-address` |
| INCOME | `/verify-income` |

Required profile guarantees at launch:

1. Individual profile responses always include `kycJourney`.
2. `kycJourney.nextAction.route` points to one of the existing routes first.
3. `kycJourney.stages[].displayState` is sufficient for dashboard checklist items, prompt banners, trigger buttons, and page guards.
4. Individual profile responses do not require `verificationRequirements.nextStep` or individual legacy booleans.

### Frontend stage-state model

The backend attempt status is not enough for page rendering. The frontend also needs a stage-local page state model.

Recommended page state mapping:

```ts
type KycPageState =
  | "IDLE"
  | "PREFLIGHT_RUNNING"
  | "READY_TO_SUBMIT"
  | "SUBMITTING"
  | "SUBMITTED_FOR_REVIEW"
  | "AUTO_APPROVED"
  | "REJECTED_HARD_STOP"
  | "ERROR";
```

This state does not need to be persisted, but the API must return enough data for the frontend to resolve it deterministically.

### Submit endpoints

Recommended route shape:

- `POST /api/v1/kyc/individual/stages/government-id/submit`
- `POST /api/v1/kyc/individual/stages/identity-document/submit`
- `POST /api/v1/kyc/individual/stages/address/submit`
- `POST /api/v1/kyc/individual/stages/income/submit`

Suggested request union:

```ts
interface GovernmentIdSubmitDto {
  method: "BVN" | "NIN";
  identifier: string;
}

interface IdentityDocumentSubmitDto {
  method: "INTERNATIONAL_PASSPORT" | "DRIVER_LICENSE" | "NIN_SLIP";
  country: "NIGERIA";
  documentNumber: string;
  frontAssetToken: string;
  backAssetToken?: string;
}

interface AddressSubmitDto {
  method: "UTILITY_BILL" | "BANK_STATEMENT" | "GOVERNMENT_LETTER" | "OTHER";
  frontAssetToken: string;
  supportingAssetTokens?: string[];
}

interface IncomeSubmitDto {
  method:
    | "PAYSLIP"
    | "EMPLOYMENT_LETTER"
    | "CONTRACT"
    | "BANK_STATEMENT_INCOME"
    | "TAX_RETURN"
    | "BUSINESS_REGISTRATION"
    | "OTHER";
  frontAssetToken: string;
  supportingAssetTokens?: string[];
}

type IndividualKycSubmitDto =
  | GovernmentIdSubmitDto
  | IdentityDocumentSubmitDto
  | AddressSubmitDto
  | IncomeSubmitDto;
```

Suggested submit response:

```ts
interface KycStageSubmitResponseDto {
  attemptId: number;
  stage: KycStage;
  status: KycAttemptStatus;
  providerStatus: KycProviderStatus;
  outcome: "APPROVED" | "UNDER_REVIEW" | "REJECTED_HARD_STOP";
  reasonCode: string | null;
  reasonMessage: string | null;
  decisionMode: KycDecisionMode;
  extractedFields: Record<string, unknown> | null;
  comparisonSummary: Record<string, unknown> | null;
  toastMessage: string | null;
  redirectTo: string | null;
  invalidateProfile: boolean;
  nextAction: KycNextActionDto;
}
```

Behavior expectations:

- GOVERNMENT_ID may auto-approve or route to review based on provider comparison result.
- IDENTITY_DOCUMENT may auto-approve when provider and profile checks pass.
- ADDRESS initially always returns PENDING_REVIEW after submit, even if OCR is clean.
- INCOME may auto-approve when OCR checks pass.

Frontend-specific submit requirements:

1. Address and income must keep a simple success contract while the generic `DocumentVerificationPage` is still in use.
2. Identity-document submit must return deterministic redirect semantics because the current flow always routes to the document success page after a successful submit.
3. Submit responses should carry a user-facing toast string so the frontend can stop inferring copy from raw status values.
4. Submit responses should indicate whether the profile cache should be invalidated immediately.

### Preview endpoints

Preview should be stateless or draft-based. It should not create a current attempt until submit is confirmed.

Recommended route shape:

- `POST /api/v1/kyc/individual/stages/identity-document/preview`
- `POST /api/v1/kyc/individual/stages/address/preview`
- `POST /api/v1/kyc/individual/stages/income/preview`

Suggested preview request DTO:

```ts
interface KycStagePreviewDto {
  stage: Extract<KycStage, "IDENTITY_DOCUMENT" | "ADDRESS" | "INCOME">;
  method: KycMethod;
  frontAssetToken: string;
  backAssetToken?: string;
  country?: "NIGERIA";
  documentNumber?: string;
}
```

Suggested preview response:

```ts
type KycPreviewOutcome = "READY" | "REVIEW_LIKELY" | "BLOCKED";

interface KycStagePreviewResponseDto {
  outcome: KycPreviewOutcome;
  stage: Extract<KycStage, "IDENTITY_DOCUMENT" | "ADDRESS" | "INCOME">;
  draftToken: string | null;
  providerStatus: KycProviderStatus;
  canSubmit: boolean;
  reasonCode: string | null;
  reasonMessage: string | null;
  extractedFields: Record<string, unknown> | null;
  comparisonSummary: Record<string, unknown> | null;
  autofill: {
    documentNumber?: string;
  } | null;
  warnings: string[];
}
```

Preview outcome rules:

- `READY`: submit can likely auto-approve or proceed cleanly.
- `REVIEW_LIKELY`: enough data was extracted to submit, but manual review is likely.
- `BLOCKED`: hard-stop issues such as expired or unsupported documents.

Frontend-specific preview requirements:

1. The preview response must support the current identity-document behavior where submit is allowed when the document is fully valid or enough text was extracted for review.
2. The preview response must support document-number autofill for the identity-document page.
3. The preview response must distinguish user-blocking hard stops from warnings that still allow submission.
4. A later frontend phase can reuse `draftToken` to prevent duplicate provider analysis on final submit.

### Admin decision endpoints

Recommended route shape:

- `POST /api/v1/admin/kyc/attempts/:attemptId/decision`
- `POST /api/v1/admin/kyc/attempts/:attemptId/recheck`

Suggested decision request DTO:

```ts
type AdminKycDecisionAction = "APPROVE" | "REJECT" | "ESCALATE";

interface AdminKycDecisionDto {
  action: AdminKycDecisionAction;
  expectedVersion: number;
  note?: string;
  reasonCode?: string;
  notifyUser?: boolean;
}
```

Suggested decision response DTO:

```ts
interface AdminKycDecisionResponseDto {
  attemptId: number;
  userId: number;
  stage: KycStage;
  status: KycAttemptStatus;
  reviewerId: number;
  reviewedAt: string;
  nextAction: KycNextActionDto;
  version: number;
}
```

Suggested recheck request DTO:

```ts
interface AdminKycRecheckDto {
  provider: "DOJAH" | "OCR";
  note?: string;
}
```

Suggested recheck response DTO:

```ts
interface AdminKycRecheckResponseDto {
  attemptId: number;
  stage: KycStage;
  providerStatus: KycProviderStatus;
  extractedFields: Record<string, unknown> | null;
  comparisonSummary: Record<string, unknown> | null;
  evidenceSummary: Record<string, unknown> | null;
  lookedUpAt: string;
}
```

### Admin frontend support DTOs

The admin web app needs more than decision and recheck endpoints. It also needs queue and detail responses aligned to an attempt-first model.

Suggested queue item DTO:

```ts
interface AdminKycQueueAttemptDto {
  attemptId: number;
  userId: number;
  stage: KycStage;
  method: KycMethod;
  status: KycAttemptStatus;
  providerStatus: KycProviderStatus;
  attemptNo: number;
  version: number;
  submittedAt: string;
  reviewedAt: string | null;
  reviewerId: number | null;
  queueReason: string | null;
  recommendedDecision: "APPROVE" | "REVIEW" | "REJECT" | null;
  user: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string;
    tier: number;
  };
  evidenceSummary: Record<string, unknown> | null;
  comparisonSummary: Record<string, unknown> | null;
  allowedActions: Array<"APPROVE" | "REJECT" | "ESCALATE" | "RECHECK">;
}
```

Suggested attempt detail DTO:

```ts
interface AdminKycAttemptDetailDto {
  attempt: AdminKycQueueAttemptDto;
  extractedFields: Record<string, unknown> | null;
  rawEvidence: Array<{
    id: number;
    kind: string;
    url: string;
    mimeType: string;
  }>;
  lookupHistory: AdminKycRecheckResponseDto[];
  decisionHistory: Array<{
    status: KycAttemptStatus;
    note: string | null;
    reviewerId: number | null;
    createdAt: string;
  }>;
}
```

## Prisma Cutover Plan

Because pre-launch individual KYC state is disposable, the plan should cut over directly to the new schema and source of truth instead of running a long additive, dual-write, backfill migration.

### Add

| Item | Action | Why |
| --- | --- | --- |
| `KycStage` enum | add | separates stage from the legacy verification-type enum values that mixed stage and method |
| `KycAttemptStatus` enum | add | normalizes all per-stage workflow states |
| `KycProviderStatus` enum | add | separates provider result from workflow decision |
| `KycDecisionMode` enum | add | records auto vs manual outcome |
| `KycMethod` enum | add | supports stage-specific submission methods |
| `KycReasonCode` enum or constrained string field | add | standardizes rejection and review reasons |
| `KycStageAttempt` table | add | canonical per-stage attempt record |
| `KycEvidenceAsset` table | add | normalizes file storage away from stage state |
| `draftToken` support table or expiring draft fields | add | reuses preview outputs during final submit |
| `supersededByAttemptId` or `attemptNo` + `isCurrent` | add | supports resubmission cleanly |
| `comparisonSummary` JSON | add | stores normalized match results across Dojah and OCR |
| `extractedFields` JSON | add | stores provider and OCR extracted fields in one place |
| `evidenceSummary` JSON | add | stores computed human-review summary |

### Drop or reset at cutover

| Current field or table | Cutover action | Replacement |
| --- | --- | --- |
| `User.isBvnVerified` | stop reading or writing for individual KYC; reset existing individual values as part of cutover | derived from current GOVERNMENT_ID attempt approvals |
| `User.isNinVerified` | stop reading or writing for individual KYC; reset existing individual values as part of cutover | derived from current GOVERNMENT_ID attempt approvals |
| `User.isDocumentVerified` | stop reading or writing for individual KYC once business dependencies are isolated | derived from current IDENTITY_DOCUMENT approval |
| `User.isAddressVerified` | stop reading or writing for individual KYC; reset existing individual values as part of cutover | derived from current ADDRESS approval |
| `User.isIncomeVerified` | stop reading or writing for individual KYC; reset existing individual values as part of cutover | derived from current INCOME approval |
| `User.documentVerificationStatus` | stop reading or writing for individual KYC once business dependencies are isolated | derived from current IDENTITY_DOCUMENT attempt |
| `User.addressVerificationStatus` | stop reading or writing for individual KYC; reset existing individual values as part of cutover | derived from current ADDRESS attempt |
| `User.incomeVerificationStatus` | stop reading or writing for individual KYC; reset existing individual values as part of cutover | derived from current INCOME attempt |
| `User.addressDocumentUrl` | stop treating as canonical for individual KYC; clear or ignore during cutover | latest ADDRESS evidence asset |
| `User.incomeDocumentUrl` | stop treating as canonical for individual KYC; clear or ignore during cutover | latest INCOME evidence asset |
| `UserDocument.verificationStatus` | stop treating as canonical for individual KYC | stage attempt status |
| `UserDocument.dojah*` fields | stop treating as canonical for individual KYC | `extractedFields` and `comparisonSummary` on attempt |
| legacy verification status enum | stop using as the source of truth for individual KYC | richer attempt status vocabulary |

### Reset at cutover

The clean-cutover assumption allows the individual KYC launch to reset pre-launch review state instead of preserving it.

1. Reset individual users to Tier 0 unless a deliberate seed or migration exception is approved.
2. Clear individual pending, rejected, escalated, and resubmission state instead of backfilling it into the new stage model.
3. Archive or snapshot pre-launch KYC records once before the reset so the team can inspect old behavior if needed.
4. Seed deterministic QA users for NOT_STARTED, PENDING_REVIEW, REJECTED, ESCALATED, and VERIFIED flows instead of depending on organic legacy state.

### Backfill and compatibility sections that can be removed now

| Previous migration-heavy section or assumption | Remove now | Replacement |
| --- | --- | --- |
| Purpose language about additive rollout and later compatibility removal | yes | direct cutover before launch |
| Working decision that user booleans remain available during migration | yes | disposable pre-launch individual KYC state |
| Planning implication bullet about temporary compatibility fields | yes | remove individual compatibility fields before launch |
| Profile DTO `verificationRequirements` block for individual users | yes | `kycJourney`-only individual launch contract |
| Frontend compatibility and route mapping section built around rollout guarantees | yes | route mapping that keeps existing URLs without preserving individual compatibility fields |
| Suggested rollout phases: additive schema, dual-write, read-switch, cleanup | yes | direct cutover phases |
| Checklist items for additive migration, dual-write, and parity-based legacy removal | yes | reset, cutover, and deletion tasks |
| Required order before column drop that depends on backfill and preserved pending state | yes | delete legacy reads and writes directly once cutover is complete |

### Exact backfill and compatibility code paths that become deletion targets

Once the cutover branch is complete, these runtime areas no longer need to preserve old individual KYC state:

1. `src/modules/api/auth/services/individual-kyc-stage.service.ts`: `submitLegacy`, `backfillGovernmentIdAttempt`, `backfillIdentityDocumentAttempt`, `backfillAddressAttempt`, `backfillIncomeAttempt`, and the legacy response projection helpers.
2. `src/modules/api/auth/services/index.ts`, `src/modules/api/auth/services/tier.service.ts`, `src/modules/api/auth/services/tier-verification.service.ts`, and `src/modules/api/kyc/services/index.ts`: remaining individual reads of legacy verification flags, statuses, and user-first queue projections.
3. `src/lib/verification-flow.ts`, `src/lib/kycPrompt.ts`, `src/components/verification/VerificationTrigger.tsx`, and `src/app/(main)/(kyc)/_components/UploadDocument.tsx`: individual fallback logic that still reads `verificationRequirements.nextStep` or legacy individual flags.
4. `src/services/admin/admin-client.api.ts` and `src/app/(admin)/admin/(dashboard)/kyc/page.tsx`: legacy queue item fields and user-first review compatibility logic for individual KYC.

### Derive

| Derived output | Source |
| --- | --- |
| tier eligibility | derived from current approved stages, then persisted into `User.tier` for performance |
| profile KYC banners | derived from `kycJourney.overallStatus` and stage statuses |
| admin queue membership | derived from current attempts where `status in (PENDING_REVIEW, ESCALATED)` |
| resubmission availability | derived from latest current attempt status |

### Suggested cutover phases

#### Phase 1: finish launch-blocking contract and UI work

- finish the individual frontend shift to `kycJourney`;
- finish the admin queue shift to attempt-first records;
- stop designing around preservation of pending, rejected, or resubmitting pre-launch users.

#### Phase 2: prepare the reset and cutover

- snapshot pre-launch KYC data once for reference;
- write the one-time reset script for individual KYC state and Tier 0 restart;
- confirm which shared business fields remain temporarily because business KYC is out of scope.

#### Phase 3: cut over to the stage-attempt model

- make `KycStageAttempt` and `KycEvidenceAsset` the only source of truth for individual KYC;
- make individual profile responses return only `kycJourney`;
- make admin queue and detail responses consume current attempts only.

#### Phase 4: delete legacy paths

- remove individual dual-write logic;
- remove individual backfill logic;
- remove frontend individual fallback logic;
- drop or ignore legacy individual fields that no longer serve business flows.

## Transition Matrix

The matrix below uses the target status model.

### Stage: GOVERNMENT_ID

| Current status | Event | Actor | Next status | Notes |
| --- | --- | --- | --- | --- |
| none | submit BVN or NIN | user | SUBMITTED | create current attempt with method BVN or NIN |
| SUBMITTED | provider match passes and profile comparison passes | system | APPROVED | auto decision; current stage completes |
| SUBMITTED | provider passes but name mismatch only | system | PENDING_REVIEW | reasonCode=`MANUAL_REVIEW_REQUIRED` or `NAME_MISMATCH` |
| SUBMITTED | provider passes but DOB mismatch | system | REJECTED | reasonCode=`DOB_MISMATCH`; user must resubmit |
| SUBMITTED | duplicate identity found | system | REJECTED | reasonCode=`DUPLICATE_IDENTITY` |
| SUBMITTED | provider timeout or error with retry not exhausted | system | PENDING_REVIEW | providerStatus=`ERROR`; manual review queue optional |
| PENDING_REVIEW | approve | admin | APPROVED | optimistic lock with expectedVersion |
| PENDING_REVIEW | reject | admin | REJECTED | note and reasonCode required |
| PENDING_REVIEW | escalate | admin | ESCALATED | route to senior reviewer |
| ESCALATED | approve | senior admin | APPROVED | final review decision |
| ESCALATED | reject | senior admin | REJECTED | final review decision |
| REJECTED | resubmit | user | SUBMITTED | create new current attempt with attemptNo + 1 |

### Stage: IDENTITY_DOCUMENT

| Current status | Event | Actor | Next status | Notes |
| --- | --- | --- | --- | --- |
| none | submit identity document | user | SUBMITTED | preview may exist, but attempt starts on submit |
| SUBMITTED | Dojah valid, name matches, DOB matches, not expired | system | APPROVED | auto-approve |
| SUBMITTED | extractable text but provider result inconclusive | system | PENDING_REVIEW | reasonCode=`MANUAL_REVIEW_REQUIRED` |
| SUBMITTED | document unsupported or expired | system | REJECTED | reasonCode=`UNSUPPORTED_DOCUMENT` or `DOCUMENT_EXPIRED` |
| SUBMITTED | extraction failed completely | system | REJECTED or PENDING_REVIEW | phase-one policy choice; recommended `REJECTED` for hard stop, `PENDING_REVIEW` for partial extraction |
| PENDING_REVIEW | approve | admin | APPROVED | current stage completes |
| PENDING_REVIEW | reject | admin | REJECTED | note and reasonCode required |
| PENDING_REVIEW | escalate | admin | ESCALATED | elevated review |
| ESCALATED | approve | senior admin | APPROVED | final review decision |
| ESCALATED | reject | senior admin | REJECTED | final review decision |
| REJECTED | resubmit | user | SUBMITTED | create new current attempt with attemptNo + 1 |

### Stage: ADDRESS

| Current status | Event | Actor | Next status | Notes |
| --- | --- | --- | --- | --- |
| none | submit address document | user | SUBMITTED | requires IDENTITY_DOCUMENT approved first |
| SUBMITTED | phase-one policy routes every submission to review | system | PENDING_REVIEW | OCR results still populate extractedFields and comparisonSummary |
| SUBMITTED | future phase: OCR confidence high, name match, address match, recent | system | APPROVED | optional future guarded auto-approval |
| SUBMITTED | OCR flags mismatch or poor quality | system | PENDING_REVIEW | reasonCode reflects issue |
| PENDING_REVIEW | approve | admin | APPROVED | current stage completes |
| PENDING_REVIEW | reject | admin | REJECTED | note and reasonCode required |
| PENDING_REVIEW | escalate | admin | ESCALATED | elevated review |
| ESCALATED | approve | senior admin | APPROVED | final review decision |
| ESCALATED | reject | senior admin | REJECTED | final review decision |
| REJECTED | resubmit | user | SUBMITTED | create new current attempt with attemptNo + 1 |

### Stage: INCOME

| Current status | Event | Actor | Next status | Notes |
| --- | --- | --- | --- | --- |
| none | submit income document | user | SUBMITTED | requires ADDRESS approved first |
| SUBMITTED | OCR confidence high, name match, income indicators found, recent | system | APPROVED | auto-approve |
| SUBMITTED | OCR partial or inconclusive | system | PENDING_REVIEW | reasonCode=`MANUAL_REVIEW_REQUIRED` |
| SUBMITTED | hard failure due to unreadable file or missing indicators | system | PENDING_REVIEW or REJECTED | phase-one policy choice; recommended `PENDING_REVIEW` unless the file is unusable |
| PENDING_REVIEW | approve | admin | APPROVED | current stage completes |
| PENDING_REVIEW | reject | admin | REJECTED | note and reasonCode required |
| PENDING_REVIEW | escalate | admin | ESCALATED | elevated review |
| ESCALATED | approve | senior admin | APPROVED | final review decision |
| ESCALATED | reject | senior admin | REJECTED | final review decision |
| REJECTED | resubmit | user | SUBMITTED | create new current attempt with attemptNo + 1 |

## Concrete Implementation Checklist

- [x] confirm final enum names and replace the canonical individual model with `KycStageAttempt` plus `KycEvidenceAsset`.
- [ ] confirm the exact reset scope for pre-launch individual KYC data and Tier 0 restart.
- [ ] confirm address launch policy: always review or guarded auto-approve;
- [ ] define exact JSON shape for `comparisonSummary` and `extractedFields` per stage;
- [x] add the stage-attempt and evidence schema needed for launch.
- [x] add `kycJourney` to the individual profile response on the current branch.
- [x] add the stage preview and submit endpoints on the current branch.
- [x] add attempt decision and recheck endpoints on the current branch.
- [x] add the first wave of frontend `kycJourney` adapters for route resolution, prompts, generic document flows, and admin user detail.
- [ ] remove individual `verificationRequirements` from the target launch profile contract and remaining user UI flows.
- [ ] update identity-document flow to consume the final preview and submit contract without legacy success assumptions.
- [ ] switch the admin queue and detail views fully to attempt-first records and delete user-first queue compatibility fields.
- [ ] cut the one-time reset script for individual KYC state and Tier 0 restart.
- [ ] remove dual-write from individual submit and decision flows.
- [ ] remove individual backfill from the stage service.
- [ ] seed deterministic QA users for fresh-start and review-path testing.
- [ ] delete remaining individual legacy read paths before launch.

## Change Log

- 2026-04-29: initial draft created with target contract, status model, Prisma evolution plan, and stage transition matrix.
- 2026-04-29: expanded plan to cover actual frontend route gating, stage-page behavior, admin queue consumers, compatibility requirements, and frontend migration phases.
- 2026-05-01: converted the rollout from migration-heavy to clean cutover, assuming pre-launch individual KYC state can be reset instead of preserved through dual-write and backfill.