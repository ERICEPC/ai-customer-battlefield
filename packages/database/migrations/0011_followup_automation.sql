create unique index analysis_runs_trigger_event_terminal_unique_idx
  on app.analysis_runs (tenant_id, trigger_event_id)
  where trigger_event_id is not null
    and status in ('completed', 'superseded');

alter table app.notification_events
  drop constraint notification_events_type_valid,
  drop constraint notification_events_source_valid,
  add column followup_id uuid,
  add column battle_state_version_id uuid,
  add constraint notification_events_followup_fk
    foreign key (tenant_id, followup_id)
    references app.followups (tenant_id, id),
  add constraint notification_events_battle_state_version_fk
    foreign key (tenant_id, battle_state_version_id)
    references app.battle_state_versions (tenant_id, id),
  add constraint notification_events_type_valid check (
    event_type in (
      'action_due',
      'weekly_report_published',
      'sales_progress_updated'
    )
  ),
  add constraint notification_events_source_valid check (
    (
      event_type = 'action_due'
      and reminder_id is not null
      and report_version_id is null
      and followup_id is null
      and battle_state_version_id is null
    ) or (
      event_type = 'weekly_report_published'
      and reminder_id is null
      and report_version_id is not null
      and followup_id is null
      and battle_state_version_id is null
    ) or (
      event_type = 'sales_progress_updated'
      and reminder_id is null
      and report_version_id is null
      and followup_id is not null
      and battle_state_version_id is not null
    )
  );

create index notification_events_followup_idx
  on app.notification_events (tenant_id, followup_id)
  where followup_id is not null;

create index notification_events_battle_state_version_idx
  on app.notification_events (tenant_id, battle_state_version_id)
  where battle_state_version_id is not null;
