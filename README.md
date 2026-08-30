# AI Customer Battlefield

AI Customer Battlefield is an independent customer-operation workspace for sales teams. It is designed around reviewable business facts, human-confirmed AI suggestions, configurable workflows, and replaceable integrations rather than any single collaboration platform or model provider.

The first engineering milestone is a walking vertical slice: a user submits raw follow-up notes, an Agent adapter proposes a structured draft, and the system returns that draft in `pending_confirmation` state. The slice intentionally does not persist or promote AI output to a formal business record.

## Architecture boundaries

- `apps/web`: browser experience built on the public API contract
- `apps/api`: versioned HTTP API and infrastructure adapters
- `packages/contracts`: transport schemas shared by API clients and servers
- `packages/core`: framework-free domain and application behavior
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

Start the API and Web applications in separate terminals:

```bash
pnpm --filter @battlefield/api dev
pnpm --filter @battlefield/web dev
```

The Web app runs at `http://localhost:3000` and the API at `http://localhost:3001`.

Before opening a pull request:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check:public
```

## Documentation

- [V1 product design](docs/01-V1产品设计总纲.md)
- [Business data model](docs/02-业务数据模型.md)
- [Documentation index](docs/README.md)
- [Foundation implementation plan](docs/superpowers/plans/2026-08-31-foundation-walking-skeleton.md)

## Current scope

The repository currently proves one vertical slice: raw sales follow-up input becomes a structured AI proposal that is visibly marked `pending_confirmation`. The development Agent is deterministic, making the slice runnable without a model account.

Authentication, database persistence, confirmation-to-formal-record transactions, real model providers, notifications, and production deployment are intentionally outside this first milestone. Their future adapters must preserve the boundaries established here.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

## Data safety

This public repository contains no customer records, production exports, access credentials, private collaboration links, or internal research evidence. Use synthetic data in examples and tests. Run `pnpm check:public` before every push.

No open-source license has been selected yet. Public visibility does not grant permission to copy, modify, or redistribute this code.
