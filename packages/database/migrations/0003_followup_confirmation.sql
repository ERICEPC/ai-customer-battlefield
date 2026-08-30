create table app.source_inputs (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  source_type text not null,
  source_message_id text,
  submitted_by uuid not null,
  raw_content text not null,
  content_hash text not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint source_inputs_pk primary key (tenant_id, id),
  constraint source_inputs_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint source_inputs_submitted_by_fk
    foreign key (tenant_id, submitted_by)
    references app.users (tenant_id, id),
  constraint source_inputs_source_type_valid
    check (source_type in ('web', 'feishu', 'email', 'import', 'api')),
  constraint source_inputs_message_present
    check (source_message_id is null or length(btrim(source_message_id)) > 0),
  constraint source_inputs_content_present check (length(btrim(raw_content)) > 0),
  constraint source_inputs_hash_valid check (content_hash ~ '^[0-9a-f]{64}$')
);

create unique index source_inputs_external_message_unique_idx
  on app.source_inputs (tenant_id, source_type, source_message_id)
  where source_message_id is not null;

create index source_inputs_submitter_idx
  on app.source_inputs (tenant_id, submitted_by, received_at desc, id desc);

create table app.followup_drafts (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  source_input_id uuid not null,
  entity_id uuid not null,
  status text not null default 'pending_confirmation',
  candidate_payload jsonb not null,
  created_by uuid not null,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  confirmed_by uuid,
  cancelled_at timestamptz,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint followup_drafts_pk primary key (tenant_id, id),
  constraint followup_drafts_source_fk
    foreign key (tenant_id, source_input_id)
    references app.source_inputs (tenant_id, id),
  constraint followup_drafts_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint followup_drafts_created_by_fk
    foreign key (tenant_id, created_by)
    references app.users (tenant_id, id),
  constraint followup_drafts_confirmed_by_fk
    foreign key (tenant_id, confirmed_by)
    references app.users (tenant_id, id),
  constraint followup_drafts_source_unique unique (tenant_id, source_input_id),
  constraint followup_drafts_status_valid
    check (status in ('pending_confirmation', 'confirmed', 'cancelled', 'expired')),
  constraint followup_drafts_candidate_object
    check (jsonb_typeof(candidate_payload) = 'object'),
  constraint followup_drafts_expiry_after_creation check (expires_at > created_at),
  constraint followup_drafts_version_positive check (version_no > 0),
  constraint followup_drafts_terminal_metadata check (
    (
      status = 'pending_confirmation'
      and confirmed_at is null
      and confirmed_by is null
      and cancelled_at is null
    ) or (
      status = 'confirmed'
      and confirmed_at is not null
      and confirmed_by is not null
      and cancelled_at is null
    ) or (
      status = 'cancelled'
      and confirmed_at is null
      and confirmed_by is null
      and cancelled_at is not null
    ) or (
      status = 'expired'
      and confirmed_at is null
      and confirmed_by is null
      and cancelled_at is null
    )
  )
);

create index followup_drafts_entity_timeline_idx
  on app.followup_drafts (tenant_id, entity_id, created_at desc, id desc);

create index followup_drafts_pending_idx
  on app.followup_drafts (tenant_id, expires_at, id)
  where status = 'pending_confirmation';

create table app.draft_revisions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  draft_id uuid not null,
  revision_no bigint not null,
  candidate_payload jsonb not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  constraint draft_revisions_pk primary key (tenant_id, id),
  constraint draft_revisions_draft_fk
    foreign key (tenant_id, draft_id)
    references app.followup_drafts (tenant_id, id),
  constraint draft_revisions_changed_by_fk
    foreign key (tenant_id, changed_by)
    references app.users (tenant_id, id),
  constraint draft_revisions_number_unique
    unique (tenant_id, draft_id, revision_no),
  constraint draft_revisions_number_positive check (revision_no > 0),
  constraint draft_revisions_candidate_object
    check (jsonb_typeof(candidate_payload) = 'object')
);

create index draft_revisions_draft_idx
  on app.draft_revisions (tenant_id, draft_id, revision_no desc);

create table app.followups (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  source_input_id uuid not null,
  source_draft_id uuid not null,
  occurred_at timestamptz not null,
  followup_type text not null,
  summary text not null,
  result_summary text,
  submitted_by uuid not null,
  confirmed_by uuid not null,
  confirmed_at timestamptz not null,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  constraint followups_pk primary key (tenant_id, id),
  constraint followups_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint followups_source_input_fk
    foreign key (tenant_id, source_input_id)
    references app.source_inputs (tenant_id, id),
  constraint followups_source_draft_fk
    foreign key (tenant_id, source_draft_id)
    references app.followup_drafts (tenant_id, id),
  constraint followups_submitted_by_fk
    foreign key (tenant_id, submitted_by)
    references app.users (tenant_id, id),
  constraint followups_confirmed_by_fk
    foreign key (tenant_id, confirmed_by)
    references app.users (tenant_id, id),
  constraint followups_source_draft_unique unique (tenant_id, source_draft_id),
  constraint followups_type_valid
    check (followup_type in ('meeting', 'call', 'message', 'email', 'other')),
  constraint followups_summary_present check (length(btrim(summary)) > 0),
  constraint followups_result_present
    check (result_summary is null or length(btrim(result_summary)) > 0),
  constraint followups_confirmation_order check (confirmed_at >= occurred_at),
  constraint followups_version_positive check (version_no > 0)
);

create index followups_entity_timeline_idx
  on app.followups (tenant_id, entity_id, occurred_at desc, id desc);

create index followups_submitter_idx
  on app.followups (tenant_id, submitted_by, occurred_at desc, id desc);

create table app.followup_corrections (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  followup_id uuid not null,
  supersedes_followup_id uuid not null,
  reason text not null,
  corrected_by uuid not null,
  corrected_at timestamptz not null,
  constraint followup_corrections_pk primary key (tenant_id, id),
  constraint followup_corrections_followup_fk
    foreign key (tenant_id, followup_id)
    references app.followups (tenant_id, id),
  constraint followup_corrections_supersedes_fk
    foreign key (tenant_id, supersedes_followup_id)
    references app.followups (tenant_id, id),
  constraint followup_corrections_corrected_by_fk
    foreign key (tenant_id, corrected_by)
    references app.users (tenant_id, id),
  constraint followup_corrections_followup_unique unique (tenant_id, followup_id),
  constraint followup_corrections_supersedes_unique
    unique (tenant_id, supersedes_followup_id),
  constraint followup_corrections_distinct
    check (followup_id <> supersedes_followup_id),
  constraint followup_corrections_reason_present check (length(btrim(reason)) > 0)
);

create index followup_corrections_supersedes_idx
  on app.followup_corrections (tenant_id, supersedes_followup_id);

create table app.followup_participants (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  followup_id uuid not null,
  user_id uuid,
  contact_id uuid,
  participant_role text not null,
  created_at timestamptz not null default now(),
  constraint followup_participants_pk primary key (tenant_id, id),
  constraint followup_participants_followup_fk
    foreign key (tenant_id, followup_id)
    references app.followups (tenant_id, id),
  constraint followup_participants_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint followup_participants_contact_fk
    foreign key (tenant_id, contact_id)
    references app.contacts (tenant_id, id),
  constraint followup_participants_exactly_one_person
    check ((user_id is null) <> (contact_id is null)),
  constraint followup_participants_role_valid
    check (participant_role in ('sales_owner', 'participant', 'customer_contact', 'observer'))
);

create unique index followup_participants_user_unique_idx
  on app.followup_participants (tenant_id, followup_id, user_id, participant_role)
  where user_id is not null;

create unique index followup_participants_contact_unique_idx
  on app.followup_participants (tenant_id, followup_id, contact_id, participant_role)
  where contact_id is not null;

create index followup_participants_user_idx
  on app.followup_participants (tenant_id, user_id, followup_id)
  where user_id is not null;

create index followup_participants_contact_idx
  on app.followup_participants (tenant_id, contact_id, followup_id)
  where contact_id is not null;

create table app.followup_opportunities (
  tenant_id uuid not null,
  followup_id uuid not null,
  opportunity_id uuid not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint followup_opportunities_pk
    primary key (tenant_id, followup_id, opportunity_id),
  constraint followup_opportunities_followup_fk
    foreign key (tenant_id, followup_id)
    references app.followups (tenant_id, id),
  constraint followup_opportunities_opportunity_fk
    foreign key (tenant_id, opportunity_id)
    references app.opportunities (tenant_id, id)
);

create unique index followup_opportunities_primary_unique_idx
  on app.followup_opportunities (tenant_id, followup_id)
  where is_primary;

create index followup_opportunities_opportunity_idx
  on app.followup_opportunities (tenant_id, opportunity_id, followup_id);

create function app.enforce_followup_primary_opportunity()
returns trigger
language plpgsql
as $$
declare
  target_tenant_id uuid;
  target_followup_id uuid;
  relation_count integer;
  primary_count integer;
begin
  target_tenant_id := coalesce(new.tenant_id, old.tenant_id);
  target_followup_id := coalesce(new.followup_id, old.followup_id);

  select count(*)::integer,
         count(*) filter (where is_primary)::integer
    into relation_count, primary_count
  from app.followup_opportunities
  where tenant_id = target_tenant_id
    and followup_id = target_followup_id;

  if relation_count > 1 and primary_count <> 1 then
    raise exception 'multiple follow-up opportunities require exactly one primary link';
  end if;

  return null;
end;
$$;

create constraint trigger followup_opportunities_primary_required
after insert or update or delete on app.followup_opportunities
deferrable initially deferred
for each row execute function app.enforce_followup_primary_opportunity();

create table app.business_facts (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  opportunity_id uuid,
  followup_id uuid not null,
  fact_type text not null,
  fact_value text not null,
  occurred_at timestamptz not null,
  confirmed_at timestamptz not null,
  confirmed_by uuid not null,
  valid_status text not null default 'valid',
  supersedes_fact_id uuid,
  created_at timestamptz not null default now(),
  constraint business_facts_pk primary key (tenant_id, id),
  constraint business_facts_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint business_facts_opportunity_fk
    foreign key (tenant_id, opportunity_id)
    references app.opportunities (tenant_id, id),
  constraint business_facts_followup_fk
    foreign key (tenant_id, followup_id)
    references app.followups (tenant_id, id),
  constraint business_facts_confirmed_by_fk
    foreign key (tenant_id, confirmed_by)
    references app.users (tenant_id, id),
  constraint business_facts_supersedes_fk
    foreign key (tenant_id, supersedes_fact_id)
    references app.business_facts (tenant_id, id),
  constraint business_facts_type_valid
    check (fact_type ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  constraint business_facts_value_present check (length(btrim(fact_value)) > 0),
  constraint business_facts_status_valid
    check (valid_status in ('valid', 'superseded', 'invalidated')),
  constraint business_facts_not_self_superseding check (id <> supersedes_fact_id),
  constraint business_facts_confirmation_order check (confirmed_at >= occurred_at)
);

create unique index business_facts_supersedes_unique_idx
  on app.business_facts (tenant_id, supersedes_fact_id)
  where supersedes_fact_id is not null;

create index business_facts_entity_timeline_idx
  on app.business_facts (tenant_id, entity_id, occurred_at desc, id desc);

create index business_facts_followup_idx
  on app.business_facts (tenant_id, followup_id, id);

create index business_facts_opportunity_idx
  on app.business_facts (tenant_id, opportunity_id, occurred_at desc, id desc)
  where opportunity_id is not null;

create table app.source_evidence (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  source_input_id uuid,
  source_type text not null,
  content_ref text,
  excerpt text,
  content_hash text not null,
  sensitivity text not null default 'internal',
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint source_evidence_pk primary key (tenant_id, id),
  constraint source_evidence_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint source_evidence_source_input_fk
    foreign key (tenant_id, source_input_id)
    references app.source_inputs (tenant_id, id),
  constraint source_evidence_source_type_valid
    check (source_type in ('web', 'feishu', 'email', 'attachment', 'import', 'api')),
  constraint source_evidence_ref_present
    check (content_ref is null or length(btrim(content_ref)) > 0),
  constraint source_evidence_excerpt_present
    check (excerpt is null or length(btrim(excerpt)) > 0),
  constraint source_evidence_hash_valid check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint source_evidence_sensitivity_valid
    check (sensitivity in ('public', 'internal', 'confidential', 'restricted'))
);

create index source_evidence_input_idx
  on app.source_evidence (tenant_id, source_input_id, captured_at desc, id desc)
  where source_input_id is not null;

create table app.fact_evidence_links (
  tenant_id uuid not null,
  fact_id uuid not null,
  evidence_id uuid not null,
  relation_type text not null,
  created_at timestamptz not null default now(),
  constraint fact_evidence_links_pk primary key (tenant_id, fact_id, evidence_id),
  constraint fact_evidence_links_fact_fk
    foreign key (tenant_id, fact_id)
    references app.business_facts (tenant_id, id),
  constraint fact_evidence_links_evidence_fk
    foreign key (tenant_id, evidence_id)
    references app.source_evidence (tenant_id, id),
  constraint fact_evidence_links_relation_valid
    check (relation_type in ('supports', 'contradicts', 'context'))
);

create index fact_evidence_links_evidence_idx
  on app.fact_evidence_links (tenant_id, evidence_id, fact_id);

create table app.idempotency_records (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null,
  response_payload jsonb,
  resource_type text,
  resource_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  constraint idempotency_records_pk primary key (tenant_id, id),
  constraint idempotency_records_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint idempotency_records_created_by_fk
    foreign key (tenant_id, created_by)
    references app.users (tenant_id, id),
  constraint idempotency_records_key_unique
    unique (tenant_id, operation, idempotency_key),
  constraint idempotency_records_operation_present check (length(btrim(operation)) > 0),
  constraint idempotency_records_key_valid
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  constraint idempotency_records_hash_valid check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_records_status_valid
    check (status in ('in_progress', 'completed')),
  constraint idempotency_records_response_object
    check (response_payload is null or jsonb_typeof(response_payload) = 'object'),
  constraint idempotency_records_resource_pair
    check ((resource_type is null) = (resource_id is null)),
  constraint idempotency_records_completion_state check (
    (status = 'in_progress' and completed_at is null and response_payload is null)
    or (status = 'completed' and completed_at is not null and response_payload is not null)
  ),
  constraint idempotency_records_expiry_order
    check (expires_at is null or expires_at > created_at)
);

create index idempotency_records_expiry_idx
  on app.idempotency_records (tenant_id, expires_at, id)
  where expires_at is not null;

create table app.audit_entries (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  action text not null,
  actor_user_id uuid not null,
  request_id text,
  before_payload jsonb,
  after_payload jsonb,
  reason text,
  occurred_at timestamptz not null,
  constraint audit_entries_pk primary key (tenant_id, id),
  constraint audit_entries_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint audit_entries_actor_fk
    foreign key (tenant_id, actor_user_id)
    references app.users (tenant_id, id),
  constraint audit_entries_aggregate_present check (length(btrim(aggregate_type)) > 0),
  constraint audit_entries_action_present check (length(btrim(action)) > 0),
  constraint audit_entries_request_present
    check (request_id is null or length(btrim(request_id)) > 0),
  constraint audit_entries_before_object
    check (before_payload is null or jsonb_typeof(before_payload) = 'object'),
  constraint audit_entries_after_object
    check (after_payload is null or jsonb_typeof(after_payload) = 'object'),
  constraint audit_entries_reason_present
    check (reason is null or length(btrim(reason)) > 0)
);

create index audit_entries_aggregate_idx
  on app.audit_entries (tenant_id, aggregate_type, aggregate_id, occurred_at desc, id desc);

create index audit_entries_actor_idx
  on app.audit_entries (tenant_id, actor_user_id, occurred_at desc, id desc);

create table app.domain_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  event_version bigint not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  constraint domain_events_pk primary key (tenant_id, id),
  constraint domain_events_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint domain_events_aggregate_version_unique
    unique (tenant_id, aggregate_type, aggregate_id, event_version),
  constraint domain_events_aggregate_present check (length(btrim(aggregate_type)) > 0),
  constraint domain_events_type_valid check (event_type ~ '^[a-z][a-z0-9_.-]{0,199}$'),
  constraint domain_events_version_positive check (event_version > 0),
  constraint domain_events_payload_object check (jsonb_typeof(payload) = 'object')
);

create index domain_events_type_idx
  on app.domain_events (tenant_id, event_type, occurred_at desc, id desc);

create table app.outbox_messages (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending',
  dedupe_key text not null,
  available_at timestamptz not null,
  attempt_count integer not null default 0,
  last_error text,
  claimed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  constraint outbox_messages_pk primary key (tenant_id, id),
  constraint outbox_messages_event_fk
    foreign key (tenant_id, event_id)
    references app.domain_events (tenant_id, id),
  constraint outbox_messages_event_unique unique (tenant_id, event_id),
  constraint outbox_messages_dedupe_unique unique (tenant_id, dedupe_key),
  constraint outbox_messages_topic_present check (length(btrim(topic)) > 0),
  constraint outbox_messages_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint outbox_messages_status_valid
    check (status in ('pending', 'processing', 'published', 'failed', 'cancelled')),
  constraint outbox_messages_dedupe_present check (length(btrim(dedupe_key)) > 0),
  constraint outbox_messages_attempt_non_negative check (attempt_count >= 0),
  constraint outbox_messages_error_present
    check (last_error is null or length(btrim(last_error)) > 0),
  constraint outbox_messages_published_state
    check ((status = 'published') = (published_at is not null))
);

create index outbox_messages_claim_idx
  on app.outbox_messages (status, available_at, id)
  where status in ('pending', 'failed');

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'source_inputs',
    'followup_drafts',
    'draft_revisions',
    'followups',
    'followup_corrections',
    'followup_participants',
    'followup_opportunities',
    'business_facts',
    'source_evidence',
    'fact_evidence_links',
    'idempotency_records',
    'audit_entries',
    'domain_events',
    'outbox_messages'
  ]
  loop
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
