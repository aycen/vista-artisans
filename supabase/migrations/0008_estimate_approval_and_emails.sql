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
