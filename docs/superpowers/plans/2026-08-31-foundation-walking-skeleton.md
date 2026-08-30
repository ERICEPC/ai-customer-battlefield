# Foundation Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a safe, testable monorepo whose first vertical slice creates an AI-generated follow-up draft without binding the business core to a model vendor, database, notification channel, or Web framework.

**Architecture:** Use separate Next.js Web and NestJS API applications in a pnpm workspace. Put transport schemas in `packages/contracts` and pure application/domain logic plus Agent ports in `packages/core`; framework adapters live under `apps/*`. The first slice is deliberately in-memory: it proves the boundaries and confirmation state before database schema and provider integrations are introduced.

**Tech Stack:** Node.js 24.15+, pnpm 11.19.0, TypeScript ESM, Next.js 16, NestJS 12, Zod, Vitest, React Testing Library, Biome, GitHub Actions.

**Spec:** `docs/01-V1产品设计总纲.md` and `docs/02-业务数据模型.md`

## Global Constraints

- The public repository is `https://github.com/ERICEPC/ai-customer-battlefield`.
- Do not track Feishu URLs, recordings, exported business data, internal findings, local memory files, tokens, credentials, or absolute user paths.
- Do not add an open-source license until the owner explicitly selects one.
- Use Node.js `>=24.15.0 <25` and pin `packageManager` to `pnpm@11.19.0`.
- Use ESM and TypeScript strict mode in every workspace.
- Web consumes the API through a versioned REST contract; no business rule may live only in a Next.js route, component, or Server Action.
- Agent code calls business capabilities through typed ports/Tools and never receives a database client or arbitrary SQL capability.
- An AI result is a `pending_confirmation` draft, never a formal follow-up fact.
- The first slice has no production database, authentication provider, model provider, or notification provider; those are later plans behind the ports established here.
- Use test-first red-green-refactor cycles and keep each commit independently verifiable.

---

### Task 1: Public repository boundary and workspace foundation

**Files:**
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.gitattributes`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `scripts/public-boundary.mjs`
- Test: `scripts/public-boundary.test.mjs`

**Interfaces:**
- Consumes: the approved public/private boundary in this plan.
- Produces: root commands `pnpm check:public`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` for every later task.

- [ ] **Step 1: Initialize Git with a main branch and add the remote**

Run:

```bash
git init -b main
git remote add origin https://github.com/ERICEPC/ai-customer-battlefield.git
```

Expected: `git remote -v` lists only the public repository.

- [ ] **Step 2: Write the public-boundary failing test**

Create `scripts/public-boundary.test.mjs` using `node:test`. Import `findPublicBoundaryViolations` from `public-boundary.mjs`; assert that paths under `artifacts/`, planning-memory files, video formats, private collaboration hostnames, and absolute macOS home paths are reported as violations. Build sensitive-looking fixture strings from separate fragments so the public scanner does not flag its own tests.

- [ ] **Step 3: Run the test and verify it fails**

Run: `node --test scripts/public-boundary.test.mjs`

Expected: FAIL because `public-boundary.mjs` does not exist.

- [ ] **Step 4: Implement the boundary checker and repository metadata**

`scripts/public-boundary.mjs` must export:

```js
export function findPublicBoundaryViolations(entries) {
  const forbiddenPaths = [
    /^artifacts\//,
    /^findings\.md$/,
    /^progress\.md$/,
    /^task_plan\.md$/,
    /^docs\/(design|discovery|research)\//,
    /\.(mp4|mov|m4v)$/i,
  ];
  const forbiddenContent = [
    new RegExp(["sense", "time\\.feishu\\.cn"].join(""), "i"),
    new RegExp(["/", "Users", "/"].join("")),
    new RegExp(["recording", "\\.mp4"].join(""), "i"),
  ];
  return entries.filter(({ path, content = "" }) =>
    forbiddenPaths.some((pattern) => pattern.test(path)) ||
    forbiddenContent.some((pattern) => pattern.test(content)),
  );
}
```

The CLI portion must read `git ls-files`, scan tracked UTF-8 text files, print only file paths and rule names, never secret values, and exit non-zero on violations.

`.gitignore` must exclude internal planning/evidence files, media, environment files, dependencies, build output, coverage, and editor/system noise while allowing `docs/01-*`, `docs/02-*`, `docs/README.md`, and `docs/superpowers/plans/**`.

Create a root `package.json` with:

```json
{
  "name": "ai-customer-battlefield",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=24.15.0 <25" },
  "scripts": {
    "check:public": "node scripts/public-boundary.mjs",
    "lint": "biome check .",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
```

Install the shared development tools and let the lockfile pin exact resolved versions:

```bash
pnpm add -Dw typescript@latest @biomejs/biome@latest vitest@latest @types/node@latest
```

README must describe the product in generic terms, show the workspace layout, explain that the repository contains no customer data, and link only to public-safe documents. SECURITY must instruct contributors to report vulnerabilities privately and never open an issue containing customer data.

- [ ] **Step 5: Run the boundary test and metadata checks**

Run:

```bash
node --test scripts/public-boundary.test.mjs
git check-ignore -v findings.md progress.md task_plan.md artifacts/private/sample-video.mp4
```

Expected: test PASS; every internal path is ignored.

- [ ] **Step 6: Commit the public repository foundation**

Run:

```bash
git add .gitignore .editorconfig .gitattributes package.json pnpm-workspace.yaml tsconfig.base.json biome.json README.md CONTRIBUTING.md SECURITY.md scripts docs/README.md docs/01-V1产品设计总纲.md docs/02-业务数据模型.md CONTEXT.md
pnpm check:public
git commit -m "chore: initialize public project foundation"
```

Expected: commit succeeds and `pnpm check:public` reports zero violations.

---

### Task 2: Versioned transport contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/health.ts`
- Create: `packages/contracts/src/followup-draft.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/followup-draft.test.ts`

**Interfaces:**
- Consumes: Zod and the API prefix `/api/v1`.
- Produces: `createFollowupDraftRequestSchema`, `followupDraftResponseSchema`, `CreateFollowupDraftRequest`, `FollowupDraftResponse`, and `HealthResponse` for API and Web.

- [ ] **Step 1: Write failing contract tests**

Test these cases:

```ts
expect(createFollowupDraftRequestSchema.safeParse({ rawInput: "" }).success).toBe(false);
expect(createFollowupDraftRequestSchema.safeParse({ rawInput: "客户确认预算" }).success).toBe(true);
expect(followupDraftResponseSchema.parse(validDraft).status).toBe("pending_confirmation");
```

The valid response must include `draftId`, `status`, `rawInput`, `candidate.summary`, `candidate.relatedOpportunityIds`, and ISO `createdAt`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @battlefield/contracts test`

Expected: FAIL because schemas are absent.

- [ ] **Step 3: Implement minimal Zod schemas and exported inferred types**

Use a strict request schema with trimmed `rawInput` length `1..10000`. Define response status as `z.literal("pending_confirmation")`; do not include a formal follow-up ID or committed business state.

`packages/contracts/package.json` must be a private ESM workspace named `@battlefield/contracts` with `build: tsc -p tsconfig.json`, `typecheck: tsc --noEmit -p tsconfig.json`, and `test: vitest run`. Install its runtime dependency:

```bash
pnpm --filter @battlefield/contracts add zod@latest
```

- [ ] **Step 4: Run contracts tests and typecheck**

Run:

```bash
pnpm --filter @battlefield/contracts test
pnpm --filter @battlefield/contracts typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts pnpm-lock.yaml package.json
git commit -m "feat: define follow-up draft API contracts"
```

---

### Task 3: Framework-free follow-up draft use case and Agent port

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/followup-drafts/followup-draft-agent.ts`
- Create: `packages/core/src/followup-drafts/create-followup-draft.ts`
- Create: `packages/core/src/followup-drafts/errors.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/src/followup-drafts/create-followup-draft.test.ts`

**Interfaces:**
- Consumes: transport-compatible input values but no Nest, Next, database, or model SDK.
- Produces:

```ts
export interface FollowupDraftAgent {
  propose(input: {
    actor: { tenantId: string; userId: string };
    rawInput: string;
  }): Promise<{
    summary: string;
    relatedOpportunityIds: string[];
  }>;
}

export class CreateFollowupDraft {
  execute(input: {
    actor: { tenantId: string; userId: string };
    rawInput: string;
  }): Promise<FollowupDraft>;
}
```

- [ ] **Step 1: Write failing use-case tests**

Cover:

1. whitespace-only input throws `InvalidRawInputError` and does not call the Agent;
2. a valid input calls the injected Agent once with actor scope;
3. output status is exactly `pending_confirmation`;
4. ID and time come from injected deterministic `DraftIdGenerator` and `Clock` ports.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @battlefield/core test`

Expected: FAIL because the use case and port are absent.

- [ ] **Step 3: Implement minimal pure TypeScript logic**

The class constructor accepts `{ agent, idGenerator, clock }`. Trim input, reject empty values, call `agent.propose`, and return:

```ts
{
  draftId: idGenerator.next(),
  status: "pending_confirmation",
  rawInput: trimmedInput,
  candidate,
  createdAt: clock.now().toISOString(),
}
```

Do not persist, notify, change a stage, or create an action.

`packages/core/package.json` must be a private ESM workspace named `@battlefield/core` with the same build/typecheck/test scripts as contracts. Core owns its input/output types and must not depend on `@battlefield/contracts`; the API adapter performs the transport-to-core mapping.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
pnpm --filter @battlefield/core test
pnpm --filter @battlefield/core typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat: add framework-free follow-up draft use case"
```

---

### Task 4: NestJS API adapter and deterministic development Agent

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Create: `apps/api/src/followup-drafts/followup-drafts.module.ts`
- Create: `apps/api/src/followup-drafts/followup-drafts.controller.ts`
- Create: `apps/api/src/followup-drafts/deterministic-followup-draft-agent.ts`
- Create: `apps/api/src/followup-drafts/followup-draft.providers.ts`
- Test: `apps/api/test/app.e2e.test.ts`

**Interfaces:**
- Consumes: `@battlefield/contracts` and `CreateFollowupDraft` from `@battlefield/core`.
- Produces: `GET /api/v1/health` and `POST /api/v1/followup-drafts`.

- [ ] **Step 1: Write failing API end-to-end tests**

Assert:

```ts
await request(app.getHttpServer())
  .get("/api/v1/health")
  .expect(200)
  .expect({ status: "ok" });

const response = await request(app.getHttpServer())
  .post("/api/v1/followup-drafts")
  .set("x-tenant-id", "tenant-demo")
  .set("x-user-id", "user-demo")
  .send({ rawInput: "客户确认预算，下一步提交方案" })
  .expect(201);

expect(response.body.status).toBe("pending_confirmation");
```

Also assert missing actor headers return 401/403 and blank input returns 400.

- [ ] **Step 2: Run e2e tests and verify they fail**

Run: `pnpm --filter @battlefield/api test:e2e`

Expected: FAIL because the API app is absent.

- [ ] **Step 3: Implement the API adapter**

Use a global prefix `api/v1`. Validate requests with the shared schema. Map actor headers into the application input; label this header adapter development-only in code because real authentication is a later plan.

The deterministic Agent adapter must implement `FollowupDraftAgent` and return a predictable summary without external model calls. It must live in `apps/api`, proving that a future OpenAI/SenseTime/other adapter can replace it without changing core.

`apps/api/package.json` must define `@battlefield/api`, depend on both workspace packages, and provide `dev`, `build`, `typecheck`, and `test:e2e` scripts. Install:

```bash
pnpm --filter @battlefield/api add @nestjs/common@latest @nestjs/core@latest @nestjs/platform-express@latest reflect-metadata@latest rxjs@latest @battlefield/contracts@workspace:* @battlefield/core@workspace:*
pnpm --filter @battlefield/api add -D @nestjs/testing@latest supertest@latest @types/supertest@latest
```

Before API tests/builds, build workspace dependencies with `pnpm --filter @battlefield/api... build` or an explicit package pretest script so a fresh clone never relies on untracked `dist/` output.

- [ ] **Step 4: Run API tests, typecheck, and build**

Run:

```bash
pnpm --filter @battlefield/api test:e2e
pnpm --filter @battlefield/api typecheck
pnpm --filter @battlefield/api... build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat: expose follow-up draft API"
```

---

### Task 5: Next.js sales workbench shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/src/followup-drafts/followup-draft-form.tsx`
- Create: `apps/web/src/followup-drafts/api-client.ts`
- Test: `apps/web/src/followup-drafts/followup-draft-form.test.tsx`

**Interfaces:**
- Consumes: `CreateFollowupDraftRequest` and `FollowupDraftResponse` from `@battlefield/contracts`, plus `NEXT_PUBLIC_API_BASE_URL`.
- Produces: a desktop-first responsive workbench with raw input, submit state, failure state, and a pending-confirmation result card.

- [ ] **Step 1: Write failing component tests**

Test that the form:

1. disables submit for empty input;
2. calls the injected API client with trimmed text;
3. shows a loading label during the request;
4. renders the returned summary and the visible status “待确认”；
5. renders a retryable error message without clearing the user input.

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm --filter @battlefield/web test`

Expected: FAIL because the component is absent.

- [ ] **Step 3: Implement the minimal workbench**

Use semantic HTML, keyboard-accessible controls, visible focus states, and Chinese product copy. Keep the visual scope to the sales input card and pending-confirmation card; do not invent the full map or dashboard in this task.

The API client posts to `/api/v1/followup-drafts` with development actor headers supplied from environment defaults only in local development. Production must fail closed when real auth is absent.

`apps/web/package.json` must define `@battlefield/web` and provide `dev`, `build`, `typecheck`, and `test` scripts. Install:

```bash
pnpm --filter @battlefield/web add next@latest react@latest react-dom@latest @battlefield/contracts@workspace:*
pnpm --filter @battlefield/web add -D @types/react@latest @types/react-dom@latest @testing-library/react@latest @testing-library/jest-dom@latest jsdom@latest
```

Configure Next `transpilePackages: ["@battlefield/contracts"]` so local development consumes the workspace contract package without duplicating schemas.

- [ ] **Step 4: Run Web tests, typecheck, and build**

Run:

```bash
pnpm --filter @battlefield/web test
pnpm --filter @battlefield/web typecheck
pnpm --filter @battlefield/web... build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: add sales follow-up draft workbench"
```

---

### Task 6: Whole-repository quality gate and first public push

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: all root verification commands created in Tasks 1–5.
- Produces: a reproducible CI gate and public collaboration instructions.

- [ ] **Step 1: Add a failing CI/workspace assertion**

Extend `scripts/public-boundary.test.mjs` to assert `.github/workflows/ci.yml` invokes `pnpm check:public`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

- [ ] **Step 2: Run and verify the assertion fails**

Run: `node --test scripts/public-boundary.test.mjs`

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Add GitHub Actions and collaboration docs**

CI must use checkout, setup-node with Node 24, Corepack/pnpm 11.19.0, `pnpm install --frozen-lockfile`, and the five root verification commands. Do not expose secrets or add deployment.

README must include local setup, commands, architecture boundaries, current limitations, and a link to CONTRIBUTING. Document that authentication, database persistence, real model providers, notifications, and production deployment are intentionally absent from this first slice.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
pnpm check:public
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git status --short
```

Expected: every command exits 0; only intended files are modified.

- [ ] **Step 5: Commit and push**

```bash
git add .github README.md docs/README.md scripts/public-boundary.test.mjs
git commit -m "ci: verify public monorepo"
git push -u origin main
```

Expected: the public repository shows the commits and CI starts without exposing ignored internal files.

---

## Follow-up Plans After This Skeleton

Create separate plans rather than extending this one for:

1. PostgreSQL schema, migrations, tenancy enforcement, facts, evidence, and immutable history;
2. real authentication and authorization decisions;
3. model/Agent adapters plus typed business Tools;
4. draft confirmation and formal follow-up commit transaction;
5. battle-state analysis, actions, reminders, weekly reports, and notifications;
6. complete UI information architecture and battle-map visualization.
