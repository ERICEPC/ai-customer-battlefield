alter table app.business_facts
  add constraint business_facts_entity_identity_unique
  unique (tenant_id, id, entity_id);

alter table app.opportunities
  add constraint opportunities_entity_identity_unique
  unique (tenant_id, id, entity_id);

create table app.analysis_runs (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  trigger_event_id uuid,
  rule_version text not null,
  analyzer_config_version text not null,
  input_version text not null,
  status text not null default 'running',
  error_code text,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint analysis_runs_pk primary key (tenant_id, id),
  constraint analysis_runs_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint analysis_runs_trigger_event_fk
    foreign key (tenant_id, trigger_event_id)
    references app.domain_events (tenant_id, id),
  constraint analysis_runs_created_by_fk
    foreign key (tenant_id, created_by)
    references app.users (tenant_id, id),
  constraint analysis_runs_entity_identity_unique
    unique (tenant_id, id, entity_id),
  constraint analysis_runs_input_identity_unique
    unique (tenant_id, id, entity_id, input_version),
  constraint analysis_runs_rule_version_present
    check (length(btrim(rule_version)) > 0),
  constraint analysis_runs_config_version_present
    check (length(btrim(analyzer_config_version)) > 0),
  constraint analysis_runs_input_version_valid
    check (input_version ~ '^[0-9a-f]{64}$'),
  constraint analysis_runs_status_valid
    check (status in ('running', 'completed', 'failed', 'superseded')),
  constraint analysis_runs_error_code_valid
    check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  constraint analysis_runs_error_message_present
    check (error_message is null or length(btrim(error_message)) > 0),
  constraint analysis_runs_terminal_metadata check (
    (
      status = 'running'
      and finished_at is null
      and error_code is null
      and error_message is null
    ) or (
      status in ('completed', 'superseded')
      and finished_at is not null
      and error_code is null
      and error_message is null
    ) or (
      status = 'failed'
      and finished_at is not null
      and error_code is not null
      and error_message is not null
    )
  ),
  constraint analysis_runs_finish_order
    check (finished_at is null or finished_at >= started_at)
);

create index analysis_runs_entity_timeline_idx
  on app.analysis_runs (tenant_id, entity_id, started_at desc, id desc);

create index analysis_runs_running_idx
  on app.analysis_runs (tenant_id, started_at, id)
  where status = 'running';

create index analysis_runs_trigger_event_idx
  on app.analysis_runs (tenant_id, trigger_event_id)
  where trigger_event_id is not null;

create table app.business_signals (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  fact_id uuid not null,
  analysis_run_id uuid not null,
  dimension text not null,
  direction text not null,
  strength smallint not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint business_signals_pk primary key (tenant_id, id),
  constraint business_signals_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint business_signals_fact_entity_fk
    foreign key (tenant_id, fact_id, entity_id)
    references app.business_facts (tenant_id, id, entity_id),
  constraint business_signals_run_entity_fk
    foreign key (tenant_id, analysis_run_id, entity_id)
    references app.analysis_runs (tenant_id, id, entity_id),
  constraint business_signals_entity_identity_unique
    unique (tenant_id, id, entity_id),
  constraint business_signals_run_fact_dimension_unique
    unique (tenant_id, analysis_run_id, fact_id, dimension),
  constraint business_signals_dimension_valid
    check (dimension in ('relationship', 'potential', 'risk', 'stage')),
  constraint business_signals_direction_valid
    check (direction in ('positive', 'negative', 'neutral')),
  constraint business_signals_strength_valid
    check (strength >= 0 and strength <= 100),
  constraint business_signals_reason_present
    check (length(btrim(reason)) > 0)
);

create index business_signals_entity_idx
  on app.business_signals (tenant_id, entity_id, created_at desc, id desc);

create index business_signals_fact_idx
  on app.business_signals (tenant_id, fact_id, id);

create index business_signals_run_idx
  on app.business_signals (tenant_id, analysis_run_id, id);

create table app.battle_state_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  version_no bigint not null,
  input_version text not null,
  relationship_score numeric(5, 2),
  potential_score numeric(5, 2),
  quadrant_code text,
  primary_opportunity_id uuid,
  risk_level text not null,
  data_sufficiency text not null,
  data_gaps jsonb not null default '[]'::jsonb,
  summary text not null,
  analysis_run_id uuid not null,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint battle_state_versions_pk primary key (tenant_id, id),
  constraint battle_state_versions_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint battle_state_versions_opportunity_entity_fk
    foreign key (tenant_id, primary_opportunity_id, entity_id)
    references app.opportunities (tenant_id, id, entity_id),
  constraint battle_state_versions_run_input_fk
    foreign key (tenant_id, analysis_run_id, entity_id, input_version)
    references app.analysis_runs (tenant_id, id, entity_id, input_version),
  constraint battle_state_versions_entity_number_unique
    unique (tenant_id, entity_id, version_no),
  constraint battle_state_versions_run_unique
    unique (tenant_id, analysis_run_id),
  constraint battle_state_versions_entity_identity_unique
    unique (tenant_id, id, entity_id),
  constraint battle_state_versions_projection_identity_unique
    unique (tenant_id, id, entity_id, version_no, input_version),
  constraint battle_state_versions_version_positive check (version_no > 0),
  constraint battle_state_versions_input_version_valid
    check (input_version ~ '^[0-9a-f]{64}$'),
  constraint battle_state_versions_relationship_score_valid
    check (relationship_score is null or (relationship_score >= 0 and relationship_score <= 100)),
  constraint battle_state_versions_potential_score_valid
    check (potential_score is null or (potential_score >= 0 and potential_score <= 100)),
  constraint battle_state_versions_quadrant_valid
    check (quadrant_code is null or quadrant_code ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint battle_state_versions_risk_valid
    check (risk_level in ('low', 'medium', 'high', 'critical')),
  constraint battle_state_versions_sufficiency_valid
    check (data_sufficiency in ('insufficient', 'partial', 'sufficient')),
  constraint battle_state_versions_gaps_array
    check (jsonb_typeof(data_gaps) = 'array'),
  constraint battle_state_versions_summary_present
    check (length(btrim(summary)) > 0),
  constraint battle_state_versions_map_coherent check (
    (
      relationship_score is null
      and potential_score is null
      and quadrant_code is null
    ) or (
      relationship_score is not null
      and potential_score is not null
      and quadrant_code is not null
    )
  ),
  constraint battle_state_versions_sufficiency_coherent check (
    (
      data_sufficiency = 'insufficient'
      and relationship_score is null
      and potential_score is null
      and quadrant_code is null
      and jsonb_array_length(data_gaps) > 0
    ) or (
      data_sufficiency = 'partial'
    ) or (
      data_sufficiency = 'sufficient'
      and relationship_score is not null
      and potential_score is not null
      and quadrant_code is not null
    )
  )
);

create index battle_state_versions_entity_timeline_idx
  on app.battle_state_versions (tenant_id, entity_id, version_no desc);

create index battle_state_versions_map_filter_idx
  on app.battle_state_versions (
    tenant_id, data_sufficiency, quadrant_code, risk_level,
    relationship_score, potential_score, entity_id
  );

create table app.battle_state_current (
  tenant_id uuid not null,
  entity_id uuid not null,
  battle_state_version_id uuid not null,
  version_no bigint not null,
  input_version text not null,
  updated_at timestamptz not null,
  constraint battle_state_current_pk primary key (tenant_id, entity_id),
  constraint battle_state_current_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint battle_state_current_version_fk
    foreign key (
      tenant_id, battle_state_version_id, entity_id, version_no, input_version
    ) references app.battle_state_versions (
      tenant_id, id, entity_id, version_no, input_version
    ),
  constraint battle_state_current_version_unique
    unique (tenant_id, battle_state_version_id),
  constraint battle_state_current_version_positive check (version_no > 0),
  constraint battle_state_current_input_version_valid
    check (input_version ~ '^[0-9a-f]{64}$')
);

create index battle_state_current_version_idx
  on app.battle_state_current (
    tenant_id, battle_state_version_id, entity_id, version_no
  );

create table app.battle_state_evidence_links (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  battle_state_version_id uuid not null,
  fact_id uuid,
  signal_id uuid,
  contribution text not null,
  created_at timestamptz not null default now(),
  constraint battle_state_evidence_links_pk primary key (tenant_id, id),
  constraint battle_state_evidence_links_state_entity_fk
    foreign key (tenant_id, battle_state_version_id, entity_id)
    references app.battle_state_versions (tenant_id, id, entity_id),
  constraint battle_state_evidence_links_fact_entity_fk
    foreign key (tenant_id, fact_id, entity_id)
    references app.business_facts (tenant_id, id, entity_id),
  constraint battle_state_evidence_links_signal_entity_fk
    foreign key (tenant_id, signal_id, entity_id)
    references app.business_signals (tenant_id, id, entity_id),
  constraint battle_state_evidence_links_exactly_one_source
    check ((fact_id is null) <> (signal_id is null)),
  constraint battle_state_evidence_links_contribution_present
    check (length(btrim(contribution)) > 0)
);

create unique index battle_state_evidence_links_fact_unique_idx
  on app.battle_state_evidence_links (
    tenant_id, battle_state_version_id, fact_id
  ) where fact_id is not null;

create unique index battle_state_evidence_links_signal_unique_idx
  on app.battle_state_evidence_links (
    tenant_id, battle_state_version_id, signal_id
  ) where signal_id is not null;

create index battle_state_evidence_links_state_idx
  on app.battle_state_evidence_links (
    tenant_id, battle_state_version_id, created_at, id
  );

create table app.action_proposals (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  opportunity_id uuid,
  title text not null,
  description text not null,
  suggested_owner_id uuid,
  suggested_priority text not null,
  suggested_planned_at timestamptz,
  source_battle_state_version_id uuid not null,
  status text not null default 'pending_confirmation',
  version_no bigint not null default 1,
  proposed_at timestamptz not null,
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by uuid,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_proposals_pk primary key (tenant_id, id),
  constraint action_proposals_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint action_proposals_opportunity_entity_fk
    foreign key (tenant_id, opportunity_id, entity_id)
    references app.opportunities (tenant_id, id, entity_id),
  constraint action_proposals_suggested_owner_fk
    foreign key (tenant_id, suggested_owner_id)
    references app.users (tenant_id, id),
  constraint action_proposals_state_entity_fk
    foreign key (tenant_id, source_battle_state_version_id, entity_id)
    references app.battle_state_versions (tenant_id, id, entity_id),
  constraint action_proposals_decided_by_fk
    foreign key (tenant_id, decided_by)
    references app.users (tenant_id, id),
  constraint action_proposals_entity_identity_unique
    unique (tenant_id, id, entity_id),
  constraint action_proposals_title_present check (length(btrim(title)) > 0),
  constraint action_proposals_description_present
    check (length(btrim(description)) > 0),
  constraint action_proposals_priority_valid
    check (suggested_priority in ('low', 'medium', 'high', 'urgent')),
  constraint action_proposals_status_valid
    check (status in ('pending_confirmation', 'accepted', 'rejected', 'expired')),
  constraint action_proposals_version_positive check (version_no > 0),
  constraint action_proposals_expiry_order check (expires_at > proposed_at),
  constraint action_proposals_suggested_time_order
    check (suggested_planned_at is null or suggested_planned_at > proposed_at),
  constraint action_proposals_decision_order
    check (decided_at is null or decided_at >= proposed_at),
  constraint action_proposals_reason_present
    check (decision_reason is null or length(btrim(decision_reason)) > 0),
  constraint action_proposals_terminal_metadata check (
    (
      status = 'pending_confirmation'
      and decided_at is null
      and decided_by is null
      and decision_reason is null
    ) or (
      status = 'accepted'
      and decided_at is not null
      and decided_by is not null
      and decision_reason is null
    ) or (
      status = 'rejected'
      and decided_at is not null
      and decided_by is not null
      and decision_reason is not null
    ) or (
      status = 'expired'
      and decided_at is not null
      and decided_by is null
      and decision_reason is null
    )
  )
);

create index action_proposals_pending_idx
  on app.action_proposals (tenant_id, expires_at, proposed_at, id)
  where status = 'pending_confirmation';

create index action_proposals_queue_idx
  on app.action_proposals (
    tenant_id, status, suggested_priority, proposed_at desc, id desc
  );

create index action_proposals_entity_idx
  on app.action_proposals (tenant_id, entity_id, proposed_at desc, id desc);

create index action_proposals_state_idx
  on app.action_proposals (
    tenant_id, source_battle_state_version_id, proposed_at, id
  );

create table app.business_actions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  opportunity_id uuid,
  title text not null,
  description text not null,
  owner_user_id uuid not null,
  priority text not null,
  status text not null default 'planned',
  planned_at timestamptz not null,
  completed_at timestamptz,
  source_proposal_id uuid not null,
  confirmed_by uuid not null,
  confirmed_at timestamptz not null,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_actions_pk primary key (tenant_id, id),
  constraint business_actions_entity_fk
    foreign key (tenant_id, entity_id)
    references app.business_entities (tenant_id, id),
  constraint business_actions_opportunity_entity_fk
    foreign key (tenant_id, opportunity_id, entity_id)
    references app.opportunities (tenant_id, id, entity_id),
  constraint business_actions_owner_fk
    foreign key (tenant_id, owner_user_id)
    references app.users (tenant_id, id),
  constraint business_actions_source_proposal_entity_fk
    foreign key (tenant_id, source_proposal_id, entity_id)
    references app.action_proposals (tenant_id, id, entity_id),
  constraint business_actions_confirmed_by_fk
    foreign key (tenant_id, confirmed_by)
    references app.users (tenant_id, id),
  constraint business_actions_source_proposal_unique
    unique (tenant_id, source_proposal_id),
  constraint business_actions_title_present check (length(btrim(title)) > 0),
  constraint business_actions_description_present
    check (length(btrim(description)) > 0),
  constraint business_actions_priority_valid
    check (priority in ('low', 'medium', 'high', 'urgent')),
  constraint business_actions_status_valid
    check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  constraint business_actions_version_positive check (version_no > 0),
  constraint business_actions_planned_after_confirmation
    check (planned_at > confirmed_at),
  constraint business_actions_completion_state check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint business_actions_completion_order
    check (completed_at is null or completed_at >= confirmed_at),
  constraint business_actions_update_order check (updated_at >= created_at)
);

create index business_actions_owner_due_idx
  on app.business_actions (
    tenant_id, owner_user_id, status, planned_at, id
  ) where status in ('planned', 'in_progress');

create index business_actions_entity_idx
  on app.business_actions (tenant_id, entity_id, status, planned_at, id);

create index business_actions_opportunity_idx
  on app.business_actions (tenant_id, opportunity_id, status, planned_at, id)
  where opportunity_id is not null;

create table app.action_status_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  action_id uuid not null,
  from_status text,
  to_status text not null,
  changed_by uuid not null,
  reason text,
  changed_at timestamptz not null,
  version_no bigint not null,
  constraint action_status_history_pk primary key (tenant_id, id),
  constraint action_status_history_action_fk
    foreign key (tenant_id, action_id)
    references app.business_actions (tenant_id, id),
  constraint action_status_history_changed_by_fk
    foreign key (tenant_id, changed_by)
    references app.users (tenant_id, id),
  constraint action_status_history_version_unique
    unique (tenant_id, action_id, version_no),
  constraint action_status_history_version_positive check (version_no > 0),
  constraint action_status_history_reason_present
    check (reason is null or length(btrim(reason)) > 0),
  constraint action_status_history_transition_valid check (
    (version_no = 1 and from_status is null and to_status = 'planned')
    or (from_status = 'planned' and to_status in ('in_progress', 'cancelled'))
    or (from_status = 'in_progress' and to_status in ('completed', 'cancelled'))
  )
);

create index action_status_history_action_idx
  on app.action_status_history (tenant_id, action_id, version_no desc);

create function app.reject_immutable_battle_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is immutable', tg_table_name;
end;
$$;

create trigger business_signals_immutable
before update or delete on app.business_signals
for each row execute function app.reject_immutable_battle_history_mutation();

create trigger battle_state_versions_immutable
before update or delete on app.battle_state_versions
for each row execute function app.reject_immutable_battle_history_mutation();

create trigger battle_state_evidence_links_immutable
before update or delete on app.battle_state_evidence_links
for each row execute function app.reject_immutable_battle_history_mutation();

create trigger action_status_history_immutable
before update or delete on app.action_status_history
for each row execute function app.reject_immutable_battle_history_mutation();

create function app.enforce_analysis_run_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'running' then
    raise exception 'terminal analysis runs are immutable';
  end if;

  if new.status not in ('completed', 'failed', 'superseded') then
    raise exception 'analysis runs may only transition from running to a terminal status';
  end if;

  if new.tenant_id <> old.tenant_id
    or new.id <> old.id
    or new.entity_id <> old.entity_id
    or new.rule_version <> old.rule_version
    or new.analyzer_config_version <> old.analyzer_config_version
    or new.input_version <> old.input_version
    or new.started_at <> old.started_at
    or new.created_by <> old.created_by
    or new.created_at <> old.created_at
    or new.trigger_event_id is distinct from old.trigger_event_id
  then
    raise exception 'analysis run identity and input metadata are immutable';
  end if;

  return new;
end;
$$;

create trigger analysis_runs_transition_guard
before update on app.analysis_runs
for each row execute function app.enforce_analysis_run_transition();

create function app.enforce_action_proposal_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'pending_confirmation' then
    raise exception 'terminal action proposals are immutable';
  end if;

  if new.status not in ('accepted', 'rejected', 'expired') then
    raise exception 'pending action proposals require a terminal decision';
  end if;

  if new.version_no <> old.version_no + 1 then
    raise exception 'action proposal decisions must increment version exactly once';
  end if;

  if new.tenant_id <> old.tenant_id
    or new.id <> old.id
    or new.entity_id <> old.entity_id
    or new.source_battle_state_version_id <> old.source_battle_state_version_id
    or new.proposed_at <> old.proposed_at
    or new.expires_at <> old.expires_at
  then
    raise exception 'action proposal source metadata is immutable';
  end if;

  return new;
end;
$$;

create trigger action_proposals_transition_guard
before update on app.action_proposals
for each row execute function app.enforce_action_proposal_transition();

create function app.enforce_business_action_transition()
returns trigger
language plpgsql
as $$
begin
  if new.version_no <> old.version_no + 1 then
    raise exception 'business action updates must increment version exactly once';
  end if;

  if old.status in ('completed', 'cancelled') then
    raise exception 'terminal business actions are immutable';
  end if;

  if not (
    (old.status = 'planned' and new.status in ('in_progress', 'cancelled'))
    or (old.status = 'in_progress' and new.status in ('completed', 'cancelled'))
  ) then
    raise exception 'invalid business action status transition';
  end if;

  if new.tenant_id <> old.tenant_id
    or new.id <> old.id
    or new.entity_id <> old.entity_id
    or new.source_proposal_id <> old.source_proposal_id
    or new.confirmed_by <> old.confirmed_by
    or new.confirmed_at <> old.confirmed_at
    or new.created_at <> old.created_at
  then
    raise exception 'business action source metadata is immutable';
  end if;

  return new;
end;
$$;

create trigger business_actions_transition_guard
before update on app.business_actions
for each row execute function app.enforce_business_action_transition();

create function app.enforce_action_proposal_action_pair()
returns trigger
language plpgsql
as $$
declare
  target_tenant_id uuid;
  target_proposal_id uuid;
  proposal_status text;
  action_count integer;
begin
  if tg_table_name = 'action_proposals' then
    target_tenant_id := coalesce(new.tenant_id, old.tenant_id);
    target_proposal_id := coalesce(new.id, old.id);
  else
    target_tenant_id := coalesce(new.tenant_id, old.tenant_id);
    target_proposal_id := coalesce(new.source_proposal_id, old.source_proposal_id);
  end if;

  select status
    into proposal_status
  from app.action_proposals
  where tenant_id = target_tenant_id
    and id = target_proposal_id;

  select count(*)::integer
    into action_count
  from app.business_actions
  where tenant_id = target_tenant_id
    and source_proposal_id = target_proposal_id;

  if proposal_status = 'accepted' and action_count <> 1 then
    raise exception 'an accepted action proposal requires exactly one formal action';
  end if;

  if proposal_status is distinct from 'accepted' and action_count <> 0 then
    raise exception 'only an accepted action proposal may create a formal action';
  end if;

  return null;
end;
$$;

create constraint trigger action_proposals_action_pair_required
after insert or update or delete on app.action_proposals
deferrable initially deferred
for each row execute function app.enforce_action_proposal_action_pair();

create constraint trigger business_actions_proposal_pair_required
after insert or update or delete on app.business_actions
deferrable initially deferred
for each row execute function app.enforce_action_proposal_action_pair();

create function app.enforce_action_history_chain()
returns trigger
language plpgsql
as $$
declare
  previous_status text;
begin
  if new.version_no = 1 then
    if new.from_status is not null or new.to_status <> 'planned' then
      raise exception 'the initial action history entry must start at planned';
    end if;
    return null;
  end if;

  select to_status
    into previous_status
  from app.action_status_history
  where tenant_id = new.tenant_id
    and action_id = new.action_id
    and version_no = new.version_no - 1;

  if previous_status is null or previous_status <> new.from_status then
    raise exception 'action status history must form a contiguous chain';
  end if;

  return null;
end;
$$;

create constraint trigger action_status_history_chain_required
after insert on app.action_status_history
deferrable initially deferred
for each row execute function app.enforce_action_history_chain();

create function app.enforce_action_current_history()
returns trigger
language plpgsql
as $$
declare
  target_tenant_id uuid;
  target_action_id uuid;
  current_status text;
  current_version bigint;
  history_count bigint;
  matching_count bigint;
  maximum_version bigint;
begin
  if tg_table_name = 'business_actions' then
    target_tenant_id := coalesce(new.tenant_id, old.tenant_id);
    target_action_id := coalesce(new.id, old.id);
  else
    target_tenant_id := coalesce(new.tenant_id, old.tenant_id);
    target_action_id := coalesce(new.action_id, old.action_id);
  end if;

  select status, version_no
    into current_status, current_version
  from app.business_actions
  where tenant_id = target_tenant_id
    and id = target_action_id;

  if not found then
    return null;
  end if;

  select count(*)::bigint,
         count(*) filter (
           where version_no = current_version and to_status = current_status
         )::bigint,
         max(version_no)
    into history_count, matching_count, maximum_version
  from app.action_status_history
  where tenant_id = target_tenant_id
    and action_id = target_action_id;

  if history_count <> current_version
    or maximum_version <> current_version
    or matching_count <> 1
  then
    raise exception 'business action status and version require matching contiguous history';
  end if;

  return null;
end;
$$;

create constraint trigger business_actions_current_history_required
after insert or update on app.business_actions
deferrable initially deferred
for each row execute function app.enforce_action_current_history();

create constraint trigger action_status_history_current_required
after insert on app.action_status_history
deferrable initially deferred
for each row execute function app.enforce_action_current_history();

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'analysis_runs',
    'business_signals',
    'battle_state_versions',
    'battle_state_current',
    'battle_state_evidence_links',
    'action_proposals',
    'business_actions',
    'action_status_history'
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
