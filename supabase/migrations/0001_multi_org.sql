-- Vista Artisans: multi-user, multi-organization schema for Supabase (Postgres).
-- Every business record belongs to an organization. Row Level Security lets a signed-in
-- user reach only rows of organizations they are a member of. Admins manage all business data;
-- workers see only the job schedule, address and scope of work (through worker_schedule()).
-- Money is bigint cents; quantities are bigint hundredths. Errors meant for app users use SQLSTATE VA001.

create extension if not exists pgcrypto;

-- ---------- Organizations and membership ----------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 200),
  created_at timestamptz not null default now()
);

create table memberships (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'worker' check (role in ('admin', 'worker')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on memberships(user_id);

-- security definer so policies can check membership without recursing through memberships' own RLS
create function is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where org_id = p_org and user_id = auth.uid());
$$;

create function is_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where org_id = p_org and user_id = auth.uid() and role = 'admin');
$$;

-- Creating an organization also makes the caller its admin (one atomic step).
create function create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in.' using errcode = 'VA001'; end if;
  insert into organizations (name) values (p_name) returning id into v_org;
  insert into memberships (org_id, user_id, role) values (v_org, auth.uid(), 'admin');
  return v_org;
end $$;

-- ---------- Business tables ----------
-- unique (id, org_id) on parents + composite foreign keys on children make it impossible
-- to attach a record to a parent that belongs to a different organization.

create table clients (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  phone text not null default '' check (length(phone) <= 50),
  email text not null default '' check (length(email) <= 200),
  address text not null default '' check (length(address) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create index clients_org_name_idx on clients(org_id, lower(name));

create table estimates (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  client_id bigint not null,
  project_name text not null check (length(trim(project_name)) between 1 and 200),
  scope text not null default '',
  estimated_cost_cents bigint check (estimated_cost_cents is null or estimated_cost_cents >= 0),
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  -- deleting a client deletes its estimates; converted estimates (and the client's jobs) block the delete
  foreign key (client_id, org_id) references clients(id, org_id) on delete cascade
);
create index estimates_org_idx on estimates(org_id, status);

create table line_items (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  estimate_id bigint not null,
  position int not null,
  description text not null check (length(trim(description)) between 1 and 500),
  qty_hundredths bigint not null check (qty_hundredths > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  line_total_cents bigint generated always as ((qty_hundredths * unit_price_cents + 50) / 100) stored,
  foreign key (estimate_id, org_id) references estimates(id, org_id) on delete cascade
);
create index line_items_estimate_idx on line_items(estimate_id);

create table jobs (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  estimate_id bigint not null unique,           -- one job per estimate, enforced by the database
  client_id bigint not null,
  project_name text not null,
  address text not null,
  scope text not null,
  contract_cents bigint not null check (contract_cents >= 0),
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  scheduled_date date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (estimate_id, org_id) references estimates(id, org_id),
  foreign key (client_id, org_id) references clients(id, org_id)
);
create index jobs_org_idx on jobs(org_id, status);

create table expenses (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  description text not null check (length(trim(description)) between 1 and 500),
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index expenses_job_idx on expenses(job_id);

create table payments (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  created_at timestamptz not null default now(),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index payments_job_idx on payments(job_id);

-- ---------- Locking converted estimates ----------
create function prevent_converted_estimate_change() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from jobs where estimate_id = old.id) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;

create function prevent_converted_line_item_change() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from jobs where estimate_id in (
      case when tg_op = 'INSERT' then null else old.estimate_id end,
      case when tg_op = 'DELETE' then null else new.estimate_id end)) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;

create trigger estimates_locked before update or delete on estimates
  for each row execute function prevent_converted_estimate_change();
create trigger line_items_locked before insert or update or delete on line_items
  for each row execute function prevent_converted_line_item_change();

-- ---------- Totals (security_invoker so RLS of the caller applies) ----------
create view estimate_totals with (security_invoker = true) as
  select e.id as estimate_id, e.org_id, coalesce(sum(li.line_total_cents), 0)::bigint as total_cents
  from estimates e left join line_items li on li.estimate_id = e.id
  group by e.id, e.org_id;

create view job_totals with (security_invoker = true) as
  select j.id as job_id, j.org_id, j.contract_cents,
    coalesce((select sum(amount_cents) from expenses x where x.job_id = j.id), 0)::bigint as expenses_cents,
    coalesce((select sum(amount_cents) from payments p where p.job_id = j.id), 0)::bigint as payments_cents
  from jobs j;

-- ---------- Convert estimate to job (idempotent: repeat calls return the same job) ----------
create function convert_estimate_to_job(p_estimate bigint) returns bigint
language plpgsql security invoker set search_path = public as $$
declare e estimates; c clients; v_job bigint; v_total bigint;
begin
  select * into e from estimates where id = p_estimate for update;  -- RLS applies: other orgs see nothing
  if not found then raise exception 'Estimate not found.' using errcode = 'VA001'; end if;
  select id into v_job from jobs where estimate_id = p_estimate;
  if v_job is not null then return v_job; end if;
  if e.status <> 'approved' then raise exception 'Only approved estimates can be converted to a job.' using errcode = 'VA001'; end if;
  select * into c from clients where id = e.client_id;
  select total_cents into v_total from estimate_totals where estimate_id = p_estimate;
  insert into jobs (org_id, estimate_id, client_id, project_name, address, scope, contract_cents)
    values (e.org_id, e.id, c.id, e.project_name, c.address, e.scope, v_total)
    on conflict (estimate_id) do nothing
    returning id into v_job;
  if v_job is null then select id into v_job from jobs where estimate_id = p_estimate; end if;
  return v_job;
end $$;

-- ---------- Row Level Security ----------
alter table organizations enable row level security;
alter table memberships enable row level security;
alter table clients enable row level security;
alter table estimates enable row level security;
alter table line_items enable row level security;
alter table jobs enable row level security;
alter table expenses enable row level security;
alter table payments enable row level security;

create policy org_read on organizations for select to authenticated using (is_member(id));
create policy org_rename on organizations for update to authenticated using (is_admin(id)) with check (is_admin(id));

create policy members_read on memberships for select to authenticated using (is_member(org_id));
-- memberships change only through the team functions in 0002 (they keep at least one admin)

create policy org_rows on clients    for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy org_rows on estimates  for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy org_rows on line_items for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy org_rows on jobs       for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy org_rows on expenses   for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy org_rows on payments   for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on function is_member(uuid), is_admin(uuid), create_organization(text), convert_estimate_to_job(bigint) to authenticated;
grant select, insert, update, delete on clients, estimates, line_items, jobs, expenses, payments to authenticated;
grant select on memberships to authenticated;
grant select, update on organizations to authenticated;
grant select on estimate_totals, job_totals to authenticated;
