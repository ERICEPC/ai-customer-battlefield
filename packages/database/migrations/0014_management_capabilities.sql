create table app.management_capabilities (
  code text primary key,
  name text not null,
  description text not null,
  created_at timestamptz not null default now(),
  constraint management_capabilities_code_valid
    check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint management_capabilities_code_supported
    check (
      code in (
        'access_control.manage',
        'ai_runtime_config.manage',
        'audit.read',
        'management_query.execute',
        'worker_operations.manage'
      )
    ),
  constraint management_capabilities_name_present
    check (length(btrim(name)) between 1 and 200),
  constraint management_capabilities_description_present
    check (length(btrim(description)) between 1 and 1000)
);

create table app.role_capability_grants (
  tenant_id uuid not null,
  role_code text not null,
  capability_code text not null,
  granted_by uuid,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint role_capability_grants_pk
    primary key (tenant_id, role_code, capability_code),
  constraint role_capability_grants_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint role_capability_grants_capability_fk
    foreign key (capability_code) references app.management_capabilities (code),
  constraint role_capability_grants_granter_fk
    foreign key (tenant_id, granted_by) references app.users (tenant_id, id),
  constraint role_capability_grants_role_valid
    check (role_code ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint role_capability_grants_reason_present
    check (length(btrim(reason)) between 1 and 1000)
);

create index role_capability_grants_capability_idx
  on app.role_capability_grants (tenant_id, capability_code, role_code);

insert into app.management_capabilities (code, name, description)
values
  (
    'access_control.manage',
    '权限管理',
    '查看和维护租户内角色能力授权。'
  ),
  (
    'ai_runtime_config.manage',
    'Agent 运行配置管理',
    '创建、发布和回滚租户 Agent 运行配置。'
  ),
  (
    'audit.read',
    '审计日志读取',
    '在业务数据范围内检索受控审计元数据。'
  ),
  (
    'management_query.execute',
    '管理问数执行',
    '执行受控、带证据且受对象范围约束的管理查询。'
  ),
  (
    'worker_operations.manage',
    '异步任务运维',
    '查看 Worker 健康并重放失败或死信任务。'
  );

create function app.seed_default_management_capabilities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into app.role_capability_grants (
    tenant_id,
    role_code,
    capability_code,
    granted_by,
    reason,
    created_at
  )
  select
    new.id,
    'department_leader',
    capability.code,
    null,
    'tenant_default',
    new.created_at
  from app.management_capabilities as capability;
  return new;
end;
$$;

create trigger tenants_seed_default_management_capabilities
after insert on app.tenants
for each row execute function app.seed_default_management_capabilities();

insert into app.role_capability_grants (
  tenant_id,
  role_code,
  capability_code,
  granted_by,
  reason,
  created_at
)
select
  tenant.id,
  'department_leader',
  capability.code,
  null,
  'migration_default',
  current_timestamp
from app.tenants as tenant
cross join app.management_capabilities as capability
on conflict (tenant_id, role_code, capability_code) do nothing;

alter table app.role_capability_grants enable row level security;
alter table app.role_capability_grants force row level security;
create policy role_capability_grants_tenant_isolation
  on app.role_capability_grants
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
