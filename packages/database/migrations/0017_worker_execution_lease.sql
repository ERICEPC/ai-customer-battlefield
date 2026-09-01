create table app.worker_execution_leases (
  tenant_id uuid not null,
  worker_key text not null,
  instance_id uuid not null,
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  constraint worker_execution_leases_pk primary key (tenant_id, worker_key),
  constraint worker_execution_leases_tenant_fk
    foreign key (tenant_id) references app.tenants (id),
  constraint worker_execution_leases_key_valid
    check (worker_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint worker_execution_leases_renew_order
    check (renewed_at >= acquired_at),
  constraint worker_execution_leases_expiry_order
    check (lease_expires_at > renewed_at)
);

create index worker_execution_leases_expiry_idx
  on app.worker_execution_leases (tenant_id, lease_expires_at, worker_key);

alter table app.worker_execution_leases enable row level security;
alter table app.worker_execution_leases force row level security;

create policy worker_execution_leases_tenant_isolation
  on app.worker_execution_leases
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
