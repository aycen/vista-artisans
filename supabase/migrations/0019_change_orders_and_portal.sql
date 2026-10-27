-- 1. Change orders: work added to (or taken off) a job after the estimate was approved. The client signs it online,
--    or the company marks it approved; once approved, its amount is added to the job's contract total and it is locked.
-- 2. Client portal: one private link per client showing their estimates, jobs, change orders, invoices and job photos.

-- ---------- Client portal ----------
-- The secret part of the client's portal link (about 244 random bits), like an estimate's link.
alter table clients add column portal_token text not null unique
  default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

-- ---------- Change orders ----------
create table change_orders (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  title text not null check (length(trim(title)) between 1 and 200),
  details text not null default '' check (length(details) <= 5000),
  -- Negative for a credit (work taken off the job).
  amount_cents bigint not null check (amount_cents <> 0 and amount_cents between -10000000000 and 10000000000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'canceled')),
  sent_to text not null default '' check (length(sent_to) <= 200),
  sent_at timestamptz,
  -- The client's approval: written only by the server. Empty signer_name = the company marked it approved.
  approved_at timestamptz,
  signer_name text check (length(signer_name) <= 200),
  signature text check (length(signature) <= 300000),
  signer_ip text,
  signer_agent text,
  decline_reason text check (length(decline_reason) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index change_orders_job_idx on change_orders(job_id);
alter table change_orders enable row level security;
create policy org_rows on change_orders for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, delete on change_orders to authenticated;
grant insert (org_id, job_id, title, details, amount_cents, status, sent_to, sent_at) on change_orders to authenticated;
grant update (title, details, amount_cents, status, sent_to, sent_at, updated_at) on change_orders to authenticated;
revoke all on change_orders from anon;

-- Approving adds the amount to the job's contract total, once. Approved change orders can't be changed or deleted.
create function change_order_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_contract bigint;
begin
  if tg_op = 'DELETE' then
    -- (Deleting the whole job or company still removes it.)
    if old.status = 'approved' and exists (select 1 from jobs where id = old.job_id) then
      raise exception 'An approved change order is part of the contract and can''t be deleted.' using errcode = 'VA001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'approved' then
      raise exception 'This change order is approved and locked.' using errcode = 'VA001';
    end if;
  end if;
  if new.status = 'approved' then
    select contract_cents into v_contract from jobs where id = new.job_id and org_id = new.org_id for update;
    if v_contract + new.amount_cents < 0 then
      raise exception 'This credit is more than the job''s contract total.' using errcode = 'VA001';
    end if;
    new.approved_at := coalesce(new.approved_at, now());
    update jobs set contract_cents = contract_cents + new.amount_cents where id = new.job_id and org_id = new.org_id;
  else
    new.approved_at := null;
  end if;
  return new;
end $$;
create trigger change_order_rules before insert or update or delete on change_orders
  for each row execute function change_order_rules();
revoke execute on function change_order_rules() from public, anon, authenticated;

-- Change order emails go in the email log too.
alter table email_log drop constraint email_log_kind_check;
alter table email_log add constraint email_log_kind_check check (kind in ('estimate', 'estimate_reminder', 'appointment_reminder',
  'review_request', 'estimate_approved', 'estimate_declined', 'work_order', 'change_order', 'change_order_approved',
  'change_order_declined', 'portal'));
