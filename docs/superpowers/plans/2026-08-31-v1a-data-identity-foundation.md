# V1-A Data and Identity Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned PostgreSQL foundation, tenant-safe customer-operation schema, and the first persistent business-entity directory slice exposed through the existing REST/Web architecture.

**Architecture:** SQL migrations are the database source of truth. `packages/database` owns Kysely/PGlite/PostgreSQL adapters; `packages/core` owns business interfaces and use cases; NestJS and Next.js consume the versioned contract. Production uses PostgreSQL through `pg`, local tests use Kysely's PGlite dialect, and GitHub Actions verifies the same migrations on a real PostgreSQL 18 service. Migration scripts execute through an explicit transaction driver rather than Kysely prepared queries so complete PostgreSQL scripts remain atomic and are never split on semicolons.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 11.19, PostgreSQL 17+, Kysely, `pg`, PGlite, Zod, NestJS 12, Next.js 16, Vitest 4.

**Spec:** `docs/02-业务数据模型.md`, `docs/03-UI与交互设计.md`, `docs/04-系统架构与详细设计.md`

## Global Constraints

- Work directly on `main`; commit and push only after the task's tests and repository-wide public-boundary check pass.
- Production business code must never depend on PGlite; PGlite is a local/test adapter only.
- `packages/core` must not import Kysely, `pg`, NestJS, Next.js, or model-provider SDKs.
- Every tenant-owned row carries non-null `tenant_id`; composite foreign keys prevent cross-tenant references; RLS fails closed without tenant context.
- Migrations are forward-only and immutable after publication; production startup checks compatibility but never auto-creates schema.
- New behavior follows red → verify failure → minimal implementation → verify green → refactor.
- Examples, seed data, tests, and screenshots use synthetic data only.

---

## File Map

```text
packages/database/
  package.json                         # package scripts and dependencies
  tsconfig.json                        # ESM TypeScript build
  migrations/
    0001_foundation.sql                # schemas, tenant/identity tables, RLS helpers
    0002_customer_operations.sql       # entities, contacts, opportunities, assignments/history
  src/
    database-types.ts                  # Kysely table interfaces
    database-factory.ts                # PostgreSQL and PGlite database handles
    migration-provider.ts              # ordered SQL file provider with checksums
    migrate.ts                         # forward migration interface
    tenant-session.ts                  # transaction-local tenant/actor context
    testing/pglite-database.ts         # test-only PGlite adapter
    testing/index.ts                   # explicit test-only package export
    index.ts                           # small public interface
  test/
    migrations.test.ts                 # behavior of real migrations
    tenant-session.test.ts             # fail-closed tenant context
packages/contracts/src/business-entities.ts
packages/contracts/src/business-entities.test.ts
packages/core/src/business-entities/list-business-entities.ts
packages/core/src/business-entities/list-business-entities.test.ts
packages/core/src/business-entities/business-entity-reader.ts
packages/core/src/business-entities/index.ts
apps/api/src/business-entities/*       # repository adapter, module, controller, provider
apps/api/test/business-entities.e2e.test.ts
apps/web/app/entities/page.tsx
apps/web/src/business-entities/*       # API client, directory UI, tests
.github/workflows/ci.yml               # PostgreSQL service and migration verification
```

### Task 1: Database package and ordered migration runner

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/src/migration-provider.ts`
- Create: `packages/database/src/migrate.ts`
- Create: `packages/database/src/database-factory.ts`
- Create: `packages/database/src/test-database.ts`
- Create: `packages/database/src/index.ts`
- Test: `packages/database/test/migration-provider.test.ts`

**Interfaces:**
- Produces: `createPgliteDatabase()`, `createPostgresDatabase(url)`, `migrateDatabase(driver, directory)`.
- `SqlFileMigrationProvider` exposes ordered `.sql` files with SHA-256 checksums; each database handle supplies a migration driver that executes complete scripts inside the same transaction.

- [x] **Step 1: Add a failing migration-provider test**

Create a temporary migration directory through the test runtime, add `0002_second.sql` and `0001_first.sql`, load `SqlFileMigrationProvider`, and assert that returned keys are exactly `0001_first`, `0002_second`. Add a non-SQL file and assert it is ignored. The mutation caught is unsorted or unsafe file discovery.

```ts
const migrations = await provider.getMigrations();
expect(Object.keys(migrations)).toEqual(["0001_first", "0002_second"]);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @battlefield/database test -- migration-provider.test.ts`

Expected: FAIL because `@battlefield/database` and `SqlFileMigrationProvider` do not exist.

- [x] **Step 3: Implement the database package and provider**

Use `readdir({ withFileTypes: true })`, accept only `/^\d{4}_[a-z0-9_]+\.sql$/`, sort by filename, read UTF-8, and return immutable `{ name, sql, checksum }` entries. The checksum is lowercase SHA-256 of the exact UTF-8 file contents. Do not provide `down`.

```ts
export class SqlFileMigrationProvider {
  constructor(private readonly directory: string) {}

  async getMigrations(): Promise<Record<string, SqlMigration>> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    return Object.fromEntries(
      await Promise.all(
        files.map(async (filename) => {
          const migrationSql = await readFile(join(this.directory, filename), "utf8");
          return [
            filename.slice(0, -4),
            {
              name: filename.slice(0, -4),
              sql: migrationSql,
              checksum: createHash("sha256").update(migrationSql).digest("hex"),
            },
          ] as const;
        }),
      ),
    );
  }
}
```

`migrateDatabase` must throw a typed `MigrationFailedError` when a script fails, reject missing or checksum-changed applied migrations with `MigrationHistoryError`, and return immutable `{ name, status }[]` results otherwise.

- [x] **Step 4: Implement database factories**

```ts
export async function createPgliteDatabase<DB>(): Promise<DatabaseHandle<DB>>;
export function createPostgresDatabase<DB>(url: string): DatabaseHandle<DB>;

export interface DatabaseHandle<DB> {
  db: Kysely<DB>;
  migrations: MigrationDriver;
  close(): Promise<void>;
}
```

PGlite uses Kysely's `PGliteDialect`; PostgreSQL uses a bounded `pg.Pool` with connection timeout, idle timeout, application name, and a `close` method that destroys both Kysely and the underlying client exactly once. `MigrationDriver.transaction` exposes parameterized `query` plus `executeScript`; the latter uses PGlite transaction `exec` or the checked-out PostgreSQL client, never a Kysely prepared query.

`migrateDatabase` acquires a transaction advisory lock, creates `app_meta.schema_migrations`, rejects missing or checksum-changed applied migrations, executes pending scripts in filename order, and records `{ name, checksum, applied_at }` in the same transaction.

- [x] **Step 5: Verify GREEN and package checks**

Run:

```bash
pnpm --filter @battlefield/database test
pnpm --filter @battlefield/database typecheck
pnpm --filter @battlefield/database build
```

Expected: all exit 0 with no warnings.

- [x] **Step 6: Commit and push**

```bash
git add packages/database pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: add database migration module"
pnpm check:public && git push origin main
```

### Task 2: Foundation migration and fail-closed tenant context

**Files:**
- Create: `packages/database/migrations/0001_foundation.sql`
- Create: `packages/database/src/database-types.ts`
- Create: `packages/database/src/tenant-session.ts`
- Test: `packages/database/test/foundation-migration.test.ts`
- Test: `packages/database/test/tenant-session.test.ts`

**Interfaces:**
- Consumes: `migrateDatabase`, `createPgliteDatabase`.
- Produces: `ActorDatabaseContext`, `withTenantTransaction(db, context, work)`.

```ts
export interface ActorDatabaseContext {
  tenantId: string;
  userId: string;
  requestId: string;
}

export async function withTenantTransaction<T>(
  db: Kysely<Database>,
  actor: ActorDatabaseContext,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T>;
```

- [x] **Step 1: Write failing migration tests**

Tests must prove these behaviors against a real PGlite database:

1. a clean database migrates and contains `app.tenants`, `app.org_units`, `app.users`, `app.user_memberships`, `app.channel_addresses`;
2. `org_units.parent_id` cannot reference an organization in another tenant;
3. the same active user/team/role membership cannot be inserted twice;
4. an ended membership and a new current membership are both allowed;
5. application-role reads without tenant context return zero rows, while the matching tenant context returns only that tenant.

The mutations caught are missing composite FKs, missing partial uniqueness, or permissive RLS.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @battlefield/database test -- foundation-migration.test.ts tenant-session.test.ts`

Expected: FAIL because the migration and tenant-session implementation do not exist.

- [x] **Step 3: Implement `0001_foundation.sql`**

Create schemas `app` and `app_meta`; functions `app.current_tenant_id()` and `app.current_user_id()` read transaction-local settings with `missing_ok=true`. Create the five tables with UUID IDs, `timestamptz`, lower-case identifiers, check constraints, composite `(tenant_id,id)` unique keys, FK-side indexes, and partial active-membership uniqueness.

Enable and force RLS on every tenant-owned table. Policies use:

```sql
using (tenant_id = app.current_tenant_id())
with check (tenant_id = app.current_tenant_id())
```

No context must evaluate to null/false. The migration role can seed tenants; the runtime role receives only schema usage and required DML grants in deployment setup, not ownership.

- [x] **Step 4: Implement transaction-local actor context**

Inside one Kysely transaction call `set_config('app.current_tenant_id', tenantId, true)`, `set_config('app.current_user_id', userId, true)`, and `set_config('app.request_id', requestId, true)` before invoking `work`. Validate every ID as UUID before opening the transaction.

- [x] **Step 5: Verify GREEN**

Run the two focused tests, then `pnpm --filter @battlefield/database test && pnpm --filter @battlefield/database typecheck`.

- [x] **Step 6: Commit and push**

```bash
git add packages/database
git commit -m "feat: add tenant-safe database foundation"
pnpm check:public && git push origin main
```

### Task 3: Customer-operation migration and invariants

**Files:**
- Create: `packages/database/migrations/0002_customer_operations.sql`
- Modify: `packages/database/src/database-types.ts`
- Test: `packages/database/test/customer-operations-migration.test.ts`

**Interfaces:**
- Produces physical storage for business entity types/entities, entity assignments, contacts/affiliations, opportunities/assignments, and stage history.

- [x] **Step 1: Write failing invariant tests**

Prove with literal synthetic rows:

1. cross-tenant contact affiliation and opportunity references are rejected;
2. one entity can have several collaborators but only one current primary `owner`;
3. one entity can have several opportunities but only one open primary opportunity;
4. the same contact can have current affiliations to different entities;
5. the same contact/entity pair cannot have two current affiliations, but an ended affiliation plus a new one is valid;
6. stage progress is restricted to 0–100 and amount is non-negative;
7. stage history is appendable and references the same-tenant opportunity.

- [x] **Step 2: Verify RED**

Run: `pnpm --filter @battlefield/database test -- customer-operations-migration.test.ts`

Expected: FAIL because `0002_customer_operations.sql` is absent.

- [x] **Step 3: Implement the migration**

Create exactly these tables in `app`: `business_entity_types`, `business_entities`, `entity_assignments`, `contacts`, `contact_affiliations`, `opportunities`, `opportunity_assignments`, `opportunity_stage_history`. Every table includes `tenant_id`; every relation uses composite tenant FK; every FK has an index; current primary and active-pair invariants use partial unique indexes.

Use status checks:

```text
business_entities: active | inactive | archived
contacts: active | inactive | archived
opportunities: open | won | lost | cancelled
assignment_role: owner | collaborator | management_observer
```

Stage code remains text and references a versioned rule later; `stage_progress` is numeric(5,2) with `0 <= value <= 100`.

- [x] **Step 4: Add RLS and query indexes**

Enable/force the tenant policy on all eight tables. Add list index `(tenant_id, status, updated_at desc, id desc)`, entity opportunity index `(tenant_id, entity_id, status, updated_at desc)`, and active assignment/affiliation partial indexes specified by the data model.

- [x] **Step 5: Verify GREEN and empty-database rebuild**

Run all database tests twice using fresh database handles. Both runs must pass independently, proving no test depends on prior state.

- [x] **Step 6: Commit and push**

```bash
git add packages/database
git commit -m "feat: add customer operations schema"
pnpm check:public && git push origin main
```

### Task 4: Business-entity contract and framework-free list use case

**Files:**
- Create: `packages/contracts/src/business-entities.ts`
- Create: `packages/contracts/src/business-entities.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/core/src/business-entities/business-entity-reader.ts`
- Create: `packages/core/src/business-entities/list-business-entities.ts`
- Create: `packages/core/src/business-entities/list-business-entities.test.ts`
- Create: `packages/core/src/business-entities/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export interface BusinessEntityListItem {
  id: string;
  typeCode: string;
  name: string;
  shortName: string | null;
  status: "active" | "inactive" | "archived";
  isT0: boolean;
  primaryOwnerName: string | null;
  primaryOpportunity: { id: string; name: string; stageCode: string; stageProgress: string } | null;
  updatedAt: string;
  versionNo: string;
}

export interface BusinessEntityReader {
  list(input: { actor: ActorScope; status?: string; search?: string; cursor?: string; limit: number }):
    Promise<{ items: BusinessEntityListItem[]; nextCursor: string | null }>;
}

export class ListBusinessEntities {
  execute(input: { actor: ActorScope; status?: string; search?: string; cursor?: string; limit?: number }):
    Promise<BusinessEntityPage>;
}
```

- [x] **Step 1: Write contract tests that reject malformed filters and rows**

Cover trimmed search up to 100 characters, limit 1–100, allowed statuses, strict unknown-key rejection, ISO timestamps, UUID IDs, decimal stage progress as string, and opaque nullable `nextCursor`.

- [x] **Step 2: Verify contract RED, then implement schemas and verify GREEN**

Run: `pnpm --filter @battlefield/contracts test -- business-entities.test.ts`.

- [x] **Step 3: Write core use-case tests**

Use a specific in-memory reader and assert observable inputs/results: default limit 20, whitespace search normalization, maximum limit rejection, and unchanged propagation of an opaque cursor. Do not assert mock call existence without a returned business result.

- [x] **Step 4: Verify core RED, implement minimal use case, verify GREEN**

Run: `pnpm --filter @battlefield/core test -- list-business-entities.test.ts`.

- [x] **Step 5: Commit and push**

```bash
git add packages/contracts packages/core
git commit -m "feat: define business entity directory interface"
pnpm check:public && git push origin main
```

### Task 5: Kysely entity reader and tenant-safe API endpoint

**Files:**
- Create: `packages/database/src/business-entities/kysely-business-entity-reader.ts`
- Create: `packages/database/test/kysely-business-entity-reader.test.ts`
- Modify: `packages/database/src/index.ts`
- Create: `apps/api/src/database/database.module.ts`
- Create: `apps/api/src/business-entities/business-entities.controller.ts`
- Create: `apps/api/src/business-entities/business-entities.module.ts`
- Create: `apps/api/src/business-entities/business-entities.providers.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/business-entities.e2e.test.ts`

**Interfaces:**
- `KyselyBusinessEntityReader` implements `BusinessEntityReader`.
- `GET /api/v1/business-entities` returns the contract page and keeps the development actor adapter fail-closed in production.

- [x] **Step 1: Write failing repository integration tests**

Seed two tenants, several entities, assignments and opportunities through `withTenantTransaction`. Assert tenant A never sees tenant B, active primary owner/opportunity are projected, search is case-insensitive, status filters work, and the second cursor page has no duplicate or missing row.

- [x] **Step 2: Verify repository RED**

Run: `pnpm --filter @battlefield/database test -- kysely-business-entity-reader.test.ts`.

- [x] **Step 3: Implement keyset query and cursor codec**

Order by `updated_at desc, id desc`; encode `{ updatedAt, id }` as base64url JSON with strict decoding. Fetch `limit + 1`, return at most `limit`, and derive `nextCursor` from the last returned item only when another row exists. Join current primary owner and open primary opportunity through bounded lateral/subqueries so each entity remains one row.

- [x] **Step 4: Write failing API E2E tests**

Prove `401` without development actor headers, `400` for invalid query, `200` with contract-conforming tenant-scoped data, and no tenant leakage. Test the real Nest module with a real PGlite database adapter; only the external identity provider remains substituted by the development adapter.

- [x] **Step 5: Implement Nest module/controller and verify GREEN**

The controller parses headers into the existing development `ActorScope`, validates the query with Zod, calls `ListBusinessEntities`, and parses the response contract before returning. No SQL or tenant filter belongs in the controller.

- [ ] **Step 6: Commit and push**

```bash
git add packages/database apps/api
git commit -m "feat: expose persistent business entity directory"
pnpm check:public && git push origin main
```

### Task 6: Web business-entity directory

**Files:**
- Create: `apps/web/src/business-entities/api-client.ts`
- Create: `apps/web/src/business-entities/business-entity-directory.tsx`
- Create: `apps/web/src/business-entities/business-entity-directory.test.tsx`
- Create: `apps/web/app/entities/page.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `GET /api/v1/business-entities` and shared Zod response schema.
- Produces: accessible desktop table and mobile card directory with search/status filters and cursor pagination.

- [ ] **Step 1: Write failing UI behavior tests**

Prove initial loading, rows with owner/opportunity/stage, empty state, recoverable API error, debounced search submission, status filter, next-page append without duplicates, and a 390px-friendly semantic card/table switch. Test the real component with an injected request function returning complete contract objects.

- [ ] **Step 2: Verify UI RED**

Run: `pnpm --filter @battlefield/web test -- business-entity-directory.test.tsx`.

- [ ] **Step 3: Implement the page and API client**

Use the deep-blue/white/gold tokens from `docs/03-UI与交互设计.md`. The directory heading answers “当前由谁负责、主商机推进到哪里”； T0 is a gold label, status always includes text, and missing owner/opportunity displays an explicit data gap rather than a blank cell.

- [ ] **Step 4: Verify component tests and browser behavior**

Run the focused Web tests. Start API/Web with synthetic development seed, verify desktop and 390px layouts, keyboard focus, no horizontal overflow, loading/error/empty states, and tenant-scoped rows.

- [ ] **Step 5: Commit and push**

```bash
git add apps/web
git commit -m "feat: add business entity directory"
pnpm check:public && git push origin main
```

### Task 7: Real PostgreSQL CI, documentation, and phase verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/02-业务数据模型.md`
- Modify: `progress.md` and `task_plan.md` (ignored internal working memory)

**Interfaces:**
- Produces: CI evidence that migrations and repository behavior run on PostgreSQL 18; documents PostgreSQL 17+ compatibility and local PGlite setup.

- [ ] **Step 1: Add PostgreSQL service to CI**

Use `postgres:18-alpine` with a health check and job-level `DATABASE_URL`. Add an explicit `pnpm --filter @battlefield/database test:postgres` step before repository-wide tests. The database test script must create/drop its own schemas and must not depend on a pre-existing database.

- [ ] **Step 2: Run fresh full local verification**

```bash
pnpm install --frozen-lockfile
pnpm check:public
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: exit 0; migration tests pass on PGlite; all existing 17 tests remain green plus the new suite.

- [ ] **Step 3: Update documentation and public boundary**

Document local PGlite behavior, production `DATABASE_URL`, forward migration command, synthetic seed, and the explicit limitation that PGlite is not production. Remove the old README statement that persistence belongs only to a future milestone.

- [ ] **Step 4: Commit, push, and verify Actions**

```bash
git add .github README.md docs packages apps pnpm-lock.yaml
git commit -m "feat: deliver tenant-safe customer data foundation"
pnpm check:public && git push origin main
```

Verify the remote `main` SHA matches local and the GitHub Actions run completes successfully. Record exact test totals and CI URL in `progress.md` without adding private evidence to Git.
