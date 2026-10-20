-- A photo or PDF of the receipt for an expense (optional, one per expense).
alter table expenses add constraint expenses_id_org_key unique (id, org_id);
create table expense_receipts (
  expense_id bigint primary key,
  org_id uuid not null,
  data bytea not null check (octet_length(data) <= 5242880),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'application/pdf')),
  filename text not null default '' check (length(filename) <= 200),
  created_at timestamptz not null default now(),
  foreign key (expense_id, org_id) references expenses(id, org_id) on delete cascade
);
alter table expense_receipts enable row level security;
create policy org_rows on expense_receipts for all to authenticated using (is_admin(org_id)) with check (is_admin(org_id));
grant select, insert, update, delete on expense_receipts to authenticated;
revoke all on expense_receipts from anon;
