create table app.user_ai_settings (
  tenant_id uuid not null,
  user_id uuid not null,
  provider text not null default 'senseaudio',
  model_id text not null default 'senseaudio-s2-flash',
  api_key_ciphertext text,
  api_key_iv text,
  api_key_auth_tag text,
  api_key_last_four text,
  version_no bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_ai_settings_pk primary key (tenant_id, user_id),
  constraint user_ai_settings_user_fk
    foreign key (tenant_id, user_id)
    references app.users (tenant_id, id),
  constraint user_ai_settings_provider_supported
    check (provider = 'senseaudio'),
  constraint user_ai_settings_model_present
    check (length(btrim(model_id)) between 1 and 200),
  constraint user_ai_settings_version_positive
    check (version_no > 0),
  constraint user_ai_settings_key_fields_consistent
    check (
      num_nonnulls(
        api_key_ciphertext,
        api_key_iv,
        api_key_auth_tag,
        api_key_last_four
      ) = 0
      or
      (
        num_nonnulls(
          api_key_ciphertext,
          api_key_iv,
          api_key_auth_tag,
          api_key_last_four
        ) = 4
        and
        length(api_key_ciphertext) between 1 and 5000
        and length(api_key_iv) between 1 and 200
        and length(api_key_auth_tag) between 1 and 200
        and length(api_key_last_four) = 4
      )
    )
);

alter table app.user_ai_settings enable row level security;
alter table app.user_ai_settings force row level security;

create policy user_ai_settings_tenant_isolation on app.user_ai_settings
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
