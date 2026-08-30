alter table app.channel_addresses
  add constraint channel_addresses_identity_channel_unique
  unique (tenant_id, id, channel),
  add constraint channel_addresses_identity_channel_user_unique
  unique (tenant_id, id, channel, user_id);

alter table app.outbox_messages
  drop constraint outbox_messages_status_valid,
  drop constraint outbox_messages_published_state,
  add column claim_token uuid,
  add column last_error_code text;

drop index app.outbox_messages_claim_idx;

alter table app.outbox_messages
  add constraint outbox_messages_status_valid
    check (status in (
      'pending', 'processing', 'published', 'failed', 'cancelled',
      'dead_lettered'
    )),
  add constraint outbox_messages_error_code_valid
    check (
      last_error_code is null
      or last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
    ),
  add constraint outbox_messages_published_state
    check ((status = 'published') = (published_at is not null)),
  add constraint outbox_messages_claim_state check (
    (
      status = 'processing'
      and claimed_at is not null
      and claim_token is not null
    ) or (
      status <> 'processing'
      and claimed_at is null
      and claim_token is null
    )
  ),
  add constraint outbox_messages_failure_state check (
    (
      status in ('failed', 'dead_lettered')
      and last_error_code is not null
      and last_error is not null
    ) or (
      status not in ('failed', 'dead_lettered')
      and last_error_code is null
      and last_error is null
    )
  );

create index outbox_messages_claim_idx
  on app.outbox_messages (tenant_id, status, available_at, id)
  where status in ('pending', 'failed');

create table app.reminder_policy_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  policy_key text not null,
  version_no bigint not null,
  name text not null,
  status text not null,
  nodes jsonb not null,
  effective_at timestamptz not null,
  published_by uuid not null,
  created_at timestamptz not null default now(),
  constraint reminder_policy_versions_pk primary key (tenant_id, id),
  constraint reminder_policy_versions_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint reminder_policy_versions_user_fk
    foreign key (tenant_id, published_by)
    references app.users (tenant_id, id),
  constraint reminder_policy_versions_number_unique
    unique (tenant_id, policy_key, version_no),
  constraint reminder_policy_versions_key_valid
    check (policy_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint reminder_policy_versions_number_positive check (version_no > 0),
  constraint reminder_policy_versions_name_present
    check (length(btrim(name)) > 0),
  constraint reminder_policy_versions_status_valid
    check (status in ('draft', 'published', 'retired')),
  constraint reminder_policy_versions_nodes_array
    check (jsonb_typeof(nodes) = 'array' and jsonb_array_length(nodes) > 0)
);

create unique index reminder_policy_versions_published_unique_idx
  on app.reminder_policy_versions (tenant_id, policy_key)
  where status = 'published';

create index reminder_policy_versions_publisher_idx
  on app.reminder_policy_versions (tenant_id, published_by, created_at desc);

create table app.notification_template_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  template_key text not null,
  channel text not null,
  version_no bigint not null,
  name text not null,
  status text not null,
  title_template text not null,
  body_template text not null,
  deep_link_template text not null,
  priority text not null,
  effective_at timestamptz not null,
  published_by uuid not null,
  created_at timestamptz not null default now(),
  constraint notification_template_versions_pk primary key (tenant_id, id),
  constraint notification_template_versions_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint notification_template_versions_user_fk
    foreign key (tenant_id, published_by)
    references app.users (tenant_id, id),
  constraint notification_template_versions_number_unique
    unique (tenant_id, template_key, channel, version_no),
  constraint notification_template_versions_key_valid
    check (template_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint notification_template_versions_channel_valid
    check (channel in ('in_app', 'feishu', 'email')),
  constraint notification_template_versions_number_positive
    check (version_no > 0),
  constraint notification_template_versions_name_present
    check (length(btrim(name)) > 0),
  constraint notification_template_versions_status_valid
    check (status in ('draft', 'published', 'retired')),
  constraint notification_template_versions_title_present
    check (
      length(btrim(title_template)) > 0
      and length(title_template) <= 200
    ),
  constraint notification_template_versions_body_present
    check (
      length(btrim(body_template)) > 0
      and length(body_template) <= 2000
    ),
  constraint notification_template_versions_deep_link_safe
    check (
      length(deep_link_template) <= 2000
      and left(deep_link_template, 1) = '/'
      and left(deep_link_template, 2) <> '//'
      and position(chr(10) in deep_link_template) = 0
      and position(chr(13) in deep_link_template) = 0
    ),
  constraint notification_template_versions_priority_valid
    check (priority in ('low', 'medium', 'high', 'urgent'))
);

create unique index notification_template_versions_published_unique_idx
  on app.notification_template_versions (tenant_id, template_key, channel)
  where status = 'published';

create index notification_template_versions_publisher_idx
  on app.notification_template_versions (
    tenant_id, published_by, created_at desc
  );

create table app.reminder_instances (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  action_id uuid not null,
  recipient_user_id uuid not null,
  policy_version_id uuid not null,
  action_version_no bigint not null,
  kind text not null,
  remind_at timestamptz not null,
  channels jsonb not null,
  status text not null default 'scheduled',
  available_at timestamptz not null,
  attempt_count integer not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  notification_event_id uuid,
  dedupe_key text not null,
  last_error_code text,
  last_error_message text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminder_instances_pk primary key (tenant_id, id),
  constraint reminder_instances_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint reminder_instances_action_fk
    foreign key (tenant_id, action_id)
    references app.business_actions (tenant_id, id),
  constraint reminder_instances_recipient_fk
    foreign key (tenant_id, recipient_user_id)
    references app.users (tenant_id, id),
  constraint reminder_instances_policy_fk
    foreign key (tenant_id, policy_version_id)
    references app.reminder_policy_versions (tenant_id, id),
  constraint reminder_instances_dedupe_unique unique (tenant_id, dedupe_key),
  constraint reminder_instances_notification_unique
    unique (tenant_id, notification_event_id),
  constraint reminder_instances_action_version_positive
    check (action_version_no > 0),
  constraint reminder_instances_kind_valid
    check (kind in ('advance', 'due', 'overdue', 'escalation')),
  constraint reminder_instances_channels_array
    check (jsonb_typeof(channels) = 'array' and jsonb_array_length(channels) > 0),
  constraint reminder_instances_status_valid
    check (status in (
      'scheduled', 'processing', 'notified', 'failed', 'cancelled',
      'dead_lettered'
    )),
  constraint reminder_instances_dedupe_present
    check (length(btrim(dedupe_key)) > 0),
  constraint reminder_instances_attempt_non_negative check (attempt_count >= 0),
  constraint reminder_instances_error_code_valid
    check (
      last_error_code is null
      or last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
    ),
  constraint reminder_instances_error_message_present
    check (
      last_error_message is null
      or length(btrim(last_error_message)) > 0
    ),
  constraint reminder_instances_claim_state check (
    (
      status = 'processing'
      and claimed_at is not null
      and claim_token is not null
    ) or (
      status <> 'processing'
      and claimed_at is null
      and claim_token is null
    )
  ),
  constraint reminder_instances_notification_state
    check ((status = 'notified') = (notification_event_id is not null)),
  constraint reminder_instances_failure_state check (
    (
      status in ('failed', 'dead_lettered')
      and last_error_code is not null
      and last_error_message is not null
    ) or (
      status not in ('failed', 'dead_lettered')
      and last_error_code is null
      and last_error_message is null
    )
  ),
  constraint reminder_instances_cancelled_state
    check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint reminder_instances_update_order check (updated_at >= created_at)
);

create index reminder_instances_claim_idx
  on app.reminder_instances (tenant_id, status, available_at, id)
  where status in ('scheduled', 'failed');

create index reminder_instances_action_idx
  on app.reminder_instances (tenant_id, action_id, status, remind_at, id);

create index reminder_instances_recipient_idx
  on app.reminder_instances (
    tenant_id, recipient_user_id, status, remind_at, id
  );

create index reminder_instances_policy_idx
  on app.reminder_instances (tenant_id, policy_version_id, id);

create table app.notification_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  recipient_user_id uuid not null,
  reminder_id uuid not null,
  event_type text not null,
  title text not null,
  body text not null,
  deep_link text not null,
  priority text not null,
  read_at timestamptz,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  constraint notification_events_pk primary key (tenant_id, id),
  constraint notification_events_recipient_identity_unique
    unique (tenant_id, id, recipient_user_id),
  constraint notification_events_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint notification_events_recipient_fk
    foreign key (tenant_id, recipient_user_id)
    references app.users (tenant_id, id),
  constraint notification_events_reminder_fk
    foreign key (tenant_id, reminder_id)
    references app.reminder_instances (tenant_id, id),
  constraint notification_events_reminder_unique unique (tenant_id, reminder_id),
  constraint notification_events_dedupe_unique unique (tenant_id, dedupe_key),
  constraint notification_events_type_valid check (event_type = 'action_due'),
  constraint notification_events_title_present
    check (length(btrim(title)) > 0 and length(title) <= 200),
  constraint notification_events_body_present
    check (length(btrim(body)) > 0 and length(body) <= 2000),
  constraint notification_events_deep_link_safe check (
    length(deep_link) <= 2000
    and left(deep_link, 1) = '/'
    and left(deep_link, 2) <> '//'
    and position(chr(10) in deep_link) = 0
    and position(chr(13) in deep_link) = 0
  ),
  constraint notification_events_priority_valid
    check (priority in ('low', 'medium', 'high', 'urgent')),
  constraint notification_events_dedupe_present
    check (length(btrim(dedupe_key)) > 0),
  constraint notification_events_read_order
    check (read_at is null or read_at >= created_at)
);

alter table app.reminder_instances
  add constraint reminder_instances_notification_fk
  foreign key (tenant_id, notification_event_id)
  references app.notification_events (tenant_id, id);

create index notification_events_recipient_unread_idx
  on app.notification_events (
    tenant_id, recipient_user_id, read_at, created_at desc, id desc
  );

create table app.notification_deliveries (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  notification_event_id uuid not null,
  recipient_user_id uuid not null,
  channel text not null,
  address_id uuid,
  status text not null default 'pending',
  dedupe_key text not null,
  available_at timestamptz not null,
  attempt_count integer not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  delivered_at timestamptz,
  provider_message_id text,
  provider_request_id text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_pk primary key (tenant_id, id),
  constraint notification_deliveries_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint notification_deliveries_event_fk
    foreign key (tenant_id, notification_event_id, recipient_user_id)
    references app.notification_events (tenant_id, id, recipient_user_id),
  constraint notification_deliveries_address_channel_fk
    foreign key (tenant_id, address_id, channel, recipient_user_id)
    references app.channel_addresses (tenant_id, id, channel, user_id),
  constraint notification_deliveries_event_channel_unique
    unique (tenant_id, notification_event_id, channel),
  constraint notification_deliveries_dedupe_unique unique (tenant_id, dedupe_key),
  constraint notification_deliveries_channel_valid
    check (channel in ('in_app', 'feishu', 'email')),
  constraint notification_deliveries_address_state check (
    (channel = 'in_app' and address_id is null)
    or (channel in ('feishu', 'email') and address_id is not null)
  ),
  constraint notification_deliveries_status_valid
    check (status in (
      'pending', 'processing', 'delivered', 'failed', 'cancelled',
      'dead_lettered'
    )),
  constraint notification_deliveries_dedupe_present
    check (length(btrim(dedupe_key)) > 0),
  constraint notification_deliveries_attempt_non_negative
    check (attempt_count >= 0),
  constraint notification_deliveries_claim_state check (
    (
      status = 'processing'
      and claimed_at is not null
      and claim_token is not null
    ) or (
      status <> 'processing'
      and claimed_at is null
      and claim_token is null
    )
  ),
  constraint notification_deliveries_delivered_state
    check ((status = 'delivered') = (delivered_at is not null)),
  constraint notification_deliveries_provider_state check (
    (
      status = 'delivered'
      and channel in ('feishu', 'email')
      and provider_message_id is not null
    ) or (
      status = 'delivered'
      and channel = 'in_app'
      and provider_message_id is null
      and provider_request_id is null
    ) or (
      status <> 'delivered'
      and provider_message_id is null
      and provider_request_id is null
    )
  ),
  constraint notification_deliveries_error_code_valid
    check (
      last_error_code is null
      or last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
    ),
  constraint notification_deliveries_error_message_present
    check (
      last_error_message is null
      or length(btrim(last_error_message)) > 0
    ),
  constraint notification_deliveries_failure_state check (
    (
      status in ('failed', 'dead_lettered')
      and last_error_code is not null
      and last_error_message is not null
    ) or (
      status not in ('failed', 'dead_lettered')
      and last_error_code is null
      and last_error_message is null
    )
  ),
  constraint notification_deliveries_delivery_order
    check (delivered_at is null or delivered_at >= created_at),
  constraint notification_deliveries_update_order check (updated_at >= created_at)
);

create index notification_deliveries_claim_idx
  on app.notification_deliveries (tenant_id, status, available_at, id)
  where status in ('pending', 'failed');

create index notification_deliveries_address_idx
  on app.notification_deliveries (
    tenant_id, address_id, recipient_user_id, status, id
  )
  where address_id is not null;

create function app.reject_published_notification_config_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'published' then
    raise exception 'published % versions are immutable', tg_table_name;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger reminder_policy_versions_published_immutable
before update or delete on app.reminder_policy_versions
for each row execute function app.reject_published_notification_config_mutation();

create trigger notification_template_versions_published_immutable
before update or delete on app.notification_template_versions
for each row execute function app.reject_published_notification_config_mutation();

insert into app.reminder_policy_versions (
  tenant_id, policy_key, version_no, name, status, nodes, effective_at,
  published_by
)
select
  tenant.id,
  'default_action_due',
  1,
  '默认动作到期提醒',
  'published',
  '[{"kind":"due","offsetMinutes":0,"recipient":"owner","channels":["in_app","feishu"]}]'::jsonb,
  now(),
  publisher.id
from app.tenants as tenant
join lateral (
  select app_user.id
  from app.users as app_user
  where app_user.tenant_id = tenant.id and app_user.status = 'active'
  order by app_user.created_at, app_user.id
  limit 1
) as publisher on true;

insert into app.notification_template_versions (
  tenant_id, template_key, channel, version_no, name, status, title_template,
  body_template, deep_link_template, priority, effective_at, published_by
)
select
  tenant.id,
  'action_due',
  template.channel,
  1,
  template.name,
  'published',
  '经营动作已到计划时间',
  '{{action_title}} 已到计划时间，请及时推进。',
  '/actions?actionId={{action_id}}',
  'high',
  now(),
  publisher.id
from app.tenants as tenant
join lateral (
  select app_user.id
  from app.users as app_user
  where app_user.tenant_id = tenant.id and app_user.status = 'active'
  order by app_user.created_at, app_user.id
  limit 1
) as publisher on true
cross join (
  values
    ('in_app'::text, '动作到期站内通知'::text),
    ('feishu'::text, '动作到期飞书通知'::text)
) as template(channel, name);

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'reminder_policy_versions',
    'reminder_instances',
    'notification_template_versions',
    'notification_events',
    'notification_deliveries'
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
