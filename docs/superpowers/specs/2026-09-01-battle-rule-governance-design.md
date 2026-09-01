# Battle Rule Governance Design

## Purpose

Move deterministic battle-map scoring and action suggestions out of API/Worker wiring and into one tenant-scoped, versioned rule release. Preserve today's visible calculation as the default while making later business changes publishable, reversible, and auditable without code deployment.

## Domain boundary

- A **battle rule version** is immutable content: score parameters, data-sufficiency threshold, default quadrant/risk/signal settings, action template, and business-stage labels.
- A **battle rule release** is the tenant's current pointer to one immutable version. Publishing an older version is the rollback mechanism and creates a new release number.
- A **resolved battle rule** is the exact version/release snapshot supplied to one analysis run. Both HTTP-triggered analysis and Worker follow-up automation use the same resolver.
- The analyzer receives validated rule content; it does not read the database and cannot choose a version.
- `analysis_runs.rule_version` remains the immutable execution receipt. Its value identifies both version and release; `analyzer_config_version` continues to identify analyzer implementation/configuration.

## V1 rule schema

The rule document is deliberately bounded rather than accepting arbitrary executable expressions:

- minimum confirmed fact count;
- relationship score base, increment per fact, and maximum;
- potential score base, increment per fact, and maximum;
- sufficient-data quadrant, risk level, signal strength, and signal dimension;
- empty-data and successful-analysis copy;
- one default proposed-action template and priority;
- a bounded map from stable business stage codes to user-facing Chinese labels.

The default document reproduces the current deterministic behavior exactly: one confirmed fact is sufficient; relationship is `min(90, 60 + facts × 5)`; potential is `min(95, 70 + facts × 5)`; the quadrant is `high_relationship_high_potential`; signal strength is 70; the current Chinese summaries and action copy remain unchanged.

## Persistence and authorization

- `app.battle_rule_versions` stores immutable JSONB rule content with a canonical SHA-256 fingerprint and tenant-local version number.
- `app.battle_rule_releases` stores the current tenant pointer and monotonically increasing release number.
- `app.battle_rule_release_history` stores immutable publish/rollback history with reason and actor.
- All three tables carry `tenant_id`, use composite foreign keys, enable and force RLS, and reject mutation of history rows.
- Existing and new tenants receive an immutable system-created default version and release. System seed actors are nullable; interactive creates/releases always record the authenticated user.
- A dedicated `business_rules.manage` capability controls listing, creating, publishing, and rolling back rules. It does not widen business-object visibility.
- Version creation and release append audit metadata. Rule content itself is not copied into general audit payloads; version ID, version number, fingerprint, release number, and reason are sufficient to locate the immutable source.

## Runtime behavior and failure mode

1. The use case reads confirmed facts and rejects a stale input watermark as today.
2. It resolves the tenant's current released rule once.
3. It starts the analysis run with that resolved receipt.
4. It passes the same validated rule snapshot to the analyzer.
5. Completion keeps the existing stale-write protection and evidence validation.

Missing, corrupt, or unreleased tenant configuration fails closed before an analysis run is created. The API/Worker must not silently fall back to a different formula because that would make historical results untraceable.

## Management experience

The existing system-management page will gain an independently loaded “作战规则” card for accounts with `business_rules.manage`. It shows the current release, immutable version history, the bounded rule fields, stage labels, mandatory release reason, and explicit “发布此版本” rollback action. A successful release refreshes the rule card and audit history without reloading unrelated sections.

Stage labels will be served from the same current release projection rather than hardcoded in the business-entity React component. Stable stage codes remain stored in business tables and URLs.

## Non-goals for this slice

- No general-purpose scripting/DSL or arbitrary user-written code.
- No automatic retroactive recalculation of all historical entities after a release.
- No rule test laboratory or staged multi-approver workflow yet.
- No change to the existing manual confirmation requirement for formal business facts and suggested actions.

## Acceptance

- The default released rule produces the same scores, quadrant, signals, and suggested action as current code.
- API-triggered and Worker-triggered analyses record the same current rule receipt for the same tenant.
- Publishing a new version affects the next run only; prior analysis records retain their old receipt.
- Publishing an older version creates a new release number and restores its content without mutating history.
- Unauthorized accounts cannot read or mutate rule management data, and a rule capability alone exposes no customer records.
- The management card makes current version, rule parameters, stage labels, and release history visibly inspectable.
