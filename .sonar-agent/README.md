# Sonar Agent Coordination System

This folder contains the directory-level coverage backlog and assignment artifacts for parallel test coverage work on uncovered source areas.

## Files

- `uncovered-directories.json`: full directory map with uncovered line totals.
- `agent-shards.json`: balanced initial split across 6 agents.
- `work-queue.json`: shared claim queue for dynamic, non-overlapping execution.
- `work-queue.lock`: lock file created automatically by claim/complete/release scripts.

## Why this prevents overlap

- Every unit of work is a unique directory path in `work-queue.json`.
- Agents must acquire an exclusive filesystem lock before editing queue state.
- A directory can only be in one state at a time: `pending`, `in_progress`, or `done`.
- Claiming sets `claimedBy` and lease timestamps, so no second agent can claim the same directory.
- Expired leases are recycled back to `pending` by the claim script.

## Standard Workflow

Run from `flipxer-web-services` root.

1. Claim assigned directory by ID (recommended for kickoff)

   `powershell -File tools/sonar-agent/claim-item.ps1 -AgentId sonar-agent-1 -ItemId <id>`

2. Or claim highest-priority pending directory

   `powershell -File tools/sonar-agent/claim-next.ps1 -AgentId sonar-agent-1`

3. Implement tests for files in the claimed directory

4. Mark complete

   `powershell -File tools/sonar-agent/complete-item.ps1 -AgentId sonar-agent-1 -ItemId <id> -Notes "added service and edge-case tests"`

5. If blocked, release back to queue

   `powershell -File tools/sonar-agent/release-item.ps1 -AgentId sonar-agent-1 -ItemId <id> -Reason "dependency on provider fixture"`

6. Monitor queue

   `powershell -File tools/sonar-agent/queue-status.ps1`

## Kickoff Sheet

- Launch-ready 6-agent wave-1 plan: `.sonar-agent/KICKOFF_6_AGENT_PLAN.md`
- Includes first 3 claim IDs per agent and target test files from current Sonar uncovered data.

## Suggested Team Policy

- One branch per claimed directory: `test/coverage-<agent>-<directory-slug>`
- Maximum active claims per agent: 2
- Lease duration: 120 minutes
- Rebalance after each 20 completed queue items using latest Sonar data

## Rebuild Map and Queue

Regenerate `uncovered-directories.json` and `work-queue.json` after major merges so the queue reflects current Sonar uncovered lines.
