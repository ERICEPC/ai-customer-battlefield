create table app.user_credentials (
  tenant_id uuid not null,
  user_id uuid not null,
  password_hash text not null,
  password_updated_at timestamptz not null default now(),
  failed_attempt_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_credentials_pk primary key (tenant_id, user_id),
  constraint user_credentials_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint user_credentials_password_hash_present
    check (length(btrim(password_hash)) between 16 and 1024),
  constraint user_credentials_failed_attempt_count_valid
    check (failed_attempt_count >= 0),
  constraint user_credentials_locked_until_valid
    check (locked_until is null or locked_until >= password_updated_at)
);

create table app.user_sessions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null,
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_sessions_pk primary key (tenant_id, id),
  constraint user_sessions_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint user_sessions_token_hash_format
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint user_sessions_expires_after_creation
    check (expires_at > created_at),
  constraint user_sessions_last_used_after_creation
    check (last_used_at >= created_at),
  constraint user_sessions_revoked_after_creation
    check (revoked_at is null or revoked_at >= created_at),
  constraint user_sessions_token_hash_unique unique (tenant_id, token_hash)
);

create index user_sessions_active_user_expiry_idx
  on app.user_sessions (tenant_id, user_id, expires_at desc)
  where revoked_at is null;

create index user_sessions_expiry_idx
  on app.user_sessions (tenant_id, expires_at)
  where revoked_at is null;

alter table app.user_credentials enable row level security;
alter table app.user_credentials force row level security;
create policy user_credentials_tenant_isolation on app.user_credentials
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));

alter table app.user_sessions enable row level security;
alter table app.user_sessions force row level security;
create policy user_sessions_tenant_isolation on app.user_sessions
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));

create or replace function app.resolve_active_tenant_id(login_slug text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
  select id
  from app.tenants
  where slug = lower(btrim(login_slug))
    and status = 'active'
  limit 1
$$;

revoke all on function app.resolve_active_tenant_id(text) from public;
