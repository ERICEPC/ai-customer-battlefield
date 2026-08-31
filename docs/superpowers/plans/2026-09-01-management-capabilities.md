# Management Capability Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed governance-role checks with tenant-scoped capabilities without widening any business-data scope.

**Architecture:** A small capability interface is shared by session resolution, the HTTP guard, the Web shell, and the two database adapters that already defend privileged mutations. PostgreSQL owns the tenant grant projection and RLS; business repositories continue enforcing current entity responsibility independently.

**Tech Stack:** TypeScript ESM, Zod, Kysely, PostgreSQL/PGlite, NestJS, Next.js/React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-management-capabilities-design.md`

## Global Constraints

- Keep `tenant_id` on every tenant-owned grant and force RLS.
- Preserve the current sales/department-leader browser behavior.
- Do not convert capabilities into all-tenant business visibility.
- Do not stage the user's existing `apps/web/next-env.d.ts` change.
- Run only affected tests until the migration is applied to the real database.

---

### Task 1: Capability vocabulary and database projection

**Files:**
- Create: `packages/core/src/authorization/management-capability.ts`
- Create: `packages/core/src/authorization/index.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/database/migrations/0014_management_capabilities.sql`
- Create: `packages/database/migrations/0015_backfill_management_capabilities.sql`
- Create: `packages/database/src/authorization/management-capabilities.ts`
- Modify: `packages/database/src/database-types.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/management-capabilities.test.ts`

**Interfaces:**
- Produces: `managementCapabilityCodes`, `ManagementCapability`, and `actorHasManagementCapability(transaction, actor, capability)`.

- [x] Write migration tests for the five catalog rows, leader defaults, no sales defaults, and tenant RLS.
- [x] Run `pnpm exec vitest run test/management-capabilities.test.ts` from `packages/database` and observe RED.
- [x] Add the closed core vocabulary, RLS tables, current-grant indexes, existing-tenant backfill, and new-tenant default seeding.
- [x] Add typed Kysely tables and the shared transactional capability predicate.
- [x] Rerun the focused database test and typecheck until GREEN.

### Task 2: Resolve current capabilities into authenticated sessions

**Files:**
- Modify: `packages/core/src/identity/identity-store.ts`
- Modify: `packages/core/src/identity/manage-session.test.ts`
- Modify: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/auth.test.ts`
- Modify: `packages/database/src/identity/kysely-identity-store.ts`
- Modify: `packages/database/test/kysely-identity-store.test.ts`
- Modify: authentication fixtures under `apps/api` and `apps/web`.

**Interfaces:**
- Produces: `IdentityProfile.capabilities: ManagementCapability[]` and strict `SessionProfile.capabilities`.

- [x] Add RED contract/core/database assertions that sales resolves `[]`, a leader resolves all five sorted codes, and revocation affects a subsequent resolve.
- [x] Load role grants in the existing identity tenant transaction and attach them to both login and session results.
- [x] Update strict fixtures and run focused contracts, core, database identity, API auth, and Web auth tests.

### Task 3: Capability-aware HTTP, Web, and adapter authorization

**Files:**
- Modify: `apps/api/src/auth/auth.constants.ts`
- Modify: `apps/api/src/auth/auth.guard.ts`
- Modify: four governance controllers under `apps/api/src`.
- Modify: `packages/database/src/ai-configuration/kysely-ai-runtime-config-store.ts`
- Modify: `packages/database/src/worker-operations/kysely-worker-operations-repository.ts`
- Modify: `apps/web/src/layout/app-shell.tsx`
- Modify: related focused tests.

**Interfaces:**
- Produces: `RequireCapabilities(...capabilities)`; every listed capability is required.

- [x] Add RED API coverage: keep role unchanged, revoke only `worker_operations.manage`, and receive 403 on the next request while other granted governance endpoints stay available.
- [x] Replace four controller decorators and fixed-role database predicates with capability checks.
- [x] Change management navigation/direct-route guards to capability checks and keep current labels unchanged.
- [x] Run only affected API, database, and Web tests plus affected typechecks and Biome.

### Task 4: Real migration and delivery

**Files:**
- Modify: `task_plan.md`, `progress.md`, and `findings.md` (ignored persistent working memory).

- [x] Apply migrations `0014` and `0015` to the real PostgreSQL database and verify five current leader grants and zero sales grants without printing credentials. `0015` repairs existing tenants through the non-RLS login directory after real PostgreSQL exposed the original force-RLS backfill gap.
- [x] Log in as sales and leader; prove sales receives no management capability and leader receives all five while organization relationships remain unchanged.
- [x] Run public-boundary and staged-diff checks.
- [x] Commit the focused slice, push directly to `main`, and continue with audited capability-grant mutation endpoints.

### Task 5: Audited role-capability management backend

**Files:**
- Create: `packages/contracts/src/access-control.ts`
- Create: `packages/core/src/authorization/access-control-manager.ts`
- Create: `packages/database/src/authorization/kysely-access-control-manager.ts`
- Create: `apps/api/src/access-control/*`
- Modify: package exports and `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: a current capability/role snapshot and an idempotent full-replacement role-grant operation.

- [x] Add RED contract and core validation tests for closed capability sets, strict requests, reason, role code, and idempotency key.
- [x] Add RED database tests for listing, grant/revoke, immediate session effect, authorization, idempotent replay, conflict, tenant isolation, audit payload, and tenant lockout prevention.
- [x] Implement the deep access-control manager over the existing RLS grant projection, generic idempotency ledger, and audit log.
- [x] Add capability-protected REST endpoints and focused API E2E coverage.
- [x] Apply no schema migration: this slice intentionally reuses the already deployed grant, idempotency, and audit tables.
- [x] Run affected package typechecks, focused tests, differential Biome, public-boundary and staged-diff checks.
- [ ] Commit and push directly to `main`, then add the permission card to the existing system-management page.
