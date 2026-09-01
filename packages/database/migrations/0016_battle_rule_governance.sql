alter table app.management_capabilities
  drop constraint management_capabilities_code_supported;

alter table app.management_capabilities
  add constraint management_capabilities_code_supported
  check (
    code in (
      'access_control.manage',
      'ai_runtime_config.manage',
      'audit.read',
      'business_rules.manage',
      'management_query.execute',
      'worker_operations.manage'
    )
  );

insert into app.management_capabilities (code, name, description)
values (
  'business_rules.manage',
  '作战规则管理',
  '创建、发布和回滚租户作战分析规则与业务阶段标签。'
);

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
  'business_rules.manage',
  null,
  'battle_rule_governance_default',
  current_timestamp
from app_auth.tenant_login_directory as directory
on conflict (tenant_id, role_code, capability_code) do nothing;

alter table app.role_capability_grants force row level security;

create table app.battle_rule_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  version_no bigint not null,
  name text not null,
  rules jsonb not null,
  content_fingerprint text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint battle_rule_versions_pk primary key (tenant_id, id),
  constraint battle_rule_versions_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint battle_rule_versions_creator_fk
    foreign key (tenant_id, created_by) references app.users (tenant_id, id),
  constraint battle_rule_versions_number_positive check (version_no > 0),
  constraint battle_rule_versions_name_present
    check (length(btrim(name)) between 1 and 200),
  constraint battle_rule_versions_rules_object check (jsonb_typeof(rules) = 'object'),
  constraint battle_rule_versions_fingerprint_valid
    check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint battle_rule_versions_number_unique unique (tenant_id, version_no),
  constraint battle_rule_versions_fingerprint_unique
    unique (tenant_id, content_fingerprint),
  constraint battle_rule_versions_release_target_unique unique (tenant_id, id)
);

create index battle_rule_versions_creator_idx
  on app.battle_rule_versions (tenant_id, created_by, created_at desc)
  where created_by is not null;

create table app.battle_rule_releases (
  tenant_id uuid primary key,
  version_id uuid not null,
  release_no bigint not null,
  released_by uuid,
  released_at timestamptz not null,
  constraint battle_rule_releases_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint battle_rule_releases_version_fk
    foreign key (tenant_id, version_id)
    references app.battle_rule_versions (tenant_id, id),
  constraint battle_rule_releases_user_fk
    foreign key (tenant_id, released_by) references app.users (tenant_id, id),
  constraint battle_rule_releases_number_positive check (release_no > 0)
);

create index battle_rule_releases_version_idx
  on app.battle_rule_releases (tenant_id, version_id);

create table app.battle_rule_release_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  release_no bigint not null,
  version_id uuid not null,
  released_by uuid,
  released_at timestamptz not null,
  reason text not null,
  constraint battle_rule_release_history_pk primary key (tenant_id, id),
  constraint battle_rule_release_history_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint battle_rule_release_history_version_fk
    foreign key (tenant_id, version_id)
    references app.battle_rule_versions (tenant_id, id),
  constraint battle_rule_release_history_user_fk
    foreign key (tenant_id, released_by) references app.users (tenant_id, id),
  constraint battle_rule_release_history_number_positive check (release_no > 0),
  constraint battle_rule_release_history_reason_present
    check (length(btrim(reason)) between 1 and 1000),
  constraint battle_rule_release_history_number_unique unique (tenant_id, release_no)
);

create index battle_rule_release_history_version_idx
  on app.battle_rule_release_history (tenant_id, version_id);

create function app.reject_battle_rule_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

create trigger battle_rule_versions_immutable
before update or delete on app.battle_rule_versions
for each row execute function app.reject_battle_rule_history_mutation();

create trigger battle_rule_release_history_immutable
before update or delete on app.battle_rule_release_history
for each row execute function app.reject_battle_rule_history_mutation();

insert into app.battle_rule_versions (
  tenant_id,
  id,
  version_no,
  name,
  rules,
  content_fingerprint,
  created_by,
  created_at
)
select
  directory.tenant_id,
  gen_random_uuid(),
  1,
  '默认确定性作战规则 V1',
  $json${
    "minimumFactCount": 1,
    "relationshipScore": {"base": 60, "perFact": 5, "maximum": 90},
    "potentialScore": {"base": 70, "perFact": 5, "maximum": 95},
    "insufficientResult": {
      "riskLevel": "medium",
      "dataGap": "缺少已确认的正式经营事实",
      "summary": "当前正式事实不足，暂不生成精确作战坐标。"
    },
    "sufficientResult": {
      "quadrantCode": "high_relationship_high_potential",
      "riskLevel": "low",
      "signalDimension": "potential",
      "signalStrength": 70,
      "summaryTemplate": "已基于 {factCount} 条正式事实生成可回放的确定性分析。"
    },
    "actionProposal": {
      "title": "确认下一步客户经营动作",
      "description": "结合最新正式事实，与客户确认负责人、时间和预期结果。",
      "priority": "high"
    },
    "stageLabels": {
      "intent_communication": "意向沟通",
      "opportunity_confirmed": "商机确认",
      "needs_confirmed": "需求确认",
      "solution_communication": "方案沟通",
      "solution_validation": "方案验证",
      "proposal": "方案与报价",
      "commercial_negotiation": "商务谈判",
      "contract_signing": "客户签约",
      "won": "赢单"
    }
  }$json$::jsonb,
  '6c633514f9cd058b4ca57bcc2d403e5c4c07e39ea38e37543b0329b750fd4809',
  null,
  current_timestamp
from app_auth.tenant_login_directory as directory
on conflict (tenant_id, content_fingerprint) do nothing;

insert into app.battle_rule_releases (
  tenant_id,
  version_id,
  release_no,
  released_by,
  released_at
)
select
  version.tenant_id,
  version.id,
  1,
  null,
  version.created_at
from app.battle_rule_versions as version
where version.version_no = 1
on conflict (tenant_id) do nothing;

insert into app.battle_rule_release_history (
  tenant_id,
  id,
  release_no,
  version_id,
  released_by,
  released_at,
  reason
)
select
  release.tenant_id,
  gen_random_uuid(),
  release.release_no,
  release.version_id,
  release.released_by,
  release.released_at,
  'migration_default'
from app.battle_rule_releases as release
on conflict (tenant_id, release_no) do nothing;

create function app.seed_default_battle_rule_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  default_version_id uuid := gen_random_uuid();
begin
  insert into app.battle_rule_versions (
    tenant_id,
    id,
    version_no,
    name,
    rules,
    content_fingerprint,
    created_by,
    created_at
  ) values (
    new.id,
    default_version_id,
    1,
    '默认确定性作战规则 V1',
    $json${
      "minimumFactCount": 1,
      "relationshipScore": {"base": 60, "perFact": 5, "maximum": 90},
      "potentialScore": {"base": 70, "perFact": 5, "maximum": 95},
      "insufficientResult": {
        "riskLevel": "medium",
        "dataGap": "缺少已确认的正式经营事实",
        "summary": "当前正式事实不足，暂不生成精确作战坐标。"
      },
      "sufficientResult": {
        "quadrantCode": "high_relationship_high_potential",
        "riskLevel": "low",
        "signalDimension": "potential",
        "signalStrength": 70,
        "summaryTemplate": "已基于 {factCount} 条正式事实生成可回放的确定性分析。"
      },
      "actionProposal": {
        "title": "确认下一步客户经营动作",
        "description": "结合最新正式事实，与客户确认负责人、时间和预期结果。",
        "priority": "high"
      },
      "stageLabels": {
        "intent_communication": "意向沟通",
        "opportunity_confirmed": "商机确认",
        "needs_confirmed": "需求确认",
        "solution_communication": "方案沟通",
        "solution_validation": "方案验证",
        "proposal": "方案与报价",
        "commercial_negotiation": "商务谈判",
        "contract_signing": "客户签约",
        "won": "赢单"
      }
    }$json$::jsonb,
    '6c633514f9cd058b4ca57bcc2d403e5c4c07e39ea38e37543b0329b750fd4809',
    null,
    new.created_at
  );

  insert into app.battle_rule_releases (
    tenant_id,
    version_id,
    release_no,
    released_by,
    released_at
  ) values (new.id, default_version_id, 1, null, new.created_at);

  insert into app.battle_rule_release_history (
    tenant_id,
    id,
    release_no,
    version_id,
    released_by,
    released_at,
    reason
  ) values (
    new.id,
    gen_random_uuid(),
    1,
    default_version_id,
    null,
    new.created_at,
    'tenant_default'
  );

  return new;
end;
$$;

create trigger tenants_seed_default_battle_rule_release
after insert on app.tenants
for each row execute function app.seed_default_battle_rule_release();

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'battle_rule_versions',
    'battle_rule_releases',
    'battle_rule_release_history'
  ]
  loop
    execute format('alter table app.%I enable row level security', protected_table);
    execute format('alter table app.%I force row level security', protected_table);
    execute format(
      'create policy %I on app.%I using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))',
      protected_table || '_tenant_isolation',
      protected_table
    );
  end loop;
end;
$$;
