-- Job offers get an optional deadline to accept; after it passes the offer can't be accepted.
alter table job_offers add column respond_by timestamptz;

drop function my_offers(uuid);
create function my_offers(p_org uuid)
returns table (offer_id bigint, job_id bigint, project_name text, address text, scope text, start_date date, end_date date,
               payout_cents bigint, note text, created_at timestamptz, respond_by timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, j.id, j.project_name, j.address, j.scope, j.start_date, j.end_date, o.payout_cents, o.note, o.created_at, o.respond_by
  from job_offers o join jobs j on j.id = o.job_id
  where o.org_id = p_org and o.user_id = auth.uid() and o.status = 'open' and is_member(p_org)
    and (o.respond_by is null or o.respond_by > now())
  order by o.created_at desc;
$$;
revoke execute on function my_offers(uuid) from public, anon;
grant execute on function my_offers(uuid) to authenticated;

create or replace function respond_to_offer(p_offer bigint, p_accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare o job_offers;
begin
  select * into o from job_offers where id = p_offer and user_id = auth.uid() for update;
  if not found or not is_member(o.org_id) then raise exception 'Offer not found.' using errcode = 'VA001'; end if;
  if o.status <> 'open' then
    raise exception '%', case o.status when 'taken' then 'Sorry, someone else already took this job.'
      when 'withdrawn' then 'This offer was withdrawn.' else 'You already answered this offer.' end using errcode = 'VA001';
  end if;
  if o.respond_by is not null and o.respond_by <= now() then
    raise exception 'Sorry, the deadline to accept this offer has passed.' using errcode = 'VA001';
  end if;
  if not p_accept then
    update job_offers set status = 'declined', responded_at = now() where id = p_offer;
    return 'declined';
  end if;
  perform 1 from jobs where id = o.job_id for update;
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
