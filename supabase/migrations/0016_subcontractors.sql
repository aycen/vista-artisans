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
