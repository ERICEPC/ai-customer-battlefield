# AI Customer Battlefield

AI Customer Battlefield is an independent customer-operation workspace for sales teams. It is designed around reviewable business facts, human-confirmed AI suggestions, configurable workflows, and replaceable integrations rather than any single collaboration platform or model provider.

The repository now contains a connected operating loop: a persistent tenant-scoped business-entity directory, human-confirmed follow-ups and facts, evidence-backed battle analysis, a customer battle map, a separately confirmed action workflow, a role-scoped sales/management workspace, and a controlled evidence-backed sales-progress query. AI output remains a draft or suggestion until a salesperson explicitly confirms it. The complete V1 product is still under active development.

## Architecture boundaries

- `apps/web`: browser experience built on the public API contract
- `apps/api`: versioned HTTP API and infrastructure adapters
- `apps/worker`: lease-based Outbox, reminder, and notification processing
- `packages/contracts`: transport schemas shared by API clients and servers
- `packages/core`: framework-free domain and application behavior
- `packages/database`: SQL migrations and replaceable Kysely PostgreSQL/PGlite adapters
- `docs`: public product, architecture, and implementation documentation

Business capabilities are exposed to Agents through typed ports/Tools. Core application code has no direct dependency on a model vendor, database client, notification channel, or Web framework.

## Local development

Requirements:

- Node.js `>=24.15.0 <25`
- pnpm `11.19.0`

After dependencies are installed:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install
```

For a local synthetic demo, start the in-memory PGlite API and Web application in separate terminals:

```bash
pnpm --filter @battlefield/api dev:demo
pnpm --filter @battlefield/web dev
```

Open `http://localhost:3000/workspace` for the role-scoped sales/management homepage, `/` for the follow-up confirmation workbench, `/entities` for the entity directory, `/battle-map` for evidence-backed positioning, `/actions` for the suggestion decision gate and formal actions, `/ask` for the controlled sales-progress query, or `/inbox` for durable in-app notifications. The demo API runs the same reminder Worker in-process with external channels disabled. Its database is recreated on every API restart and must never be used as production storage.

For a PostgreSQL-backed environment, use a dedicated PostgreSQL 17+ database, apply forward migrations explicitly, and then start the normal API:

```bash
export DATABASE_URL=postgresql://user:password@localhost:5432/battlefield
pnpm --filter @battlefield/database migrate
pnpm --filter @battlefield/api dev
pnpm --filter @battlefield/worker dev
```

The API and worker are separate production processes connected only through the same migrated PostgreSQL database. Neither process auto-creates or auto-migrates production schema. `DATABASE_URL` is mandatory; the worker also requires explicit tenant/system-user scope and bounded polling/lease values. Production authentication remains intentionally fail-closed until the OIDC adapter is implemented. See [`.env.example`](.env.example) for development variables.

### Optional Feishu notifications

Feishu is an outbound adapter, not the application entry point or source of truth. The Web inbox works without Feishu. To enable app-bot delivery for the worker's configured tenant, provision a self-built Feishu app with bot capability and the `im:message:send_as_bot` permission, make the app available to the intended users, persist each recipient's active `open_id` as a tenant-scoped channel address, and set all four values shown in [`.env.example`](.env.example). The public Web base URL must use HTTPS.

Leave both credential values empty to disable Feishu. A partial credential pair fails worker startup. Production credentials belong in the deployment platform's Secret Manager and must never be committed, logged, or returned by an API. The worker sends summary-only interactive cards with a Web deep link through the pinned official SDK; it performs no business mutation from card callbacks. Rate limits, network failures, and provider 5xx responses are retried on the delivery row, while unavailable recipients and permission/input failures are dead-lettered without changing the in-app notification.

Before pushing to `main`:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check:public
```

When a disposable PostgreSQL database whose name ends in `_test` is available:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/battlefield_test \
  pnpm --filter @battlefield/database test:postgres

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/battlefield_test \
  pnpm --filter @battlefield/worker test:postgres
```

Both integration tests refuse to reset a database whose name does not end in `_test`. The database smoke also verifies manager/self progress-query scopes, denial paths, redacted audit metadata, historical action reconstruction, and representative index-backed query plans. The Worker smoke accepts a proposal, consumes the real Outbox, schedules and materializes one due reminder, proves inbox/read/action-completion behavior, and asserts that disabled Feishu creates no delivery row.

## Documentation

- [V1 product design](docs/01-V1产品设计总纲.md)
- [Business data model](docs/02-业务数据模型.md)
- [UI and interaction design](docs/03-UI与交互设计.md)
- [System architecture and detailed design](docs/04-系统架构与详细设计.md)
- [Documentation index](docs/README.md)
- [V1-A implementation plan](docs/superpowers/plans/2026-08-31-v1a-data-identity-foundation.md)
- [Follow-up confirmation implementation plan](docs/superpowers/plans/2026-08-31-v1b-followup-confirmation.md)
- [Battle analysis and actions implementation plan](docs/superpowers/plans/2026-08-31-v1c-battle-analysis-actions.md)
- [Reminders and notifications implementation plan](docs/superpowers/plans/2026-08-31-v1d-reminders-notifications.md)
- [Role-scoped workspace implementation plan](docs/superpowers/plans/2026-08-31-v1e-role-scoped-workspace.md)
- [Controlled management progress query implementation plan](docs/superpowers/plans/2026-08-31-v1f-management-progress-query.md)

## Current scope

Implemented today:

- tenant, organization, user, membership, and channel-address foundation with fail-closed RLS;
- business entities, contacts and affiliation history, opportunities, assignment history, and stage history;
- the `0003` physical foundation for sources, draft revisions, formal follow-ups, facts/evidence, idempotency, audit events, domain events, and Outbox messages;
- tenant-safe entity directory API with keyset pagination and responsive Web UI;
- deterministic follow-up proposal plus persistent create/read/revise/cancel/confirm REST APIs and immutable formal-record retrieval;
- responsive Web confirmation workbench with explicit human acknowledgement, optimistic-conflict recovery, stable retry idempotency, and confirmed source/actor receipt;
- tenant-safe battle analysis, evidence/signal versioning, separately persisted action proposals, explicit accept/reject decisions, and formal action state transitions;
- responsive battle-map and action workspaces with truthful partial-page counts, exact immutable source-version deep links, cursor-paged active-owner selection, timezone-safe planning, server-authoritative expired suggestions, and ambiguity-safe idempotent retries;
- role-scoped sales/management homepage with actor-specific KPIs, bounded priority actions, current-versus-previous battle changes, data-gap summaries, exact authorized deep links, and responsive 390px navigation;
- controlled `sales_weekly_progress` querying for a salesperson's current responsibility scope, with manager-observer intersection, exclusive period end and historical cutoff reconstruction, bounded processing, retry-safe idempotent audit, identifier-bound evidence links, gaps, unified denial, and responsive `/ask` UI;
- lease-based Outbox consumption, versioned due reminders, atomic in-app notification materialization, independently retryable channel deliveries, and a responsive notification center;
- optional Feishu app-bot delivery through a tenant-bound credential/channel adapter, with the Web inbox remaining independent;
- PGlite local tests and PostgreSQL 18 CI verification of the same SQL migrations.

Still in progress for V1: personal/team weekly reports, reminder escalation and summary policies, arbitrary-language routing into approved query capabilities, configurable prompts/models/rules, import tools, production OIDC, field-level masking for real customer evidence, and deploy/operations acceptance. Their adapters must preserve the boundaries established here.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

## Data safety

This public repository contains no customer records, production exports, access credentials, private collaboration links, or internal research evidence. Use synthetic data in examples and tests. Run `pnpm check:public` before every push.

No open-source license has been selected yet. Public visibility does not grant permission to copy, modify, or redistribute this code.
