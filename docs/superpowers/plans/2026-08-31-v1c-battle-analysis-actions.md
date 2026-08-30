# V1-C Battle Analysis and Confirmed Actions Implementation Plan

> **For agentic workers:** Execute task-by-task with test-driven development. Work directly on `main`; commit and push each milestone only after focused and repository-wide verification.

**Goal:** Turn confirmed follow-up facts into replayable, evidence-backed battle-state versions and action proposals, then require a separate human decision before any proposal becomes a formal business action. Deliver a native Web battle map and action-confirmation queue without starting reminders or external notifications.

**Architecture:** Fact confirmation and analysis remain separate transactions. A framework-free `BattleAnalysisStore` reads a versioned fact snapshot; a replaceable analyzer produces schema-bound signals, scores, gaps, and action candidates outside database transactions. A short persistence transaction rejects stale input, appends an immutable battle-state version, updates the current projection, records evidence, and stores pending proposals. A separate deep `ActionDecisionStore` atomically accepts or rejects one proposal with optimistic versioning and idempotency. Formal actions are deterministic application writes; no model receives SQL or direct table access.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 11.19, PostgreSQL 17+/18 CI, Kysely, PGlite, Zod, NestJS 12, Next.js 16, Vitest 4.

**Spec:** `docs/01-V1产品设计总纲.md` sections 6–10, `docs/02-业务数据模型.md` sections 9–10 and 13–19, `docs/03-UI与交互设计.md` sections 6–9, and `docs/04-系统架构与详细设计.md` sections 7–11.

## Global constraints

- Only confirmed formal facts and explicit master data can feed analysis; raw input and pending drafts never affect scores, quadrants, risk, or proposals.
- Analyzer/model calls are outside transactions. Persistence accepts only strict versioned output and never trusts provider prose.
- Every analysis records the exact fact/input watermark, rule version, analyzer configuration, evidence, data sufficiency, and terminal status.
- A late run cannot replace a current projection created from newer facts. It becomes `superseded` and creates no actionable proposal.
- Scores are explainable 0–100 values; insufficient data is explicit and must not be disguised as a precise score.
- `battle_state_versions` are immutable. `battle_state_current` is a rebuildable projection and never the sole source of truth.
- An `action_proposal` is not a task. It cannot enter reminders, reports-as-completed, or notification scheduling until separately accepted.
- Accept/reject decisions require the proposal version and `Idempotency-Key`. Acceptance validates a same-tenant owner, planned time, priority, source, and current proposal state.
- Accepting atomically creates one formal action, initial status history, audit entry, domain event, idempotency result, and Outbox message. Rejection retains reason and audit history without creating an action.
- Reminder policies/instances, notification delivery, reports, management queries, configurable admin UI, and production authentication remain deferred.
- Every new tenant table uses composite tenant foreign keys, explicit tenant predicates, and forced RLS. Real PostgreSQL 18 remains a CI gate.

## Public contract target

```text
POST /api/v1/business-entities/:id/analysis-runs
GET  /api/v1/business-entities/:id/battle-state
GET  /api/v1/battle-map

GET  /api/v1/action-proposals
GET  /api/v1/action-proposals/:id
POST /api/v1/action-proposals/:id/accept
POST /api/v1/action-proposals/:id/reject

GET  /api/v1/actions
GET  /api/v1/actions/:id
POST /api/v1/actions/:id/transition
```

Analysis requests accept an entity ID plus an optional expected input watermark. Map and queue reads use cursor pagination and bounded filters. Accept receives proposal `versionNo`, owner, priority, planned time, and editable title/description; reject receives `versionNo` and a required reason. Decisions carry `Idempotency-Key`. Action transition is optimistic and supports only the documented state machine.

---

### Task 1: Contracts and framework-free analysis/action modules

**Files:**
- Create: `packages/contracts/src/battle-analysis.ts`
- Create: `packages/contracts/src/business-actions.ts`
- Create tests and modify contract indexes
- Create: `packages/core/src/battle-analysis/*`
- Create: `packages/core/src/action-decisions/*`
- Modify core indexes

- [x] First write contract tests for strict candidates, score ranges, sufficiency/risk/quadrant codes, evidence references, cursor filters, proposal versions, acceptance/rejection payloads, action transitions, terminal receipts, and stable errors.
- [x] Write core tests proving facts are read before analyzer execution, analyzer execution is outside persistence, stale input is surfaced explicitly, and only one deep Store call persists a validated result.
- [x] Write action-decision tests for separate acceptance/rejection, required owner/time/source, optimistic conflict, expiry, terminal-state rejection, idempotent repeat, and invalid transitions.
- [x] Implement the smallest provider-free schemas, ports, use cases, clocks, ID seams, and typed errors that make the tests pass.
- [x] Run focused and full verification; commit `feat: define battle analysis and action contracts`.

### Task 2: `0004_battle_analysis_actions` schema and invariants

**Files:**
- Create: `packages/database/migrations/0004_battle_analysis_actions.sql`
- Modify: `packages/database/src/database-types.ts`
- Create: `packages/database/test/battle-analysis-actions-migration.test.ts`
- Modify: real PostgreSQL expected table/RLS assertions

Tables: `analysis_runs`, `business_signals`, `battle_state_versions`, `battle_state_current`, `battle_state_evidence_links`, `action_proposals`, `business_actions`, and `action_status_history`. Reuse existing `idempotency_records`, `audit_entries`, `domain_events`, and `outbox_messages` rather than creating feature-specific duplicates.

- [x] Prove RED for cross-tenant references, score/risk/sufficiency/status checks, immutable version numbering, one current projection per entity, evidence XOR/uniqueness, stale watermark protection, proposal expiry/terminal metadata, one action per accepted proposal, action owner tenant safety, and valid action transitions.
- [x] Implement composite foreign keys, forced RLS, FK-side indexes, current-map/filter indexes, pending-proposal indexes, owner/due-action indexes, and immutable-history constraints.
- [x] Keep `battle_state_current` replaceable and derived; do not use triggers to hide application decisions or model rules.
- [x] Extend real PostgreSQL 18 assertions and migration transaction smoke tests; commit `feat: add battle analysis and action schema`.

### Task 3: Kysely analysis persistence and separate action decision transactions

**Files:**
- Create: `packages/database/src/battle-analysis/kysely-battle-analysis-store.ts`
- Create: `packages/database/src/action-decisions/kysely-action-decision-store.ts`
- Create integration tests and modify package exports/seed helpers

- [x] Write integration tests for tenant-scoped fact snapshots, deterministic watermarking, append-only versions, evidence chains, projection replacement, late-run suppression, proposal creation, and empty/insufficient data.
- [x] Implement analysis start/failure/completion without keeping a transaction open across analyzer work. On completion, lock the entity/current projection, compare the fact watermark, append results, and update the projection only when current.
- [x] Write acceptance/rejection integration tests for fixed lock order, editable accepted fields, same-tenant owner, expiry, optimistic conflict, request-hash idempotency, terminal repeat, rollback on Outbox failure, and no cross-tenant visibility.
- [x] Implement formal action creation plus initial status history/audit/event/Outbox in one short transaction; rejected proposals never create actions.
- [ ] Run PGlite and PostgreSQL transaction verification; commit `feat: persist battle states and confirmed actions`.

### Task 4: Analysis, map, proposal, and action REST APIs

**Files:**
- Create/modify NestJS modules under `apps/api/src/battle-analysis`, `battle-map`, and `business-actions`
- Create/modify real Nest + PGlite E2E tests

- [ ] Write E2E tests for request analysis, retrieve current/evidence, map pagination/filtering, proposal queue/detail, accept/reject idempotency, formal action retrieval/transition, malformed IDs, missing actor, stale versions, terminal conflicts, and tenant isolation.
- [ ] Add a deterministic development analyzer behind the core analyzer interface. It must use synthetic, explicit rules and expose its fixed rule/config version; no provider SDK enters controllers or transactions.
- [ ] Map typed failures to stable 400/404/409/422 error contracts without leaking SQL, prompts, or evidence text.
- [ ] Keep production fail-closed when required database/analyzer/auth adapters are unavailable.
- [ ] Run API and full repository verification; commit `feat: expose battle analysis and action api`.

### Task 5: Native battle map and action confirmation Web flows

**Files:**
- Create: `apps/web/app/battle-map/*`
- Create: `apps/web/app/actions/*`
- Create feature clients/components/tests under `apps/web/src`
- Modify AppShell navigation and shared responsive styles

- [ ] Build a native map page with T0 cards, KPI summary, relationship × potential plot, data-sufficiency treatment, selected-point explanation, evidence list, and an accessible table/list equivalent.
- [ ] Build an action-proposal queue where one proposal is reviewed at a time; require owner, time, priority, source visibility, explicit “创建经营动作”, and a reason for rejection.
- [ ] Show proposals and formal actions as different objects/states. Never label pending proposals as tasks and never imply reminders are active.
- [ ] Cover loading, empty, insufficient data, analyzer failure, stale analysis, version conflict, retry with stable idempotency, accepted/rejected terminal receipts, and refresh recovery.
- [ ] Verify desktop and 390px mobile layouts, keyboard operation, non-color point encoding, no horizontal overflow, and console cleanliness against the real Nest + PGlite demo.
- [ ] Run full verification; commit `feat: add battle map and action confirmation workspace`.

### Task 6: Phase acceptance and continuity

- [ ] Run frozen-lockfile install, public-boundary scan, lint, typecheck, all tests, production builds, `git diff --check`, and real PostgreSQL 18 CI.
- [ ] Prove from the real Web app: confirmed fact → analysis version/evidence → current map point → pending proposal → separate human acceptance → one formal action; prove retry creates no duplicate.
- [ ] Record exact counts, remote SHA, CI URL, implemented/deferred boundaries, and browser evidence in ignored `progress.md` and public living docs.
- [ ] Mark V1-C complete only for this slice, then immediately plan/execute Outbox consumption, in-app/Feishu notification adapters, and reminders.

## Acceptance gate

On synthetic data, a confirmed follow-up can trigger a replayable analysis whose immutable state and evidence explain the map position. A late analysis cannot overwrite newer state. The Web map has an accessible list equivalent and makes data gaps visible. An action proposal remains non-operative until a salesperson explicitly accepts it with owner, priority, and planned time; acceptance is idempotent and creates exactly one formal action with source, history, audit, event, and Outbox, while rejection creates none. Tenant isolation, rollback, and constraints pass on PostgreSQL 18. No reminder or external notification is claimed active in this phase.
