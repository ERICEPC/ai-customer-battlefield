# V1-F Controlled Management Progress Query Implementation Plan

> **Scope:** Deliver the first management-query vertical slice: an authorized manager asks for one seller's progress over an explicit “this week” interval and receives a deterministic, evidence-backed answer. This closes only controlled management progress queries, not arbitrary natural-language analytics or weekly reports.

**Goal:** Add `/ask` and `POST /api/v1/management-queries` so the synthetic and real management entry can select an authorized seller, execute `sales_weekly_progress`, inspect stable metrics and entity-level evidence, and follow links back to existing business pages.

**Architecture:** The HTTP controller and future Agent Tool adapter call the same framework-independent application port. The model never receives SQL or database credentials. PostgreSQL resolves subject and entity scope from current `entity_assignments`, executes bounded deterministic queries in one tenant transaction, and appends a minimal audit record. The Web client consumes strict contracts and never calculates authorization locally.

**Tech stack:** TypeScript ESM, Zod contracts, framework-independent core, Kysely/PostgreSQL adapter, NestJS REST, Next.js/React Web, Vitest, PGlite locally and PostgreSQL 18 in CI.

## Confirmed product decisions for this slice

- The first supported capability is exactly `sales_weekly_progress`; there is no arbitrary SQL, free-form filter language or generated answer that can invent facts.
- The client sends explicit ISO `periodStart` and `periodEnd` instants. The requested range must be positive and at most 31 days. Queries use `min(periodEnd, serverNow)` as `dataCutoffAt`, avoiding an unconfirmed tenant-timezone rule while still supporting a Web “本周” preset.
- “某销售进展” means activity on the seller's **currently responsible entities**, not a claim that the seller personally typed every fact. Action metrics remain attributed to the formal action owner.
- A seller may query their own current owner/collaborator scope. A management observer may query only active owner/collaborator users on the intersection of entities they currently observe. Same-tenant membership alone grants nothing.
- Ended, future, unassigned and foreign-tenant relationships contribute neither subject candidates nor result rows. Unauthorized and missing subjects share one not-found response.
- Every headline metric is deterministic. Entity highlights contain typed evidence references and existing application deep links; missing current analysis is reported as a data gap, never interpreted as low risk.
- The execution appends an `audit_entries` row containing capability, subject, requested interval, data cutoff and result counts, but not raw evidence text. A dedicated query-run table remains deferred until report generation needs durable response versions.
- The Web experience uses a constrained question composer: authorized seller, “本周” date interval and the supported progress question. A future Agent runtime may map natural language into the same strict request, without changing the database or REST result contract.

## Response shape

The strict response contains:

- `queryId`, `capability`, subject identity, requested period and `dataCutoffAt`;
- `scope.entityCount` and `scope.kind` (`self` or `observed_portfolio`);
- metrics for confirmed follow-ups, valid facts, stage changes, completed actions, open actions and overdue actions;
- bounded entity highlights with latest activity, concise structured counts and evidence references;
- bounded data gaps for scoped entities without a current battle-state version.

Evidence kinds are limited to `followup`, `fact`, `stage_change`, `action` and `battle_state`. Deep links target `/entities`, `/actions?actionId=…` or `/battle-map?entityId=…&stateVersion=…`; a link cannot expand authorization.

## Task 1: Freeze contracts and the framework-independent seam

**Files:**

- Create: `packages/contracts/src/management-queries.ts`
- Create: `packages/contracts/src/management-queries.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/core/src/management-queries/management-query-repository.ts`
- Create: `packages/core/src/management-queries/run-management-query.ts`
- Create: `packages/core/src/management-queries/run-management-query.test.ts`
- Create: `packages/core/src/management-queries/index.ts`
- Modify: `packages/core/src/index.ts`

1. Write RED contract tests for strict request/response schemas, interval bounds, typed evidence, bounded items and unknown-field rejection.
2. Write RED core tests proving authorization/not-found propagation, exact input delegation and no model/runtime dependency.
3. Implement the smallest schemas, records, repository port and use case needed to turn both suites GREEN.
4. Run contracts/core focused tests, typecheck, Biome and diff checks.

**Local evidence:** RED suites first failed because the management-query contracts and use cases did not exist. The GREEN implementation now accepts only `sales_weekly_progress`, rejects non-positive or over-31-day periods, bounds strict subject/result/evidence collections, prevents external evidence links, delegates actor scope without any model runtime, and exposes a bounded subject-list use case so HTTP will not depend directly on the database adapter. Contracts pass 57/57 and core passes 42/42 with package typechecks, Biome and diff checks green.

## Task 2: Implement assignment-scoped PostgreSQL projection and audit

**Files:**

- Create: `packages/database/src/management-queries/kysely-management-query-repository.ts`
- Create: `packages/database/src/management-queries/index.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/management-query-repository.test.ts`

1. Seed two seller scopes, one observed intersection, ended/future assignments, unassigned same-tenant rows and foreign-tenant rows.
2. Write RED tests for subject candidates and `sales_weekly_progress`: current scoped facts count; action ownership; evidence links; missing-analysis gaps; stable cutoff; bounded highlights; and audit metadata without evidence text.
3. Prove self scope and observed-portfolio intersection independently.
4. Prove ended, future, unassigned and cross-tenant rows disappear from subjects, metrics, highlights and gaps.
5. Implement one tenant transaction with an explicit server timestamp and repeated active-assignment predicates. Use parameterized Kysely/SQL only.
6. Inspect representative PostgreSQL 18 plans in CI; add an index only if existing assignment/entity/action/timeline indexes do not support the bounded query.

## Task 3: Expose strict REST endpoints

**Files:**

- Create: `apps/api/src/management-queries/management-queries.controller.ts`
- Create: `apps/api/src/management-queries/management-queries.module.ts`
- Create: `apps/api/src/management-queries/management-queries.providers.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/management-queries.e2e.test.ts`

1. Write RED E2E tests for `GET /api/v1/management-query-subjects` and `POST /api/v1/management-queries`.
2. Prove server-derived actor scope, strict request validation, an authorized observer result, self query, unauthorized/missing unified 404 and a different tenant result boundary.
3. Wire the core use case and database adapter; do not accept tenant, actor, role or raw SQL fields from the request body.
4. Return the repository's stable `queryId`/audit ID for traceability.

## Task 4: Deliver the `/ask` Web experience

**Files:**

- Create: `apps/web/app/ask/page.tsx`
- Create: `apps/web/src/management-queries/api-client.ts`
- Create: `apps/web/src/management-queries/api-client.test.ts`
- Create: `apps/web/src/management-queries/management-query-workspace.tsx`
- Create: `apps/web/src/management-queries/management-query-workspace.test.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/src/workspace/workspace-dashboard.tsx`

1. Write RED client/component tests for authorized subject loading, “本周” interval display, query submission, metrics, evidence links, data gaps, empty scope, validation, slow loading, retry and stale-response suppression.
2. Implement the constrained question composer and a readable answer layout; label the data cutoff and scope explicitly.
3. Replace the management-query navigation placeholder with `/ask`; add an entry from management workspace without changing the follow-up creation route.
4. At 390px keep controls at least 44px high, stack metrics/highlights and prevent horizontal overflow.

## Task 5: Acceptance, living docs, review and direct-main delivery

**Files:**

- Modify: `README.md`
- Modify: `docs/01-V1产品设计总纲.md`
- Modify: `docs/03-UI与交互设计.md`
- Modify: `docs/04-系统架构与详细设计.md`
- Modify: `task_plan.md`
- Modify: `progress.md`
- Modify: `findings.md`

1. Run frozen install, public-boundary, Biome, typecheck, full tests, production build and diff checks.
2. Run real PostgreSQL 18 subject/scope/audit acceptance in CI.
3. Run desktop and true 390×844 browser acceptance for manager query → evidence deep link, plus self scope and unauthorized API paths. Assert no console errors and no horizontal overflow.
4. Request two-axis code/spec review; resolve Critical/Important findings and refresh evidence counts.
5. Push directly to `main`, watch the matching SHA CI, and record SHA, run URL, duration and deferred boundaries.

## Acceptance gate

An authenticated manager can select only an authorized seller, ask for the supported weekly-progress capability, and receive a strict answer whose counts, entity highlights and evidence all come from the current assignment intersection and explicit time interval. A seller can query only their own current responsibility scope. Unauthorized, ended, future, unassigned and cross-tenant data are absent in subjects and answers; missing analysis is visible as a gap. The query is audited without storing raw evidence text, every deep link re-authorizes on landing, desktop/390px Web works, PostgreSQL 18 and the full repository gate pass, and the implementation remains callable as a future Agent Tool without binding the product to a model provider.
