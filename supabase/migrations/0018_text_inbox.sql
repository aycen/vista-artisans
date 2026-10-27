-- Texts tab: replies from clients and texts the company sends by hand. (Automatic follow-up texts stay in email_log.)
create table sms_messages (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  client_id bigint references clients(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  phone text not null check (length(phone) <= 20),
  body text not null check (length(body) <= 1600),
  status text not null default 'sent' check (status in ('sent', 'failed', 'received')),
  error text not null default '' check (length(error) <= 500),
  provider_id text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index sms_messages_org_idx on sms_messages(org_id, created_at desc);
create index sms_messages_client_idx on sms_messages(client_id, created_at);
alter table sms_messages enable row level security;
-- Admins read their company's texts and mark replies read; only the server adds texts.
create policy org_rows on sms_messages for select to authenticated using (is_admin(org_id));
grant select on sms_messages to authenticated;
grant update (read_at) on sms_messages to authenticated;
create policy org_read on sms_messages for update to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
revoke all on sms_messages from anon;

-- A text to a company's number: file it under the company (and the client with that number, if any). Called by the Twilio webhook.
create function record_sms_inbound(p_to text, p_from text, p_body text, p_sid text) returns void
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_client bigint; d text := regexp_replace(p_from, '\D', '', 'g');
begin
  select org_id into v_org from sms_senders where phone = p_to;
  if v_org is null then return; end if;
  select id into v_client from clients
    where org_id = v_org and regexp_replace(phone, '\D', '', 'g') in (d, substr(d, 2)) order by id limit 1;
  insert into sms_messages (org_id, client_id, direction, phone, body, status, provider_id)
    values (v_org, v_client, 'in', left(p_from, 20), left(coalesce(p_body, ''), 1600), 'received', left(coalesce(p_sid, ''), 64));
end $$;
revoke execute on function record_sms_inbound(text, text, text, text) from public, anon, authenticated;
