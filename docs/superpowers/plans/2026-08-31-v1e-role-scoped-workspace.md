# V1-E Role-Scoped Workspace Implementation Plan

> **For agentic workers:** implement task-by-task with test-first checkpoints; keep every write behind the existing tenant/actor context and push verified increments directly to `main`.

**Goal:** Complete the product V1-A homepage requirement with one role-scoped workspace that tells a seller what needs confirmation or action and gives a management observer an evidence-backed portfolio overview, without granting tenant-wide visibility or inventing unconfirmed report/reminder rules.

**Architecture:** Add a read-only workspace projection over the existing `0001`–`0005` source tables; no new migration or duplicate statistics table is required. Scope is derived from active `entity_assignments`: owners/collaborators see assigned entities and their own actions, while `management_observer` assignments additionally expose actions across the observed entities. A framework-free query port returns a strict snapshot through NestJS; Next.js renders the same response as a seller workbench or observed-portfolio overview. PostgreSQL remains authoritative, the browser never expands scope, and future organization RBAC can replace the scope resolver without changing the public response.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 11.19, PostgreSQL 17+/18 CI, Kysely, PGlite, Zod, NestJS 12, Next.js 16, Vitest 4.

**Spec:** `docs/01-V1产品设计总纲.md` sections 4, 6.1, 6.3 and 9–10; `docs/03-UI与交互设计.md` sections 2–5 and 7–9; `docs/04-系统架构与详细设计.md` sections 5, 7 and 10.

## Global Constraints

- This slice completes the sales/management homepage only. It does not claim management natural-language queries, weekly reports, organization-wide RBAC, or configurable dashboard builders.
- Every returned entity must have a current `entity_assignments` row for the actor. Tenant membership alone never grants portfolio visibility.
- An owner/collaborator sees only actions assigned to that actor. A current `management_observer` assignment may see all open actions for that observed entity. Mixed scope is allowed and must not duplicate entities or actions.
- Pending draft count is limited to drafts submitted by the actor. Pending proposal count is limited to assigned entities. Unread notification count is limited to the actor as recipient.
- “Overdue” means `planned_at <= server_now` and status is `planned` or `in_progress`; it does not depend on an unmodelled tenant timezone. Upcoming work is ordered by exact timestamp rather than labelled “today.”
- Battle change cards compare the current immutable state version with the immediately previous version for the same entity. No previous version means “new baseline,” not a fabricated zero delta.
- The projection returns summaries, IDs, timestamps, scores and data gaps only. It does not return raw evidence bodies, contact details, provider responses or secrets.
- One request observes one tenant transaction snapshot and carries explicit tenant predicates in addition to forced RLS.
- Lists are bounded: at most 5 priority actions and 5 recent battle changes. Counts may cover the full authorized scope.
- Empty and partial data are valid. Missing analysis must increase the “data incomplete” signal rather than exclude the assigned entity.

---

### Task 1: Strict workspace contract and framework-free query boundary

**Files:**
- Create: `packages/contracts/src/workspace.ts`
- Create: `packages/contracts/src/workspace.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/core/src/workspace/workspace-reader.ts`
- Create: `packages/core/src/workspace/get-workspace-snapshot.ts`
- Create: `packages/core/src/workspace/get-workspace-snapshot.test.ts`
- Create: `packages/core/src/workspace/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces `workspaceSnapshotSchema`, `WorkspaceSnapshot`, `WorkspaceReader`, and `GetWorkspaceSnapshot`.
- Public shape contains `generatedAt`, `scopeMode`, bounded KPI counts, priority actions, recent battle changes, and quadrant distribution.

- [x] **Step 1: Write contract tests and verify RED**

Cover strict unknown-key rejection, non-negative counts, UUID/ISO timestamp validation, nullable previous state, exact action/status/priority unions, bounded data gaps and exactly one bucket per quadrant code.

- [x] **Step 2: Implement the strict Zod contract**

Use this stable top-level shape:

```ts
{
  generatedAt,
  scopeMode: "personal" | "observed_portfolio" | "mixed",
  kpis: {
    assignedEntityCount,
    pendingDraftCount,
    pendingProposalCount,
    overdueActionCount,
    unreadNotificationCount,
    highRiskEntityCount,
    dataIncompleteEntityCount,
  },
  priorityActions: [...],
  recentBattleChanges: [...],
  quadrantDistribution: [...],
}
```

Deep links are application-relative fixed-format links assembled from validated IDs; arbitrary URLs are not part of the contract.

- [x] **Step 3: Write core use-case tests and verify RED**

Prove actor and one injected clock instant pass unchanged to the reader, an invalid clock is rejected before the reader runs, and the use case performs no authorization, transport parsing or SQL itself. As in the existing modules, the NestJS controller performs runtime response parsing with the shared contract.

- [x] **Step 4: Implement the minimal port/use case and run focused GREEN**

Run contracts/core tests, type checks and Biome before committing.

Commit: `feat: define role-scoped workspace contract`

**Evidence:** the contract suite first failed because `workspace.ts` did not exist; the core suite then failed because the workspace use-case modules did not exist. After implementation, contracts passed 51/51, core passed 38/38, both type checks passed, and the repository Biome/diff checks were clean.

---

### Task 2: Tenant- and assignment-scoped PostgreSQL projection

**Files:**
- Create: `packages/database/src/workspace/kysely-workspace-reader.ts`
- Create: `packages/database/test/workspace-reader.test.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/src/testing/synthetic-directory.ts`

**Interfaces:**
- Implements `WorkspaceReader` with `withTenantTransaction` and an injected `Clock`/`now` value.
- Reuses existing tables and indexes; this task must not add cached counters or a migration.

- [x] **Step 1: Seed a two-tenant, mixed-assignment scenario and verify RED**

Include an owned entity, an observed entity, an unassigned same-tenant entity and a foreign-tenant entity. Add own/team actions, pending drafts/proposals, read/unread notifications, entities without analysis, and two state versions with a quadrant/score change.

- [x] **Step 2: Prove scope and count invariants**

Required tests:

- foreign-tenant and unassigned same-tenant data never changes counts or lists;
- owner/collaborator scope does not expose another user's action;
- management observer scope includes open actions on the observed entity;
- ended assignments grant no visibility;
- multiple current assignments do not duplicate rows;
- pending drafts and unread notifications remain actor-specific;
- completed/cancelled actions are not overdue;
- current-versus-previous battle delta is deterministic;
- missing analysis contributes to data-incomplete count;
- all lists remain bounded and stably ordered.

- [x] **Step 3: Implement one consistent read transaction**

Prefer a small number of explicit aggregate/list queries over one unmaintainable mega-query. Every query must repeat `tenant_id`, use assignment `exists`/deduplicated scope, and run under forced RLS actor context.

- [x] **Step 4: Inspect query plans for the scope joins**

Use PostgreSQL 18 integration or equivalent fixture queries to verify existing assignment/action/current-state indexes are used at V1 scale. Add a forward migration only if an actually observed missing index requires it.

- [x] **Step 5: Run database tests, real PostgreSQL checks, typecheck and commit**

Commit: `feat: project role-scoped workspace data`

**Evidence:** the focused suite first failed because the workspace reader module did not exist. After implementation, its mixed personal/observer, same-tenant unassigned, ended-assignment, cross-tenant, count, bounded-order and invalid-clock cases passed 4/4; the full PGlite database suite passed 86/86 across 14 files, and database typecheck/Biome/diff checks passed. Commit `91a62da` passed PostgreSQL 18 and all repository gates in Actions run `33350342971` (3 minutes 22 seconds); representative plans used `entity_assignments_user_current_idx` and `business_actions_owner_due_idx`, so no migration was added.

---

### Task 3: NestJS workspace API

**Files:**
- Create: `apps/api/src/workspace/workspace.controller.ts`
- Create: `apps/api/src/workspace/workspace.module.ts`
- Create: `apps/api/src/workspace/workspace.providers.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/workspace.e2e.test.ts`
- Modify: `apps/api/test/run-e2e.mjs`

**Interfaces:**
- Adds `GET /workspace` using only server-derived `ActorScope` and the workspace use case.
- Returns the strict workspace snapshot; it accepts no client-provided tenant/user/scope override.

- [x] **Step 1: Write real Nest + PGlite E2E tests and verify 404 RED**

Prove missing actor headers return 401, development actor returns the strict snapshot, query attempts such as `tenantId`, `userId` or `scope=tenant` return 400, and a second actor cannot infer unassigned or foreign data from counts.

- [x] **Step 2: Implement fail-closed provider/controller/module**

Keep database absence as an explicit unavailable provider, preserve production development-header rejection, and parse the outgoing result through the shared schema.

- [x] **Step 3: Add the file to the isolated API E2E runner and run API GREEN twice**

Each E2E file remains a fresh process; the suite stays fail-fast and deterministic.

- [x] **Step 4: Run API typecheck/build/Biome and commit**

Commit: `feat: expose role-scoped workspace API`

**Evidence:** the new real Nest + PGlite suite first returned 404 for all five workspace scenarios. After the module was wired, 5/5 passed; the official fresh-process API runner passed 30/30 twice consecutively. API typecheck, production build, Biome and diff checks passed. Commit `2edb59e` passed all repository gates in Actions run `33350647948` (4 minutes 13 seconds).

---

### Task 4: Responsive sales/management workspace UI

**Files:**
- Create: `apps/web/src/workspace/api-client.ts`
- Create: `apps/web/src/workspace/api-client.test.ts`
- Create: `apps/web/src/workspace/workspace-dashboard.tsx`
- Create: `apps/web/src/workspace/workspace-dashboard.test.tsx`
- Create: `apps/web/app/workspace/page.tsx`
- Modify: `apps/web/src/layout/app-shell.tsx`
- Modify: `apps/web/src/layout/app-shell.test.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `packages/database/src/action-decisions/kysely-action-query-reader.ts`
- Modify: `packages/database/test/workspace-reader.test.ts`
- Modify: `apps/api/test/battle-actions.e2e.test.ts`

**Interfaces:**
- `/workspace` renders the same projection as “今日工作台” for personal scope and “经营总览” for observed-portfolio scope.
- Existing `/` remains the follow-up capture workbench; desktop/mobile navigation points “今日/经营总览” to `/workspace` and “跟进” to `/`.

- [x] **Step 1: Write client/component/navigation tests and verify RED**

Cover exact API parsing, loading skeleton, retryable error, empty assigned scope, partial/no-analysis state, personal and management copy, KPI cards, action ordering, change delta/new-baseline labels, safe deep links, and mobile navigation semantics.

- [x] **Step 2: Implement the workspace dashboard**

Desktop layout: judgement header, KPI row, priority-action primary column, recent-change/evidence summary, quadrant distribution and explicit scope explanation. Mobile layout: single-column cards, no miniature scatter plot, primary links at comfortable touch size.

- [x] **Step 3: Preserve state/accessibility rules**

Use semantic headings/lists, text in addition to color, `aria-live` for loading/error, visible focus, no nested interactive controls, and no horizontal overflow at 390px.

- [x] **Step 4: Run Web tests/typecheck/build/Biome and commit**

Commit: `feat: add sales and management workspace`

**Local evidence:** the Web client/component/navigation suites first failed because the workspace client and page did not exist and the overview route still pointed to `#`. Review then exposed that the action deep link was not consumed and that the existing exact-action query accepted same-tenant out-of-scope IDs. Red tests drove exact deep-link loading plus one shared active-assignment visibility predicate for exact and paged action reads; owners see their own actions, observers see open actions on observed entities, and ended, unassigned, cross-tenant or otherwise unauthorized IDs return the same 404 as missing records. The final local suites passed Web 77/77, database 88/88 and isolated API 30/30; Web/database/API type and build gates, Biome, public-boundary and diff checks passed. Browser acceptance used the real Nest + PGlite demo at 1280×900 and true 390×844: the personal scope, seven KPI links, formal-action and battle-state deep links rendered from the strict API, both viewports had `scrollWidth === innerWidth`, the mobile “今日” item was current, and console errors/warnings were zero. Browser testing also found that the synthetic state history lacked its `battle_state_current` pointer; a failing database test captured the issue before the demo seed and startup build lifecycle were corrected.

---

### Task 5: Full acceptance, documentation and direct-main delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/01-V1产品设计总纲.md`
- Modify: `docs/03-UI与交互设计.md`
- Modify: `docs/04-系统架构与详细设计.md`
- Modify: this plan's checkboxes/evidence
- Update ignored: `task_plan.md`, `progress.md`, `findings.md`

- [ ] **Step 1: Run the complete local gate**

```bash
pnpm install --frozen-lockfile
pnpm check:public
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

- [ ] **Step 2: Run assignment-boundary acceptance**

On real PostgreSQL 18 or the CI integration path, prove an owner cannot see another user's action, a management observer can see an observed entity's open action, an ended assignment removes scope, and no foreign-tenant row changes any count.

- [ ] **Step 3: Run real browser acceptance**

At desktop and true 390×844 CSS viewport, prove personal workspace → action deep link → notification/workbench links and observed-portfolio workspace → changed entity/map deep link. Assert no horizontal overflow and zero console warnings/errors.

- [ ] **Step 4: Update living docs without overstating V1**

Mark the sales/management homepage delivered. Keep management queries, weekly reports, reminder escalation, production OIDC/RBAC, configuration UI, import and deployment recovery explicit.

- [ ] **Step 5: Review, push directly to `main`, and watch matching CI**

Record SHA, exact test counts, PostgreSQL evidence, browser evidence, CI URL/duration and deferred boundaries. Close only V1-E, then continue to management queries/reports.

## Acceptance Gate

For an authenticated actor, `/workspace` returns one strict, read-only snapshot whose counts and lists are derived only from current assignments and actor-specific responsibilities. Personal scope never exposes another user's action; management visibility exists only for explicit active observer assignments; ended/unassigned/cross-tenant data is invisible even in counts. The UI explains its scope, distinguishes missing analysis from low risk, links every actionable item to an existing application route, works without horizontal overflow at 390px, and keeps the follow-up creation workflow independent. PostgreSQL 18, API E2E, Web behavior, accessibility and full repository gates all pass.
