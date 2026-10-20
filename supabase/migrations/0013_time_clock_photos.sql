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
