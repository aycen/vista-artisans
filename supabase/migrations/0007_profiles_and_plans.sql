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
