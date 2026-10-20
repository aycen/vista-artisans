-- QuickBooks Online: each company links its own QuickBooks. Keystone pushes clients (as customers),
-- jobs (as invoices) and payments (applied to those invoices). It never reads or changes anything else there.
-- Tokens are written and read only by the app server (as the database owner); admins see status through qbo_status().
create table qbo_connections (
  org_id uuid primary key references organizations(id) on delete cascade,
  realm_id text not null,
  company_name text not null default '',
  access_token text not null,
  refresh_token text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  item_id text,                                  -- the "Keystone job" service item used on invoice lines
  sync_from date not null default current_date,  -- only jobs and payments from this date on are sent
  last_synced_at timestamptz,
  last_error text not null default '',
  connected_at timestamptz not null default now()
);
alter table qbo_connections enable row level security;
revoke all on qbo_connections from anon, authenticated;

-- What has been sent, per QuickBooks company, so nothing is sent twice.
create table qbo_links (
  org_id uuid not null references organizations(id) on delete cascade,
  realm_id text not null,
  kind text not null check (kind in ('client', 'job', 'payment')),
  local_id bigint not null,
  qbo_id text not null,
  synced_at timestamptz not null default now(),
  primary key (org_id, realm_id, kind, local_id)
);
alter table qbo_links enable row level security;
create policy org_rows on qbo_links for select to authenticated using (is_admin(org_id));
grant select on qbo_links to authenticated;
revoke all on qbo_links from anon;

create function qbo_status(p_org uuid)
returns table (realm_id text, company_name text, connected_at timestamptz, last_synced_at timestamptz, last_error text,
               sync_from date, synced_jobs bigint, synced_payments bigint)
language sql stable security definer set search_path = public as $$
  select c.realm_id, c.company_name, c.connected_at, c.last_synced_at, c.last_error, c.sync_from,
    (select count(*) from qbo_links l where l.org_id = c.org_id and l.realm_id = c.realm_id and l.kind = 'job'),
    (select count(*) from qbo_links l where l.org_id = c.org_id and l.realm_id = c.realm_id and l.kind = 'payment')
  from qbo_connections c where c.org_id = p_org and is_admin(p_org);
$$;
revoke execute on function qbo_status(uuid) from public, anon;
grant execute on function qbo_status(uuid) to authenticated;
