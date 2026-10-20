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
