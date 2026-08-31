# V1-G Personal and Managed-Portfolio Weekly Reports Implementation Plan

> **Scope:** Deliver immutable, evidence-backed personal and managed-portfolio weekly report snapshots with human review, publication, history and notification. This slice does not silently invent an organization tree, tenant timezone, automatic schedule or reminder-escalation timing.

**Goal:** Add `/reports` and strict report APIs so a seller can generate and publish a personal weekly report, while a management observer can generate and publish a report for the portfolio they currently observe. Both report types use the same formal facts as management queries, render four structured sections, preserve evidence and publish through the channel-neutral notification pipeline.

**Architecture:** Extract the deterministic weekly-progress projection behind V1-F into a database-internal reusable component. Management queries keep their authorization, idempotency and audit boundary; report generation resolves its own current scope and snapshots the projection into immutable report/version/item/evidence tables. Framework-independent use cases own lifecycle transitions. Publication writes audit, `weekly_report.published.v1` Outbox and in-app notification intent transactionally; the existing Worker and optional Feishu adapter handle delivery after commit.

**Tech stack:** TypeScript ESM, Zod contracts, framework-independent core, Kysely/PostgreSQL 17+ adapter, NestJS REST, Next.js/React Web, existing Outbox/notification Worker, Vitest, PGlite locally and PostgreSQL 18 in CI.

## Confirmed and reversible decisions

- A **personal report** snapshots the subject seller's current owner/collaborator entity scope. The authenticated seller can generate only their own personal report.
- A **managed-portfolio report** snapshots the authenticated manager's current `management_observer` entities. Its UI label explains that it is the current management scope, not an unverified department or full tenant.
- The request carries explicit ISO `periodStart` and exclusive `periodEnd`, with the same positive/31-day bound as V1-F. `dataCutoffAt = min(periodEnd, serverNow)`. No tenant timezone is hard-coded.
- Generation and revision are deterministic in V1-G. No model call is required to calculate metrics, choose facts or authorize evidence. A future versioned summary generator may consume the same structured snapshot without changing report identity or facts.
- The four sections are `progress`, `risk`, `next_action` and `data_gap`. Items are bounded structured records. Reviewers may include/exclude an item and edit one bounded report note, but may not rewrite source-derived item content or evidence.
- Generation completes into `in_review`. Publication freezes the version. A correction creates the next version in the same report series and records the prior published version; it never overwrites published rows.
- Before publishing an in-review version, current scope is recomputed and compared with its stored fingerprint. Scope loss returns not-found; scope change returns a conflict and requires regeneration. A published report remains a delivered artifact available only to its explicit audience; every evidence deep link still re-authorizes against current business permissions.
- Personal report audience is the subject seller. Managed-portfolio report audience is the generating manager in this slice. Configurable team distribution is deferred until organization/access administration exists.
- `POST /reports` requires `Idempotency-Key`. Same actor/key/request/scope replays the same version; a changed request or scope conflicts. Report review and publish transitions use optimistic `versionNo` and are naturally retry-safe.
- A published report creates one channel-neutral `weekly_report_published` notification event with a `/reports?reportId=...&versionId=...` deep link. In-app is the durable truth; optional Feishu delivery is an adapter and cannot roll back publication.
- Generation is manually triggered in V1-G. Versioned automatic generation/publish schedules and action reminder escalation are V1-H, because their weekday, timezone, offsets and recipients are not yet confirmed.

## Snapshot shape and limits

- One report covers at most 500 scoped entities and 5000 source rows per event kind, matching V1-F's truthful completeness bound.
- `progress` contains confirmed follow-ups, valid facts, opportunity stage changes and completed actions within the explicit interval.
- `risk` contains overdue open actions and evidence-backed current risk/battle-state items at the cutoff.
- `next_action` contains planned/in-progress formal actions visible at the cutoff.
- `data_gap` identifies scoped entities without a battle-state version at the cutoff.
- Team-level metrics and evidence are deduplicated by stable source ID across collaborating sellers. Member attribution is retained separately and is never presented as a deduplicated team total unless it is actually deduplicated.
- Item summary is capped at 500 characters, report note at 2000, and deep links remain application-relative and identifier-bound.

## Task 1: Freeze contracts, lifecycle and shared projection seam

**Files:**

- Create: `packages/contracts/src/weekly-reports.ts`
- Create: `packages/contracts/src/weekly-reports.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/core/src/weekly-reports/weekly-report-repository.ts`
- Create: `packages/core/src/weekly-reports/weekly-report-use-cases.ts`
- Create: `packages/core/src/weekly-reports/weekly-report-use-cases.test.ts`
- Create: `packages/core/src/weekly-reports/index.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/database/src/weekly-progress/weekly-progress-projection.ts`
- Modify: `packages/database/src/management-queries/kysely-management-query-repository.ts`

1. Write RED contract tests for strict generate/review/publish/revise/list/detail shapes, four section kinds, relative evidence routes, explicit periods, bounded collections and unknown-field rejection.
2. Write RED lifecycle tests for current-scope generation, item inclusion/note review, optimistic conflicts, publish freeze, idempotent publish, revision and unified inaccessible/not-found behavior.
3. Define a framework-independent repository port; HTTP, Worker and future Agent Tool may call use cases but cannot read report tables directly.
4. Extract V1-F's deterministic event collection/aggregation into a transaction-scoped projection helper while preserving all V1-F results and tests unchanged.
5. Run contracts, core and management-query database regression tests before moving to schema work.

## Task 2: Add `0006_weekly_reports` and tenant-safe invariants

**Files:**

- Create: `packages/database/migrations/0006_weekly_reports.sql`
- Modify: `packages/database/src/database-types.ts`
- Create: `packages/database/test/weekly-reports-migration.test.ts`
- Modify: `packages/database/test/postgres-migrations.postgres.test.ts`

1. Write RED migration tests before adding SQL.
2. Add `weekly_reports` series identity, `weekly_report_versions`, `weekly_report_scope_entities`, `weekly_report_items`, `report_evidence_links` and `weekly_report_audiences`.
3. Use composite tenant foreign keys, forced RLS, partial/current indexes, positive version numbers, exclusive period checks and explicit status checks.
4. Enforce one version number per series, one item key per version, one evidence key per item and one audience user/role per version.
5. Add triggers that reject changes to source-derived fields after insert and reject every update/delete of published versions, items, scope or evidence. Permit only reviewed note/item-inclusion changes while the parent is `in_review`.
6. Extend notification event/template constraints for `weekly_report_published` using a new migration only; never edit `0005`.
7. Verify cross-tenant references, fail-closed RLS, publication immutability and empty-database migration on PostgreSQL 18.

## Task 3: Implement generation, review, publication and revision persistence

**Files:**

- Create: `packages/database/src/weekly-reports/kysely-weekly-report-repository.ts`
- Create: `packages/database/src/weekly-reports/index.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/weekly-report-repository.test.ts`
- Modify: notification/Outbox stores only through their existing public seams where possible

1. Seed personal, overlapping collaborator, observed portfolio, ended/future assignment, same-tenant unobserved and foreign-tenant evidence.
2. Write RED tests proving personal and managed scope, unique team totals, member attribution, four sections, data gaps, exact evidence routes and row limits.
3. Prove generation idempotency, scope-fingerprint conflicts, scope revocation, review optimistic locking, publish freeze, revision lineage and audit without source-body duplication.
4. Generate the series/version/scope/items/evidence/audience in one tenant transaction using the shared weekly projection.
5. Publish in one tenant transaction: reauthorize scope, transition the report version, append audit and Outbox once, and make retries return the same published record.
6. Have the existing Outbox path materialize one in-app event and optional external delivery without coupling report publication to Feishu availability.

## Task 4: Expose strict report REST APIs

**Files:**

- Create: `apps/api/src/weekly-reports/weekly-reports.controller.ts`
- Create: `apps/api/src/weekly-reports/weekly-reports.module.ts`
- Create: `apps/api/src/weekly-reports/weekly-reports.providers.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/weekly-reports.e2e.test.ts`

1. Write RED E2E tests for list, generate, detail, review update, publish and revise.
2. Expose `GET /api/v1/reports`, `POST /api/v1/reports`, `GET /api/v1/reports/:versionId`, `PATCH /api/v1/reports/:versionId/review`, `POST /api/v1/reports/:versionId/publish` and `POST /api/v1/reports/:versionId/revise`.
3. Derive tenant/actor/scope only from the server identity boundary. Reject tenant/user/audience/scope/SQL overrides and require idempotency where a write may be retried ambiguously.
4. Map invalid input to 400, inaccessible/missing to unified 404, version/scope/idempotency conflicts to 409, limits to 422 and missing persistence to 503.
5. Prove a seller cannot generate a managed report, a manager cannot generate another seller's personal report, and same-tenant membership/cross-tenant IDs grant nothing.

## Task 5: Deliver responsive `/reports` review and publication

**Files:**

- Create: `apps/web/app/reports/page.tsx`
- Create: `apps/web/src/weekly-reports/api-client.ts`
- Create: `apps/web/src/weekly-reports/api-client.test.ts`
- Create: `apps/web/src/weekly-reports/weekly-report-workspace.tsx`
- Create: `apps/web/src/weekly-reports/weekly-report-workspace.test.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: workspace/report navigation links

1. Write RED client/component tests for list/history, personal/managed availability, explicit week generation, four sections, evidence, gaps, inclusion toggles, note, conflict recovery, publish, revision and empty/slow/error states.
2. Render report type and exact scope honestly: `个人周报` or `管理范围周报`, never `全团队` when organization scope is unknown.
3. Keep source text read-only; provide only include/exclude and report-note controls. Show period, cutoff, version, data sufficiency, generator version and publication state.
4. After publication, show immutable history and delivery status. Notification deep links open the exact report version; evidence links reauthorize on their destination.
5. At 390px stack cards and controls, keep touch targets at least 44px, avoid horizontal overflow and preserve the four-section reading order.

## Task 6: Acceptance, docs, review and direct-main delivery

**Files:**

- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/01-V1产品设计总纲.md`
- Modify: `docs/02-业务数据模型.md`
- Modify: `docs/03-UI与交互设计.md`
- Modify: `docs/04-系统架构与详细设计.md`
- Modify: `task_plan.md`, `progress.md`, `findings.md`

1. Run frozen install, public-boundary, Biome, all typechecks, full tests, production builds and diff checks.
2. Run PostgreSQL 18 empty migration, RLS, constraints, representative report projection plans and simultaneous generation/publish idempotency.
3. Run desktop and true 390×844 browser acceptance for personal generate → review → publish → notification → exact report/evidence, then managed-portfolio generate/publish and unauthorized paths.
4. Request two-axis Standards/Spec review; resolve all Critical and Important findings and rerun the complete gate.
5. Push directly to `main`, watch the matching SHA CI and record SHA, run URL, duration and deferred V1-H boundaries.

## Acceptance gate

A seller can generate, review and publish only their own evidence-backed weekly snapshot. A manager can generate, review and publish only the current portfolio they are authorized to observe, with overlapping member evidence deduplicated and scope named truthfully. Both report types show an explicit interval/cutoff, four structured sections, source evidence and data gaps; reviewers cannot rewrite facts. Scope is revalidated before publication, published versions are immutable and revisions preserve lineage. Publication succeeds independently of external channels, creates one in-app notification and may create one Feishu delivery. Unauthorized, ended, future, unobserved and cross-tenant data never enter the report. PostgreSQL 18, full repository tests/builds, desktop/390px browser flows and final review all pass.
