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
