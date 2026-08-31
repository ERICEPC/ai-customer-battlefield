create table app.worker_heartbeats (
  tenant_id uuid not null,
  worker_key text not null,
  instance_id uuid not null,
  started_at timestamptz not null,
  expected_interval_ms integer not null,
  lease_ms integer not null,
  last_tick_started_at timestamptz,
  last_tick_completed_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_tick_summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null,
  constraint worker_heartbeats_pk primary key (tenant_id, worker_key),
  constraint worker_heartbeats_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint worker_heartbeats_key_valid
    check (worker_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint worker_heartbeats_expected_interval_valid
    check (expected_interval_ms between 10 and 300000),
  constraint worker_heartbeats_lease_valid
    check (lease_ms between 1000 and 3600000),
  constraint worker_heartbeats_summary_object
    check (jsonb_typeof(last_tick_summary) = 'object'),
  constraint worker_heartbeats_error_code_valid
    check (
      last_error_code is null
      or last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
    ),
  constraint worker_heartbeats_error_pair
    check ((last_error_code is null) = (last_error_message is null)),
  constraint worker_heartbeats_error_message_present
    check (
      last_error_message is null
      or length(btrim(last_error_message)) between 1 and 500
    ),
  constraint worker_heartbeats_tick_order
    check (
      last_tick_completed_at is null
      or last_tick_started_at is null
      or last_tick_completed_at >= last_tick_started_at
    ),
  constraint worker_heartbeats_update_order
    check (updated_at >= started_at)
);

create index worker_heartbeats_updated_idx
  on app.worker_heartbeats (tenant_id, updated_at desc, worker_key);

create table app.async_work_replay_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  work_kind text not null,
  work_item_id uuid not null,
  prior_status text not null,
  prior_attempt_count integer not null,
  prior_error_code text not null,
  prior_error_message text not null,
  reason text not null,
  idempotency_key text not null,
  request_hash text not null,
  replayed_by uuid not null,
  replayed_at timestamptz not null,
  constraint async_work_replay_history_pk primary key (tenant_id, id),
  constraint async_work_replay_history_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint async_work_replay_history_user_fk
    foreign key (tenant_id, replayed_by)
    references app.users (tenant_id, id),
  constraint async_work_replay_history_kind_valid
    check (work_kind in ('outbox', 'reminder', 'notification_delivery')),
  constraint async_work_replay_history_status_valid
    check (prior_status in ('failed', 'dead_lettered')),
  constraint async_work_replay_history_attempt_valid
    check (prior_attempt_count >= 0),
  constraint async_work_replay_history_error_code_valid
    check (prior_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  constraint async_work_replay_history_error_message_present
    check (length(btrim(prior_error_message)) between 1 and 500),
  constraint async_work_replay_history_reason_present
    check (length(btrim(reason)) between 1 and 1000),
  constraint async_work_replay_history_key_valid
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  constraint async_work_replay_history_hash_valid
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint async_work_replay_history_key_unique
    unique (tenant_id, idempotency_key)
);

create index async_work_replay_history_item_idx
  on app.async_work_replay_history (
    tenant_id, work_kind, work_item_id, replayed_at desc, id desc
  );

create function app.reject_async_work_replay_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'async-work replay history rows are immutable';
end;
$$;

create trigger async_work_replay_history_immutable
before update or delete on app.async_work_replay_history
for each row execute function app.reject_async_work_replay_history_mutation();

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'worker_heartbeats',
    'async_work_replay_history'
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
