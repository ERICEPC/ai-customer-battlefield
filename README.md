# AI Customer Battlefield

AI Customer Battlefield is an independent customer-operation workspace for sales teams. It is designed around reviewable business facts, human-confirmed AI suggestions, configurable workflows, and replaceable integrations rather than any single collaboration platform or model provider.

The repository now contains two connected vertical slices: a persistent, tenant-scoped business-entity directory and a human-confirmed follow-up workflow backed by versioned PostgreSQL migrations. AI output remains a draft until the salesperson explicitly confirms it; confirmation atomically creates the formal follow-up, facts/evidence links, audit event, domain event, idempotency result, and Outbox message. The complete V1 product is still under active development.

## Architecture boundaries

- `apps/web`: browser experience built on the public API contract
- `apps/api`: versioned HTTP API and infrastructure adapters
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

Open `http://localhost:3000/` for the follow-up confirmation workbench or `http://localhost:3000/entities` for the entity directory. The demo database is recreated on every API restart and must never be used as production storage.

For a PostgreSQL-backed environment, use a dedicated PostgreSQL 17+ database, apply forward migrations explicitly, and then start the normal API:

```bash
export DATABASE_URL=postgresql://user:password@localhost:5432/battlefield
pnpm --filter @battlefield/database migrate
pnpm --filter @battlefield/api dev
```

The API never auto-creates or auto-migrates production schema. `DATABASE_URL` is mandatory when `NODE_ENV=production`; production authentication remains intentionally fail-closed until the OIDC adapter is implemented. See [`.env.example`](.env.example) for development variables.

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
```

The integration test refuses to reset a database whose name does not end in `_test`.

## Documentation

- [V1 product design](docs/01-V1产品设计总纲.md)
- [Business data model](docs/02-业务数据模型.md)
- [UI and interaction design](docs/03-UI与交互设计.md)
- [System architecture and detailed design](docs/04-系统架构与详细设计.md)
- [Documentation index](docs/README.md)
- [V1-A implementation plan](docs/superpowers/plans/2026-08-31-v1a-data-identity-foundation.md)
- [Follow-up confirmation implementation plan](docs/superpowers/plans/2026-08-31-v1b-followup-confirmation.md)

## Current scope

Implemented today:

- tenant, organization, user, membership, and channel-address foundation with fail-closed RLS;
- business entities, contacts and affiliation history, opportunities, assignment history, and stage history;
- the `0003` physical foundation for sources, draft revisions, formal follow-ups, facts/evidence, idempotency, audit events, domain events, and Outbox messages;
- tenant-safe entity directory API with keyset pagination and responsive Web UI;
- deterministic follow-up proposal plus persistent create/read/revise/cancel/confirm REST APIs and immutable formal-record retrieval;
- responsive Web confirmation workbench with explicit human acknowledgement, optimistic-conflict recovery, stable retry idempotency, and confirmed source/actor receipt;
- PGlite local tests and PostgreSQL 18 CI verification of the same SQL migrations.

Still in progress for V1: battle analysis and separately confirmed action loops, Outbox workers and notifications, configurable prompts/models/rules, reminders, reports, management queries, import tools, production OIDC, and deploy/operations acceptance. Their adapters must preserve the boundaries established here.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

## Data safety

This public repository contains no customer records, production exports, access credentials, private collaboration links, or internal research evidence. Use synthetic data in examples and tests. Run `pnpm check:public` before every push.

No open-source license has been selected yet. Public visibility does not grant permission to copy, modify, or redistribute this code.
