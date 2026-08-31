create schema if not exists app_auth;

revoke all on schema app_auth from public;

create table app_auth.tenant_login_directory (
  tenant_id uuid primary key,
  slug text not null,
  constraint tenant_login_directory_tenant_fk
    foreign key (tenant_id)
    references app.tenants (id)
    on delete cascade,
  constraint tenant_login_directory_slug_lowercase
    check (slug = lower(slug)),
  constraint tenant_login_directory_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  constraint tenant_login_directory_slug_unique unique (slug)
);

revoke all on app_auth.tenant_login_directory from public;

insert into app_auth.tenant_login_directory (tenant_id, slug)
select id, slug
from app.tenants
where status = 'active';

create or replace function app_auth.sync_tenant_login_directory()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app, app_auth
as $$
begin
  if tg_op = 'DELETE' then
    delete from app_auth.tenant_login_directory
    where tenant_id = old.id;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.id <> new.id then
    delete from app_auth.tenant_login_directory
    where tenant_id = old.id;
  end if;

  if new.status = 'active' then
    insert into app_auth.tenant_login_directory (tenant_id, slug)
    values (new.id, new.slug)
    on conflict (tenant_id) do update
    set slug = excluded.slug;
  else
    delete from app_auth.tenant_login_directory
    where tenant_id = new.id;
  end if;

  return new;
end
$$;

revoke all on function app_auth.sync_tenant_login_directory() from public;

create trigger tenants_login_directory_sync
after insert or update of id, slug, status or delete
on app.tenants
for each row
execute function app_auth.sync_tenant_login_directory();

create or replace function app.resolve_active_tenant_id(login_slug text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, app_auth
as $$
  select tenant_id
  from app_auth.tenant_login_directory
  where slug = lower(btrim(login_slug))
  limit 1
$$;

revoke all on function app.resolve_active_tenant_id(text) from public;
