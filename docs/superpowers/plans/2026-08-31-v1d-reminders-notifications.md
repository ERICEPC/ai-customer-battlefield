# V1-D Reminder and Notification Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one production-shaped reminder flow in which an accepted formal action schedules a versioned due-time reminder, the reminder creates a durable in-app notification, and an optional Feishu app-bot adapter delivers the same channel-neutral notification without becoming a business dependency.

**Architecture:** Keep PostgreSQL as the source of truth and use the existing transactional Outbox as the boundary between action writes and asynchronous work. A separate worker claims messages and due jobs with short leases, invokes framework-free handlers, and records retries/dead letters; notification events are the inbox truth, while Feishu is one replaceable delivery adapter. V1-D publishes a versioned due-time policy only; advance, overdue, and escalation nodes remain expressible in the policy schema but are not silently assigned business values.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 11.19, PostgreSQL 17+/18 CI, Kysely, PGlite, Zod, NestJS 12, Next.js 16, Vitest 4, `@larksuiteoapi/node-sdk` 1.73.0.

**Spec:** `docs/01-V1产品设计总纲.md` sections 6.5, 8.3, 9–10; `docs/02-业务数据模型.md` sections 10, 12–14 and 17–18; `docs/04-系统架构与详细设计.md` sections 9.2, 11.1, 12, 15–16.

## Global Constraints

- Only a confirmed `business_action` may produce a reminder; pending, rejected, or expired proposals never enter reminder scheduling.
- Notification creation and all external delivery occur after the business transaction. A notification failure must never roll back a follow-up, fact, analysis, proposal decision, or action transition.
- The in-app notification event is the durable user-visible truth; Feishu/email are delivery attempts and may fail independently.
- Outbox publication is at least once. Every handler, reminder instance, notification event, and channel delivery therefore requires a tenant-scoped stable dedupe key.
- Workers claim at most 50 rows per transaction with `for update skip locked`, release database locks before calling external services, recover expired leases, and stop automatic retry after 8 attempts.
- Retryable failures use `available_at = now + min(2^attempt_count * 30 seconds, 30 minutes)`; permanent provider failures and attempt 8 enter `dead_lettered` with a sanitized error code/message.
- Reminder policies and notification templates are immutable published versions. V1-D seeds only `due` at offset `0` minutes and an `action_due` template for existing tenants.
- Completing or cancelling an action cancels every scheduled/failed reminder that has not created a notification. Changing planned time is not added in this slice; the future edit command must cancel and rebuild against the latest action version.
- Feishu production delivery uses an app bot and official SDK. Feishu CLI remains a debugging/Tool option and is not imported by the worker runtime.
- Credentials are read through a `FeishuCredentialProvider`; secrets, access tokens, raw provider responses, customer evidence, phone numbers, and email addresses are never stored in notification bodies or logs.
- All new tenant tables use composite tenant foreign keys, explicit tenant predicates, forced RLS, and real PostgreSQL 18 verification.

---

### Task 1: Strict reminder/notification contracts and framework-free ports

**Files:**
- Create: `packages/contracts/src/reminders.ts`
- Create: `packages/contracts/src/notifications.ts`
- Create: `packages/contracts/src/reminders.test.ts`
- Create: `packages/contracts/src/notifications.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/core/src/async-work/outbox-processor.ts`
- Create: `packages/core/src/async-work/outbox-processor.test.ts`
- Create: `packages/core/src/reminders/reminder-scheduler.ts`
- Create: `packages/core/src/reminders/reminder-scheduler.test.ts`
- Create: `packages/core/src/notifications/notification-delivery.ts`
- Create: `packages/core/src/notifications/notification-delivery.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces `OutboxMessage`, `OutboxStore`, `OutboxTopicHandler`, `ProcessOutboxBatch`, `ReminderStore`, `ScheduleActionReminders`, `DispatchDueReminders`, `NotificationStore`, `NotificationChannel`, and strict HTTP response schemas.
- `NotificationChannel` consumes rendered channel-neutral content and returns only provider metadata; it cannot query business tables.

- [x] **Step 1: Write failing contract tests for bounded public shapes**

```ts
expect(reminderInstanceSchema.parse({
  reminderId,
  actionId,
  recipientUserId,
  kind: "due",
  remindAt: "2026-09-01T01:00:00.000Z",
  status: "scheduled",
  policyVersion: "1",
})).toMatchObject({ kind: "due", status: "scheduled" });

expect(inboxPageSchema.parse({
  items: [{
    notificationId,
    eventType: "action_due",
    title: "经营动作已到计划时间",
    body: "确认下一步客户经营动作",
    deepLink: `/actions?actionId=${actionId}`,
    priority: "high",
    createdAt: "2026-09-01T01:00:00.000Z",
    readAt: null,
  }],
  nextCursor: null,
})).toBeDefined();
```

- [x] **Step 2: Run the new contract tests and verify RED**

Run: `pnpm --filter @battlefield/contracts test -- --run`

Expected: FAIL because `reminders.ts`, `notifications.ts`, and their exports do not exist.

- [x] **Step 3: Implement strict Zod contracts**

```ts
export const reminderKindSchema = z.enum([
  "advance",
  "due",
  "overdue",
  "escalation",
]);
export const reminderStatusSchema = z.enum([
  "scheduled",
  "processing",
  "notified",
  "failed",
  "cancelled",
  "dead_lettered",
]);
export const notificationPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "urgent",
]);
export const inboxQuerySchema = z.strictObject({
  unreadOnly: booleanQuerySchema.optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
```

Keep `title` at 200 characters, `body` at 2,000, `deepLink` at 2,000 and require an application-relative path beginning with `/`; reject arbitrary URLs and unknown keys.

- [x] **Step 4: Write failing core behavior tests**

Cover these exact invariants:

```ts
it("acknowledges an outbox row only after its handler commits", async () => {
  handler.handle.mockRejectedValueOnce(new Error("temporary"));
  await processor.runOnce(scope);
  expect(store.markPublished).not.toHaveBeenCalled();
  expect(store.reschedule).toHaveBeenCalledWith(expect.objectContaining({
    messageId,
    attemptCount: 1,
  }));
});

it("schedules only a formal action and uses a stable due-node key", async () => {
  await scheduler.onActionAccepted({ actor, actionId, occurredAt });
  expect(store.schedule).toHaveBeenCalledWith(expect.objectContaining({
    actionId,
    kind: "due",
    dedupeKey: `action:${actionId}:policy:1:due:owner:${ownerId}`,
  }));
});

it("persists inbox truth before requesting an external channel", async () => {
  await delivery.deliver(notificationId);
  expect(store.claimDelivery).toHaveBeenCalledBefore(channel.send);
  expect(store.markDelivered).toHaveBeenCalledAfter(channel.send);
});
```

- [x] **Step 5: Run core tests and verify RED**

Run: `pnpm --filter @battlefield/core test -- --run`

Expected: FAIL on missing ports/use cases.

- [x] **Step 6: Implement the smallest framework-free modules**

```ts
export interface OutboxStore {
  claimBatch(input: ClaimOutboxInput): Promise<OutboxMessage[]>;
  markPublished(input: CompleteOutboxInput): Promise<void>;
  reschedule(input: RetryOutboxInput): Promise<void>;
  deadLetter(input: DeadLetterOutboxInput): Promise<void>;
}

export interface NotificationChannel {
  readonly channel: "feishu" | "email";
  send(input: ChannelNotification): Promise<{
    providerMessageId: string;
    providerRequestId: string | null;
  }>;
}
```

`ProcessOutboxBatch` selects a handler by exact topic, treats unknown topics as permanent errors, calculates retry delay from the documented formula, and never catches an error without persisting retry/dead-letter state.

- [x] **Step 7: Run focused tests, typecheck, and commit**

Run: `pnpm --filter @battlefield/contracts test -- --run && pnpm --filter @battlefield/core test -- --run && pnpm --filter @battlefield/core typecheck`

Expected: all focused checks pass.

Commit: `feat: define reminder and notification contracts`

---

### Task 2: `0005_reminders_notifications` schema and database invariants

**Files:**
- Create: `packages/database/migrations/0005_reminders_notifications.sql`
- Modify: `packages/database/src/database-types.ts`
- Create: `packages/database/test/reminders-notifications-migration.test.ts`
- Modify: `packages/database/test/postgres-migrations.postgres.test.ts`

**Interfaces:**
- Produces tenant-safe persistence for `reminder_policy_versions`, `reminder_instances`, `notification_template_versions`, `notification_events`, and `notification_deliveries`.
- Extends `outbox_messages.status` with terminal `dead_lettered` without changing existing published records.

- [x] **Step 1: Write migration tests before SQL exists**

Test cross-tenant FK rejection, forced RLS, one published policy/template version per key, immutable published rows, JSON-array policy nodes, one reminder per dedupe key, one notification per dedupe key, one delivery per event/channel, read timestamp coherence, provider/error terminal-state coherence, and exclusion of `dead_lettered` rows from claim indexes.

```ts
await expect(
  tenantOne.insertInto("app.reminder_instances").values({
    tenant_id: tenantOneId,
    action_id: tenantTwoActionId,
    recipient_user_id: tenantOneUserId,
    policy_version_id: policyId,
    action_version_no: 1,
    kind: "due",
    remind_at: dueAt,
    available_at: dueAt,
    dedupe_key: "cross-tenant-must-fail",
  }).execute(),
).rejects.toThrow();
```

- [x] **Step 2: Run database tests and verify RED**

Run: `pnpm --filter @battlefield/database test -- --run`

Expected: the new migration suite fails because the five tables are missing.

- [x] **Step 3: Add the complete transactional migration**

The policy table must use this published-version core:

```sql
create table app.reminder_policy_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  policy_key text not null,
  version_no bigint not null,
  name text not null,
  status text not null,
  nodes jsonb not null,
  effective_at timestamptz not null,
  published_by uuid not null,
  created_at timestamptz not null default now(),
  constraint reminder_policy_versions_pk primary key (tenant_id, id),
  constraint reminder_policy_versions_user_fk foreign key (tenant_id, published_by)
    references app.users (tenant_id, id),
  constraint reminder_policy_versions_number_unique
    unique (tenant_id, policy_key, version_no),
  constraint reminder_policy_versions_status_valid
    check (status in ('draft', 'published', 'retired')),
  constraint reminder_policy_versions_nodes_array
    check (jsonb_typeof(nodes) = 'array' and jsonb_array_length(nodes) > 0)
);
create unique index reminder_policy_versions_published_unique_idx
  on app.reminder_policy_versions (tenant_id, policy_key)
  where status = 'published';
```

Add immutable-update triggers for published policy/template versions, composite FKs for actions/users/channel addresses/events, claim indexes on `(status, available_at, id)`, recipient unread index on `(tenant_id, recipient_user_id, read_at, created_at desc, id desc)`, and forced RLS policies matching `app.current_tenant_id()`.

- [x] **Step 4: Seed only versioned due-time defaults for existing tenants**

Insert one `default_action_due` published policy containing:

```json
[{"kind":"due","offsetMinutes":0,"recipient":"owner","channels":["in_app","feishu"]}]
```

Insert `action_due` templates for `in_app` and `feishu`. Use the tenant's first active user as `published_by`; tenants without an active user receive no seed and are surfaced by worker diagnostics rather than receiving an invalid implicit policy.

- [x] **Step 5: Update generated Kysely database interfaces**

Add exact unions for reminder/delivery statuses and typed JSON structures. `OutboxMessageTable.status` becomes:

```ts
type OutboxStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "cancelled"
  | "dead_lettered";
```

- [x] **Step 6: Verify PGlite and PostgreSQL 18 behavior**

Run: `pnpm --filter @battlefield/database test -- --run`

Run with CI PostgreSQL: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/battlefield_test pnpm --filter @battlefield/database test:postgres`

Expected: all migrations apply twice, every new tenant table has forced RLS, and all new invariants pass.

- [x] **Step 7: Commit**

Commit: `feat: add reminder and notification schema`

---

### Task 3: Kysely Outbox, reminder, and notification stores

**Files:**
- Create: `packages/database/src/async-work/kysely-outbox-store.ts`
- Create: `packages/database/src/reminders/kysely-reminder-store.ts`
- Create: `packages/database/src/notifications/kysely-notification-store.ts`
- Create: `packages/database/test/outbox-reminder-notification-store.test.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Implements Task 1 ports without exposing Kysely outside `@battlefield/database`.
- Each claim returns immutable data and a claim token; completion/retry updates require the same token and `processing` status.

- [x] **Step 1: Write failing concurrent-claim and crash-recovery tests**

```ts
const [first, second] = await Promise.all([
  store.claimBatch({ actor, now, limit: 10, leaseMs: 60_000 }),
  store.claimBatch({ actor, now, limit: 10, leaseMs: 60_000 }),
]);
expect(intersection(ids(first), ids(second))).toEqual([]);

await store.recoverExpiredClaims({ actor, now: plusMinutes(now, 2) });
expect(await readOutbox(messageId)).toMatchObject({
  status: "failed",
  claimed_at: null,
});
```

Also prove notification creation plus in-app delivery plus reminder `notified` status is one transaction, and repeated dedupe input returns the first notification instead of creating duplicates.

- [x] **Step 2: Run the database test and verify RED**

Run: `pnpm --filter @battlefield/database test -- --run`

Expected: FAIL because the Kysely stores do not exist.

- [x] **Step 3: Implement short claim transactions**

Use this locking form inside `withTenantTransaction`:

```sql
select id
from app.outbox_messages
where tenant_id = $1
  and status in ('pending', 'failed')
  and available_at <= $2
order by available_at, id
for update skip locked
limit $3
```

Update selected rows to `processing`, set `claimed_at`, increment `attempt_count`, and return them before any handler/external call. Complete/retry/dead-letter operations lock only the claimed row and validate its current state.

- [x] **Step 4: Implement reminder scheduling and notification materialization transactions**

`scheduleForAction` reads the current published policy and formal action under tenant scope, expands only known nodes, and inserts with `on conflict (tenant_id, dedupe_key) do nothing`. `materializeDueReminder` locks one processing reminder, rechecks action status/version/owner, inserts notification event and in-app delivered row, then sets `notification_event_id` and `notified` atomically.

- [x] **Step 5: Implement tenant-safe inbox keyset reads and mark-read**

Cursor order is `(created_at desc, id desc)`. `markRead` updates only the actor's recipient row and is idempotent:

```ts
.where("tenant_id", "=", input.actor.tenantId)
.where("recipient_user_id", "=", input.actor.userId)
.where("id", "=", input.notificationId)
.set({ read_at: sql`coalesce(read_at, ${input.readAt}::timestamptz)` })
```

- [x] **Step 6: Run store tests twice and commit**

Run twice: `pnpm --filter @battlefield/database test -- --run`

Expected: both clean-database runs pass with no duplicate claims or notifications.

Commit: `feat: persist outbox reminders and notifications`

---

### Task 4: Worker executable and action-reminder handlers

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/test/worker.test.ts`
- Modify: `apps/api/dev/demo-server.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Production worker consumes tenant scope from `WORKER_TENANT_ID` and `WORKER_USER_ID`; future tenant orchestration can launch the same worker per tenant without changing handlers.
- Handles `action_proposal.accepted.v1` by querying the created action and scheduling reminders; handles `business_action.status_changed.v1` by cancelling pending reminders for `completed`/`cancelled`.

- [x] **Step 1: Write failing worker orchestration tests**

Prove one batch schedules one due reminder, repeated Outbox handling creates no duplicate, completion before due cancels it, an unknown topic dead-letters without crashing later rows, a transient handler failure reschedules, and a lease-expired row becomes claimable.

```ts
await worker.tick();
await worker.tick();
expect(await countReminders(actionId)).toBe(1);

await transitionAction(actionId, "completed");
await worker.tick();
expect(await readReminder(actionId)).toMatchObject({ status: "cancelled" });
```

- [x] **Step 2: Run worker tests and verify RED**

Run: `pnpm --filter @battlefield/worker test -- --run`

Expected: FAIL because the worker package does not exist.

- [x] **Step 3: Implement a bounded polling loop**

```ts
while (!signal.aborted) {
  const result = await worker.tick();
  await wait(result.claimed === 0 ? idlePollMs : busyPollMs, signal);
}
```

Validate UUIDs and positive intervals at startup. Handle SIGINT/SIGTERM, await the active tick, then close the database. Do not use recursive timers or overlap ticks.

- [x] **Step 4: Reuse the same worker in the synthetic demo process**

`dev/demo-server.ts` owns the PGlite handle, so create the worker against that handle and run a cancellable 250ms demo poller in the same process. Seed a due-only policy/template and active Feishu address only with synthetic IDs; do not enable real external delivery.

- [x] **Step 5: Document explicit worker configuration**

Add:

```dotenv
WORKER_TENANT_ID=10000000-0000-4000-8000-000000000001
WORKER_USER_ID=30000000-0000-4000-8000-000000000001
WORKER_BATCH_SIZE=50
WORKER_IDLE_POLL_MS=5000
WORKER_LEASE_MS=60000
```

Document that API and worker are separate production processes and both use the same migrated PostgreSQL database.

- [x] **Step 6: Verify and commit**

Run: `pnpm --filter @battlefield/worker test -- --run && pnpm --filter @battlefield/worker typecheck && pnpm --filter @battlefield/worker build`

Commit: `feat: process action reminder outbox events`

---

### Task 5: Inbox REST API and responsive Web notification center

**Files:**
- Create: `apps/api/src/notifications/notifications.module.ts`
- Create: `apps/api/src/notifications/inbox.controller.ts`
- Create: `apps/api/src/notifications/notifications.providers.ts`
- Create: `apps/api/test/notifications.e2e.test.ts`
- Create: `apps/web/app/inbox/page.tsx`
- Create: `apps/web/src/notifications/inbox-workspace.tsx`
- Create: `apps/web/src/notifications/inbox-workspace.test.tsx`
- Create: `apps/web/src/notifications/api-client.ts`
- Create: `apps/web/src/notifications/api-client.test.ts`
- Modify: `apps/web/src/layout/app-shell.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Adds `GET /api/v1/inbox?unreadOnly=true&limit=50&cursor=...` and idempotent `POST /api/v1/inbox/:notificationId/read`.
- Web treats the returned deep link as an application-relative path and never renders stored HTML.

- [x] **Step 1: Write API E2E tests before controllers exist**

Cover missing actor 401, invalid cursor/limit 400, other recipient 404, unread filter, keyset pagination, stable mark-read response, repeated mark-read equality, tenant isolation, and deep-link/title/body contract validation.

```ts
const read = await actorRequest(app)
  .post(`/api/v1/inbox/${notificationId}/read`)
  .send({})
  .expect(201);
expect(await actorRequest(app)
  .post(`/api/v1/inbox/${notificationId}/read`)
  .send({})
  .expect(201)).toEqual(read);
```

- [x] **Step 2: Run API tests and verify RED**

Run: `pnpm --filter @battlefield/api test -- --run`

Expected: the inbox routes return 404.

- [x] **Step 3: Implement fail-closed providers and controllers**

Parse route/query input with shared contracts, derive actor only through the existing development-auth seam, map typed not-found/cursor failures to stable errors, and return 503 when database adapters are unavailable. Controllers contain no SQL and no Feishu calls.

- [x] **Step 4: Write Web tests before UI exists**

Cover loading, empty, error/retry, unread-only filter, cursor append, no duplicate rows, mark read, safe relative deep link, notification time/priority labels, desktop list, 390px card layout, and stale pagination response suppression.

- [x] **Step 5: Build the notification center**

The page title is `通知中心`; each row shows unread marker, title, plain-text body, priority, created time, and `查看相关动作`. Mark read optimistically only after the server returns a receipt; on failure restore unread state and expose retry. Add a `通知` item to desktop and mobile navigation.

- [x] **Step 6: Run API/Web/full checks and commit**

Run: `pnpm --filter @battlefield/api test -- --run && pnpm --filter @battlefield/web test -- --run && pnpm lint && pnpm typecheck`

Commit: `feat: add durable in-app notification center`

---

### Task 6: Optional Feishu app-bot delivery adapter

**Files:**
- Modify: `apps/worker/package.json`
- Create: `apps/worker/src/channels/feishu/feishu-channel.ts`
- Create: `apps/worker/src/channels/feishu/lark-sdk-messenger.ts`
- Create: `apps/worker/src/channels/feishu/feishu-errors.ts`
- Create: `apps/worker/src/channels/feishu/feishu-channel.test.ts`
- Create: `apps/worker/src/channels/channel-registry.ts`
- Modify: `apps/worker/src/config.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- `FeishuCredentialProvider.get(tenantId)` returns `{ appId, appSecret } | null`; the environment implementation is explicitly single-tenant.
- `FeishuMessenger.sendCard` receives `open_id`, a 50-character-or-shorter UUID, and an interactive card JSON object; tests inject a fake messenger and never call Feishu.

- [x] **Step 1: Add and lock the official SDK**

Run: `pnpm --filter @battlefield/worker add @larksuiteoapi/node-sdk@1.73.0`

Expected: worker manifest and `pnpm-lock.yaml` contain the pinned resolved dependency.

- [x] **Step 2: Write adapter tests for success and error classification**

```ts
expect(await channel.send(notification)).toEqual({
  providerMessageId: "om_synthetic",
  providerRequestId: "log_synthetic",
});
await expect(channel.send(rateLimited)).rejects.toMatchObject({
  retryable: true,
  retryAfterMs: 2_000,
});
await expect(channel.send(userOptedOut)).rejects.toMatchObject({
  retryable: false,
  code: "FEISHU_RECIPIENT_UNAVAILABLE",
});
```

Map network/5xx/429 to retryable; map missing active address, cross-tenant recipient, app scope/opt-out codes including `230038` and `230053`, and invalid card/input to permanent errors.

- [x] **Step 3: Implement a summary-plus-deep-link card**

The card displays notification title, body, priority label, created time, and one button whose URL is `PUBLIC_WEB_BASE_URL + deepLink`. It has no business mutation callback. Pass delivery dedupe key as Feishu message `uuid`; do not include evidence text beyond the already persisted notification body.

- [x] **Step 4: Integrate channel registry without making Feishu mandatory**

If credentials or an active Feishu `channel_address` are absent, create no Feishu delivery and keep the in-app notification delivered. If a Feishu delivery exists, the worker claims and sends it independently; provider downtime changes only that delivery row.

- [x] **Step 5: Document credentials and safe operating boundary**

```dotenv
PUBLIC_WEB_BASE_URL=https://battlefield.example.com
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_RECEIVE_ID_TYPE=open_id
```

Document application bot scope, `im:message:send_as_bot`, user availability requirements, Secret Manager expectations, rate-limit retry, and that empty credentials disable Feishu without disabling Web/inbox.

- [x] **Step 6: Verify and commit**

Run: `pnpm --filter @battlefield/worker test -- --run && pnpm --filter @battlefield/worker typecheck && pnpm check:public`

Commit: `feat: add optional Feishu notification adapter`

---

### Task 7: Full acceptance, PostgreSQL 18 CI, and continuity

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/01-V1产品设计总纲.md`
- Modify: `docs/02-业务数据模型.md`
- Modify: `docs/04-系统架构与详细设计.md`
- Modify: this plan's checkboxes and acceptance evidence
- Update ignored: `task_plan.md`, `progress.md`, `findings.md`

**Interfaces:**
- CI starts no real Feishu connection; it validates the adapter through fakes and validates reminder/notification SQL on PostgreSQL 18.
- Acceptance closes only V1-D and immediately transitions to sales/management home or reports/management queries according to the persistent product plan.

- [ ] **Step 1: Add a real PostgreSQL smoke path**

The smoke must migrate an empty PostgreSQL 18 database, accept one proposal, run the Outbox handler, assert one due reminder, advance the injected clock, materialize one notification/in-app delivery, retry the same messages, assert counts remain one, mark it read, complete the action, and assert no future reminder remains claimable.

- [ ] **Step 2: Run the complete local gate**

Run:

```bash
pnpm install --frozen-lockfile
pnpm check:public
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: every command exits 0; API tests run in an environment allowed to bind a loopback port.

- [ ] **Step 3: Run real browser acceptance**

Against Nest + PGlite demo and the same in-process worker, prove: confirmed fact → analysis → accepted action → due reminder → one unread inbox notification → safe action deep link → mark read. Repeat worker ticks and prove no duplicate. Verify 1280px and 390px `documentWidth === innerWidth` and zero console warnings/errors.

- [ ] **Step 4: Verify Feishu disabled-mode resilience**

Run the same acceptance with empty Feishu credentials. Inbox must still succeed, no Feishu delivery is created, and no user-facing error claims the business action failed.

- [ ] **Step 5: Review, push directly to `main`, and watch CI**

Run the repository review gate, fix every Critical/Important finding, commit the verified slice, `git push origin main`, and watch the matching GitHub Actions run to a terminal success. Record remote SHA, exact test counts, CI URL/duration, browser evidence, and deferred boundaries.

- [ ] **Step 6: Update living docs and continue**

Mark reminder/notification implementation as delivered; keep advance/overdue/escalation policy values, real Feishu tenant credentials, reports, management queries, configuration UI, production OIDC, and deployment recovery explicit. Do not mark the whole V1 complete.

## Acceptance Gate

On synthetic data, accepting a proposal creates one formal action and eventually one versioned due reminder. When due, repeated worker execution produces exactly one durable unread notification and one in-app delivery; the recipient can open the action and mark the notification read. Completing/cancelling before due prevents notification creation. A missing or failing Feishu adapter cannot affect business state or inbox availability; configured Feishu attempts are independently retryable/dead-lettered with sanitized diagnostics. All tenant isolation, leases, dedupe keys, status constraints, forced RLS, API contracts, Web accessibility, responsive layouts, and PostgreSQL 18 checks pass.
