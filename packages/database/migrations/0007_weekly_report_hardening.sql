create function app.reject_weekly_report_series_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'weekly report series identity is immutable';
end;
$$;

create trigger weekly_reports_immutable
before update or delete on app.weekly_reports
for each row execute function app.reject_weekly_report_series_mutation();

alter table app.weekly_report_items
  add column entity_name text;

update app.weekly_report_items as report_item
set entity_name = entity.name
from app.business_entities as entity
where entity.tenant_id = report_item.tenant_id
  and entity.id = report_item.entity_id;

alter table app.weekly_report_items
  alter column entity_name set not null,
  add constraint weekly_report_items_entity_name_present
    check (length(btrim(entity_name)) > 0 and length(entity_name) <= 300);

create or replace function app.guard_weekly_report_child_insert()
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
  if parent_status <> 'draft' then
    raise exception 'weekly report snapshot rows may be assembled only while draft';
  end if;
  return new;
end;
$$;

create or replace function app.guard_weekly_report_item_child_insert()
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
  if parent_status <> 'draft' then
    raise exception 'weekly report snapshot rows may be assembled only while draft';
  end if;
  return new;
end;
$$;

create or replace function app.guard_weekly_report_item_mutation()
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
    or old.entity_name is distinct from new.entity_name
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
