-- Text message follow-ups (optional, each one off until a company turns it on).
-- Every company texts from its own registered sender (US carriers require it); only the app owner sets that up.

-- The company's Twilio Messaging Service, added by the app owner after the company's texting registration is approved.
create table sms_senders (
  org_id uuid primary key references organizations(id) on delete cascade,
  messaging_service_sid text not null check (messaging_service_sid ~ '^MG[0-9a-f]{32}$'),
  phone text not null default '' check (length(phone) <= 20),
  created_at timestamptz not null default now()
);
alter table sms_senders enable row level security;
create policy org_rows on sms_senders for select to authenticated using (is_admin(org_id));
grant select on sms_senders to authenticated;
revoke all on sms_senders from anon;

-- Which automatic texts the company wants (emails keep their own settings).
alter table company_profiles
  add column sms_estimate_followups boolean not null default false,
  add column sms_appointment_reminders boolean not null default false,
  add column sms_review_requests boolean not null default false;

-- Texts go only to clients who agreed to them, and never after they reply STOP.
alter table clients
  add column sms_consent boolean not null default false,
  add column sms_opted_out_at timestamptz;

-- The message history holds texts too (to_email then holds the phone number, subject the text).
alter table email_log add column channel text not null default 'email' check (channel in ('email', 'sms'));

-- Record a STOP (or START) reply against the company that number texts for. Called by the server's Twilio webhook.
create function record_sms_reply(p_to text, p_from text, p_stop boolean) returns int
language plpgsql security definer set search_path = public as $$
declare v_org uuid; n int;
begin
  select org_id into v_org from sms_senders where phone = p_to;
  if v_org is null then return 0; end if;
  update clients set sms_opted_out_at = case when p_stop then now() else null end
    where org_id = v_org and regexp_replace(phone, '\D', '', 'g') in (regexp_replace(p_from, '\D', '', 'g'), substr(regexp_replace(p_from, '\D', '', 'g'), 2));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function record_sms_reply(text, text, boolean) from public, anon, authenticated;
