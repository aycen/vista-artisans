-- Each line item has a name (description) and a longer description of the work (details).
-- Names and descriptions stay editable after an estimate becomes a job; prices, quantities and options stay locked.
alter table line_items add column details text not null default '' check (length(details) <= 10000);

create or replace function prevent_converted_line_item_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.estimate_id, new.org_id, new.position, new.qty_hundredths, new.unit_price_cents, new.option_name)
    is not distinct from (old.estimate_id, old.org_id, old.position, old.qty_hundredths, old.unit_price_cents, old.option_name) then
    return new;
  end if;
  if exists (select 1 from jobs where estimate_id in (
      case when tg_op = 'INSERT' then null else old.estimate_id end,
      case when tg_op = 'DELETE' then null else new.estimate_id end)) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;

-- The scope of work (built from the line items) can change after conversion too.
create or replace function prevent_converted_estimate_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.client_id, new.project_name, new.estimated_cost_cents, new.status, new.chosen_option,
      new.deposit_percent, new.approved_at, new.signer_name, new.signature, new.public_token)
    is not distinct from (old.client_id, old.project_name, old.estimated_cost_cents, old.status, old.chosen_option,
      old.deposit_percent, old.approved_at, old.signer_name, old.signature, old.public_token) then
    return new;
  end if;
  if exists (select 1 from jobs where estimate_id = old.id) then
    raise exception 'This estimate has been converted to a job and is locked.' using errcode = 'VA001';
  end if;
  return coalesce(new, old);
end $$;
