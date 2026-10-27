-- Self-serve texting: a company enters its business details, Keystone buys it a toll-free number, puts it in the
-- company's own Twilio Messaging Service and files the carrier verification. When carriers approve, the server adds
-- the company's sms_senders row and texting switches on. Only the server writes here.
create table sms_registrations (
  org_id uuid primary key references organizations(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
  business_name text not null check (length(business_name) between 1 and 200),
  business_type text not null check (business_type in ('PRIVATE_PROFIT', 'SOLE_PROPRIETOR', 'NON_PROFIT')),
  ein text not null default '' check (ein ~ '^([0-9]{2}-[0-9]{7})?$'),
  street text not null check (length(street) <= 200),
  city text not null check (length(city) <= 100),
  state text not null check (state ~ '^[A-Z]{2}$'),
  zip text not null check (zip ~ '^[0-9]{5}$'),
  website text not null check (length(website) <= 300),
  contact_first_name text not null check (length(contact_first_name) <= 100),
  contact_last_name text not null check (length(contact_last_name) <= 100),
  contact_email text not null check (length(contact_email) <= 200),
  contact_phone text not null check (length(contact_phone) <= 20),
  phone_number_sid text not null default '',
  phone text not null default '',
  messaging_service_sid text not null default '',
  verification_sid text not null default '',
  problem text not null default '' check (length(problem) <= 2000),
  edit_allowed boolean not null default false,
  submitted_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table sms_registrations enable row level security;
create policy org_rows on sms_registrations for select to authenticated using (is_admin(org_id));
grant select on sms_registrations to authenticated;
revoke all on sms_registrations from anon;
