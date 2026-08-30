# V1-B Follow-up Confirmation Implementation Plan

> **For agentic workers:** Execute task-by-task with test-driven development. Work directly on `main`; each milestone is committed and pushed only after focused and repository-wide verification.

**Goal:** Replace the disposable AI draft demo with a persistent, tenant-safe workflow in which a salesperson selects a business entity, generates and edits a structured draft, explicitly confirms it, and receives a formal follow-up record whose source, evidence, audit event, domain event, and Outbox message are written atomically.

**Architecture:** Agent execution stays outside database transactions. Framework-free application use cases depend on one deep `FollowupConfirmationStore` port rather than tables or Kysely. `packages/database` implements that port with transaction-local tenant context, row locks, optimistic versions, idempotency records, and one short confirmation transaction. NestJS maps versioned HTTP contracts to use cases; Next.js consumes only those contracts. AI suggestions remain candidates and no suggested action becomes a formal action in this phase.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 11.19, PostgreSQL 17+/18 CI, Kysely, PGlite, Zod, NestJS 12, Next.js 16, Vitest 4.

**Spec:** `docs/01-V1产品设计总纲.md`, `docs/02-业务数据模型.md` sections 8, 13, 19, 22–23, and `docs/04-系统架构与详细设计.md` sections 7 and 9.

## Global constraints

- A draft is never a formal fact; only `pending_confirmation` drafts can be revised, cancelled, or confirmed.
- Creation validates the business entity and referenced opportunities in the actor's tenant before persistence.
- Confirmation locks the draft, entity, and sorted opportunities; checks expiry and optimistic `versionNo`; and is idempotent by tenant, operation, and `Idempotency-Key`.
- Confirmation atomically writes the formal follow-up, opportunity links, confirmed facts, evidence links, audit entry, domain event, and Outbox message.
- Model calls, external notifications, file access, and Feishu/email calls are forbidden inside the confirmation transaction.
- A candidate action remains an unconfirmed suggestion and cannot create reminders or formal actions before the separate V1-C action-confirmation flow.
- Every new tenant table uses composite tenant foreign keys, explicit tenant query predicates, and fail-closed forced RLS.
- SQL migrations remain forward-only and immutable after publication; PGlite is local/test only and real PostgreSQL remains a CI gate.

## Public contract target

```ts
interface FollowupDraftCandidate {
  entityId: string;
  summary: string;
  occurredAt: string;
  followupType: "meeting" | "call" | "message" | "email" | "other";
  relatedOpportunityIds: string[];
  primaryOpportunityId: string | null;
  facts: Array<{ factType: string; factValue: string }>;
}

POST   /api/v1/followup-drafts
GET    /api/v1/followup-drafts/:id
PATCH  /api/v1/followup-drafts/:id
POST   /api/v1/followup-drafts/:id/cancel
POST   /api/v1/followup-drafts/:id/confirm
GET    /api/v1/followups/:id
```

Create receives `entityId`, `rawInput`, and optional `occurredAt`; PATCH receives `versionNo` and a full validated candidate; cancel/confirm receive `versionNo` plus `Idempotency-Key`. Conflicts return stable 409 codes and the latest version. Confirmation returns the draft terminal state, formal `followupId`, and event ID without exposing internal Outbox payloads.

---

### Task 1: Contract and framework-free confirmation module

**Files:**
- Modify: `packages/contracts/src/followup-draft.ts`
- Modify: `packages/contracts/src/followup-draft.test.ts`
- Create: `packages/core/src/followup-confirmation/followup-confirmation-store.ts`
- Create: `packages/core/src/followup-confirmation/manage-followup-drafts.ts`
- Create: `packages/core/src/followup-confirmation/manage-followup-drafts.test.ts`
- Modify: package indexes

- [ ] Write contract tests for UUID entity IDs, ISO timestamps, candidate facts, strict unknown-field rejection, optimistic versions, idempotency keys, terminal responses, and stable error payloads.
- [ ] Write core tests proving Agent output is normalized outside persistence; create persists only after Agent success; revision/cancel/confirm call one deep port with actor/version/idempotency; invalid transitions and stale versions surface typed domain errors.
- [ ] Implement the smallest schemas, ports, use cases, and typed errors that make focused tests pass without importing Kysely, NestJS, Next.js, or provider SDKs.
- [ ] Run both package test/typecheck/build suites and commit `feat: define persistent follow-up confirmation contract`.

### Task 2: `0003_followup_confirmation` schema and invariants

**Files:**
- Create: `packages/database/migrations/0003_followup_confirmation.sql`
- Modify: `packages/database/src/database-types.ts`
- Test: `packages/database/test/followup-confirmation-migration.test.ts`
- Modify: PostgreSQL CI expected table/RLS assertions

Tables include sources, drafts, revisions, formal follow-ups, participants, opportunity links, facts, evidence and links, idempotency records, audit entries, domain events, and Outbox messages. Edge payloads may use JSONB, but formal searchable relationships use constrained columns and composite tenant foreign keys.

- [ ] First prove RED for cross-tenant references, one source-to-draft relation, revision monotonicity, terminal-state checks, participant XOR, multi-opportunity primary rules, correction/evidence tenant safety, idempotency uniqueness, Outbox dedupe, and forced RLS.
- [ ] Implement the migration with FK-side indexes, pending-draft and timeline partial/range indexes, `(status, available_at, id)` Outbox claim index, and immutable-event timestamps.
- [ ] Extend Kysely database types and real PostgreSQL assertions; run database test/typecheck/build suites.
- [ ] Commit `feat: add follow-up confirmation schema` and verify remote PostgreSQL CI.

### Task 3: Kysely store and atomic confirmation transaction

**Files:**
- Create: `packages/database/src/followup-confirmation/kysely-followup-confirmation-store.ts`
- Create: `packages/database/test/followup-confirmation-store.test.ts`
- Modify: package exports and synthetic seed helpers

- [ ] Write integration tests for tenant-scoped create/get/revise/cancel, optimistic conflicts, expiry, idempotent repeated confirm, idempotency payload mismatch, entity/opportunity validation, rollback on a forced failure, and no cross-tenant visibility.
- [ ] Implement create using a short persistence transaction after Agent output exists; store a source hash and revision zero without placing raw content in logs.
- [ ] Implement confirmation in the documented lock order. Create formal rows, minimal audit/event payloads, and an Outbox message in the same transaction; never call an external adapter.
- [ ] Prove a repeated key returns the original result while a different request using the same key fails; prove all written rows disappear when any transaction step fails.
- [ ] Run database tests including PostgreSQL CI and commit `feat: persist confirmed follow-up facts atomically`.

### Task 4: Persistent NestJS API

**Files:**
- Modify: `apps/api/src/followup-drafts/*`
- Create: `apps/api/src/followups/*`
- Create/modify: API E2E tests

- [ ] Write real Nest + PGlite E2E tests for create/get/revise/cancel/confirm/get-formal-record, missing actor, invalid IDs, missing idempotency key, stale version 409, terminal transition 409, and tenant isolation.
- [ ] Inject the database store into core use cases while retaining an explicit unavailable adapter when no development database is configured; production remains fail-closed.
- [ ] Map typed domain errors to stable `{ code, message, requestId, issues? }` responses without leaking SQL or raw evidence.
- [ ] Run API E2E/typecheck/build and full repository regression; commit `feat: expose persistent follow-up confirmation api`.

### Task 5: Web confirmation workbench

**Files:**
- Modify: `apps/web/src/followup-drafts/*`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`
- Test: component and API-client tests

- [ ] Write UI tests for entity selection, generation, editable summary/type/time, fact rows, dirty-state revision, confirm confirmation, loading/error/conflict recovery, cancelled state, and confirmed immutable receipt.
- [ ] Load selectable entities through the existing directory contract; do not embed database or Feishu assumptions in the client.
- [ ] Make the human boundary unmistakable: the primary action says “确认并写入正式跟进”, the result identifies the confirmed salesperson and source, and suggested actions remain separately unconfirmed.
- [ ] Verify desktop and 390px mobile layouts, keyboard flow, focus, no horizontal overflow, and browser console cleanliness against the real Nest + PGlite demo.
- [ ] Run full verification and commit `feat: complete follow-up confirmation workbench`.

### Task 6: Phase acceptance and continuity

- [ ] Run clean lockfile install, public-boundary scan, lint, typecheck, all tests, production builds, and `git diff --check`.
- [ ] Push `main`, verify the remote SHA and PostgreSQL 18 Actions run, and record exact counts/URL in ignored `progress.md`.
- [ ] Update the product/data/architecture docs with implemented versus deferred behavior; do not claim action confirmation, analysis, reminders, notifications, reports, or production auth are complete.
- [ ] Mark V1-B complete in persistent plans and immediately create/execute the next vertical plan for battle analysis and separately confirmed actions.

## Acceptance gate

From the real Web app, a synthetic salesperson can select an entity, enter a follow-up, receive a structured candidate, edit it, explicitly confirm it, refresh/retrieve the immutable formal record, and observe no duplicate on retry. Database evidence proves tenant isolation, version conflict handling, atomic rollback, source/fact/evidence links, audit/domain event, and one pending Outbox message. The same migrations and transaction tests pass on PostgreSQL 18 CI. No AI suggestion creates a formal action or notification in this phase.
