# Dependency Governance

This document defines Phase 4, Phase 5, and Phase 6 controls for dependency security in flipxer-web-services.

## Phase 4: Safety Validation Gates

Dependency changes must pass all of the following:

1. TypeScript compile gate: `pnpm exec tsc --noEmit`
2. Build gate: `pnpm run build`
3. Targeted runtime tests:
   - `src/modules/core/upload/services/__tests__/upload.factory-cloudinary-base.spec.ts`
   - `src/modules/core/upload/services/__tests__/imagekit.service.spec.ts`
   - `src/core/exception/http/__tests__/all-exceptions-filter.spec.ts`
   - `src/modules/api/trade/services/__tests__/websocket.service.spec.ts`
   - `src/modules/core/email/services/__tests__/index.spec.ts`

These gates are enforced by the workflow:
- `.github/workflows/dependency-regression-gates.yml`

## Phase 5: PR Strategy

Use this merge sequence for large remediation batches:

1. PR A: lockfile and package-manager normalization
2. PR B: critical and high vulnerability remediation
3. PR C: medium and low vulnerability remediation
4. PR D: optional cleanup PR for temporary overrides and version-range simplification

Rules:

- Keep each PR scoped to one remediation wave.
- Include explicit risk notes in every dependency PR.
- Run the Phase 4 validation gates before requesting merge.

## Phase 6: Ongoing Governance

1. Dependabot weekly updates are configured in `.github/dependabot.yml`.
2. Open high/critical alerts are blocked by `.github/workflows/dependabot-high-critical-gate.yml`.
3. Security overrides must remain documented in `package.json` under `overrides` and `pnpm.overrides`.
4. After each dependency merge, verify alerts:

```bash
gh api -H "Accept: application/vnd.github+json" \
  "/repos/Flipxer-web/flipxer-web-services/dependabot/alerts?state=open&per_page=100"
```

## Ownership

- Primary owner: Backend maintainers
- Reviewers: Security and platform maintainers
