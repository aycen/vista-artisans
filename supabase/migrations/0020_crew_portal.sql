-- The crew side of Keystone:
-- 1. Job offers: admins offer a job to one or more crew members, who accept or decline it in the app.
-- 2. Referrals: crew refer other contractors; the company pays a bonus once the person completes a job.
-- 3. Requests: crew ask for shirts (sizes and quantities) or a call.
-- 4. Profile photos: shown to the team and to the homeowners whose jobs they're on.

-- ---------- Company settings ----------
alter table company_profiles
  add column referral_bonus_cents bigint not null default 0 check (referral_bonus_cents between 0 and 10000000), -- 0 = no referral program
  add column offer_shirts boolean not null default false;
-- The app owner's own company (comped in 0007) starts with a $250 referral bonus and shirts on.
insert into company_profiles (org_id) select org_id from org_subscriptions where comped on conflict (org_id) do nothing;
update company_profiles set referral_bonus_cents = 25000, offer_shirts = true
  where org_id in (select org_id from org_subscriptions where comped);

-- Crew can read their company's perks (the profile itself stays admin-only).
create function crew_perks(p_org uuid) returns table (referral_bonus_cents bigint, offer_shirts boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(p.referral_bonus_cents, 0), coalesce(p.offer_shirts, false)
  from organizations o left join company_profiles p on p.org_id = o.id where o.id = p_org and is_member(p_org);
$$;

-- ---------- Job offers ----------
create table job_offers (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  job_id bigint not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  payout_cents bigint not null check (payout_cents >= 0 and payout_cents <= 10000000000),
  note text not null default '' check (length(note) <= 2000),
  first_come boolean not null default true,     -- once someone accepts, the other open offers for the job close
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'withdrawn', 'taken')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  foreign key (job_id, org_id) references jobs(id, org_id) on delete cascade
);
create index job_offers_job_idx on job_offers(job_id);
create index job_offers_user_idx on job_offers(user_id, status);
create unique index job_offers_one_open on job_offers(job_id, user_id) where status = 'open';
alter table job_offers enable row level security;
create policy org_rows on job_offers for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy own_offers on job_offers for select to authenticated using (user_id = auth.uid() and is_member(org_id));
grant select, insert, delete on job_offers to authenticated;
grant update (status, responded_at) on job_offers to authenticated;
revoke all on job_offers from anon;

-- Offers can only go to people in the company.
create function check_job_offer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from memberships where org_id = new.org_id and user_id = new.user_id) then
    raise exception 'That person is not on your team.' using errcode = 'VA001';
  end if;
  return new;
end $$;
create trigger check_job_offer before insert on job_offers for each row execute function check_job_offer();
revoke execute on function check_job_offer() from public, anon, authenticated;

-- The crew member's open offers, with what they need to decide (no contract price or other people's pay).
create function my_offers(p_org uuid)
returns table (offer_id bigint, job_id bigint, project_name text, address text, scope text, start_date date, end_date date,
               payout_cents bigint, note text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, j.id, j.project_name, j.address, j.scope, j.start_date, j.end_date, o.payout_cents, o.note, o.created_at
  from job_offers o join jobs j on j.id = o.job_id
  where o.org_id = p_org and o.user_id = auth.uid() and o.status = 'open' and is_member(p_org)
  order by o.created_at desc;
$$;

-- Accept (the job is assigned at the offered pay) or decline.
create function respond_to_offer(p_offer bigint, p_accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare o job_offers;
begin
  select * into o from job_offers where id = p_offer and user_id = auth.uid() for update;
  if not found or not is_member(o.org_id) then raise exception 'Offer not found.' using errcode = 'VA001'; end if;
  if o.status <> 'open' then
    raise exception '%', case o.status when 'taken' then 'Sorry, someone else already took this job.'
      when 'withdrawn' then 'This offer was withdrawn.' else 'You already answered this offer.' end using errcode = 'VA001';
  end if;
  if not p_accept then
    update job_offers set status = 'declined', responded_at = now() where id = p_offer;
    return 'declined';
  end if;
  perform 1 from jobs where id = o.job_id for update;  -- one acceptance at a time per job
  if o.first_come and exists (select 1 from job_offers where job_id = o.job_id and status = 'accepted' and first_come) then
    update job_offers set status = 'taken', responded_at = now() where id = p_offer;
    raise exception 'Sorry, someone else already took this job.' using errcode = 'VA001';
  end if;
  insert into job_assignments (org_id, job_id, user_id, payout_cents) values (o.org_id, o.job_id, o.user_id, o.payout_cents)
    on conflict (job_id, user_id) do update set payout_cents = excluded.payout_cents, updated_at = now();
  update job_offers set status = 'accepted', responded_at = now() where id = p_offer;
  if o.first_come then
    update job_offers set status = 'taken', responded_at = now() where job_id = o.job_id and status = 'open' and first_come;
  end if;
  return 'accepted';
end $$;

-- ---------- Referrals and requests ----------
create table crew_referrals (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  referred_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null check (length(trim(name)) between 1 and 200),
  email text not null default '' check (length(email) <= 200),
  phone text not null default '' check (length(phone) <= 50),
  about text not null default '' check (length(about) <= 2000),
  bonus_cents bigint not null default 0,
  status text not null default 'new' check (status in ('new', 'contacted', 'joined', 'earned', 'paid', 'not_a_fit')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email <> '' or phone <> '')
);
create index crew_referrals_org_idx on crew_referrals(org_id, created_at desc);
alter table crew_referrals enable row level security;
create policy org_rows on crew_referrals for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy own_rows on crew_referrals for select to authenticated using (referred_by = auth.uid() and is_member(org_id));
create policy crew_add on crew_referrals for insert to authenticated with check (referred_by = auth.uid() and is_member(org_id) and status = 'new');
grant select, delete on crew_referrals to authenticated;
grant insert (org_id, name, email, phone, about) on crew_referrals to authenticated;
grant update (status, updated_at) on crew_referrals to authenticated;
revoke all on crew_referrals from anon;
-- The bonus is the company's amount when the referral was made.
create function set_referral_bonus() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.bonus_cents := coalesce((select referral_bonus_cents from company_profiles where org_id = new.org_id), 0);
  return new;
end $$;
create trigger set_referral_bonus before insert on crew_referrals for each row execute function set_referral_bonus();
revoke execute on function set_referral_bonus() from public, anon, authenticated;

create table crew_requests (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('shirts', 'call')),
  details text not null default '' check (length(details) <= 2000),   -- shirt sizes, or what the call is about
  phone text not null default '' check (length(phone) <= 50),
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now()
);
create index crew_requests_org_idx on crew_requests(org_id, status, created_at desc);
alter table crew_requests enable row level security;
create policy org_rows on crew_requests for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
create policy own_rows on crew_requests for select to authenticated using (user_id = auth.uid() and is_member(org_id));
create policy crew_add on crew_requests for insert to authenticated with check (user_id = auth.uid() and is_member(org_id) and status = 'open');
grant select, delete on crew_requests to authenticated;
grant insert (org_id, kind, details, phone) on crew_requests to authenticated;
grant update (status) on crew_requests to authenticated;
revoke all on crew_requests from anon;

-- ---------- Profile photos ----------
create table profile_photos (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  data bytea not null check (octet_length(data) <= 1048576),
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  updated_at timestamptz not null default now()
);
alter table profile_photos enable row level security;
create policy own_photo on profile_photos for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Anyone in a company with them can see their photo.
create policy teammates on profile_photos for select to authenticated using (exists (
  select 1 from memberships a join memberships b on b.org_id = a.org_id where a.user_id = auth.uid() and b.user_id = profile_photos.user_id));
grant select, insert, update, delete on profile_photos to authenticated;
revoke all on profile_photos from anon;

revoke execute on function crew_perks(uuid), my_offers(uuid), respond_to_offer(bigint, boolean) from public, anon;
grant execute on function crew_perks(uuid), my_offers(uuid), respond_to_offer(bigint, boolean) to authenticated;

alter table email_log drop constraint email_log_kind_check;
alter table email_log add constraint email_log_kind_check check (kind in ('estimate', 'estimate_reminder', 'appointment_reminder',
  'review_request', 'estimate_approved', 'estimate_declined', 'work_order', 'change_order', 'change_order_approved',
  'change_order_declined', 'portal', 'job_offer', 'crew_request'));
