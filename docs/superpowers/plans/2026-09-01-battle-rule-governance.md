# Battle Rule Governance Implementation Plan

> **Execution mode:** small commits directly to `main`, affected tests only, real PostgreSQL verification at the database cutover.

**Goal:** Replace hardcoded battle scoring with a tenant-scoped immutable rule release shared by API and Worker, then expose controlled version management in the existing system-management page.

**Spec:** `docs/superpowers/specs/2026-09-01-battle-rule-governance-design.md`

## Constraints

- Preserve the current deterministic output in the default rule.
- Keep `tenant_id`, forced RLS, version history, release history, audit actor/reason, and fail-closed resolution.
- Do not stage the user's existing `apps/web/next-env.d.ts` change.
- Do not run the full repository test suite during the slice.

### Task 1: Deep core rule seam without behavior change

- [x] Define the bounded rule schema, default rule, resolved-rule receipt, and resolver port in core.
- [x] Change `RequestBattleAnalysis` to resolve once and persist/pass the same receipt.
- [x] Change `DeterministicBattleAnalyzer` to calculate entirely from the supplied rule content.
- [x] Prove default behavior and failure ordering with focused core tests.

### Task 2: PostgreSQL rule repository and capability

- [x] Add `business_rules.manage` to the closed capability vocabulary and repair default leader grants for existing tenants.
- [x] Add immutable version/current release/release history tables, new-tenant seeding, forced RLS, constraints, fingerprints, and indexes.
- [x] Implement a transactional resolver/manager with advisory locking, deduplication, publish/rollback, audit, and strict persisted JSON validation.
- [x] Prove tenant isolation, authorization, immutability, release history, and runtime resolution with focused database tests.

### Task 3: Shared API and Worker runtime wiring

- [x] Inject the PostgreSQL resolver into API analysis and Worker follow-up automation.
- [x] Remove both hardcoded rule-version strings.
- [x] Prove the two entry points resolve and record the same tenant release.

### Task 4: Rule-management API and visible UI

- [x] Add strict contracts and capability-protected list/create/release endpoints.
- [x] Add the independently loaded “作战规则” card with current release, bounded editor, version list, mandatory reason, publish, and rollback.
- [x] Serve and display stage labels from the released rule projection.
- [x] Verify the real leader browser experience and permission-limited account behavior.

### Task 5: Real cutover and handoff

- [x] Apply migrations to the real PostgreSQL 16 database and verify one default release per existing tenant.
- [x] Run one real confirmed-follow-up automation and one manual analysis; verify matching receipts and visible map/list labels.
- [x] Run affected typechecks, focused tests, public-boundary/staged-diff checks.
- [x] Commit and push each safe vertical slice to `main`; update persistent progress files and publish visible acceptance steps.
