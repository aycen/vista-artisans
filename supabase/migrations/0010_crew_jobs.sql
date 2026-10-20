-- Crew get their own overview and job list: every job they're assigned to, open or completed,
-- with only what crew may see (dates, address, scope, notes and their own pay).
create function crew_jobs(p_org uuid)
returns table (job_id bigint, project_name text, client_name text, address text, scope text, status text,
               start_date date, end_date date, completed_at timestamptz, notes text, my_payout_cents bigint)
language sql stable security definer set search_path = public as $$
  select j.id, j.project_name, c.name, j.address, j.scope, j.status, j.start_date, j.end_date, j.completed_at, j.notes, a.payout_cents
  from jobs j
  join clients c on c.id = j.client_id
  join job_assignments a on a.job_id = j.id and a.user_id = auth.uid()
  where j.org_id = p_org and is_member(p_org)
  order by j.status = 'completed', j.start_date nulls last, j.id;
$$;
revoke execute on function crew_jobs(uuid) from public, anon;
grant execute on function crew_jobs(uuid) to authenticated;
