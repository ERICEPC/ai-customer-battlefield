create schema if not exists app;

create or replace function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.current_tenant_id', true), '')::uuid
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create table app.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_slug_lowercase check (slug = lower(slug)),
  constraint tenants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint tenants_name_present check (length(btrim(name)) > 0),
  constraint tenants_status_valid check (status in ('active', 'suspended')),
  constraint tenants_slug_unique unique (slug)
);

create table app.org_units (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  parent_id uuid,
  code text not null,
  name text not null,
  unit_type text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_units_pk primary key (tenant_id, id),
  constraint org_units_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint org_units_parent_fk
    foreign key (tenant_id, parent_id)
    references app.org_units (tenant_id, id),
  constraint org_units_code_lowercase check (code = lower(code)),
  constraint org_units_code_present check (length(btrim(code)) > 0),
  constraint org_units_name_present check (length(btrim(name)) > 0),
  constraint org_units_type_valid
    check (unit_type in ('business_unit', 'department', 'sales_team', 'other')),
  constraint org_units_status_valid check (status in ('active', 'inactive')),
  constraint org_units_code_unique unique (tenant_id, code)
);

create index org_units_parent_idx
  on app.org_units (tenant_id, parent_id)
  where parent_id is not null;

create table app.users (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  display_name text not null,
  email text,
  mobile text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_pk primary key (tenant_id, id),
  constraint users_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint users_display_name_present check (length(btrim(display_name)) > 0),
  constraint users_email_present
    check (email is null or length(btrim(email)) > 0),
  constraint users_mobile_present
    check (mobile is null or length(btrim(mobile)) > 0),
  constraint users_status_valid check (status in ('active', 'inactive'))
);

create unique index users_email_unique_idx
  on app.users (tenant_id, lower(email))
  where email is not null;

create table app.user_memberships (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  org_unit_id uuid not null,
  role_code text not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  constraint user_memberships_pk primary key (tenant_id, id),
  constraint user_memberships_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint user_memberships_org_unit_fk
    foreign key (tenant_id, org_unit_id)
    references app.org_units (tenant_id, id),
  constraint user_memberships_role_code_lowercase
    check (role_code = lower(role_code)),
  constraint user_memberships_role_code_present
    check (length(btrim(role_code)) > 0),
  constraint user_memberships_valid_period
    check (valid_to is null or valid_to > valid_from)
);

create unique index user_memberships_current_unique_idx
  on app.user_memberships (tenant_id, user_id, org_unit_id, role_code)
  where valid_to is null;

create index user_memberships_org_unit_idx
  on app.user_memberships (tenant_id, org_unit_id, valid_to);

create index user_memberships_user_idx
  on app.user_memberships (tenant_id, user_id, valid_to);

create table app.channel_addresses (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  channel text not null,
  external_user_id text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_addresses_pk primary key (tenant_id, id),
  constraint channel_addresses_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint channel_addresses_channel_valid
    check (channel in ('in_app', 'feishu', 'email', 'wechat')),
  constraint channel_addresses_external_user_id_present
    check (length(btrim(external_user_id)) > 0),
  constraint channel_addresses_status_valid check (status in ('active', 'disabled')),
  constraint channel_addresses_external_unique
    unique (tenant_id, channel, external_user_id)
);

create unique index channel_addresses_current_user_channel_unique_idx
  on app.channel_addresses (tenant_id, user_id, channel)
  where status = 'active';

create index channel_addresses_user_idx
  on app.channel_addresses (tenant_id, user_id);

alter table app.tenants enable row level security;
alter table app.tenants force row level security;
create policy tenants_tenant_isolation on app.tenants
  using (id = app.current_tenant_id())
  with check (id = app.current_tenant_id());

alter table app.org_units enable row level security;
alter table app.org_units force row level security;
create policy org_units_tenant_isolation on app.org_units
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.users enable row level security;
alter table app.users force row level security;
create policy users_tenant_isolation on app.users
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.user_memberships enable row level security;
alter table app.user_memberships force row level security;
create policy user_memberships_tenant_isolation on app.user_memberships
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.channel_addresses enable row level security;
alter table app.channel_addresses force row level security;
create policy channel_addresses_tenant_isolation on app.channel_addresses
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());
