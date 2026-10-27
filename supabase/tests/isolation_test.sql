-- Run after the migration on a scratch database. Fails loudly on the first broken expectation.
\set ON_ERROR_STOP on
\pset tuples_only on
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@vista.test'), ('00000000-0000-0000-0000-00000000000b', 'bob@other.test'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@vista.test'), ('00000000-0000-0000-0000-00000000000d', 'dave@vista.test');

create function pg_temp.as_user(u text) returns void language sql as
  $$ select set_config('request.jwt.claim.sub', u, false) $$;
create function pg_temp.expect(ok boolean, msg text) returns void language plpgsql as
  $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok: %', msg; end $$;

create function pg_temp.fails(q text) returns boolean language plpgsql as
  $$ begin execute q; return false; exception when sqlstate 'VA001' then return true; end $$;
-- True when the database refuses the statement (row-level security, privileges or a cross-org key).
create function pg_temp.denied(q text) returns boolean language plpgsql as
  $$ begin execute q; return false; exception when insufficient_privilege or foreign_key_violation or check_violation then return true; end $$;

set role authenticated;

-- Alice creates Vista Artisans; Bob creates another company; Carol joins Vista as an admin, Dave as a worker.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select create_organization('Vista Artisans') as vista \gset
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select create_organization('Other Co') as other \gset
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
-- A new company starts on Free (one person); the plan can only be set by the server.
select pg_temp.expect(effective_plan(:'vista') = 'free', 'new companies start on the Free plan');
select pg_temp.expect(pg_temp.fails(format('select add_member_by_email(%L, %L, %L)', :'vista', 'carol@vista.test', 'admin')), 'Free plan is one person');
do $$ begin insert into org_subscriptions (org_id, plan, status) select org_id, 'unlimited', 'active' from memberships limit 1;
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
do $$ begin perform sync_org_subscription((select org_id from memberships limit 1), 'c', 's', 'unlimited', 'month', 'active', now(), false);
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'admins cannot give themselves a plan');
reset role;
select sync_org_subscription(:'vista', 'cus_v', 'sub_v', 'team', 'month', 'active', now() + interval '30 days', false);
set role authenticated;
select add_member_by_email(:'vista', 'CAROL@vista.test', 'admin');
select add_member_by_email(:'vista', 'dave@vista.test', 'worker');
do $$ begin insert into memberships (org_id, user_id, role) select org_id, '00000000-0000-0000-0000-00000000000b', 'admin' from memberships limit 1;
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'memberships cannot be written directly, only through team functions');

-- Alice: client, estimate (3 x 1250.50 + 2.5 x 80.10 = 3952.08 before rounding check), approve, convert twice
insert into clients (org_id, name, address) values (:'vista', 'Jane Rivera', '12 Oak St') returning id as client \gset
insert into estimates (org_id, client_id, project_name, scope, estimated_cost_cents)
  values (:'vista', :client, 'Kitchen', 'Cabinets', 250000) returning id as est \gset
insert into line_items (org_id, estimate_id, position, description, qty_hundredths, unit_price_cents) values
  (:'vista', :est, 0, 'Cabinets', 300, 125050), (:'vista', :est, 1, 'Labor', 250, 8010), (:'vista', :est, 2, 'Hardware', 100, 33);
select pg_temp.expect((select total_cents from estimate_totals where estimate_id = :est) = 395208, 'estimate total is $3,952.08');
do $$ begin perform convert_estimate_to_job((select max(id) from estimates)); raise exception 'should fail'; exception when others then
  if sqlerrm not like 'Only approved%' then raise; end if; end $$;
update estimates set status = 'approved' where id = :est;
select convert_estimate_to_job(:est) as job \gset
select pg_temp.expect(convert_estimate_to_job(:est) = :job, 'second convert returns the same job');
select pg_temp.expect((select count(*) from jobs) = 1, 'only one job exists');
select pg_temp.expect((select contract_cents from jobs where id = :job) = 395208, 'job contract equals approved total');

-- Locked estimate
do $$ begin update estimates set project_name = 'changed'; raise exception 'should fail'; exception when sqlstate 'VA001' then null; end $$;
do $$ begin delete from line_items; raise exception 'should fail'; exception when sqlstate 'VA001' then null; end $$;
do $$ begin delete from clients; raise exception 'should fail'; exception when sqlstate 'VA001' or foreign_key_violation then null; end $$;
select pg_temp.expect((select count(*) from clients) = 1, 'a client with a job cannot be deleted');
select pg_temp.expect(true, 'converted estimate and its line items are locked');

insert into expenses (org_id, job_id, description, amount_cents) values (:'vista', :job, 'Cabinet order', 180010);
insert into expense_receipts (expense_id, org_id, data, content_type) select id, org_id, '\xffd8ff', 'image/jpeg' from expenses;
insert into payments (org_id, job_id, amount_cents, paid_on) values (:'vista', :job, 200000, '2026-10-01');

-- Carol (admin of Vista) sees Vista's data
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect((select count(*) from clients) = 1, 'teammate sees the org''s client');
select pg_temp.expect((select payments_cents from job_totals where job_id = :job) = 200000, 'teammate sees job totals');
-- Dave (worker) sees nothing until assigned
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from worker_schedule(:'vista')) = 0, 'unassigned worker sees no jobs');
-- Carol assigns Dave ($400.00) and herself ($250.50); Bob can't be assigned (not on the team)
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into job_assignments (org_id, job_id, user_id, payout_cents) values
  (:'vista', :job, '00000000-0000-0000-0000-00000000000d', 40000), (:'vista', :job, '00000000-0000-0000-0000-00000000000c', 25050);
select pg_temp.expect(pg_temp.fails(format('insert into job_assignments (org_id, job_id, user_id, payout_cents) values (%L, %s, %L, 1)',
  :'vista', :job, '00000000-0000-0000-0000-00000000000b')), 'only team members can be assigned');
select pg_temp.expect((select payouts_cents from job_totals where job_id = :job) = 65050, 'payouts count toward job costs');
select pg_temp.expect((select count(*) from job_team(:job)) = 2, 'admin sees who is assigned');
-- Dave (worker) sees only his assigned job and his own pay: no money tables at all
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from clients) + (select count(*) from estimates) + (select count(*) from jobs)
  + (select count(*) from expenses) + (select count(*) from payments) + (select count(*) from job_totals)
  + (select count(*) from job_assignments) + (select count(*) from job_team(:job)) + (select count(*) from expense_receipts) = 0, 'worker sees no business tables');
select pg_temp.expect((select count(*) from worker_schedule(:'vista')) = 1, 'worker sees the job on the schedule');
select pg_temp.expect((select my_payout_cents from worker_schedule(:'vista')) = 40000, 'worker sees only his own payout');
select pg_temp.expect((select address || '|' || scope from worker_schedule(:'vista')) = '12 Oak St|Cabinets', 'worker sees address and scope');
select pg_temp.expect((select count(*) || '|' || max(my_payout_cents) from crew_jobs(:'vista')) = '1|40000', 'crew_jobs lists only his own job and pay');
do $$ begin perform add_member_by_email((select org_id from memberships limit 1), 'bob@other.test', 'admin');
  raise exception 'should fail'; exception when sqlstate 'VA001' then null; end $$;
select pg_temp.expect(true, 'worker cannot add people to the org');
-- Time clock: only W-2 crew with a rate clock in, one entry at a time; crew can't write time or read rates
select pg_temp.expect(pg_temp.fails(format('select clock_in(%s)', :job)), 'a subcontractor cannot clock in');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into member_pay (org_id, user_id, pay_type, hourly_rate_cents) values (:'vista', '00000000-0000-0000-0000-00000000000d', 'w2', 3000);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from member_pay) = 0, 'crew cannot read pay rates');
select clock_in(:job);
select pg_temp.expect(pg_temp.fails(format('select clock_in(%s)', :job)), 'only one open clock-in at a time');
select pg_temp.expect(pg_temp.denied(format('insert into time_entries (org_id, job_id, user_id, clock_in, clock_out, rate_cents) values (%L, %s, %L, now() - interval ''9 hours'', now(), 100000)', :'vista', :job, '00000000-0000-0000-0000-00000000000d')),
  'crew cannot write time entries directly');
update time_entries set rate_cents = 1;
select clock_out();
select pg_temp.expect((select count(*) || '|' || max(rate_cents) from time_entries where clock_out is not null) = '1|3000', 'crew see their own closed entry at their real rate');
-- Photos: crew on the job can add one
insert into job_photos (org_id, job_id, data, content_type) values (:'vista', :job, '\x89504e47', 'image/png');
select pg_temp.expect((select count(*) from job_photos) = 1, 'crew see photos on their job');
do $$ begin update jobs set contract_cents = 1; delete from payments; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect((select contract_cents from jobs) = 395208 and (select count(*) from payments) = 1, 'worker could not change money');
select set_member_role(:'vista', '00000000-0000-0000-0000-00000000000c', 'worker');
select pg_temp.expect(pg_temp.fails(format('select set_member_role(%L, %L, %L)', :'vista', '00000000-0000-0000-0000-00000000000a', 'worker')),
  'the last admin cannot be made a worker');
select pg_temp.expect(pg_temp.fails(format('select remove_member(%L, %L)', :'vista', '00000000-0000-0000-0000-00000000000a')),
  'admins cannot remove themselves');
select set_member_role(:'vista', '00000000-0000-0000-0000-00000000000c', 'admin');


-- Bob (other org) sees nothing of Vista and cannot write into it
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from clients) = 0, 'other org sees no clients');
select pg_temp.expect((select count(*) from estimates) = 0, 'other org sees no estimates');
select pg_temp.expect((select count(*) from line_items) = 0, 'other org sees no line items');
select pg_temp.expect((select count(*) from jobs) = 0, 'other org sees no jobs');
select pg_temp.expect((select count(*) from expenses) + (select count(*) from payments) = 0, 'other org sees no expenses or payments');
select pg_temp.expect((select count(*) from job_totals) + (select count(*) from estimate_totals) = 0, 'other org sees no totals');
select pg_temp.expect((select count(*) from organizations) = 1, 'other org sees only its own organization');
select pg_temp.expect((select count(*) from worker_schedule(:'vista')) = 0, 'other org cannot read the schedule');
select pg_temp.expect((select count(*) from crew_jobs(:'vista')) = 0, 'other org cannot read crew jobs');
select pg_temp.expect((select count(*) from expense_receipts) = 0, 'other org sees no receipts');
do $$ begin
  insert into expense_receipts (expense_id, org_id, data, content_type) values (1, (select id from organizations), '\xffd8ff', 'image/jpeg');
  raise exception 'should fail';
exception when foreign_key_violation or insufficient_privilege or check_violation or unique_violation then null; end $$;
select pg_temp.expect(true, 'cannot attach a receipt to another org''s expense');
select pg_temp.expect((select count(*) from job_photos) + (select count(*) from time_entries) + (select count(*) from member_pay) = 0,
  'other org sees no photos, time or pay rates');
select pg_temp.expect(pg_temp.denied(format('insert into job_photos (org_id, job_id, data, content_type) values (%L, %s, %L, %L)',
  (select id from organizations), :job, '\x89504e47', 'image/png')), 'cannot add a photo to another org''s job');
select pg_temp.expect(pg_temp.fails(format('select clock_in(%s)', :job)), 'cannot clock in on another org''s job');
update clients set name = 'hacked'; delete from payments;
do $$ begin insert into clients (org_id, name) select id, 'x' from organizations where name = 'Vista Artisans';
  if found then raise exception 'should fail'; end if; end $$;
do $$ begin perform convert_estimate_to_job(1); raise exception 'should fail'; exception when others then
  if sqlerrm not like 'Estimate not found%' then raise; end if; end $$;
-- Bob tries to attach his own estimate to Vista's client id (cross-org link)
do $$ begin
  insert into estimates (org_id, client_id, project_name) values ((select id from organizations), (select 1), 'steal');
  raise exception 'should fail';
exception when foreign_key_violation then null; end $$;
select pg_temp.expect(true, 'cannot link to another org''s client');
do $$ begin insert into clients (org_id, name) values ('00000000-0000-0000-0000-000000000000'::uuid, 'x'); raise exception 'should fail';
exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'cannot insert into an org you are not in');

-- Back as Alice: Bob's update/delete attempts changed nothing
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect((select name from clients where id = :client) = 'Jane Rivera', 'other org could not edit clients');
select pg_temp.expect((select count(*) from payments) = 1, 'other org could not delete payments');

-- Join codes: only admins can read the code; a new person joins with it as a worker
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000e', 'erin@vista.test');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect(org_join_code(:'vista') is null, 'workers cannot see the join code');
do $$ begin perform join_code from organizations; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'the join code column cannot be selected directly');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select org_join_code(:'vista') as code \gset
select pg_temp.expect(length(:'code') = 8, 'admin sees an 8-character code');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.expect(pg_temp.fails('select join_organization(''WRONG123'')'), 'a wrong code is refused');
select pg_temp.expect(join_organization(lower(substr(:'code', 1, 4)) || '-' || lower(substr(:'code', 5))) = :'vista'::uuid,
  'code works regardless of case and dashes');
select pg_temp.expect((select role from memberships where user_id = '00000000-0000-0000-0000-00000000000e') = 'worker', 'joining makes you a worker');
select pg_temp.expect((select count(*) from clients) = 0, 'a new joiner sees no business data');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect(regenerate_join_code(:'vista') <> :'code', 'admin can change the code');
do $$ begin update organizations set join_code = 'EASY1234'; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'nobody can pick their own join code directly');

-- Company profile: admins only, own company only. Completing a job stamps completed_at.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into company_profiles (org_id, phone, logo, logo_type) values (:'vista', '555-1111', '\x89504e47', 'image/png');
update jobs set status = 'completed' where id = :job;
select pg_temp.expect((select completed_at is not null from jobs where id = :job), 'completing a job records when');
update jobs set status = 'in_progress' where id = :job;
select pg_temp.expect((select completed_at is null from jobs where id = :job), 'reopening a job clears the completion time');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from company_profiles) = 0, 'workers cannot read the company profile');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from company_profiles) = 0, 'other companies cannot read the profile');
select set_config('t.vista', :'vista', false);
do $$ begin insert into company_profiles (org_id) values (current_setting('t.vista')::uuid);
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'other companies cannot write the profile');

-- Invoices: admins of the company only; the webhook's payment function can't be called by signed-in users
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into invoices (org_id, job_id, stripe_invoice_id, amount_cents) values (:'vista', :job, 'in_test_1', 1000);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from invoices) = 0, 'workers cannot see invoices');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from invoices) = 0, 'other companies cannot see invoices');
do $$ begin perform record_stripe_payment(current_setting('t.vista')::uuid, 1, 'in_test_1', 1000, current_date, '', '', '');
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'signed-in users cannot record Stripe payments');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin insert into stripe_accounts (org_id, account_id) values (current_setting('t.vista')::uuid, 'acct_someone_else');
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'admins cannot link a Stripe account directly (only the server can)');

-- Profiles: your own row only; admins see teammates' phone and address, workers see names only
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
insert into profiles (user_id, full_name, phone, address) values ('00000000-0000-0000-0000-00000000000d', 'Dave Diaz', '555-0100', '4 Pine Ct');
do $$ begin insert into profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000000a', 'Hacked');
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'cannot write someone else''s profile');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into profiles (user_id, full_name, phone) values ('00000000-0000-0000-0000-00000000000c', 'Carol Chen', '555-0199');
select pg_temp.expect((select count(*) from profiles) = 1, 'profiles table shows only your own row');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect((select phone from org_members(current_setting('t.vista')::uuid) where full_name = 'Dave Diaz') = '555-0100', 'admins see teammates'' phone');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select phone from org_members(current_setting('t.vista')::uuid) where full_name = 'Carol Chen') = '', 'workers do not see teammates'' phone');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from org_members(current_setting('t.vista')::uuid)) = 0, 'other companies see no members');
select pg_temp.expect((select count(*) from org_subscriptions) = 0, 'other companies cannot see a plan');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from org_subscriptions) = 0, 'workers cannot see the plan');

-- Online approvals: only the server writes the client's signature; email history stays within the company
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin update estimates set signer_name = 'Forged', approved_at = now(); raise exception 'should fail';
  exception when insufficient_privilege then null; end $$;
do $$ begin update estimates set public_token = 'guessable'; raise exception 'should fail';
  exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'companies cannot forge a client signature or change the link');
reset role;
insert into email_log (org_id, kind, to_email, subject, status) values (current_setting('t.vista')::uuid, 'estimate', 'x@y.z', 'Hi', 'sent');
set role authenticated;
select pg_temp.expect((select count(*) from email_log) = 1, 'admins see their email history');
do $$ begin insert into email_log (org_id, kind, to_email, subject, status) values (current_setting('t.vista')::uuid, 'estimate', 'x@y.z', 'Hi', 'sent');
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'email history is written only by the server');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from email_log) = 0, 'other companies cannot see email history');
select pg_temp.expect((select count(*) from estimates where public_token is not null) = 0, 'other companies cannot see estimate links');

-- Subcontractors without accounts: admins only, within their company
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into subcontractors (org_id, name) values (current_setting('t.vista')::uuid, 'Leo Tile');
select set_config('t.sub', (select id::text from subcontractors where name = 'Leo Tile'), false);
insert into sub_assignments (org_id, job_id, sub_id, payout_cents)
  select org_id, id, current_setting('t.sub')::bigint, 5000 from jobs where org_id = current_setting('t.vista')::uuid limit 1;
select pg_temp.expect((select count(*) from sub_assignments) = 1, 'admins assign subs to jobs');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from subcontractors) = 0 and (select count(*) from sub_assignments) = 0, 'other companies cannot see subs');
do $$ begin insert into subcontractors (org_id, name) values (current_setting('t.vista')::uuid, 'Spy'); raise exception 'should fail';
  exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'other companies cannot add subs');
select pg_temp.expect(pg_temp.fails(format('select link_subcontractor(%s, %L)', current_setting('t.sub'), '00000000-0000-0000-0000-00000000000b')), 'other companies cannot link a sub');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from subcontractors) = 0, 'crew cannot see subs');
select pg_temp.expect(pg_temp.fails(format('select link_subcontractor(%s, %L)', current_setting('t.sub'), '00000000-0000-0000-0000-00000000000d')), 'crew cannot link a sub');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect(pg_temp.fails(format('select link_subcontractor(%s, %L)', current_setting('t.sub'), '00000000-0000-0000-0000-00000000000b')), 'subs link only to someone on the team');
select link_subcontractor(current_setting('t.sub')::bigint, '00000000-0000-0000-0000-00000000000d');
select pg_temp.expect((select count(*) from subcontractors) = 0 and (select count(*) from job_assignments where user_id = '00000000-0000-0000-0000-00000000000d' and payout_cents >= 5000) >= 1, 'linking moves the work to their account');

-- Texting signup: only the server writes it; admins see only their own
reset role;
insert into sms_registrations (org_id, business_name, business_type, street, city, state, zip, website, contact_first_name, contact_last_name, contact_email, contact_phone)
  values (current_setting('t.vista')::uuid, 'Vista', 'SOLE_PROPRIETOR', '1 A St', 'X', 'PA', '17601', 'https://x.com', 'A', 'B', 'a@b.c', '+15555550100');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect((select count(*) from sms_registrations) = 1, 'admins see their texting signup');
do $$ begin update sms_registrations set status = 'approved'; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'companies cannot mark their own texting approved');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect((select count(*) from sms_registrations) = 0, 'other companies cannot see a texting signup');

-- Deleting: only an admin can delete their own company; deleting your account never touches a company others are in
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect(pg_temp.fails(format('select delete_organization(%L)', current_setting('t.vista'))), 'other companies cannot delete a company');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.expect(pg_temp.fails(format('select delete_organization(%L)', current_setting('t.vista'))), 'crew cannot delete their company');
select pg_temp.expect((select count(*) from my_sole_admin_orgs()) = 0, 'crew are nobody''s only admin');
select delete_my_data();
reset role;
select pg_temp.expect((select count(*) from organizations where id = current_setting('t.vista')::uuid) = 1, 'a crew member deleting their account leaves the company');
select pg_temp.expect((select count(*) from memberships where user_id = '00000000-0000-0000-0000-00000000000d') = 0, 'and removes their memberships');
set role authenticated;

-- Signed-out (anon) gets nothing
reset role; set role anon;
do $$ begin perform count(*) from clients; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select pg_temp.expect(true, 'signed-out visitors cannot read any table');
reset role;
\echo ALL ISOLATION TESTS PASSED
