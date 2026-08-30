create table app.business_entity_types (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  code text not null,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_entity_types_pk primary key (tenant_id, id),
  constraint business_entity_types_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint business_entity_types_code_lowercase check (code = lower(code)),
  constraint business_entity_types_code_present check (length(btrim(code)) > 0),
  constraint business_entity_types_name_present check (length(btrim(name)) > 0),
  constraint business_entity_types_status_valid check (status in ('active', 'inactive')),
  constraint business_entity_types_code_unique unique (tenant_id, code)
);

create table app.business_entities (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  type_id uuid not null,
  name text not null,
  short_name text,
  status text not null default 'active',
  is_t0 boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_entities_pk primary key (tenant_id, id),
  constraint business_entities_type_fk
    foreign key (tenant_id, type_id)
    references app.business_entity_types (tenant_id, id),
  constraint business_entities_name_present check (length(btrim(name)) > 0),
  constraint business_entities_short_name_present
    check (short_name is null or length(btrim(short_name)) > 0),
  constraint business_entities_status_valid
    check (status in ('active', 'inactive', 'archived')),
  constraint business_entities_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint business_entities_version_positive check (version_no > 0)
);

create index business_entities_type_idx
  on app.business_entities (tenant_id, type_id);

create index business_entities_list_idx
  on app.business_entities (tenant_id, status, updated_at desc, id desc);

create table app.entity_assignments (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  user_id uuid not null,
  assignment_role text not null,
  is_primary boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  constraint entity_assignments_pk primary key (tenant_id, id),
  constraint entity_assignments_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint entity_assignments_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint entity_assignments_role_valid
    check (assignment_role in ('owner', 'collaborator', 'management_observer')),
  constraint entity_assignments_primary_owner
    check (not is_primary or assignment_role = 'owner'),
  constraint entity_assignments_valid_period
    check (valid_to is null or valid_to > valid_from)
);

create unique index entity_assignments_current_pair_unique_idx
  on app.entity_assignments (tenant_id, entity_id, user_id, assignment_role)
  where valid_to is null;

create unique index entity_assignments_current_primary_owner_unique_idx
  on app.entity_assignments (tenant_id, entity_id)
  where valid_to is null and assignment_role = 'owner' and is_primary;

create index entity_assignments_entity_current_idx
  on app.entity_assignments (tenant_id, entity_id, assignment_role, valid_to);

create index entity_assignments_user_current_idx
  on app.entity_assignments (tenant_id, user_id, valid_to);

create table app.contacts (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  display_name text not null,
  title text,
  email text,
  mobile text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_pk primary key (tenant_id, id),
  constraint contacts_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint contacts_display_name_present check (length(btrim(display_name)) > 0),
  constraint contacts_title_present check (title is null or length(btrim(title)) > 0),
  constraint contacts_email_present check (email is null or length(btrim(email)) > 0),
  constraint contacts_mobile_present check (mobile is null or length(btrim(mobile)) > 0),
  constraint contacts_status_valid check (status in ('active', 'inactive', 'archived')),
  constraint contacts_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint contacts_version_positive check (version_no > 0)
);

create index contacts_list_idx
  on app.contacts (tenant_id, status, updated_at desc, id desc);

create index contacts_email_lookup_idx
  on app.contacts (tenant_id, lower(email))
  where email is not null;

create table app.contact_affiliations (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  contact_id uuid not null,
  entity_id uuid not null,
  job_title text,
  department text,
  is_primary boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  constraint contact_affiliations_pk primary key (tenant_id, id),
  constraint contact_affiliations_contact_fk
    foreign key (tenant_id, contact_id)
    references app.contacts (tenant_id, id),
  constraint contact_affiliations_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint contact_affiliations_job_title_present
    check (job_title is null or length(btrim(job_title)) > 0),
  constraint contact_affiliations_department_present
    check (department is null or length(btrim(department)) > 0),
  constraint contact_affiliations_valid_period
    check (valid_to is null or valid_to > valid_from)
);

create unique index contact_affiliations_current_pair_unique_idx
  on app.contact_affiliations (tenant_id, contact_id, entity_id)
  where valid_to is null;

create index contact_affiliations_contact_current_idx
  on app.contact_affiliations (tenant_id, contact_id, valid_to);

create index contact_affiliations_entity_current_idx
  on app.contact_affiliations (tenant_id, entity_id, valid_to);

create table app.opportunities (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  name text not null,
  need_summary text,
  estimated_amount numeric(18, 2),
  currency text not null default 'CNY',
  stage_code text not null,
  stage_progress numeric(5, 2) not null,
  status text not null default 'open',
  is_primary boolean not null default false,
  expected_close_at date,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunities_pk primary key (tenant_id, id),
  constraint opportunities_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint opportunities_name_present check (length(btrim(name)) > 0),
  constraint opportunities_need_summary_present
    check (need_summary is null or length(btrim(need_summary)) > 0),
  constraint opportunities_amount_non_negative
    check (estimated_amount is null or estimated_amount >= 0),
  constraint opportunities_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint opportunities_stage_code_lowercase check (stage_code = lower(stage_code)),
  constraint opportunities_stage_code_present check (length(btrim(stage_code)) > 0),
  constraint opportunities_stage_progress_valid
    check (stage_progress >= 0 and stage_progress <= 100),
  constraint opportunities_status_valid
    check (status in ('open', 'won', 'lost', 'cancelled')),
  constraint opportunities_version_positive check (version_no > 0)
);

create unique index opportunities_open_primary_unique_idx
  on app.opportunities (tenant_id, entity_id)
  where status = 'open' and is_primary;

create index opportunities_list_idx
  on app.opportunities (tenant_id, status, updated_at desc, id desc);

create index opportunities_entity_idx
  on app.opportunities (tenant_id, entity_id, status, updated_at desc);

create table app.opportunity_assignments (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  opportunity_id uuid not null,
  user_id uuid not null,
  assignment_role text not null,
  is_primary boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  constraint opportunity_assignments_pk primary key (tenant_id, id),
  constraint opportunity_assignments_opportunity_fk
    foreign key (tenant_id, opportunity_id)
    references app.opportunities (tenant_id, id),
  constraint opportunity_assignments_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint opportunity_assignments_role_valid
    check (assignment_role in ('owner', 'collaborator', 'management_observer')),
  constraint opportunity_assignments_primary_owner
    check (not is_primary or assignment_role = 'owner'),
  constraint opportunity_assignments_valid_period
    check (valid_to is null or valid_to > valid_from)
);

create unique index opportunity_assignments_current_pair_unique_idx
  on app.opportunity_assignments (tenant_id, opportunity_id, user_id, assignment_role)
  where valid_to is null;

create unique index opportunity_assignments_current_primary_owner_unique_idx
  on app.opportunity_assignments (tenant_id, opportunity_id)
  where valid_to is null and assignment_role = 'owner' and is_primary;

create index opportunity_assignments_opportunity_current_idx
  on app.opportunity_assignments (tenant_id, opportunity_id, assignment_role, valid_to);

create index opportunity_assignments_user_current_idx
  on app.opportunity_assignments (tenant_id, user_id, valid_to);

create table app.opportunity_stage_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  opportunity_id uuid not null,
  from_stage_code text,
  to_stage_code text not null,
  from_progress numeric(5, 2),
  to_progress numeric(5, 2) not null,
  changed_by_user_id uuid,
  change_source text not null,
  note text,
  changed_at timestamptz not null default now(),
  constraint opportunity_stage_history_pk primary key (tenant_id, id),
  constraint opportunity_stage_history_opportunity_fk
    foreign key (tenant_id, opportunity_id)
    references app.opportunities (tenant_id, id),
  constraint opportunity_stage_history_changed_by_fk
    foreign key (tenant_id, changed_by_user_id)
    references app.users (tenant_id, id),
  constraint opportunity_stage_history_from_stage_lowercase
    check (from_stage_code is null or from_stage_code = lower(from_stage_code)),
  constraint opportunity_stage_history_to_stage_lowercase
    check (to_stage_code = lower(to_stage_code)),
  constraint opportunity_stage_history_to_stage_present
    check (length(btrim(to_stage_code)) > 0),
  constraint opportunity_stage_history_from_progress_valid
    check (from_progress is null or (from_progress >= 0 and from_progress <= 100)),
  constraint opportunity_stage_history_to_progress_valid
    check (to_progress >= 0 and to_progress <= 100),
  constraint opportunity_stage_history_source_valid
    check (change_source in ('user', 'agent', 'import', 'system')),
  constraint opportunity_stage_history_note_present
    check (note is null or length(btrim(note)) > 0)
);

create index opportunity_stage_history_opportunity_idx
  on app.opportunity_stage_history (tenant_id, opportunity_id, changed_at desc, id desc);

create index opportunity_stage_history_changed_by_idx
  on app.opportunity_stage_history (tenant_id, changed_by_user_id)
  where changed_by_user_id is not null;

alter table app.business_entity_types enable row level security;
alter table app.business_entity_types force row level security;
create policy business_entity_types_tenant_isolation on app.business_entity_types
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.business_entities enable row level security;
alter table app.business_entities force row level security;
create policy business_entities_tenant_isolation on app.business_entities
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.entity_assignments enable row level security;
alter table app.entity_assignments force row level security;
create policy entity_assignments_tenant_isolation on app.entity_assignments
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.contacts enable row level security;
alter table app.contacts force row level security;
create policy contacts_tenant_isolation on app.contacts
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.contact_affiliations enable row level security;
alter table app.contact_affiliations force row level security;
create policy contact_affiliations_tenant_isolation on app.contact_affiliations
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.opportunities enable row level security;
alter table app.opportunities force row level security;
create policy opportunities_tenant_isolation on app.opportunities
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.opportunity_assignments enable row level security;
alter table app.opportunity_assignments force row level security;
create policy opportunity_assignments_tenant_isolation on app.opportunity_assignments
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table app.opportunity_stage_history enable row level security;
alter table app.opportunity_stage_history force row level security;
create policy opportunity_stage_history_tenant_isolation on app.opportunity_stage_history
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());
