-- Deleting a company (admins) and deleting your own account (anyone), as the app stores and Google/Meta require.

-- Deletes a company and everything in it. Jobs go first: an estimate that became a job stays locked while its job exists.
create function delete_organization(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'Only an admin can delete the company.' using errcode = 'VA001'; end if;
  delete from jobs where org_id = p_org;
  delete from organizations where id = p_org;
end $$;

-- Companies the caller is the only admin of: whether anyone else is on them decides if the account can be deleted.
create function my_sole_admin_orgs() returns table (org_id uuid, name text, others int)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, (select count(*)::int from memberships x where x.org_id = o.id and x.user_id <> auth.uid())
  from memberships m join organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and m.role = 'admin'
    and not exists (select 1 from memberships x where x.org_id = m.org_id and x.role = 'admin' and x.user_id <> auth.uid())
  order by o.name;
$$;

-- Removes the caller's own data before the login itself is deleted: companies where they're the only person,
-- every membership, and their profile. Work records other companies keep (assignments, hours) stay with those companies.
create function delete_my_data() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if auth.uid() is null then raise exception 'Not signed in.' using errcode = 'VA001'; end if;
  for r in select * from my_sole_admin_orgs() loop
    if r.others > 0 then
      raise exception 'You''re the only admin of %. Make someone else an admin or delete the company first.', r.name using errcode = 'VA001';
    end if;
    perform delete_organization(r.org_id);
  end loop;
  delete from memberships where user_id = auth.uid();
  delete from profiles where user_id = auth.uid();
end $$;

revoke execute on function delete_organization(uuid), my_sole_admin_orgs(), delete_my_data() from anon, public;
grant execute on function delete_organization(uuid), my_sole_admin_orgs(), delete_my_data() to authenticated;
