alter table app.role_capability_grants no force row level security;

insert into app.role_capability_grants (
  tenant_id,
  role_code,
  capability_code,
  granted_by,
  reason,
  created_at
)
select
  directory.tenant_id,
  'department_leader',
  capability.code,
  null,
  'existing_tenant_default_repair',
  current_timestamp
from app_auth.tenant_login_directory as directory
cross join app.management_capabilities as capability
on conflict (tenant_id, role_code, capability_code) do nothing;

alter table app.role_capability_grants force row level security;
