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
