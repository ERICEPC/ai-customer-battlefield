# V1-H Two-Level Identity and Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a visibly usable login/logout flow where Sales 1 sees their department and direct leader, Leader A sees the department sales roster, and all browser API access is bound to a server-side session instead of caller-supplied actor headers.

**Architecture:** Add versioned PostgreSQL credentials and sessions behind a core identity port, expose NestJS login/session/logout endpoints, and enforce one authenticated actor for every protected request through a global guard. The Next.js shell loads the session, renders role/department relationships, and sends cookies on all API requests; test-only actor headers remain available only under `NODE_ENV=test` so existing focused E2E fixtures can be migrated incrementally without creating a production bypass.

**Tech Stack:** PostgreSQL 17+, Kysely, TypeScript 5.9, Node.js `crypto.scrypt`, NestJS 12, Next.js 16, React 19, Zod 4, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-31-business-first-demo-core-design.md`

## Global Constraints

- V1 implements only `sales` and `department_leader` memberships in one direct department; no inherited organization hierarchy or matrix reporting.
- The browser never chooses `tenant_id` or `user_id`; the API resolves both from an `HttpOnly`, `SameSite=Lax` session cookie.
- Passwords use a memory-hard `scrypt` hash with a random salt; session tokens are random and only SHA-256 hashes are persisted.
- The session cookie is `Secure` in production, is never returned in JSON, and is revoked on logout.
- Sales see their direct leader; leaders see current sales in their direct department. Historical memberships are retained by `valid_from`/`valid_to`.
- The first visible demo accounts are synthetic only: `sales1@demo.local` and `leader.a@demo.local`, both under tenant slug `alpha`, with the documented demo password `Demo@2026`.
- Existing `tenant_id` RLS stays forced. Tenant slug resolution exposes only the UUID of an active tenant through a narrow security-definer function before tenant context exists.
- Each implementation task ends with a focused commit pushed directly to `main`; do not create branches or pull requests.

---

### Task 1: Define the public authentication contract

**Files:**
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/auth.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: Zod schemas from `zod`.
- Produces: `loginRequestSchema`, `sessionProfileSchema`, `loginResponseSchema`, `authApiErrorSchema`, and their inferred TypeScript types.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { loginRequestSchema, sessionProfileSchema } from "./auth.js";

describe("authentication contracts", () => {
  it("accepts the two-level sales profile", () => {
    expect(sessionProfileSchema.parse({
      user: { id: crypto.randomUUID(), displayName: "销售1", email: "sales1@demo.local" },
      role: "sales",
      department: { id: crypto.randomUUID(), name: "商业化一部" },
      directLeader: { id: crypto.randomUUID(), displayName: "领导A" },
      teamMembers: [],
      expiresAt: "2026-09-01T12:00:00.000Z",
    }).role).toBe("sales");
  });

  it("rejects unsupported hierarchy roles", () => {
    expect(() => sessionProfileSchema.parse({ role: "regional_manager" })).toThrow();
  });

  it("normalizes login identifiers", () => {
    expect(loginRequestSchema.parse({
      tenantSlug: "ALPHA",
      email: " SALES1@DEMO.LOCAL ",
      password: "Demo@2026",
    })).toMatchObject({ tenantSlug: "alpha", email: "sales1@demo.local" });
  });
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `pnpm --filter @battlefield/contracts test -- auth.test.ts`

Expected: FAIL because `auth.ts` and its exports do not exist.

- [ ] **Step 3: Implement strict schemas**

```ts
export const identityRoleSchema = z.enum(["sales", "department_leader"]);
export const loginRequestSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(200),
}).strict();
export const identityPersonSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(200),
});
export const sessionProfileSchema = z.object({
  user: identityPersonSchema.extend({ email: z.string().email() }),
  role: identityRoleSchema,
  department: z.object({ id: z.string().uuid(), name: z.string().min(1).max(200) }),
  directLeader: identityPersonSchema.nullable(),
  teamMembers: z.array(identityPersonSchema),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
```

`loginResponseSchema` wraps `{ session: sessionProfileSchema }`. `authApiErrorSchema` is strict `{ code, message, requestId }` with non-empty strings.

- [ ] **Step 4: Export and verify the contract**

Run: `pnpm --filter @battlefield/contracts test -- auth.test.ts && pnpm --filter @battlefield/contracts typecheck`

Expected: PASS with both roles constrained to the two-level model.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth.ts packages/contracts/src/auth.test.ts packages/contracts/src/index.ts
git commit -m "feat: define two-level identity contracts"
git push origin main
```

### Task 2: Persist credentials, sessions, and direct-department profiles

**Files:**
- Create: `packages/database/migrations/0008_two_level_identity.sql`
- Create: `packages/core/src/identity/identity-store.ts`
- Create: `packages/core/src/identity/manage-session.ts`
- Create: `packages/core/src/identity/manage-session.test.ts`
- Create: `packages/database/src/identity/kysely-identity-store.ts`
- Create: `packages/database/test/two-level-identity-migration.test.ts`
- Create: `packages/database/test/kysely-identity-store.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/database/src/database-types.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `ActorDatabaseContext`, `withTenantTransaction`, and existing `tenants`, `users`, `org_units`, and `user_memberships` tables.
- Produces: `IdentityStore`, `AuthenticateSession`, `ResolveSession`, `RevokeSession`, `hashPassword`, `verifyPassword`, and `KyselyIdentityStore`.

- [ ] **Step 1: Write migration tests for credential/session safety**

The test migrates a fresh PGlite database and asserts:

```ts
expect(tableNames).toContain("user_credentials");
expect(tableNames).toContain("user_sessions");
expect(forcedRlsTables).toEqual(expect.arrayContaining(["user_credentials", "user_sessions"]));
expect(await resolveTenant("alpha")).toBe(SYNTHETIC_TENANT_ID);
expect(await resolveTenant("missing")).toBeNull();
```

It also verifies duplicate current credentials, duplicate session hashes, expired sessions, and cross-tenant reads are rejected or invisible.

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `pnpm --filter @battlefield/database test -- two-level-identity-migration.test.ts`

Expected: FAIL because migration `0008_two_level_identity.sql` does not exist.

- [ ] **Step 3: Add the identity migration**

Create `app.user_credentials` keyed by `(tenant_id, user_id)` with `password_hash`, `password_updated_at`, `failed_attempt_count`, and `locked_until`. Create `app.user_sessions` with `(tenant_id, id)`, `user_id`, `token_hash`, `expires_at`, `last_used_at`, `revoked_at`, and timestamps. Add tenant/user foreign keys, unique `(tenant_id, token_hash)`, expiry and active-session indexes, forced tenant RLS, and this narrow resolver:

```sql
create or replace function app.resolve_active_tenant_id(login_slug text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
  select id
  from app.tenants
  where slug = lower(btrim(login_slug)) and status = 'active'
  limit 1
$$;
```

The function returns only an active tenant UUID and never user, credential, or membership data.

- [ ] **Step 4: Add core session tests**

Cover correct password login, generic invalid-credentials failure, token hashing before persistence, expired/revoked session rejection, logout revocation, sales direct-leader profile, and leader current-team profile. Use deterministic test doubles for the clock and secret generator.

- [ ] **Step 5: Run the core tests and verify they fail**

Run: `pnpm --filter @battlefield/core test -- manage-session.test.ts`

Expected: FAIL because the identity use cases do not exist.

- [ ] **Step 6: Implement the core identity port and use cases**

```ts
export interface IdentityStore {
  findLoginAccount(input: { tenantSlug: string; email: string }): Promise<LoginAccount | null>;
  createSession(input: { actor: ActorScope; sessionId: string; tokenHash: string; expiresAt: string; createdAt: string }): Promise<IdentityProfile>;
  resolveSession(input: { tenantId: string; tokenHash: string; now: string }): Promise<IdentityProfile | null>;
  revokeSession(input: { actor: ActorScope; sessionId: string; revokedAt: string }): Promise<void>;
}
```

Use `scrypt` with a random 16-byte salt and timing-safe comparison. Store only `sha256(rawToken)`; serialize the browser cookie value as `<tenantUuid>.<rawToken>` so RLS tenant context can be established before looking up the token hash.

- [ ] **Step 7: Write repository tests**

Seed Department A, Sales 1, Leader A, active memberships, and credentials. Assert Sales 1 resolves `directLeader=Leader A`, Leader A resolves `teamMembers=[Sales 1]`, an expired membership is excluded, and another tenant cannot be resolved through the same tenant context.

- [ ] **Step 8: Implement `KyselyIdentityStore` and database types**

The login lookup first calls `app.resolve_active_tenant_id`, then opens `withTenantTransaction` for that tenant. Profile queries select exactly one current `sales` or `department_leader` membership and join only current users in that department. Ambiguous or unsupported current role sets fail closed.

- [ ] **Step 9: Verify core and database identity behavior**

Run: `pnpm --filter @battlefield/core test -- manage-session.test.ts && pnpm --filter @battlefield/database test -- two-level-identity-migration.test.ts kysely-identity-store.test.ts && pnpm --filter @battlefield/database typecheck`

Expected: PASS with no plaintext password or raw session token stored.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/identity packages/core/src/index.ts packages/database/migrations/0008_two_level_identity.sql packages/database/src/identity packages/database/src/database-types.ts packages/database/src/index.ts packages/database/test/two-level-identity-migration.test.ts packages/database/test/kysely-identity-store.test.ts
git commit -m "feat: persist two-level login sessions"
git push origin main
```

### Task 3: Enforce authenticated browser sessions in the API

**Files:**
- Create: `apps/api/src/auth/auth.constants.ts`
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/auth.guard.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/auth/auth.providers.ts`
- Create: `apps/api/src/auth/authenticated-request.ts`
- Create: `apps/api/test/auth.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/health/health.controller.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/test/run-e2e.mjs`

**Interfaces:**
- Consumes: core session use cases, `KyselyIdentityStore`, `DATABASE_HANDLE`, and auth contracts.
- Produces: `POST /api/v1/auth/login`, `GET /api/v1/auth/session`, `POST /api/v1/auth/logout`, and a global guard that binds the resolved actor to protected requests.

- [ ] **Step 1: Write an API E2E test for the visible session lifecycle**

```ts
const login = await request(app.getHttpServer())
  .post("/api/v1/auth/login")
  .send({ tenantSlug: "alpha", email: "sales1@demo.local", password: "Demo@2026" })
  .expect(201);
expect(login.headers["set-cookie"][0]).toContain("battlefield_session=");
expect(login.headers["set-cookie"][0]).toContain("HttpOnly");
expect(login.body.session).toMatchObject({
  role: "sales",
  department: { name: "商业化一部" },
  directLeader: { displayName: "领导A" },
});
const cookie = login.headers["set-cookie"][0].split(";")[0];
await request(app.getHttpServer()).get("/api/v1/auth/session").set("Cookie", cookie).expect(200);
await request(app.getHttpServer()).post("/api/v1/auth/logout").set("Cookie", cookie).expect(204);
await request(app.getHttpServer()).get("/api/v1/auth/session").set("Cookie", cookie).expect(401);
```

Also assert a leader session returns Sales 1 in `teamMembers`, missing cookies are rejected, invalid login errors do not reveal whether the email exists, and caller-supplied actor headers cannot override an authenticated session.

- [ ] **Step 2: Run the API auth test and verify it fails**

Run: `pnpm --filter @battlefield/api exec vitest run test/auth.e2e.test.ts`

Expected: FAIL because the auth module and endpoints do not exist.

- [ ] **Step 3: Implement the auth module and global guard**

`AuthGuard` skips only handlers marked with `PUBLIC_ROUTE`; otherwise it parses `battlefield_session`, resolves the session, stores `{ actor, profile, sessionId }` on the request, and overwrites any incoming `x-tenant-id`/`x-user-id` values with the authenticated actor for compatibility with existing controllers. Under `NODE_ENV=test` only, requests without a cookie may continue using valid synthetic actor headers so focused legacy E2E tests stay isolated; production and normal development have no header fallback.

The login endpoint sets:

```text
battlefield_session=<tenantUuid>.<rawToken>; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800
```

and adds `Secure` in production. Logout revokes the database row before clearing the cookie.

- [ ] **Step 4: Mark health public and enable credentialed CORS**

`configureApp` sets `credentials: true`, retains the configured exact Web origin, and never uses `*` with cookies. The health controller is explicitly public; all current business controllers become protected through the global guard.

- [ ] **Step 5: Verify API authentication**

Run: `pnpm --filter @battlefield/api exec vitest run test/auth.e2e.test.ts && pnpm --filter @battlefield/api typecheck`

Expected: PASS; session identity overrides spoofed actor headers.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth apps/api/src/app.module.ts apps/api/src/health/health.controller.ts apps/api/src/main.ts apps/api/test/auth.e2e.test.ts apps/api/test/run-e2e.mjs
git commit -m "feat: enforce authenticated api sessions"
git push origin main
```

### Task 4: Seed the two visible demo identities

**Files:**
- Create: `packages/database/src/testing/synthetic-identity.ts`
- Create: `packages/database/test/synthetic-identity.test.ts`
- Modify: `packages/database/src/testing/index.ts`
- Modify: `apps/api/dev/demo-server.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `hashPassword`, synthetic tenant/sales/manager IDs, and migrated identity tables.
- Produces: `seedSyntheticTwoLevelIdentity(database)` with Department A, Sales 1, Leader A, memberships, email credentials, and current leader scope.

- [ ] **Step 1: Write the failing synthetic identity test**

After running the seed twice, assert there is one Department A, one current sales membership, one current leader membership, and one credential per user. Authenticate both accounts and verify these exact visible profiles:

```ts
expect(salesProfile).toMatchObject({
  role: "sales",
  department: { name: "商业化一部" },
  directLeader: { displayName: "领导A" },
});
expect(leaderProfile).toMatchObject({
  role: "department_leader",
  department: { name: "商业化一部" },
  teamMembers: [{ displayName: "销售1" }],
});
```

- [ ] **Step 2: Run and verify the seed test fails**

Run: `pnpm --filter @battlefield/database test -- synthetic-identity.test.ts`

Expected: FAIL because `seedSyntheticTwoLevelIdentity` does not exist.

- [ ] **Step 3: Implement the idempotent seed and demo-server call**

Use stable synthetic UUIDs, set the existing owner user to `销售1 / sales1@demo.local`, set the existing manager user to `领导A / leader.a@demo.local`, attach both to Department A with their two role codes, and persist a scrypt hash of the synthetic demo password. Call the seed after the existing directory and management-observer seeds.

- [ ] **Step 4: Verify repeatable demo identity setup**

Run: `pnpm --filter @battlefield/database test -- synthetic-identity.test.ts && pnpm --filter @battlefield/api typecheck`

Expected: PASS after two seed invocations with no duplicate current relationships.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/testing/synthetic-identity.ts packages/database/src/testing/synthetic-identity.test.ts packages/database/src/testing/index.ts apps/api/dev/demo-server.ts .env.example
git commit -m "feat: seed visible sales and leader accounts"
git push origin main
```

### Task 5: Build the visible login and identity shell

**Files:**
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/src/auth/api-client.ts`
- Create: `apps/web/src/auth/api-client.test.ts`
- Create: `apps/web/src/auth/login-form.tsx`
- Create: `apps/web/src/auth/login-form.test.tsx`
- Create: `apps/web/src/auth/session-provider.tsx`
- Create: `apps/web/src/api/api-configuration.ts`
- Modify: `apps/web/src/layout/app-shell.tsx`
- Modify: `apps/web/src/layout/app-shell.test.tsx`
- Modify: `apps/web/src/business-entities/api-client.ts`
- Modify: `apps/web/src/followup-drafts/api-client.ts`
- Modify: `apps/web/src/battle-operations/api-client.ts`
- Modify: `apps/web/src/notifications/api-client.ts`
- Modify: `apps/web/src/workspace/api-client.ts`
- Modify: `apps/web/src/management-queries/api-client.ts`
- Modify: `apps/web/src/weekly-reports/api-client.ts`
- Modify: `apps/web/app/globals.css`
- Delete: `apps/web/src/config/development-actor.ts`
- Delete: `apps/web/src/config/development-actor.test.ts`

**Interfaces:**
- Consumes: auth REST endpoints and session contracts.
- Produces: `/login`, a session-aware `AppShell`, an identity popover, logout behavior, and cookie credentials on all browser API calls.

- [ ] **Step 1: Write failing Web tests**

Cover:

```ts
expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/auth/login"), expect.objectContaining({ credentials: "include" }));
expect(screen.getByText("所属部门：商业化一部")).toBeVisible();
expect(screen.getByText("直属领导：领导A")).toBeVisible();
expect(screen.getByText("团队成员")).toBeVisible();
expect(screen.getByText("销售1")).toBeVisible();
expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
```

Login validation keeps the email on failure, never keeps the password, and presents a generic credential error. A `401` from `/auth/session` renders a login link and redirects through `window.location.assign("/login")` only in the browser.

- [ ] **Step 2: Run the Web tests and verify they fail**

Run: `pnpm --filter @battlefield/web test -- auth app-shell`

Expected: FAIL because the login/session components do not exist and AppShell still reads the development actor environment.

- [ ] **Step 3: Implement shared credentialed API configuration**

`apiBaseUrl()` returns the configured base URL or `http://localhost:3001`; every browser request sets `credentials: "include"`. Remove `NEXT_PUBLIC_DEV_TENANT_ID`, `NEXT_PUBLIC_DEV_USER_ID`, and production “authentication not configured” branches from all feature clients. Do not send actor headers from Web.

- [ ] **Step 4: Implement the login form and session-aware shell**

The login page visibly labels tenant, email, and password, pre-fills tenant slug `alpha`, and displays the two synthetic demo account emails below the form. `SessionProvider` fetches `/auth/session`, withholds protected children while loading, and exposes `session` and `logout()`.

The top-right identity button opens a popover:

- Sales 1: `销售身份`, `所属部门：商业化一部`, `直属领导：领导A`.
- Leader A: `直属领导`, `所属部门：商业化一部`, `团队成员：销售1`.
- Both: email and `退出登录`.

- [ ] **Step 5: Verify the Web identity experience**

Run: `pnpm --filter @battlefield/web test -- auth app-shell && pnpm --filter @battlefield/web typecheck && pnpm --filter @battlefield/web build`

Expected: PASS and no Web source references to development actor headers remain.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/login/page.tsx apps/web/src/auth apps/web/src/api apps/web/src/layout apps/web/src/business-entities/api-client.ts apps/web/src/followup-drafts/api-client.ts apps/web/src/battle-operations/api-client.ts apps/web/src/notifications/api-client.ts apps/web/src/workspace/api-client.ts apps/web/src/management-queries/api-client.ts apps/web/src/weekly-reports/api-client.ts apps/web/app/globals.css
git add -u apps/web/src/config
git commit -m "feat: add visible sales and leader login"
git push origin main
```

### Task 6: Perform the first visible acceptance and document it

**Files:**
- Create: `docs/acceptance/2026-08-31-stage-1-two-level-login.md`
- Modify: `docs/README.md`
- Modify: `task_plan.md`
- Modify: `progress.md`

**Interfaces:**
- Consumes: the running demo API and Web app.
- Produces: a repeatable human acceptance script with visible expected results.

- [ ] **Step 1: Start the demo API and Web app**

Run in separate terminals:

```bash
pnpm --filter @battlefield/api dev:demo
pnpm --filter @battlefield/web dev
```

Expected: API on `http://127.0.0.1:3001`, Web on `http://localhost:3000`, no credential value printed.

- [ ] **Step 2: Visually accept Sales 1**

Open `http://localhost:3000/login`, log in with tenant `alpha`, email `sales1@demo.local`, password `Demo@2026`, then open the account control. Verify the visible copy is exactly “销售身份 / 商业化一部 / 直属领导：领导A”. Refresh `/workspace` and confirm the session persists. Log out and verify protected content disappears.

- [ ] **Step 3: Visually accept Leader A**

Log in with `leader.a@demo.local` and the same synthetic password. Open the account control and verify “直属领导 / 商业化一部 / 团队成员：销售1”. Refresh and log out.

- [ ] **Step 4: Verify identity cannot be overridden**

With Leader A logged in, use the normal browser UI only and verify it continues to show Leader A after navigation. With no login, direct navigation to `/workspace` must show the login path instead of synthetic sales data.

- [ ] **Step 5: Run proportionate regression checks**

Run:

```bash
pnpm check:public
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: all commands exit 0. These checks are regression evidence, not the user-facing acceptance result.

- [ ] **Step 6: Write the acceptance guide and progress record**

The acceptance guide records URL, both synthetic accounts, the five visible clicks, expected labels, logout behavior, and the explicit boundary that Stage 1 does not yet include real Agent analysis, read-only ledgers, map mutation, notification drawer, or leader natural-language questions.

- [ ] **Step 7: Commit and push the accepted stage**

```bash
git add docs/acceptance/2026-08-31-stage-1-two-level-login.md docs/README.md task_plan.md progress.md
git commit -m "docs: add stage one visible acceptance"
git push origin main
```
