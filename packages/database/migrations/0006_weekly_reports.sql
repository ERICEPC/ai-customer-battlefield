create table app.weekly_reports (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  report_type text not null,
  owner_user_id uuid not null,
  subject_user_id uuid,
  period_start timestamptz not null,
  period_end timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint weekly_reports_pk primary key (tenant_id, id),
  constraint weekly_reports_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint weekly_reports_owner_fk
    foreign key (tenant_id, owner_user_id)
    references app.users (tenant_id, id),
  constraint weekly_reports_subject_fk
    foreign key (tenant_id, subject_user_id)
    references app.users (tenant_id, id),
  constraint weekly_reports_creator_fk
    foreign key (tenant_id, created_by)
    references app.users (tenant_id, id),
  constraint weekly_reports_series_unique
    unique (
      tenant_id, report_type, owner_user_id, period_start, period_end
    ),
  constraint weekly_reports_type_valid
    check (report_type in ('personal', 'managed_portfolio')),
  constraint weekly_reports_subject_valid check (
    (report_type = 'personal' and subject_user_id = owner_user_id)
    or (report_type = 'managed_portfolio' and subject_user_id is null)
  ),
  constraint weekly_reports_period_valid check (
    period_end > period_start
    and period_end - period_start <= interval '31 days'
  )
);

create index weekly_reports_owner_history_idx
  on app.weekly_reports (
    tenant_id, owner_user_id, period_end desc, created_at desc, id desc
  );

create table app.weekly_report_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  report_id uuid not null,
  revision_no bigint not null,
  lock_version bigint not null default 1,
  status text not null,
  data_cutoff_at timestamptz not null,
  title text not null,
  note text not null default '',
  scope_fingerprint text not null,
  scope_entity_count integer not null,
  contributor_count integer not null,
  confirmed_followup_count integer not null,
  valid_fact_count integer not null,
  stage_change_count integer not null,
  completed_action_count integer not null,
  open_action_count integer not null,
  overdue_action_count integer not null,
  generator_kind text not null,
  generator_version text not null,
  previous_version_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  published_by uuid,
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint weekly_report_versions_pk primary key (tenant_id, id),
  constraint weekly_report_versions_identity_series_unique
    unique (tenant_id, id, report_id),
  constraint weekly_report_versions_report_fk
    foreign key (tenant_id, report_id)
    references app.weekly_reports (tenant_id, id),
  constraint weekly_report_versions_creator_fk
    foreign key (tenant_id, created_by)
    references app.users (tenant_id, id),
  constraint weekly_report_versions_publisher_fk
    foreign key (tenant_id, published_by)
    references app.users (tenant_id, id),
  constraint weekly_report_versions_previous_fk
    foreign key (tenant_id, previous_version_id, report_id)
    references app.weekly_report_versions (tenant_id, id, report_id),
  constraint weekly_report_versions_number_unique
    unique (tenant_id, report_id, revision_no),
  constraint weekly_report_versions_revision_positive check (revision_no > 0),
  constraint weekly_report_versions_lock_positive check (lock_version > 0),
  constraint weekly_report_versions_lineage_valid check (
    (revision_no = 1 and previous_version_id is null)
    or (revision_no > 1 and previous_version_id is not null)
  ),
  constraint weekly_report_versions_status_valid
    check (status in ('draft', 'in_review', 'published', 'cancelled')),
  constraint weekly_report_versions_title_present
    check (length(btrim(title)) > 0 and length(title) <= 200),
  constraint weekly_report_versions_note_bounded check (length(note) <= 2000),
  constraint weekly_report_versions_scope_fingerprint_valid
    check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint weekly_report_versions_counts_non_negative check (
    scope_entity_count >= 0
    and contributor_count >= 0
    and confirmed_followup_count >= 0
    and valid_fact_count >= 0
    and stage_change_count >= 0
    and completed_action_count >= 0
    and open_action_count >= 0
    and overdue_action_count >= 0
  ),
  constraint weekly_report_versions_generator_kind_valid
    check (generator_kind in ('deterministic', 'agent')),
  constraint weekly_report_versions_generator_present
    check (length(btrim(generator_version)) > 0 and length(generator_version) <= 200),
  constraint weekly_report_versions_publication_state check (
    (
      status = 'published'
      and published_by is not null
      and published_at is not null
    ) or (
      status <> 'published'
      and published_by is null
      and published_at is null
    )
  ),
  constraint weekly_report_versions_time_order check (
    updated_at >= created_at
    and (published_at is null or published_at >= created_at)
  )
);

create index weekly_report_versions_series_idx
  on app.weekly_report_versions (
    tenant_id, report_id, revision_no desc, id desc
  );

create index weekly_report_versions_review_idx
  on app.weekly_report_versions (
    tenant_id, status, updated_at desc, id desc
  ) where status in ('draft', 'in_review');

create table app.weekly_report_scope_entities (
  tenant_id uuid not null,
  report_version_id uuid not null,
  entity_id uuid not null,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  constraint weekly_report_scope_entities_pk
    primary key (tenant_id, report_version_id, entity_id),
  constraint weekly_report_scope_entities_version_fk
    foreign key (tenant_id, report_version_id)
    references app.weekly_report_versions (tenant_id, id),
  constraint weekly_report_scope_entities_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint weekly_report_scope_entities_sort_non_negative
    check (sort_order >= 0)
);

create index weekly_report_scope_entities_entity_idx
  on app.weekly_report_scope_entities (
    tenant_id, entity_id, report_version_id
  );

create table app.weekly_report_items (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  report_version_id uuid not null,
  section_type text not null,
  entity_id uuid not null,
  title text not null,
  summary text not null,
  severity text not null,
  occurred_at timestamptz,
  included boolean not null default true,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  constraint weekly_report_items_pk primary key (tenant_id, id),
  constraint weekly_report_items_version_fk
    foreign key (tenant_id, report_version_id)
    references app.weekly_report_versions (tenant_id, id),
  constraint weekly_report_items_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint weekly_report_items_key_unique
    unique (tenant_id, report_version_id, section_type, entity_id, sort_order),
  constraint weekly_report_items_section_valid
    check (section_type in ('progress', 'risk', 'next_action', 'data_gap')),
  constraint weekly_report_items_title_present
    check (length(btrim(title)) > 0 and length(title) <= 200),
  constraint weekly_report_items_summary_present
    check (length(btrim(summary)) > 0 and length(summary) <= 500),
  constraint weekly_report_items_severity_valid
    check (severity in ('positive', 'info', 'warning', 'critical')),
  constraint weekly_report_items_sort_non_negative check (sort_order >= 0)
);

create index weekly_report_items_version_section_idx
  on app.weekly_report_items (
    tenant_id, report_version_id, section_type, included, sort_order, id
  );

create table app.report_evidence_links (
  tenant_id uuid not null,
  report_item_id uuid not null,
  evidence_type text not null,
  evidence_id uuid not null,
  occurred_at timestamptz not null,
  label text not null,
  deep_link text not null,
  created_at timestamptz not null default now(),
  constraint report_evidence_links_pk
    primary key (tenant_id, report_item_id, evidence_type, evidence_id),
  constraint report_evidence_links_item_fk
    foreign key (tenant_id, report_item_id)
    references app.weekly_report_items (tenant_id, id),
  constraint report_evidence_links_type_valid check (
    evidence_type in (
      'followup', 'fact', 'stage_change', 'action', 'battle_state'
    )
  ),
  constraint report_evidence_links_label_present
    check (length(btrim(label)) > 0 and length(label) <= 500),
  constraint report_evidence_links_deep_link_safe check (
    length(deep_link) <= 2000
    and left(deep_link, 1) = '/'
    and left(deep_link, 2) <> '//'
    and position(chr(10) in deep_link) = 0
    and position(chr(13) in deep_link) = 0
  )
);

create table app.weekly_report_item_contributors (
  tenant_id uuid not null,
  report_item_id uuid not null,
  user_id uuid not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint weekly_report_item_contributors_pk
    primary key (tenant_id, report_item_id, user_id),
  constraint weekly_report_item_contributors_item_fk
    foreign key (tenant_id, report_item_id)
    references app.weekly_report_items (tenant_id, id),
  constraint weekly_report_item_contributors_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint weekly_report_item_contributors_name_present
    check (length(btrim(display_name)) > 0 and length(display_name) <= 200)
);

create index weekly_report_item_contributors_user_idx
  on app.weekly_report_item_contributors (
    tenant_id, user_id, report_item_id
  );

create table app.weekly_report_audiences (
  tenant_id uuid not null,
  report_version_id uuid not null,
  user_id uuid not null,
  audience_role text not null,
  created_at timestamptz not null default now(),
  constraint weekly_report_audiences_pk
    primary key (tenant_id, report_version_id, user_id, audience_role),
  constraint weekly_report_audiences_version_fk
    foreign key (tenant_id, report_version_id)
    references app.weekly_report_versions (tenant_id, id),
  constraint weekly_report_audiences_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint weekly_report_audiences_role_valid
    check (audience_role in ('reviewer', 'recipient'))
);

create index weekly_report_audiences_user_idx
  on app.weekly_report_audiences (
    tenant_id, user_id, report_version_id, audience_role
  );

create function app.validate_weekly_report_version_period()
returns trigger
language plpgsql
as $$
declare
  report_start timestamptz;
  report_end timestamptz;
begin
  select report.period_start, report.period_end
    into report_start, report_end
  from app.weekly_reports as report
  where report.tenant_id = new.tenant_id and report.id = new.report_id;

  if report_start is null
    or new.data_cutoff_at < report_start
    or new.data_cutoff_at > report_end then
    raise exception 'weekly report cutoff is outside its report period';
  end if;
  return new;
end;
$$;

create trigger weekly_report_versions_period_guard
before insert or update on app.weekly_report_versions
for each row execute function app.validate_weekly_report_version_period();

create function app.guard_weekly_report_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'weekly report versions cannot be deleted';
  end if;
  if old.status in ('published', 'cancelled') then
    raise exception 'terminal weekly report versions are immutable';
  end if;
  if old.report_id is distinct from new.report_id
    or old.revision_no is distinct from new.revision_no
    or old.data_cutoff_at is distinct from new.data_cutoff_at
    or old.title is distinct from new.title
    or old.scope_fingerprint is distinct from new.scope_fingerprint
    or old.scope_entity_count is distinct from new.scope_entity_count
    or old.contributor_count is distinct from new.contributor_count
    or old.confirmed_followup_count is distinct from new.confirmed_followup_count
    or old.valid_fact_count is distinct from new.valid_fact_count
    or old.stage_change_count is distinct from new.stage_change_count
    or old.completed_action_count is distinct from new.completed_action_count
    or old.open_action_count is distinct from new.open_action_count
    or old.overdue_action_count is distinct from new.overdue_action_count
    or old.generator_kind is distinct from new.generator_kind
    or old.generator_version is distinct from new.generator_version
    or old.previous_version_id is distinct from new.previous_version_id
    or old.created_by is distinct from new.created_by
    or old.created_at is distinct from new.created_at then
    raise exception 'source-derived weekly report fields are immutable';
  end if;
  if new.lock_version <> old.lock_version + 1 then
    raise exception 'weekly report lock version must increment by one';
  end if;
  if not (
    (old.status = 'draft' and new.status in ('draft', 'in_review', 'cancelled'))
    or (
      old.status = 'in_review'
      and new.status in ('in_review', 'published', 'cancelled')
    )
  ) then
    raise exception 'invalid weekly report status transition';
  end if;
  return new;
end;
$$;

create trigger weekly_report_versions_mutation_guard
before update or delete on app.weekly_report_versions
for each row execute function app.guard_weekly_report_version_mutation();

create function app.guard_weekly_report_child_insert()
returns trigger
language plpgsql
as $$
declare
  parent_status text;
  parent_version_id uuid;
begin
  parent_version_id := case tg_table_name
    when 'weekly_report_scope_entities' then new.report_version_id
    when 'weekly_report_items' then new.report_version_id
    when 'weekly_report_audiences' then new.report_version_id
    else null
  end;
  if parent_version_id is null then
    raise exception 'weekly report child table has no direct version';
  end if;
  select status into parent_status
  from app.weekly_report_versions
  where tenant_id = new.tenant_id and id = parent_version_id;
  if parent_status not in ('draft', 'in_review') then
    raise exception 'weekly report children cannot change after review';
  end if;
  return new;
end;
$$;

create trigger weekly_report_scope_entities_insert_guard
before insert on app.weekly_report_scope_entities
for each row execute function app.guard_weekly_report_child_insert();

create trigger weekly_report_items_insert_guard
before insert on app.weekly_report_items
for each row execute function app.guard_weekly_report_child_insert();

create trigger weekly_report_audiences_insert_guard
before insert on app.weekly_report_audiences
for each row execute function app.guard_weekly_report_child_insert();

create function app.guard_weekly_report_item_child_insert()
returns trigger
language plpgsql
as $$
declare
  parent_status text;
begin
  select report_version.status into parent_status
  from app.weekly_report_items as report_item
  inner join app.weekly_report_versions as report_version
    on report_version.tenant_id = report_item.tenant_id
    and report_version.id = report_item.report_version_id
  where report_item.tenant_id = new.tenant_id
    and report_item.id = new.report_item_id;
  if parent_status not in ('draft', 'in_review') then
    raise exception 'weekly report item children cannot change after review';
  end if;
  return new;
end;
$$;

create trigger report_evidence_links_insert_guard
before insert on app.report_evidence_links
for each row execute function app.guard_weekly_report_item_child_insert();

create trigger weekly_report_item_contributors_insert_guard
before insert on app.weekly_report_item_contributors
for each row execute function app.guard_weekly_report_item_child_insert();

create function app.guard_weekly_report_item_mutation()
returns trigger
language plpgsql
as $$
declare
  parent_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'weekly report items cannot be deleted';
  end if;
  select status into parent_status
  from app.weekly_report_versions
  where tenant_id = old.tenant_id and id = old.report_version_id;
  if parent_status <> 'in_review' then
    raise exception 'only in-review report items may be selected';
  end if;
  if old.tenant_id is distinct from new.tenant_id
    or old.id is distinct from new.id
    or old.report_version_id is distinct from new.report_version_id
    or old.section_type is distinct from new.section_type
    or old.entity_id is distinct from new.entity_id
    or old.title is distinct from new.title
    or old.summary is distinct from new.summary
    or old.severity is distinct from new.severity
    or old.occurred_at is distinct from new.occurred_at
    or old.sort_order is distinct from new.sort_order
    or old.created_at is distinct from new.created_at then
    raise exception 'source-derived weekly report item fields are immutable';
  end if;
  return new;
end;
$$;

create trigger weekly_report_items_mutation_guard
before update or delete on app.weekly_report_items
for each row execute function app.guard_weekly_report_item_mutation();

create function app.reject_weekly_report_snapshot_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'weekly report snapshot rows are immutable';
end;
$$;

create trigger weekly_report_scope_entities_immutable
before update or delete on app.weekly_report_scope_entities
for each row execute function app.reject_weekly_report_snapshot_mutation();

create trigger report_evidence_links_immutable
before update or delete on app.report_evidence_links
for each row execute function app.reject_weekly_report_snapshot_mutation();

create trigger weekly_report_item_contributors_immutable
before update or delete on app.weekly_report_item_contributors
for each row execute function app.reject_weekly_report_snapshot_mutation();

create trigger weekly_report_audiences_immutable
before update or delete on app.weekly_report_audiences
for each row execute function app.reject_weekly_report_snapshot_mutation();

alter table app.notification_events
  drop constraint notification_events_type_valid,
  alter column reminder_id drop not null,
  add column report_version_id uuid,
  add constraint notification_events_report_version_fk
    foreign key (tenant_id, report_version_id)
    references app.weekly_report_versions (tenant_id, id),
  add constraint notification_events_report_version_unique
    unique (tenant_id, report_version_id),
  add constraint notification_events_type_valid
    check (event_type in ('action_due', 'weekly_report_published')),
  add constraint notification_events_source_valid check (
    (
      event_type = 'action_due'
      and reminder_id is not null
      and report_version_id is null
    ) or (
      event_type = 'weekly_report_published'
      and reminder_id is null
      and report_version_id is not null
    )
  );

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'weekly_reports',
    'weekly_report_versions',
    'weekly_report_scope_entities',
    'weekly_report_items',
    'report_evidence_links',
    'weekly_report_item_contributors',
    'weekly_report_audiences'
  ] loop
    execute format('alter table app.%I enable row level security', protected_table);
    execute format('alter table app.%I force row level security', protected_table);
    execute format(
      'create policy %I on app.%I using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())',
      protected_table || '_tenant_isolation',
      protected_table
    );
  end loop;
end;
$$;
