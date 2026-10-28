-- Calendar events: admins block off time (networking events, inspections, anything else that affects availability).
-- They show on the Jobs calendar next to jobs and estimate visits. Times are optional (no start time = all day).
create table calendar_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  start_date date not null,
  end_date date not null,
  start_time time,
  end_time time,
  notes text not null default '' check (length(notes) <= 2000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 366),
  check (end_time is null or start_time is not null)
);
create index calendar_events_org_idx on calendar_events(org_id, start_date);
alter table calendar_events enable row level security;
create policy org_rows on calendar_events for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on calendar_events to authenticated;
revoke all on calendar_events from anon;
