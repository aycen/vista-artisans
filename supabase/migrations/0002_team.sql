-- Team management and the worker view.
-- Admins add people who already have an account, change their role, or remove them.
-- An organization always keeps at least one admin.
-- Errors meant for the person using the app use SQLSTATE VA001.

-- Members of an organization with their email (auth.users is not readable by app users directly).
create function org_members(p_org uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from memberships m join auth.users u on u.id = m.user_id
  where m.org_id = p_org and is_member(p_org)
  order by m.created_at;
$$;

create function add_member_by_email(p_org uuid, p_email text, p_role text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not is_admin(p_org) then raise exception 'Only an admin can add people.' using errcode = 'VA001'; end if;
  if p_role not in ('admin', 'worker') then raise exception 'Choose Admin or Worker.' using errcode = 'VA001'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No account uses that email yet. Ask them to sign up first, then add them.' using errcode = 'VA001';
  end if;
  if exists (select 1 from memberships where org_id = p_org and user_id = v_user) then
    raise exception 'That person is already on this team. Change their role instead.' using errcode = 'VA001';
  end if;
  insert into memberships (org_id, user_id, role) values (p_org, v_user, p_role);
  return v_user;
end $$;

create function set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'Only an admin can change roles.' using errcode = 'VA001'; end if;
  if p_role not in ('admin', 'worker') then raise exception 'Choose Admin or Worker.' using errcode = 'VA001'; end if;
  perform 1 from memberships where org_id = p_org for update;  -- serialize team changes
  if p_role = 'worker' and not exists (select 1 from memberships where org_id = p_org and role = 'admin' and user_id <> p_user) then
    raise exception 'The team needs at least one admin. Make someone else an admin first.' using errcode = 'VA001';
  end if;
  update memberships set role = p_role where org_id = p_org and user_id = p_user;
end $$;

create function remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'Only an admin can remove people.' using errcode = 'VA001'; end if;
  if p_user = auth.uid() then raise exception 'You cannot remove yourself.' using errcode = 'VA001'; end if;
  perform 1 from memberships where org_id = p_org for update;
  if not exists (select 1 from memberships where org_id = p_org and role = 'admin' and user_id <> p_user) then
    raise exception 'The team needs at least one admin. Make someone else an admin first.' using errcode = 'VA001';
  end if;
  delete from memberships where org_id = p_org and user_id = p_user;
end $$;

-- What a worker may see: open jobs' schedule, address and scope of work, with no money. Admins get the same list.
create function worker_schedule(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text,
               status text, scheduled_date date, notes text)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.scheduled_date, j.notes
  from jobs j join clients c on c.id = j.client_id
  where j.org_id = p_org and is_member(p_org) and j.status <> 'completed'
  order by j.scheduled_date nulls last, j.id;
$$;

revoke execute on function org_members(uuid), add_member_by_email(uuid, text, text), set_member_role(uuid, uuid, text),
  remove_member(uuid, uuid), worker_schedule(uuid) from anon, public;
grant execute on function org_members(uuid), add_member_by_email(uuid, text, text), set_member_role(uuid, uuid, text),
  remove_member(uuid, uuid), worker_schedule(uuid) to authenticated;
