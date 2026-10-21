-- Vista Artisans: complete database setup for a NEW Supabase project.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run. Run it once.
-- (Generated from the files in supabase/migrations/, in order. If you already ran an earlier setup.sql,
-- run only the migration files you have not run yet instead.)

begin;
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

-- Team management and the worker view.
-- Admins add people who already have an account, change their role, or remove them.
-- An organization always keeps at least one admin.
-- Errors meant for the person using the app use SQLSTATE VA001.

-- Members of an organization with their email (auth.users is not readable by app users directly).
create function org_members(p_org uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from memberships m join auth.users u on u.id = m.user_id
  where m.org_id = p_org and is_member(p_org)
  order by m.created_at;
$$;

create function add_member_by_email(p_org uuid, p_email text, p_role text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not is_admin(p_org) then raise exception 'Only an admin can add people.' using errcode = 'VA001'; end if;
  if p_role not in ('admin', 'worker') then raise exception 'Choose Admin or Worker.' using errcode = 'VA001'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No account uses that email yet. Ask them to sign up first, then add them.' using errcode = 'VA001';
  end if;
  if exists (select 1 from memberships where org_id = p_org and user_id = v_user) then
    raise exception 'That person is already on this team. Change their role instead.' using errcode = 'VA001';
  end if;
  insert into memberships (org_id, user_id, role) values (p_org, v_user, p_role);
  return v_user;
end $$;

create function set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'Only an admin can change roles.' using errcode = 'VA001'; end if;
  if p_role not in ('admin', 'worker') then raise exception 'Choose Admin or Worker.' using errcode = 'VA001'; end if;
  perform 1 from memberships where org_id = p_org for update;  -- serialize team changes
  if p_role = 'worker' and not exists (select 1 from memberships where org_id = p_org and role = 'admin' and user_id <> p_user) then
    raise exception 'The team needs at least one admin. Make someone else an admin first.' using errcode = 'VA001';
  end if;
  update memberships set role = p_role where org_id = p_org and user_id = p_user;
end $$;

create function remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'Only an admin can remove people.' using errcode = 'VA001'; end if;
  if p_user = auth.uid() then raise exception 'You cannot remove yourself.' using errcode = 'VA001'; end if;
  perform 1 from memberships where org_id = p_org for update;
  if not exists (select 1 from memberships where org_id = p_org and role = 'admin' and user_id <> p_user) then
    raise exception 'The team needs at least one admin. Make someone else an admin first.' using errcode = 'VA001';
  end if;
  delete from memberships where org_id = p_org and user_id = p_user;
end $$;

-- What a worker may see: open jobs' schedule, address and scope of work, with no money. Admins get the same list.
create function worker_schedule(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text,
               status text, scheduled_date date, notes text)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.scheduled_date, j.notes
  from jobs j join clients c on c.id = j.client_id
  where j.org_id = p_org and is_member(p_org) and j.status <> 'completed'
  order by j.scheduled_date nulls last, j.id;
$$;

revoke execute on function org_members(uuid), add_member_by_email(uuid, text, text), set_member_role(uuid, uuid, text),
  remove_member(uuid, uuid), worker_schedule(uuid) from anon, public;
grant execute on function org_members(uuid), add_member_by_email(uuid, text, text), set_member_role(uuid, uuid, text),
  remove_member(uuid, uuid), worker_schedule(uuid) to authenticated;

-- Worker payouts: admins assign people to a job with the amount they will be paid for it.
-- Workers see only the jobs they are assigned to, with their own payout. Payouts count as job costs.
-- Payouts are records only; nothing is paid through the app.

create table job_assignments (
  org_id uuid not null,
  job_id bigint not null,
  user_id uuid not null references auth.users(id),
  payout_cents bigint not null check (payout_cents >= 0 and payout_cents <= 10000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, user_id),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index job_assignments_user_idx on job_assignments(user_id);

-- Only people on the organization's team can be assigned. (Removing someone from the team later
-- keeps their payout records, so job costs stay complete.)
create function check_assignment_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from memberships where org_id = new.org_id and user_id = new.user_id) then
    raise exception 'That person is not on this team.' using errcode = 'VA001';
  end if;
  return new;
end $$;
create trigger job_assignments_member before insert or update on job_assignments
  for each row execute function check_assignment_member();

alter table job_assignments enable row level security;
create policy org_rows on job_assignments for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on job_assignments to authenticated;
revoke all on job_assignments from anon;

-- Job totals now include payouts.
drop view job_totals;
create view job_totals with (security_invoker = true) as
  select j.id as job_id, j.org_id, j.contract_cents,
    coalesce((select sum(amount_cents) from expenses x where x.job_id = j.id), 0)::bigint as expenses_cents,
    coalesce((select sum(amount_cents) from payments p where p.job_id = j.id), 0)::bigint as payments_cents,
    coalesce((select sum(payout_cents) from job_assignments a where a.job_id = j.id), 0)::bigint as payouts_cents
  from jobs j;
grant select on job_totals to authenticated;
revoke all on job_totals from anon;

-- Assignment list with emails, for admins.
create function job_team(p_job bigint)
returns table (user_id uuid, email text, role text, payout_cents bigint)
language sql stable security definer set search_path = public as $$
  select a.user_id, u.email::text, coalesce(m.role, 'removed'), a.payout_cents
  from job_assignments a
  join auth.users u on u.id = a.user_id
  left join memberships m on m.org_id = a.org_id and m.user_id = a.user_id
  where a.job_id = p_job and is_admin(a.org_id)
  order by u.email;
$$;

-- The schedule: workers see open jobs assigned to them, with their own payout.
-- Admins see every open job (my_payout_cents is their own payout if they are assigned, otherwise null).
drop function worker_schedule(uuid);
create function worker_schedule(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text,
               status text, scheduled_date date, notes text, my_payout_cents bigint)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.scheduled_date, j.notes, a.payout_cents
  from jobs j
  join clients c on c.id = j.client_id
  left join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
  where j.org_id = p_org and is_member(p_org) and j.status <> 'completed'
    and (is_admin(p_org) or a.user_id is not null)
  order by j.scheduled_date nulls last, j.id;
$$;

revoke execute on function job_team(bigint), worker_schedule(uuid), check_assignment_member() from anon, public;
grant execute on function job_team(bigint), worker_schedule(uuid) to authenticated;

-- 1. Join codes: people join an existing organization by typing its code instead of creating their own.
--    Joining with a code makes you a worker; an admin can promote you on the Team page.
-- 2. Jobs get a start date and an optional end date (the old single scheduled date becomes the start date).

-- ---------- Join codes ----------
-- 8 characters without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX.
create function new_join_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text := '';
  b bytea := uuid_send(gen_random_uuid()); -- core Postgres randomness, no extension needed
begin
  for i in 0..7 loop
    -- skip bytes 6 and 8, which hold the UUID's fixed version and variant bits
    code := code || substr(alphabet, (get_byte(b, (array[0, 1, 2, 3, 4, 5, 9, 10])[i + 1]) % length(alphabet)) + 1, 1);
  end loop;
  return code;
end $$;

alter table organizations add column join_code text;
update organizations set join_code = new_join_code() where join_code is null;
alter table organizations alter column join_code set not null;
alter table organizations alter column join_code set default new_join_code();
alter table organizations add constraint organizations_join_code_key unique (join_code);
-- The code is readable only through org_join_code() (admins), not by selecting the table.
revoke select on organizations from authenticated;
grant select (id, name, created_at) on organizations to authenticated;
revoke update on organizations from authenticated;
grant update (name) on organizations to authenticated;

-- Admins read their organization's code through this function (members don't see it).
create function org_join_code(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select join_code from organizations where id = p_org and is_admin(p_org);
$$;

create function regenerate_join_code(p_org uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not is_admin(p_org) then raise exception 'Only an admin can change the join code.' using errcode = 'VA001'; end if;
  update organizations set join_code = new_join_code() where id = p_org returning join_code into v_code;
  return v_code;
end $$;

-- Simple guard against guessing codes: at most 10 failed attempts per person per hour.
create table join_attempts (
  user_id uuid not null,
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_idx on join_attempts(user_id, attempted_at);
alter table join_attempts enable row level security; -- no policies: only the function below touches it
revoke all on join_attempts from anon, authenticated;

create function join_organization(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Not signed in.' using errcode = 'VA001'; end if;
  if (select count(*) from join_attempts where user_id = auth.uid() and attempted_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many tries. Wait an hour, or ask your admin to add you by email.' using errcode = 'VA001';
  end if;
  select id into v_org from organizations where join_code = v_code;
  if v_org is null then
    raise exception 'That code doesn''t match any company. Check it with your admin.' using errcode = 'VA001';
  end if;
  insert into memberships (org_id, user_id, role) values (v_org, auth.uid(), 'worker') on conflict do nothing;
  return v_org;
end $$;

-- The error above undoes anything join_organization wrote, so the app records a failed attempt
-- separately by calling record_failed_join() after a bad code.
create function record_failed_join() returns void
language sql security definer set search_path = public as $$
  insert into join_attempts (user_id) select auth.uid() where auth.uid() is not null;
$$;

-- ---------- Job dates ----------
alter table jobs rename column scheduled_date to start_date;
alter table jobs add column end_date date;
alter table jobs add constraint jobs_dates_order check (end_date is null or start_date is null or end_date >= start_date);

drop function worker_schedule(uuid);
create function worker_schedule(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text,
               status text, start_date date, end_date date, notes text, my_payout_cents bigint)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.start_date, j.end_date, j.notes, a.payout_cents
  from jobs j
  join clients c on c.id = j.client_id
  left join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
  where j.org_id = p_org and is_member(p_org) and j.status <> 'completed'
    and (is_admin(p_org) or a.user_id is not null)
  order by j.start_date nulls last, j.id;
$$;

revoke execute on function new_join_code(), org_join_code(uuid), regenerate_join_code(uuid), join_organization(text),
  record_failed_join(), worker_schedule(uuid) from anon, public;
grant execute on function org_join_code(uuid), regenerate_join_code(uuid), join_organization(text),
  record_failed_join(), worker_schedule(uuid) to authenticated;

-- 1. Company profile: logo and contact details printed on estimates and work orders (admins only).
-- 2. Jobs remember when they were completed, so the home screen can report each month's gross profit.

create table company_profiles (
  org_id uuid primary key references organizations(id) on delete cascade,
  phone text not null default '' check (length(phone) <= 50),
  email text not null default '' check (length(email) <= 200),
  address text not null default '' check (length(address) <= 500),
  website text not null default '' check (length(website) <= 200),
  license_number text not null default '' check (length(license_number) <= 100),
  estimate_terms text not null default '' check (length(estimate_terms) <= 5000),
  work_order_terms text not null default '' check (length(work_order_terms) <= 5000),
  logo bytea check (logo is null or octet_length(logo) <= 1500000),
  logo_type text check (logo_type in ('image/png', 'image/jpeg')),
  updated_at timestamptz not null default now()
);
alter table company_profiles enable row level security;
create policy org_rows on company_profiles for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on company_profiles to authenticated;
revoke all on company_profiles from anon;

alter table jobs add column completed_at timestamptz;
update jobs set completed_at = updated_at where status = 'completed';

create function set_job_completed_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    new.completed_at := now();
  elsif new.status <> 'completed' then
    new.completed_at := null;
  end if;
  return new;
end $$;
create trigger jobs_completed_at before insert or update of status on jobs
  for each row execute function set_job_completed_at();

-- Invoices sent through Stripe Connect. Each company links its own Stripe account (money goes straight to them).
-- Stripe emails the client a pay link; when they pay, Stripe calls the app's webhook and the payment is
-- recorded on the job automatically. Admins only.

create table stripe_accounts (
  org_id uuid primary key references organizations(id) on delete cascade,
  account_id text not null unique,
  charges_enabled boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table stripe_accounts enable row level security;
-- Admins can read their own row; only the app server (as the database owner) writes it, so nobody can
-- point their company at someone else's Stripe account.
create policy org_rows on stripe_accounts for select to authenticated using (is_admin(org_id));
grant select on stripe_accounts to authenticated;
revoke all on stripe_accounts from anon;

-- A client's Stripe customer belongs to one Stripe account; if the company links a different account, a new one is made.
alter table clients add column stripe_customer_id text, add column stripe_customer_account text;

create table invoices (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  stripe_invoice_id text not null unique,
  number text not null default '',
  amount_cents bigint not null check (amount_cents > 0),
  description text not null default '' check (length(description) <= 500),
  sent_to text not null default '',
  due_date date,
  status text not null default 'open' check (status in ('open', 'paid', 'void', 'uncollectible')),
  hosted_url text not null default '',
  pdf_url text not null default '',
  payment_id bigint references payments(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index invoices_job_idx on invoices(job_id);
alter table invoices enable row level security;
create policy org_rows on invoices for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on invoices to authenticated;
revoke all on invoices from anon;

-- Called by the app's Stripe webhook (which has no signed-in user), never by people:
-- records a paid invoice as a payment on its job, once, however many times Stripe repeats the event.
create function record_stripe_payment(p_org uuid, p_job bigint, p_stripe_invoice text, p_amount bigint, p_paid_on date,
  p_number text, p_hosted_url text, p_pdf_url text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_inv invoices; v_payment bigint; v_known boolean;
begin
  select * into v_inv from invoices where stripe_invoice_id = p_stripe_invoice for update;
  v_known := found;
  if v_known and v_inv.status = 'paid' then return v_inv.payment_id; end if;
  if not exists (select 1 from jobs where id = p_job and org_id = p_org) then
    raise exception 'Unknown job % for organization %', p_job, p_org;
  end if;
  insert into payments (org_id, job_id, amount_cents, paid_on) values (p_org, p_job, p_amount, p_paid_on) returning id into v_payment;
  if v_known then
    update invoices set status = 'paid', paid_at = now(), payment_id = v_payment where id = v_inv.id;
  else
    -- The invoice row is missing (its request failed after Stripe sent it): keep a record anyway.
    insert into invoices (org_id, job_id, stripe_invoice_id, number, amount_cents, status, hosted_url, pdf_url, payment_id, paid_at)
    values (p_org, p_job, p_stripe_invoice, coalesce(p_number, ''), p_amount, 'paid', coalesce(p_hosted_url, ''), coalesce(p_pdf_url, ''), v_payment, now());
  end if;
  return v_payment;
end $$;

-- Webhook helpers (no signed-in user): which company a Stripe account belongs to, and its current status.
create function org_for_stripe_account(p_account text) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from stripe_accounts where account_id = p_account;
$$;
create function update_stripe_account(p_account text, p_charges boolean, p_details boolean) returns void
language sql security definer set search_path = public as $$
  update stripe_accounts set charges_enabled = p_charges, details_submitted = p_details, updated_at = now() where account_id = p_account;
$$;

create function set_stripe_invoice_status(p_stripe_invoice text, p_status text) returns void
language sql security definer set search_path = public as $$
  update invoices set status = p_status where stripe_invoice_id = p_stripe_invoice and status <> 'paid';
$$;

revoke execute on function record_stripe_payment(uuid, bigint, text, bigint, date, text, text, text),
  set_stripe_invoice_status(text, text), org_for_stripe_account(text), update_stripe_account(text, boolean, boolean)
  from public, anon, authenticated;

-- 1. People get an optional name, phone and address (their own profile; admins of their company can see them).
-- 2. Subscription plans: Free (one person), Team (up to 3 admins and 10 workers), Unlimited.
--    Plans are bought through Stripe on the app's own Stripe account; the server keeps this table in sync.

-- ---------- Profiles ----------
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '' check (length(full_name) <= 200),
  phone text not null default '' check (length(phone) <= 50),
  address text not null default '' check (length(address) <= 500),
  updated_at timestamptz not null default now()
);
alter table profiles enable row level security;
create policy own_profile on profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on profiles to authenticated;
revoke all on profiles from anon;

-- Members now come with their name; phone and address only for admins (and for yourself).
drop function org_members(uuid);
create function org_members(p_org uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz, full_name text, phone text, address text)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at, coalesce(p.full_name, ''),
    case when is_admin(p_org) or m.user_id = auth.uid() then coalesce(p.phone, '') else '' end,
    case when is_admin(p_org) or m.user_id = auth.uid() then coalesce(p.address, '') else '' end
  from memberships m join auth.users u on u.id = m.user_id left join profiles p on p.user_id = m.user_id
  where m.org_id = p_org and is_member(p_org)
  order by m.created_at;
$$;

drop function job_team(bigint);
create function job_team(p_job bigint)
returns table (user_id uuid, email text, role text, payout_cents bigint, full_name text, phone text)
language sql stable security definer set search_path = public as $$
  select a.user_id, u.email::text, coalesce(m.role, 'removed'), a.payout_cents, coalesce(p.full_name, ''), coalesce(p.phone, '')
  from job_assignments a
  join auth.users u on u.id = a.user_id
  left join memberships m on m.org_id = a.org_id and m.user_id = a.user_id
  left join profiles p on p.user_id = a.user_id
  where a.job_id = p_job and is_admin(a.org_id)
  order by coalesce(nullif(p.full_name, ''), u.email);
$$;

-- ---------- Plans ----------
create table org_subscriptions (
  org_id uuid primary key references organizations(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'team', 'unlimited')),
  billing_interval text check (billing_interval in ('month', 'year')),
  status text not null default 'none',          -- Stripe subscription status, or 'none'
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  first_month_discount_used boolean not null default false,
  comped boolean not null default false,        -- free Unlimited (the app owner's own company)
  updated_at timestamptz not null default now()
);
alter table org_subscriptions enable row level security;
-- Admins can read their company's plan; only the server (as the database owner) writes it.
create policy org_rows on org_subscriptions for select to authenticated using (is_admin(org_id));
grant select on org_subscriptions to authenticated;
revoke all on org_subscriptions from anon;

-- The plan in force: a paid plan counts while Stripe says active, trialing or past_due (a grace period).
create function effective_plan(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when s.comped then 'unlimited'
    when s.status in ('active', 'trialing', 'past_due') then s.plan
    else 'free' end
  from (select (select comped from org_subscriptions where org_id = p_org) is true as comped,
               (select status from org_subscriptions where org_id = p_org) as status,
               (select plan from org_subscriptions where org_id = p_org) as plan) s;
$$;

-- Seat limits, checked whenever someone joins a company or becomes an admin. Nothing is ever removed
-- when a plan ends; the company just can't add people past its limits.
create function check_plan_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_plan text := effective_plan(new.org_id); v_total int; v_admins int; v_workers int;
begin
  if v_plan = 'unlimited' then return new; end if;
  -- A role change adds nobody, so only becoming an admin is checked.
  if tg_op = 'UPDATE' and (new.role <> 'admin' or old.role = 'admin') then return new; end if;
  perform 1 from organizations where id = new.org_id for update;  -- one change at a time per company
  select count(*), count(*) filter (where role = 'admin'), count(*) filter (where role = 'worker')
    into v_total, v_admins, v_workers
    from memberships where org_id = new.org_id and user_id <> new.user_id;
  if new.role = 'admin' then v_admins := v_admins + 1; else v_workers := v_workers + 1; end if;
  v_total := v_total + 1;
  if v_plan = 'free' and tg_op = 'INSERT' and v_total > 1 then
    raise exception 'The Free plan is for one person. Upgrade to Team on the Billing page to add your crew.' using errcode = 'VA001';
  end if;
  if v_plan = 'team' and v_admins > 3 then
    raise exception 'The Team plan includes up to 3 admins. Upgrade to Unlimited on the Billing page for more.' using errcode = 'VA001';
  end if;
  if v_plan = 'team' and v_workers > 10 then
    raise exception 'The Team plan includes up to 10 workers. Upgrade to Unlimited on the Billing page for more.' using errcode = 'VA001';
  end if;
  return new;
end $$;
create trigger memberships_plan_limits before insert or update of role on memberships
  for each row execute function check_plan_limits();

-- Called by the server's Stripe webhook (no signed-in user).
create function sync_org_subscription(p_org uuid, p_customer text, p_subscription text, p_plan text, p_interval text,
  p_status text, p_period_end timestamptz, p_cancel_at_end boolean)
returns void
language sql security definer set search_path = public as $$
  insert into org_subscriptions (org_id, stripe_customer_id, stripe_subscription_id, plan, billing_interval, status,
    current_period_end, cancel_at_period_end, first_month_discount_used, updated_at)
  values (p_org, p_customer, p_subscription, p_plan, p_interval, p_status, p_period_end, p_cancel_at_end, true, now())
  on conflict (org_id) do update set stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id, plan = excluded.plan, billing_interval = excluded.billing_interval,
    status = excluded.status, current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end, first_month_discount_used = true, updated_at = now()
  -- A late event about an old, ended subscription must not replace a newer live one.
  where org_subscriptions.stripe_subscription_id is null
     or org_subscriptions.stripe_subscription_id = excluded.stripe_subscription_id
     or excluded.status in ('active', 'trialing', 'past_due')
     or org_subscriptions.status not in ('active', 'trialing', 'past_due');
$$;

-- The app owner's own company (the first one created) is comped on Unlimited.
insert into org_subscriptions (org_id, plan, status, comped)
select id, 'unlimited', 'none', true from organizations order by created_at limit 1
on conflict (org_id) do nothing;

revoke execute on function effective_plan(uuid), check_plan_limits(),
  sync_org_subscription(uuid, text, text, text, text, text, timestamptz, boolean) from public, anon;
revoke execute on function sync_org_subscription(uuid, text, text, text, text, text, timestamptz, boolean) from authenticated;
grant execute on function effective_plan(uuid), org_members(uuid), job_team(bigint) to authenticated;
revoke execute on function org_members(uuid), job_team(bigint) from public, anon;

-- 1. Clients approve estimates online: pick an option (good/better/best), sign, and pay a deposit.
-- 2. Automatic emails: estimate follow-ups, appointment reminders and review requests, with a log.

-- ---------- Options on estimates ----------
-- A line item with an option name belongs to that option; items without one are in every option.
alter table line_items add column option_name text not null default '' check (length(option_name) <= 60);
alter table estimates
  add column chosen_option text check (length(chosen_option) <= 60),
  add column deposit_percent int not null default 0 check (deposit_percent between 0 and 100),
  -- The secret part of the link clients open (about 244 random bits).
  add column public_token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  add column sent_to text not null default '' check (length(sent_to) <= 200),
  add column sent_at timestamptz,
  add column viewed_at timestamptz,
  add column reminders_sent int not null default 0,
  add column last_reminded_at timestamptz,
  -- The client's approval: written only by the server, never by the company.
  add column approved_at timestamptz,
  add column signer_name text,
  add column signature text check (length(signature) <= 300000),
  add column signer_ip text,
  add column signer_agent text,
  add column decline_reason text check (length(decline_reason) <= 2000);

-- The total of an estimate: shared items plus the chosen option (or the first option until one is chosen).
create function estimate_total(p_estimate bigint) returns bigint
language sql stable security invoker set search_path = public as $$
  select coalesce(sum(li.line_total_cents), 0)::bigint
  from line_items li join estimates e on e.id = li.estimate_id
  where li.estimate_id = p_estimate
    and (li.option_name = '' or li.option_name = coalesce(e.chosen_option,
      (select l2.option_name from line_items l2 where l2.estimate_id = p_estimate and l2.option_name <> ''
       order by l2.position limit 1)));
$$;
create or replace view estimate_totals with (security_invoker = true) as
  select e.id as estimate_id, e.org_id, estimate_total(e.id) as total_cents from estimates e;

-- Converted estimates stay locked, except for delivery tracking (when it was sent, opened, reminded).
create or replace function prevent_converted_estimate_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.client_id, new.project_name, new.scope, new.estimated_cost_cents, new.status, new.chosen_option,
      new.deposit_percent, new.approved_at, new.signer_name, new.signature, new.public_token)
    is not distinct from (old.client_id, old.project_name, old.scope, old.estimated_cost_cents, old.status, old.chosen_option,
      old.deposit_percent, old.approved_at, old.signer_name, old.signature, old.public_token) then
    return new;
  end if;
  if exists (select 1 from jobs where estimate_id = old.id) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;

-- Companies edit their estimates, but not the client's signature or the link.
revoke update on estimates from authenticated;
grant update (client_id, project_name, scope, estimated_cost_cents, status, updated_at, chosen_option, deposit_percent,
  sent_to, sent_at, reminders_sent, last_reminded_at) on estimates to authenticated;

-- ---------- Settings for automatic emails ----------
alter table company_profiles
  add column default_deposit_percent int not null default 0 check (default_deposit_percent between 0 and 100),
  add column estimate_followup_days int not null default 3 check (estimate_followup_days between 0 and 30), -- 0 = off
  add column appointment_reminders boolean not null default true,
  add column review_requests boolean not null default false,
  add column review_url text not null default '' check (length(review_url) <= 500);

alter table jobs
  add column reminder_sent_for date,           -- the start date the client was last reminded about
  add column review_requested_at timestamptz;

-- ---------- Email log ----------
create table email_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('estimate', 'estimate_reminder', 'appointment_reminder', 'review_request', 'estimate_approved', 'estimate_declined')),
  to_email text not null,
  subject text not null,
  estimate_id bigint references estimates(id) on delete cascade,
  job_id bigint references jobs(id) on delete cascade,
  status text not null check (status in ('sent', 'failed')),
  error text not null default '',
  provider_id text not null default '',
  created_at timestamptz not null default now()
);
create index email_log_estimate_idx on email_log(estimate_id);
create index email_log_job_idx on email_log(job_id);
alter table email_log enable row level security;
-- Admins can read their company's email history; only the server writes it.
create policy org_rows on email_log for select to authenticated using (is_admin(org_id));
grant select on email_log to authenticated;
revoke all on email_log from anon;

grant execute on function estimate_total(bigint) to authenticated;
revoke execute on function estimate_total(bigint) from public, anon;

-- 1. Estimates have their own job-site address (copied to the job), and an optional appointment date and time
--    that shows on the calendar.
-- 2. People enter a ZIP code instead of a full address.
-- 3. "Workers" are now called "crew" in messages.

alter table estimates
  add column address text not null default '' check (length(address) <= 500),
  add column visit_date date,
  add column visit_time time;
update estimates e set address = c.address from clients c where c.id = e.client_id;
grant update (address, visit_date, visit_time) on estimates to authenticated;
create index estimates_visit_idx on estimates(org_id, visit_date) where visit_date is not null;

-- Converting uses the estimate's address (falling back to the client's).
create or replace function convert_estimate_to_job(p_estimate bigint) returns bigint
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
    values (e.org_id, e.id, c.id, e.project_name, coalesce(nullif(e.address, ''), c.address), e.scope, v_total)
    on conflict (estimate_id) do nothing
    returning id into v_job;
  if v_job is null then select id into v_job from jobs where estimate_id = p_estimate; end if;
  return v_job;
end $$;

alter table profiles add column zip text not null default '' check (length(zip) <= 10);

drop function org_members(uuid);
create function org_members(p_org uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz, full_name text, phone text, address text, zip text)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at, coalesce(p.full_name, ''),
    case when is_admin(p_org) or m.user_id = auth.uid() then coalesce(p.phone, '') else '' end,
    case when is_admin(p_org) or m.user_id = auth.uid() then coalesce(p.address, '') else '' end,
    case when is_admin(p_org) or m.user_id = auth.uid() then coalesce(p.zip, '') else '' end
  from memberships m join auth.users u on u.id = m.user_id left join profiles p on p.user_id = m.user_id
  where m.org_id = p_org and is_member(p_org)
  order by m.created_at;
$$;
grant execute on function org_members(uuid) to authenticated;
revoke execute on function org_members(uuid) from public, anon;

create or replace function check_plan_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_plan text := effective_plan(new.org_id); v_total int; v_admins int; v_workers int;
begin
  if v_plan = 'unlimited' then return new; end if;
  -- A role change adds nobody, so only becoming an admin is checked.
  if tg_op = 'UPDATE' and (new.role <> 'admin' or old.role = 'admin') then return new; end if;
  perform 1 from organizations where id = new.org_id for update;  -- one change at a time per company
  select count(*), count(*) filter (where role = 'admin'), count(*) filter (where role = 'worker')
    into v_total, v_admins, v_workers
    from memberships where org_id = new.org_id and user_id <> new.user_id;
  if new.role = 'admin' then v_admins := v_admins + 1; else v_workers := v_workers + 1; end if;
  v_total := v_total + 1;
  if v_plan = 'free' and tg_op = 'INSERT' and v_total > 1 then
    raise exception 'The Free plan is for one person. Upgrade to Team on the Billing page to add your crew.' using errcode = 'VA001';
  end if;
  if v_plan = 'team' and v_admins > 3 then
    raise exception 'The Team plan includes up to 3 admins. Upgrade to Unlimited on the Billing page for more.' using errcode = 'VA001';
  end if;
  if v_plan = 'team' and v_workers > 10 then
    raise exception 'The Team plan includes up to 10 crew members. Upgrade to Unlimited on the Billing page for more.' using errcode = 'VA001';
  end if;
  return new;
end $$;
revoke execute on function check_plan_limits() from public, anon;

-- Crew get their own overview and job list: every job they're assigned to, open or completed,
-- with only what crew may see (dates, address, scope, notes and their own pay).
create function crew_jobs(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text, status text,
               start_date date, end_date date, completed_at timestamptz, notes text, my_payout_cents bigint)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.start_date, j.end_date, j.completed_at, j.notes, a.payout_cents
  from jobs j
  join clients c on c.id = j.client_id
  join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
  where j.org_id = p_org and is_member(p_org)
  order by j.status = 'completed', j.start_date nulls last, j.id;
$$;
revoke execute on function crew_jobs(uuid) from public, anon;
grant execute on function crew_jobs(uuid) to authenticated;

-- A photo or PDF of the receipt for an expense (optional, one per expense).
alter table expenses add constraint expenses_id_org_key unique (id, org_id);
create table expense_receipts (
  expense_id bigint primary key,
  org_id uuid not null,
  data bytea not null check (octet_length(data) <= 5242880),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'application/pdf')),
  filename text not null default '' check (length(filename) <= 200),
  created_at timestamptz not null default now(),
  foreign key (expense_id, org_id) references expenses(id, org_id) on delete cascade
);
alter table expense_receipts enable row level security;
create policy org_rows on expense_receipts for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on expense_receipts to authenticated;
revoke all on expense_receipts from anon;

-- Each line item has a name (description) and a longer description of the work (details).
-- Names and descriptions stay editable after an estimate becomes a job; prices, quantities and options stay locked.
alter table line_items add column details text not null default '' check (length(details) <= 10000);

create or replace function prevent_converted_line_item_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.estimate_id, new.org_id, new.position, new.qty_hundredths, new.unit_price_cents, new.option_name)
    is not distinct from (old.estimate_id, old.org_id, old.position, old.qty_hundredths, old.unit_price_cents, old.option_name) then
    return new;
  end if;
  if exists (select 1 from jobs where estimate_id in (
      case when tg_op = 'INSERT' then null else old.estimate_id end,
      case when tg_op = 'DELETE' then null else new.estimate_id end)) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;

-- The scope of work (built from the line items) can change after conversion too.
create or replace function prevent_converted_estimate_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.client_id, new.project_name, new.estimated_cost_cents, new.status, new.chosen_option,
      new.deposit_percent, new.approved_at, new.signer_name, new.signature, new.public_token)
    is not distinct from (old.client_id, old.project_name, old.estimated_cost_cents, old.status, old.chosen_option,
      old.deposit_percent, old.approved_at, old.signer_name, old.signature, old.public_token) then
    return new;
  end if;
  if exists (select 1 from jobs where estimate_id = old.id) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;

-- Subcontractors vs W-2 employees, a time clock for W-2 crew, and job photos.
-- Subcontractors keep the fixed payout per job. W-2 employees clock in and out on their jobs,
-- and hours x their hourly rate count as labor (a job cost, alongside payouts).

-- How each teammate is paid. Admins only; crew see their own rate through crew_jobs().
create table member_pay (
  org_id uuid not null,
  user_id uuid not null,
  pay_type text not null default 'sub' check (pay_type in ('sub', 'w2')),
  hourly_rate_cents bigint check (hourly_rate_cents >= 0 and hourly_rate_cents <= 100000000),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references memberships(org_id, user_id) on delete cascade
);
alter table member_pay enable row level security;
create policy org_rows on member_pay for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on member_pay to authenticated;
revoke all on member_pay from anon;

-- Time clock. The hourly rate is copied onto each entry, so changing a rate later doesn't rewrite past labor.
create table time_entries (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  user_id uuid not null references auth.users(id),
  clock_in timestamptz not null,
  clock_out timestamptz,
  rate_cents bigint not null check (rate_cents >= 0 and rate_cents <= 100000000),
  created_at timestamptz not null default now(),
  check (clock_out is null or (clock_out > clock_in and clock_out - clock_in <= interval '24 hours')),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create unique index time_entries_one_open on time_entries(user_id) where clock_out is null;
create index time_entries_job_idx on time_entries(job_id);
create trigger time_entries_member before insert or update on time_entries
  for each row execute function check_assignment_member();
alter table time_entries enable row level security;
create policy org_rows on time_entries for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy own_rows on time_entries for select to authenticated using (user_id = auth.uid() and is_member(org_id));
grant select, insert, update, delete on time_entries to authenticated;
revoke all on time_entries from anon;

-- Labor cost of one time entry (0 while still clocked in).
create function labor_cents(p_in timestamptz, p_out timestamptz, p_rate bigint) returns bigint
language sql immutable as $$
  select coalesce(round(extract(epoch from (p_out - p_in)) / 3600.0 * p_rate)::bigint, 0);
$$;

-- Crew clock in on an open job they're assigned to (W-2 with an hourly rate only), one job at a time.
create function clock_in(p_job bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_rate bigint; v_open text; v_id bigint;
begin
  select j.org_id into v_org from jobs j join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
    where j.id = p_job and j.status <> 'completed';
  if v_org is null or not is_member(v_org) then
    raise exception 'You can only clock in on an open job you are assigned to.' using errcode = 'VA001';
  end if;
  select hourly_rate_cents into v_rate from member_pay where org_id = v_org and user_id = auth.uid() and pay_type = 'w2';
  if v_rate is null then
    raise exception 'Only W-2 employees with an hourly rate can clock in. Ask an admin to set yours.' using errcode = 'VA001';
  end if;
  select j.project_name into v_open from time_entries t join jobs j on j.id = t.job_id where t.user_id = auth.uid() and t.clock_out is null;
  if v_open is not null then
    raise exception 'You are already clocked in at %. Clock out there first.', v_open using errcode = 'VA001';
  end if;
  insert into time_entries (org_id, job_id, user_id, clock_in, rate_cents) values (v_org, p_job, auth.uid(), now(), v_rate)
    returning id into v_id;
  return v_id;
end $$;

-- Ends the caller's open entry (capped at 24 hours; an admin can correct it).
create function clock_out() returns void
language sql security definer set search_path = public as $$
  update time_entries set clock_out = least(greatest(now(), clock_in + interval '1 second'), clock_in + interval '24 hours')
  where user_id = auth.uid() and clock_out is null;
$$;

-- Job totals: payouts now include W-2 labor from finished time entries.
drop view job_totals;
create view job_totals with (security_invoker = true) as
  select j.id as job_id, j.org_id, j.contract_cents,
    coalesce((select sum(amount_cents) from expenses x where x.job_id = j.id), 0)::bigint as expenses_cents,
    coalesce((select sum(amount_cents) from payments p where p.job_id = j.id), 0)::bigint as payments_cents,
    (coalesce((select sum(payout_cents) from job_assignments a where a.job_id = j.id), 0)
      + coalesce((select sum(labor_cents(t.clock_in, t.clock_out, t.rate_cents)) from time_entries t where t.job_id = j.id), 0))::bigint as payouts_cents
  from jobs j;
grant select on job_totals to authenticated;
revoke all on job_totals from anon;

-- Job crew list for admins, with pay type, hours and labor.
drop function job_team(bigint);
create function job_team(p_job bigint)
returns table (user_id uuid, email text, role text, payout_cents bigint, full_name text, phone text,
               pay_type text, hourly_rate_cents bigint, minutes bigint, labor_cents bigint)
language sql stable security definer set search_path = public as $$
  select a.user_id, u.email::text, coalesce(m.role, 'removed'), a.payout_cents, coalesce(p.full_name, ''), coalesce(p.phone, ''),
    coalesce(mp.pay_type, 'sub'), mp.hourly_rate_cents,
    coalesce((select sum(extract(epoch from (t.clock_out - t.clock_in)) / 60)::bigint from time_entries t
      where t.job_id = a.job_id and t.user_id = a.user_id and t.clock_out is not null), 0),
    coalesce((select sum(labor_cents(t.clock_in, t.clock_out, t.rate_cents)) from time_entries t
      where t.job_id = a.job_id and t.user_id = a.user_id), 0)::bigint
  from job_assignments a
  join auth.users u on u.id = a.user_id
  left join memberships m on m.org_id = a.org_id and m.user_id = a.user_id
  left join profiles p on p.user_id = a.user_id
  left join member_pay mp on mp.org_id = a.org_id and mp.user_id = a.user_id
  where a.job_id = p_job and is_admin(a.org_id)
  order by coalesce(nullif(p.full_name, ''), u.email);
$$;

-- Crew job list: pay now includes their own labor, plus their hours and whether they're clocked in.
drop function crew_jobs(uuid);
create function crew_jobs(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text, status text,
               start_date date, end_date date, completed_at timestamptz, notes text, my_payout_cents bigint,
               my_pay_type text, my_minutes bigint, clocked_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.start_date, j.end_date, j.completed_at, j.notes,
    a.payout_cents + coalesce((select sum(labor_cents(t.clock_in, t.clock_out, t.rate_cents)) from time_entries t
      where t.job_id = j.id and t.user_id = a.user_id), 0)::bigint,
    coalesce(mp.pay_type, 'sub'),
    coalesce((select sum(extract(epoch from (t.clock_out - t.clock_in)) / 60)::bigint from time_entries t
      where t.job_id = j.id and t.user_id = a.user_id and t.clock_out is not null), 0),
    (select t.clock_in from time_entries t where t.job_id = j.id and t.user_id = a.user_id and t.clock_out is null)
  from jobs j
  join clients c on c.id = j.client_id
  join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
  left join member_pay mp on mp.org_id = j.org_id and mp.user_id = a.user_id
  where j.org_id = p_org and is_member(p_org)
  order by j.status = 'completed', j.start_date nulls last, j.id;
$$;

-- Job photos: admins see and manage all; crew see and add photos on jobs they're assigned to, and delete their own.
create function on_job(p_job bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from job_assignments where job_id = p_job and user_id = auth.uid());
$$;
create table job_photos (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  data bytea not null check (octet_length(data) <= 5242880),
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  created_at timestamptz not null default now(),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index job_photos_job_idx on job_photos(job_id);
alter table job_photos enable row level security;
create policy org_rows on job_photos for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy crew_read on job_photos for select to authenticated using (is_member(org_id) and on_job(job_id));
create policy crew_add on job_photos for insert to authenticated
  with check (is_member(org_id) and on_job(job_id) and uploaded_by = auth.uid());
create policy crew_delete_own on job_photos for delete to authenticated using (is_member(org_id) and uploaded_by = auth.uid());
grant select, insert, delete on job_photos to authenticated;
revoke all on job_photos from anon;

revoke execute on function clock_in(bigint), clock_out(), job_team(bigint), crew_jobs(uuid), on_job(bigint) from public, anon;
grant execute on function clock_in(bigint), clock_out(), job_team(bigint), crew_jobs(uuid), on_job(bigint) to authenticated;

-- Deleting a company (admins) and deleting your own account (anyone), as the app stores and Google/Meta require.

-- Deletes a company and everything in it. Jobs go first: an estimate that became a job stays locked while its job exists.
create function delete_organization(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'Only an admin can delete the company.' using errcode = 'VA001'; end if;
  delete from jobs where org_id = p_org;
  delete from organizations where id = p_org;
end $$;

-- Companies the caller is the only admin of: whether anyone else is on them decides if the account can be deleted.
create function my_sole_admin_orgs() returns table (org_id uuid, name text, others int)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, (select count(*)::int from memberships x where x.org_id = o.id and x.user_id <> auth.uid())
  from memberships m join organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and m.role = 'admin'
    and not exists (select 1 from memberships x where x.org_id = m.org_id and x.role = 'admin' and x.user_id <> auth.uid())
  order by o.name;
$$;

-- Removes the caller's own data before the login itself is deleted: companies where they're the only person,
-- every membership, and their profile. Work records other companies keep (assignments, hours) stay with those companies.
create function delete_my_data() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if auth.uid() is null then raise exception 'Not signed in.' using errcode = 'VA001'; end if;
  for r in select * from my_sole_admin_orgs() loop
    if r.others > 0 then
      raise exception 'You''re the only admin of %. Make someone else an admin or delete the company first.', r.name using errcode = 'VA001';
    end if;
    perform delete_organization(r.org_id);
  end loop;
  delete from memberships where user_id = auth.uid();
  delete from profiles where user_id = auth.uid();
end $$;

revoke execute on function delete_organization(uuid), my_sole_admin_orgs(), delete_my_data() from anon, public;
grant execute on function delete_organization(uuid), my_sole_admin_orgs(), delete_my_data() to authenticated;

-- Text message follow-ups (optional, each one off until a company turns it on).
-- Every company texts from its own registered sender (US carriers require it); only the app owner sets that up.

-- The company's Twilio Messaging Service, added by the app owner after the company's texting registration is approved.
create table sms_senders (
  org_id uuid primary key references organizations(id) on delete cascade,
  messaging_service_sid text not null check (messaging_service_sid ~ '^MG[0-9a-f]{32}$'),
  phone text not null default '' check (length(phone) <= 20),
  created_at timestamptz not null default now()
);
alter table sms_senders enable row level security;
create policy org_rows on sms_senders for select to authenticated using (is_admin(org_id));
grant select on sms_senders to authenticated;
revoke all on sms_senders from anon;

-- Which automatic texts the company wants (emails keep their own settings).
alter table company_profiles
  add column sms_estimate_followups boolean not null default false,
  add column sms_appointment_reminders boolean not null default false,
  add column sms_review_requests boolean not null default false;

-- Texts go only to clients who agreed to them, and never after they reply STOP.
alter table clients
  add column sms_consent boolean not null default false,
  add column sms_opted_out_at timestamptz;

-- The message history holds texts too (to_email then holds the phone number, subject the text).
alter table email_log add column channel text not null default 'email' check (channel in ('email', 'sms'));

-- Record a STOP (or START) reply against the company that number texts for. Called by the server's Twilio webhook.
create function record_sms_reply(p_to text, p_from text, p_stop boolean) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid; n int;
begin
  select org_id into v_org from sms_senders where phone = p_to;
  if v_org is null then return 0; end if;
  update clients set sms_opted_out_at = case when p_stop then now() else null end
    where org_id = v_org and regexp_replace(phone, '\D', '', 'g') in (regexp_replace(p_from, '\D', '', 'g'), substr(regexp_replace(p_from, '\D', '', 'g'), 2));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function record_sms_reply(text, text, boolean) from public, anon, authenticated;

-- Subcontractors who don't use Keystone: admins keep them on the team, assign them to jobs with a fixed payout and send
-- them work orders. If one later signs up and joins the company, an admin links them and their jobs move to their account.

create table subcontractors (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  company text not null default '' check (length(company) <= 200),
  email text not null default '' check (length(email) <= 200),
  phone text not null default '' check (length(phone) <= 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create index subcontractors_org_idx on subcontractors(org_id);
alter table subcontractors enable row level security;
create policy org_rows on subcontractors for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on subcontractors to authenticated;
revoke all on subcontractors from anon;

-- Their payouts. A subcontractor with assigned jobs can't be deleted, so job costs stay complete.
create table sub_assignments (
  org_id uuid not null,
  job_id bigint not null,
  sub_id bigint not null,
  payout_cents bigint not null check (payout_cents >= 0 and payout_cents <= 10000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, sub_id),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade,
  foreign key (sub_id, org_id) references subcontractors(id, org_id)
);
create index sub_assignments_sub_idx on sub_assignments(sub_id);
alter table sub_assignments enable row level security;
create policy org_rows on sub_assignments for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on sub_assignments to authenticated;
revoke all on sub_assignments from anon;

-- Job totals: payouts include subcontractors without accounts.
drop view job_totals;
create view job_totals with (security_invoker = true) as
  select j.id as job_id, j.org_id, j.contract_cents,
    coalesce((select sum(amount_cents) from expenses x where x.job_id = j.id), 0)::bigint as expenses_cents,
    coalesce((select sum(amount_cents) from payments p where p.job_id = j.id), 0)::bigint as payments_cents,
    (coalesce((select sum(payout_cents) from job_assignments a where a.job_id = j.id), 0)
      + coalesce((select sum(payout_cents) from sub_assignments s where s.job_id = j.id), 0)
      + coalesce((select sum(labor_cents(t.clock_in, t.clock_out, t.rate_cents)) from time_entries t where t.job_id = j.id), 0))::bigint as payouts_cents
  from jobs j;
grant select on job_totals to authenticated;
revoke all on job_totals from anon;

-- The subcontractor signed up and joined: their jobs and payouts move to their account, and the contact goes away.
create function link_subcontractor(p_sub bigint, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from subcontractors where id = p_sub;
  if v_org is null or not is_admin(v_org) then raise exception 'Subcontractor not found.' using errcode = 'VA001'; end if;
  if not exists (select 1 from memberships where org_id = v_org and user_id = p_user) then
    raise exception 'That person is not on this team.' using errcode = 'VA001';
  end if;
  insert into job_assignments (org_id, job_id, user_id, payout_cents)
    select org_id, job_id, p_user, payout_cents from sub_assignments where sub_id = p_sub
    on conflict (job_id, user_id) do update set payout_cents = job_assignments.payout_cents + excluded.payout_cents, updated_at = now();
  delete from sub_assignments where sub_id = p_sub;
  insert into member_pay (org_id, user_id, pay_type) values (v_org, p_user, 'sub') on conflict (org_id, user_id) do nothing;
  delete from subcontractors where id = p_sub;
end $$;
revoke execute on function link_subcontractor(bigint, uuid) from public, anon;
grant execute on function link_subcontractor(bigint, uuid) to authenticated;

-- Work orders can be emailed now.
alter table email_log drop constraint email_log_kind_check;
alter table email_log add constraint email_log_kind_check check (kind in ('estimate', 'estimate_reminder', 'appointment_reminder',
  'review_request', 'estimate_approved', 'estimate_declined', 'work_order'));

commit;
