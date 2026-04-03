# 6-Agent Coverage Kickoff Sheet

Generated (UTC): 2026-03-29 09:10:15Z
Project: Flipxer-web_resolve-web-services
Scope: First 3 queue claims per agent (non-overlapping)

## Launch Steps
1. Create branch per claim using format: test/coverage-<agent>-<claim-id>
2. Claim assigned item with claim-item script so assignments stay deterministic.
3. Implement tests in listed target files, run focused jest, then mark complete.

## Agent Assignments

### sonar-agent-1

- Claim 1: src/modules/api/auth/services (1214 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-1 -ItemId 1
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-1 -ItemId 1 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/auth/services/__tests__/index.spec.ts (targets src/modules/api/auth/services/index.ts, uncovered: 713)
    - src/modules/api/auth/services/__tests__/tier-verification.service.spec.ts (targets src/modules/api/auth/services/tier-verification.service.ts, uncovered: 180)
    - src/modules/api/auth/services/__tests__/transaction.service.spec.ts (targets src/modules/api/auth/services/transaction.service.ts, uncovered: 155)

- Claim 55: src/modules/api/rbac/controllers (16 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-1 -ItemId 55
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-1 -ItemId 55 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/rbac/controllers/__tests__/index.spec.ts (targets src/modules/api/rbac/controllers/index.ts, uncovered: 14)
    - src/modules/api/rbac/controllers/__tests__/seed.controller.spec.ts (targets src/modules/api/rbac/controllers/seed.controller.ts, uncovered: 2)

- Claim 61: src/modules/core/rate-limit/interceptors (12 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-1 -ItemId 61
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-1 -ItemId 61 -Notes wave-1-complete
  - Target test files:
    - src/modules/core/rate-limit/interceptors/__tests__/rate-limit.interceptor.spec.ts (targets src/modules/core/rate-limit/interceptors/rate-limit.interceptor.ts, uncovered: 12)

### sonar-agent-2

- Claim 2: src/modules/api/trade/services (1008 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-2 -ItemId 2
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-2 -ItemId 2 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/trade/services/__tests__/index.spec.ts (targets src/modules/api/trade/services/index.ts, uncovered: 390)
    - src/modules/api/trade/services/__tests__/send.service.spec.ts (targets src/modules/api/trade/services/send.service.ts, uncovered: 235)
    - src/modules/api/trade/services/__tests__/buy-order.service.spec.ts (targets src/modules/api/trade/services/buy-order.service.ts, uncovered: 234)

- Claim 25: src/modules/api/session/services (79 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-2 -ItemId 25
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-2 -ItemId 25 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/session/services/__tests__/index.spec.ts (targets src/modules/api/session/services/index.ts, uncovered: 79)

- Claim 32: src/modules/api/banks/controllers (46 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-2 -ItemId 32
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-2 -ItemId 32 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/banks/controllers/__tests__/index.spec.ts (targets src/modules/api/banks/controllers/index.ts, uncovered: 27)
    - src/modules/api/banks/controllers/__tests__/admin-order.controller.spec.ts (targets src/modules/api/banks/controllers/admin-order.controller.ts, uncovered: 11)
    - src/modules/api/banks/controllers/__tests__/fincra-webhook.controller.spec.ts (targets src/modules/api/banks/controllers/fincra-webhook.controller.ts, uncovered: 7)

### sonar-agent-3

- Claim 3: src/modules/api/trade/services/ledger (441 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-3 -ItemId 3
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-3 -ItemId 3 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/trade/services/ledger/__tests__/ledger.service.spec.ts (targets src/modules/api/trade/services/ledger/ledger.service.ts, uncovered: 291)
    - src/modules/api/trade/services/ledger/__tests__/sweep.service.spec.ts (targets src/modules/api/trade/services/ledger/sweep.service.ts, uncovered: 75)
    - src/modules/api/trade/services/ledger/__tests__/transaction-monitor.service.spec.ts (targets src/modules/api/trade/services/ledger/transaction-monitor.service.ts, uncovered: 20)

- Claim 10: src/modules/api/operations/services (219 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-3 -ItemId 10
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-3 -ItemId 10 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/operations/services/__tests__/wallet-management.service.spec.ts (targets src/modules/api/operations/services/wallet-management.service.ts, uncovered: 87)
    - src/modules/api/operations/services/__tests__/slack-webhook.service.spec.ts (targets src/modules/api/operations/services/slack-webhook.service.ts, uncovered: 80)
    - src/modules/api/operations/services/__tests__/liquidity-alert.service.spec.ts (targets src/modules/api/operations/services/liquidity-alert.service.ts, uncovered: 52)

- Claim 14: src/modules/api/trade/crons (147 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-3 -ItemId 14
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-3 -ItemId 14 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/trade/crons/__tests__/withdrawal-queue.cron.spec.ts (targets src/modules/api/trade/crons/withdrawal-queue.cron.ts, uncovered: 114)
    - src/modules/api/trade/crons/__tests__/sweep.cron.spec.ts (targets src/modules/api/trade/crons/sweep.cron.ts, uncovered: 14)
    - src/modules/api/trade/crons/__tests__/stuck-order-reconciliation.cron.spec.ts (targets src/modules/api/trade/crons/stuck-order-reconciliation.cron.ts, uncovered: 10)

### sonar-agent-4

- Claim 4: src/libs/quidax (411 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-4 -ItemId 4
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-4 -ItemId 4 -Notes wave-1-complete
  - Target test files:
    - src/libs/quidax/__tests__/index.spec.ts (targets src/libs/quidax/index.ts, uncovered: 411)

- Claim 9: src/modules/scheduler/services (227 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-4 -ItemId 9
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-4 -ItemId 9 -Notes wave-1-complete
  - Target test files:
    - src/modules/scheduler/services/__tests__/manageBalance.spec.ts (targets src/modules/scheduler/services/manageBalance.ts, uncovered: 84)
    - src/modules/scheduler/services/__tests__/manageOrder.spec.ts (targets src/modules/scheduler/services/manageOrder.ts, uncovered: 73)
    - src/modules/scheduler/services/__tests__/coinGecko.spec.ts (targets src/modules/scheduler/services/coinGecko.ts, uncovered: 60)

- Claim 13: src/modules/api/kyc/services (157 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-4 -ItemId 13
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-4 -ItemId 13 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/kyc/services/__tests__/index.spec.ts (targets src/modules/api/kyc/services/index.ts, uncovered: 157)

### sonar-agent-5

- Claim 5: src/modules/api/auth/guard (325 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-5 -ItemId 5
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-5 -ItemId 5 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/auth/guard/__tests__/index.spec.ts (targets src/modules/api/auth/guard/index.ts, uncovered: 325)

- Claim 8: src/modules/factory/trading/providers/livecoinwatch/services (234 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-5 -ItemId 8
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-5 -ItemId 8 -Notes wave-1-complete
  - Target test files:
    - src/modules/factory/trading/providers/livecoinwatch/services/__tests__/index.spec.ts (targets src/modules/factory/trading/providers/livecoinwatch/services/index.ts, uncovered: 234)

- Claim 12: src/modules/factory/bank/providers (174 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-5 -ItemId 12
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-5 -ItemId 12 -Notes wave-1-complete
  - Target test files:
    - src/modules/factory/bank/providers/__tests__/nomba.provider.spec.ts (targets src/modules/factory/bank/providers/nomba.provider.ts, uncovered: 97)
    - src/modules/factory/bank/providers/__tests__/fincra.provider.spec.ts (targets src/modules/factory/bank/providers/fincra.provider.ts, uncovered: 77)

### sonar-agent-6

- Claim 6: src/modules/api/trade/services/webhook-handlers (277 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-6 -ItemId 6
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-6 -ItemId 6 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/trade/services/webhook-handlers/__tests__/withdrawal-webhook.handler.spec.ts (targets src/modules/api/trade/services/webhook-handlers/withdrawal-webhook.handler.ts, uncovered: 162)
    - src/modules/api/trade/services/webhook-handlers/__tests__/deposit-webhook.handler.spec.ts (targets src/modules/api/trade/services/webhook-handlers/deposit-webhook.handler.ts, uncovered: 83)
    - src/modules/api/trade/services/webhook-handlers/__tests__/swap-webhook.handler.spec.ts (targets src/modules/api/trade/services/webhook-handlers/swap-webhook.handler.ts, uncovered: 32)

- Claim 7: src/modules/api/notification/services (252 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-6 -ItemId 7
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-6 -ItemId 7 -Notes wave-1-complete
  - Target test files:
    - src/modules/api/notification/services/__tests__/push.notification.service.spec.ts (targets src/modules/api/notification/services/push.notification.service.ts, uncovered: 97)
    - src/modules/api/notification/services/__tests__/admin.notification.service.spec.ts (targets src/modules/api/notification/services/admin.notification.service.ts, uncovered: 68)
    - src/modules/api/notification/services/__tests__/notification-dispatcher.service.spec.ts (targets src/modules/api/notification/services/notification-dispatcher.service.ts, uncovered: 55)

- Claim 11: src/modules/factory/trading/providers/coingecko/services (179 uncovered lines)
  - Claim command: powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-6 -ItemId 11
  - Complete command: powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-6 -ItemId 11 -Notes wave-1-complete
  - Target test files:
    - src/modules/factory/trading/providers/coingecko/services/__tests__/index.spec.ts (targets src/modules/factory/trading/providers/coingecko/services/index.ts, uncovered: 179)

## Guardrails
- Do not work outside assigned claim IDs in wave 1.
- If blocked, release item: powershell -File tools/sonar-agent/release-item.ps1 -AgentId agent-id -ItemId item-id -Reason blocked
- Monitor queue: powershell -File tools/sonar-agent/queue-status.ps1
