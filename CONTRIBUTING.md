# Contributing

Thank you for helping build AI Customer Battlefield.

## Before opening a change

1. Create a focused branch from `main`.
2. Use only synthetic test data and public-safe documentation.
3. Keep domain logic in `packages/core`, transport validation in `packages/contracts`, and infrastructure concerns in application adapters.
4. Add or update tests for behavior changes.
5. Run `pnpm check:public`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

Do not commit customer data, private collaboration links, recordings, credentials, environment files, or internal research material. AI-generated business suggestions must remain drafts until an explicit human confirmation flow promotes them.

For substantial product or architecture changes, open a discussion first so the public contract and module boundaries can be reviewed before implementation.
