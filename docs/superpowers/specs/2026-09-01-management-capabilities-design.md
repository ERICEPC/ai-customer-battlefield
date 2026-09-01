# Management Capability Authorization Design

## Purpose

Replace fixed `department_leader` checks for governance functions with tenant-scoped capabilities while preserving the current two-level sales/leader experience and all existing object-responsibility filters.

## Decisions

- A **management capability** grants entry to one governance function. It never grants visibility into customer evidence by itself.
- Current capability codes are `management_query.execute`, `audit.read`, `ai_runtime_config.manage`, `business_rules.manage`, `worker_operations.manage`, and `access_control.manage`.
- `app.management_capabilities` is the fixed catalog. `app.role_capability_grants` is the tenant-owned current grant projection keyed by tenant, role, and capability.
- Existing and newly provisioned tenants receive all six capabilities for `department_leader`; `sales` receives none. This preserves current browser behavior while making battle-rule publishing independently delegable.
- Existing-tenant repair enumerates active tenants through `app_auth.tenant_login_directory`. It temporarily removes `FORCE RLS` only from the newly owned grant table inside the migration transaction, inserts defaults idempotently, and restores `FORCE RLS` before commit.
- Session resolution reads current grants on every authenticated request, so revocation does not wait for cookie expiry.
- Nest controllers declare capabilities through `RequireCapabilities`. The guard uses the resolved session, never client headers. Test-only actor headers keep their existing isolated bypass.
- AI runtime configuration and Worker operations recheck the same capability inside their tenant database transaction. Their existing domain-specific access-denied errors remain unchanged.
- Management query and audit readers keep their existing responsibility-scoped SQL. Their HTTP entry changes from role to capability in this slice; deeper application-level authorization is deferred until those modules gain non-HTTP callers.
- The Web shell derives management navigation and direct-route guards from session capabilities. Role labels and current organization relationships remain presentation data, not authorization decisions.
- Capability grant mutation endpoints and their management UI are the next permission slice. Until then, current grants are changed only by controlled migration/operations, and every future mutation must append an audit entry with a reason.

## Security invariants

1. A capability cannot cross a tenant boundary because grants are tenant keyed, forced through RLS, and resolved only alongside a current membership.
2. An expired/future membership grants nothing even if its role has capabilities.
3. Removing a role capability affects the next request for existing sessions.
4. A system administrator capability does not imply owner, collaborator, or management-observer responsibility for any business entity.
5. Capability identifiers are a closed, versioned set in application code and the database catalog.

## Verification

- Migration tests prove catalog contents, default leader grants, no sales grants, tenant isolation, and automatic defaults for a newly inserted tenant.
- A staged-migration regression test proves an already migrated tenant with missing defaults is repaired by the append-only `0015` migration.
- Identity tests prove session capabilities differ between sales and leader and refresh after grant revocation.
- API tests prove a leader with the same role loses access immediately after capability revocation.
- Existing AI configuration and Worker tests prove sales remains denied inside database adapters.
- Web shell tests prove navigation and direct-route behavior follows capabilities rather than the role label.

## Audited grant management extension

- `GET /api/v1/access-control/role-capabilities` returns the closed capability catalog and the current grant projection for roles that have active memberships or existing grants.
- `PUT /api/v1/access-control/roles/:roleCode/capabilities` uses full-replacement semantics. The body contains the complete desired capability set plus a mandatory reason; the request also requires an `Idempotency-Key` header.
- Only actors with `access_control.manage` may read or mutate grants. The database adapter rechecks that capability inside the same tenant transaction.
- All tenant role changes share one advisory lock. A mutation is rejected if its resulting projection would leave no active tenant member with `access_control.manage`, preventing accidental tenant lockout while still allowing a controlled transfer to another role.
- The generic idempotency ledger stores a canonical request hash and the exact response. Reusing a key for a different role, capability set, or reason returns a conflict.
- Actual changes append `access_control.role_capabilities_updated` with a deterministic role aggregate ID, before/after capability snapshots, actor, request ID, and reason. A no-op request is idempotently completed but does not create misleading change audit.
- This interface manages functional entry permissions only. It does not create roles, alter organization membership, or change business-object responsibility assignments.
