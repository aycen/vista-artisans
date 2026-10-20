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
