create table app.ai_runtime_config_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  config_key text not null,
  version_no bigint not null,
  name text not null,
  provider text not null,
  default_model_id text not null,
  system_prompt text not null,
  parameters jsonb not null default '{}'::jsonb,
  content_fingerprint text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint ai_runtime_config_versions_pk primary key (tenant_id, id),
  constraint ai_runtime_config_versions_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint ai_runtime_config_versions_creator_fk
    foreign key (tenant_id, created_by)
    references app.users (tenant_id, id),
  constraint ai_runtime_config_versions_key_valid
    check (config_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint ai_runtime_config_versions_number_positive
    check (version_no > 0),
  constraint ai_runtime_config_versions_name_present
    check (length(btrim(name)) between 1 and 200),
  constraint ai_runtime_config_versions_provider_supported
    check (provider = 'senseaudio'),
  constraint ai_runtime_config_versions_model_present
    check (length(btrim(default_model_id)) between 1 and 200),
  constraint ai_runtime_config_versions_prompt_present
    check (length(btrim(system_prompt)) between 1 and 20000),
  constraint ai_runtime_config_versions_parameters_object
    check (jsonb_typeof(parameters) = 'object'),
  constraint ai_runtime_config_versions_fingerprint_valid
    check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint ai_runtime_config_versions_number_unique
    unique (tenant_id, config_key, version_no),
  constraint ai_runtime_config_versions_fingerprint_unique
    unique (tenant_id, config_key, content_fingerprint),
  constraint ai_runtime_config_versions_release_target_unique
    unique (tenant_id, config_key, id)
);

create index ai_runtime_config_versions_creator_idx
  on app.ai_runtime_config_versions (tenant_id, created_by, created_at desc);

create table app.ai_runtime_config_releases (
  tenant_id uuid not null,
  config_key text not null,
  version_id uuid not null,
  release_no bigint not null,
  released_by uuid not null,
  released_at timestamptz not null,
  constraint ai_runtime_config_releases_pk primary key (tenant_id, config_key),
  constraint ai_runtime_config_releases_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint ai_runtime_config_releases_version_fk
    foreign key (tenant_id, config_key, version_id)
    references app.ai_runtime_config_versions (tenant_id, config_key, id),
  constraint ai_runtime_config_releases_user_fk
    foreign key (tenant_id, released_by)
    references app.users (tenant_id, id),
  constraint ai_runtime_config_releases_key_valid
    check (config_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint ai_runtime_config_releases_number_positive
    check (release_no > 0)
);

create index ai_runtime_config_releases_version_idx
  on app.ai_runtime_config_releases (tenant_id, version_id);

create table app.ai_runtime_config_release_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  config_key text not null,
  release_no bigint not null,
  version_id uuid not null,
  released_by uuid not null,
  released_at timestamptz not null,
  reason text,
  constraint ai_runtime_config_release_history_pk primary key (tenant_id, id),
  constraint ai_runtime_config_release_history_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint ai_runtime_config_release_history_version_fk
    foreign key (tenant_id, config_key, version_id)
    references app.ai_runtime_config_versions (tenant_id, config_key, id),
  constraint ai_runtime_config_release_history_user_fk
    foreign key (tenant_id, released_by)
    references app.users (tenant_id, id),
  constraint ai_runtime_config_release_history_key_valid
    check (config_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint ai_runtime_config_release_history_number_positive
    check (release_no > 0),
  constraint ai_runtime_config_release_history_reason_present
    check (reason is null or length(btrim(reason)) between 1 and 1000),
  constraint ai_runtime_config_release_history_number_unique
    unique (tenant_id, config_key, release_no)
);

create index ai_runtime_config_release_history_version_idx
  on app.ai_runtime_config_release_history (tenant_id, version_id);

create function app.reject_ai_runtime_config_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

create trigger ai_runtime_config_versions_immutable
before update or delete on app.ai_runtime_config_versions
for each row execute function app.reject_ai_runtime_config_history_mutation();

create trigger ai_runtime_config_release_history_immutable
before update or delete on app.ai_runtime_config_release_history
for each row execute function app.reject_ai_runtime_config_history_mutation();

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'ai_runtime_config_versions',
    'ai_runtime_config_releases',
    'ai_runtime_config_release_history'
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
