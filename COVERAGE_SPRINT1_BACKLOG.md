# Backend Coverage Sprint 1 Backlog

## Baseline (SonarCloud)

- Project: Flipxer-web_resolve-web-services
- Overall coverage: 23.3%
- Lines to cover: 21,345
- Uncovered lines: 15,937
- Uncovered conditions: 5,250

## Sprint 1 Objective

Raise real runtime coverage by targeting high-logic, 0%-covered service files with the best line and branch ROI.

## Target Files And Estimates

| File | Current Line Coverage | Coverable Lines | Uncovered Conditions | Sprint 1 Target | Estimated New Covered Lines |
|---|---:|---:|---:|---:|---:|
| src/modules/api/rbac/services/index.ts | 0% | 163 | 60 | 55-65% | 90-105 |
| src/modules/api/banks/services/index.ts | 0% | 177 | 47 | 45-55% | 80-97 |
| src/modules/api/analytics/services/index.ts | 0% | 178 | 155 | 35-45% | 62-80 |
| src/modules/webhook/quidax/services/index.ts | 0% | 116 | 75 | 40-50% | 46-58 |
| src/modules/api/transactions/services/index.ts | 0% | 89 | 57 | 45-55% | 40-49 |
| src/modules/webhook/fincra/services/index.ts | 0% | 70 | 33 | 50-60% | 35-42 |

Planned Sprint 1 net gain: about 353 to 431 additional covered runtime lines.

## Test Scope By File

### 1) src/modules/api/rbac/services/index.ts
- Role flows: list, get by id, create duplicate guard, create success, update super-admin guard, delete default role guard.
- Permission assignment: role missing, permission mismatch, replace permissions success path.
- Admin user flows: create with privilege escalation guard, create success with userType sync, update/delete guard paths.
- Audit and seed helpers: paginated logs and permission seeding.

### 2) src/modules/api/banks/services/index.ts
- Account and payment reference validation guards.
- Payment lifecycle handlers: failed, abandoned, success.
- Order/payment not found and non-pending short-circuit branches.
- Transfer pipeline branches in processAssetValueTransferToBankHandler.
- Naira conversion branches in getAmountInNaira.

### 3) src/modules/api/analytics/services/index.ts
- Date-range resolution and period fallbacks.
- Dashboard overview aggregates and percentage-change calculations.
- Transaction volume interval grouping by granularity.
- User growth and activity aggregation branches.
- Revenue, asset distribution, conversion funnel edge branches.

### 4) src/modules/webhook/quidax/services/index.ts
- Event routing for each supported event type.
- Unknown event handling branch.
- Signature/auth validation guards.
- Retry-safe idempotency behavior.
- Error handling around downstream service failures.

### 5) src/modules/api/transactions/services/index.ts
- Status filtering and query builder branches.
- Approval/refund/retry state guards.
- Sync and export branches.
- Amount/range and conditional transaction-type branches.

### 6) src/modules/webhook/fincra/services/index.ts
- Event parsing and payment state transitions.
- Invalid payload and unsupported event guards.
- Duplicate event/idempotency path.
- Downstream failure handling and safe returns.

## Execution Order

1. RBAC service
2. Banks service
3. Analytics service
4. Quidax webhook service
5. Transactions service
6. Fincra webhook service

## Progress

- [x] Kickoff: resolve current new-code Sonar test violations in existing specs.
- [x] Add initial runtime suite for src/modules/api/rbac/services/index.ts.
- [x] Add banks service suite (35 tests).
- [x] Add analytics service suite (39 tests).
- [x] Add quidax webhook service suite (31 tests).
- [x] Add transactions service suite (27 tests).
- [x] Add fincra webhook service suite (20 tests).
- [ ] Run full backend suite and refresh SonarCloud audit.
