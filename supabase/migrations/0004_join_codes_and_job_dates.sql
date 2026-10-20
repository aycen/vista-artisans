-- 1. Join codes: people join an existing organization by typing its code instead of creating their own.
--    Joining with a code makes you a worker; an admin can promote you on the Team page.
-- 2. Jobs get a start date and an optional end date (the old single scheduled date becomes the start date).

-- ---------- Join codes ----------
-- 8 characters without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX.
create function new_join_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text := '';
  b bytea := uuid_send(gen_random_uuid()); -- core Postgres randomness, no extension needed
begin
  for i in 0..7 loop
    -- skip bytes 6 and 8, which hold the UUID's fixed version and variant bits
    code := code || substr(alphabet, (get_byte(b, (array[0, 1, 2, 3, 4, 5, 9, 10])[i + 1]) % length(alphabet)) + 1, 1);
  end loop;
  return code;
end $$;

alter table organizations add column join_code text;
update organizations set join_code = new_join_code() where join_code is null;
alter table organizations alter column join_code set not null;
alter table organizations alter column join_code set default new_join_code();
alter table organizations add constraint organizations_join_code_key unique (join_code);
-- The code is readable only through org_join_code() (admins), not by selecting the table.
revoke select on organizations from authenticated;
grant select (id, name, created_at) on organizations to authenticated;
revoke update on organizations from authenticated;
grant update (name) on organizations to authenticated;

-- Admins read their organization's code through this function (members don't see it).
create function org_join_code(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select join_code from organizations where id = p_org and is_admin(p_org);
$$;

create function regenerate_join_code(p_org uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not is_admin(p_org) then raise exception 'Only an admin can change the join code.' using errcode = 'VA001'; end if;
  update organizations set join_code = new_join_code() where id = p_org returning join_code into v_code;
  return v_code;
end $$;

-- Simple guard against guessing codes: at most 10 failed attempts per person per hour.
create table join_attempts (
  user_id uuid not null,
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_idx on join_attempts(user_id, attempted_at);
alter table join_attempts enable row level security; -- no policies: only the function below touches it
revoke all on join_attempts from anon, authenticated;

create function join_organization(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Not signed in.' using errcode = 'VA001'; end if;
  if (select count(*) from join_attempts where user_id = auth.uid() and attempted_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many tries. Wait an hour, or ask your admin to add you by email.' using errcode = 'VA001';
  end if;
  select id into v_org from organizations where join_code = v_code;
  if v_org is null then
    raise exception 'That code doesn''t match any company. Check it with your admin.' using errcode = 'VA001';
  end if;
  insert into memberships (org_id, user_id, role) values (v_org, auth.uid(), 'worker') on conflict do nothing;
  return v_org;
end $$;

-- The error above undoes anything join_organization wrote, so the app records a failed attempt
-- separately by calling record_failed_join() after a bad code.
create function record_failed_join() returns void
language sql security definer set search_path = public as $$
  insert into join_attempts (user_id) select auth.uid() where auth.uid() is not null;
$$;

-- ---------- Job dates ----------
alter table jobs rename column scheduled_date to start_date;
alter table jobs add column end_date date;
alter table jobs add constraint jobs_dates_order check (end_date is null or start_date is null or end_date >= start_date);

drop function worker_schedule(uuid);
create function worker_schedule(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text,
               status text, start_date date, end_date date, notes text, my_payout_cents bigint)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.start_date, j.end_date, j.notes, a.payout_cents
  from jobs j
  join clients c on c.id = j.client_id
  left join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
  where j.org_id = p_org and is_member(p_org) and j.status <> 'completed'
    and (is_admin(p_org) or a.user_id is not null)
  order by j.start_date nulls last, j.id;
$$;

revoke execute on function new_join_code(), org_join_code(uuid), regenerate_join_code(uuid), join_organization(text),
  record_failed_join(), worker_schedule(uuid) from anon, public;
grant execute on function org_join_code(uuid), regenerate_join_code(uuid), join_organization(text),
  record_failed_join(), worker_schedule(uuid) to authenticated;
