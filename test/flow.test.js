'use strict';
// End-to-end tests against a real server process, a fresh Postgres database with the Supabase
// migrations applied, and a local stand-in for Supabase Auth.
// Needs a Postgres 16 server: set TEST_PG_ADMIN_URL (default: postgres on localhost:5432).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');
const { startFakeAuth } = require('./fake-supabase-auth');
const { fmt } = require('../src/money');
const { startFakeStripe } = require('./fake-stripe');
const { startFakeEmail } = require('./fake-email');
const crypto = require('node:crypto');

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgresql://postgres@localhost:5432/postgres';
const DB_NAME = `vista_test_${process.pid}`;
const DB_URL = ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);
const ANON = 'test-anon-key';
const PORT = 7000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
let proc; let fakeAuth; let dbClient;

async function start(extraEnv = {}) {
  proc = spawn(process.execPath, ['--no-warnings', path.join(root, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL, DATABASE_SSL: '0', SUPABASE_URL: fakeAuth.url, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.once('data', resolve));
}
async function stop() { proc.kill(); await new Promise((r) => proc.once('exit', r)); }

// One cookie jar per person.
const jars = { alice: {}, bob: {}, carol: {}, dave: {}, erin: {}, frank: {}, gina: {}, hank: {}, ivy: {}, anon: {} };
let who = 'alice';
const as = (name) => { who = name; };
// Estimates have no separate project name any more: the job address is the name. The older tests below name their
// projects ("Kitchen remodel", "Deck"…), so a project_name they send is used as the address unless they give one.
function estimateForm(p, params) {
  if (/^\/estimates(\/\d+)?$/.test(p) && params.has('project_name')) {
    if (!params.has('address')) params.set('address', params.get('project_name'));
    params.delete('project_name');
  }
  return params;
}
async function req(method, p, form, { auth = true } = {}) {
  const jar = auth ? jars[who] : {};
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: {
      cookie: Object.entries(jar).map(([k, val]) => `${k}=${val}`).join('; '),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? estimateForm(p, new URLSearchParams(form)).toString() : undefined,
  });
  const setCookies = res.headers.getSetCookie();
  if (auth) {
    for (const c of setCookies) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i); const val = kv.slice(i + 1);
      if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = val;
    }
  }
  return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), setCookies, body: await res.text() };
}
const post = (p, form, o) => req('POST', p, form, o);
const getPage = (p, o) => req('GET', p, undefined, o);
const idFrom = (loc) => Number(loc.match(/\/(\d+)/)[1]);
const stat = (body, k) => body.match(new RegExp(`data-k="${k}">([^<]+)<`))[1];

test.before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  dbClient = new pg.Client({ connectionString: DB_URL });
  await dbClient.connect();
  const roles = await dbClient.query("SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'");
  let stub = fs.readFileSync(path.join(root, 'supabase/tests/local_auth_stub.sql'), 'utf8');
  if (roles.rowCount) stub = stub.replace(/create role [^;]+;\n/g, ''); // roles are cluster-wide
  await dbClient.query(stub);
  for (const f of fs.readdirSync(path.join(root, 'supabase/migrations')).sort()) {
    await dbClient.query(fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8'));
  }
  fakeAuth = await startFakeAuth(dbClient, ANON);
  await start();
});
test.after(async () => {
  await stop(); await fakeAuth.close(); await dbClient.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`); await admin.end();
});

test('accounts: sign up, create organization, and everything requires login', async () => {
  as('anon');
  for (const p of ['/clients', '/estimates', '/jobs', '/clients/1', '/team']) {
    const r = await getPage(p);
    assert.equal(r.status, 303); assert.equal(r.location, '/login');
  }
  assert.equal((await post('/clients', { name: 'Hacker' })).status, 401);
  jars.anon = { sa: 'forged', sr: 'forged' };
  assert.equal((await getPage('/clients')).location, '/login');
  // Logged out, the home page shows what Keystone is
  let home = await getPage('/');
  assert.equal(home.status, 200); assert.match(home.body, /Start free/); assert.match(home.body, /href="\/data-deletion"/);
  jars.anon = {};

  // Validation on sign-up
  let r = await post('/signup', { email: 'bad', password: 'short' });
  assert.equal(r.status, 422); assert.match(r.body, /valid email/); assert.match(r.body, /at least 8/);

  // Alice signs up and lands on the welcome page: join with a code, or start a company
  as('alice');
  r = await post('/signup', { email: 'alice@vista.test', password: 'alice-password' });
  assert.equal(r.status, 303);
  assert.match(r.setCookies.join(), /HttpOnly/);
  assert.equal((await getPage('/')).location, '/welcome');
  r = await getPage('/welcome'); assert.match(r.body, /Join your company/); assert.match(r.body, /Start a new company/);
  r = await post('/org/new', { name: '' }); assert.equal(r.status, 422); assert.match(r.body, /Company name is required/);
  r = await post('/org/new', { name: 'Vista Artisans' }); assert.equal(r.status, 303);
  r = await getPage('/'); assert.equal(r.status, 200); assert.match(r.body, /Vista Artisans/);

  // Wrong password is rejected; right one works
  as('anon');
  assert.equal((await post('/login', { email: 'alice@vista.test', password: 'nope' })).status, 401);
});

test('full workflow', async () => {
  as('alice');
  // Validation keeps entered information
  let r = await post('/clients', { name: '', phone: '555-123-4567', email: 'not-an-email', address: '12 Oak St' });
  assert.equal(r.status, 422);
  assert.match(r.body, /Client name is required/); assert.match(r.body, /Email address does not look valid/);
  assert.match(r.body, /value="12 Oak St"/);

  // 1. Create client
  r = await post('/clients', { name: 'Jane Rivera', phone: '555-123-4567', email: 'jane@example.com', address: '12 Oak St, Austin TX' });
  assert.equal(r.status, 303);
  const clientId = idFrom(r.location);

  // Search clients by name
  assert.match((await getPage('/clients?q=rive')).body, /Jane Rivera/);
  assert.doesNotMatch((await getPage('/clients?q=zzz')).body, /Jane Rivera/);

  // Bad money input is rejected and the form is preserved
  r = await post('/estimates', new URLSearchParams([
    ['client_id', String(clientId)], ['project_name', 'Kitchen remodel'], ['scope', 'Cabinets'], ['estimated_cost', '12.345'],
    ['item_desc', 'Cabinets'], ['item_qty', '1'], ['item_price', 'abc'],
  ]));
  assert.equal(r.status, 422);
  assert.match(r.body, /Estimated cost must be a number/); assert.match(r.body, /Line 1: Unit price must be a number/);
  assert.match(r.body, /value="Kitchen remodel"/);

  // 2. Create estimate: 3 x 1,250.50 + 2.5 x 80.10 (=200.25) + 1 x 0.33 = 3751.50 + 200.25 + 0.33 = 3952.08
  r = await post('/estimates', new URLSearchParams([
    ['client_id', String(clientId)], ['project_name', 'Kitchen remodel'], ['scope', 'Replace cabinets and counters'],
    ['estimated_cost', '2,500.00'], ['status', 'draft'],
    ['item_desc', 'Cabinets'], ['item_qty', '3'], ['item_price', '$1,250.50'],
    ['item_desc', 'Labor hours'], ['item_qty', '2.5'], ['item_price', '80.10'],
    ['item_desc', ''], ['item_qty', ''], ['item_price', ''],
    ['item_desc', 'Hardware'], ['item_qty', '1'], ['item_price', '0.33'],
  ]));
  assert.equal(r.status, 303);
  const estId = idFrom(r.location);

  // 3. Reopen (fresh GET) and check totals + profit (3952.08 - 2500.00 = 1452.08)
  r = await getPage(`/estimates/${estId}`);
  assert.match(r.body, /id="estimate-total">\$3,952\.08</);
  assert.match(r.body, /id="estimated-profit">\$1,452\.08</);
  r = await getPage(`/estimates/${estId}/edit`);
  assert.match(r.body, /value="Labor hours"/); assert.match(r.body, /value="2\.5"/); assert.match(r.body, /value="2500\.00"/);

  // Edit: remove the hardware line, change a quantity
  r = await post(`/estimates/${estId}`, new URLSearchParams([
    ['client_id', String(clientId)], ['project_name', 'Kitchen remodel'], ['scope', 'Replace cabinets and counters'],
    ['estimated_cost', '2500'], ['status', 'sent'],
    ['item_desc', 'Cabinets'], ['item_qty', '3'], ['item_price', '1250.50'],
    ['item_desc', 'Labor hours'], ['item_qty', '10'], ['item_price', '80.10'],
  ]));
  assert.equal(r.status, 303);
  r = await getPage(`/estimates/${estId}`);
  assert.match(r.body, /id="estimate-total">\$4,552\.50</); // 3751.50 + 801.00
  assert.match(r.body, /id="estimated-profit">\$2,052\.50</);

  // Cannot convert before approval
  r = await post(`/estimates/${estId}/convert`, {});
  assert.equal(r.status, 422);

  // Home shows the open estimate
  r = await getPage('/');
  assert.match(r.body, /Kitchen remodel/);

  // 4. Approve
  r = await post(`/estimates/${estId}/status`, { status: 'approved' });
  assert.equal(r.status, 303);

  // 5. Convert, with repeated clicks (sent concurrently) -> exactly one job
  const clicks = await Promise.all([1, 2, 3, 4, 5].map(() => post(`/estimates/${estId}/convert`, {})));
  const jobIds = new Set(clicks.map((c) => idFrom(c.location)));
  assert.equal(jobIds.size, 1, 'repeated clicks must not create duplicate jobs');
  const jobId = [...jobIds][0];
  r = await getPage('/jobs');
  assert.equal((r.body.match(/<a class="li" href="\/jobs\/\d+"/g) || []).length, 1);

  // Job carries client, address, scope and approved price
  r = await getPage(`/jobs/${jobId}`);
  assert.match(r.body, /Jane Rivera/); assert.match(r.body, /Job address<\/div><div class="t">Kitchen remodel</);
  assert.match(r.body, /• Cabinets\n\n• Labor hours/, 'scope of work is the line item descriptions');
  assert.equal(stat(r.body, 'contract'), '$4,552.50');
  assert.match(r.body, /\(provisional\)/);

  // Converted estimate is locked
  r = await getPage(`/estimates/${estId}/edit`); assert.equal(r.location, `/estimates/${estId}/descriptions`);
  // …except line item names and descriptions, which stay editable and update the job's scope of work
  const lines = (await dbClient.query('SELECT id FROM line_items WHERE estimate_id = $1 ORDER BY position', [estId])).rows.map((x) => x.id);
  assert.match((await getPage(`/estimates/${estId}/descriptions`)).body, /Prices and quantities are locked/);
  r = await post(`/estimates/${estId}/descriptions`, { [`name_${lines[0]}`]: '', [`details_${lines[0]}`]: '' });
  assert.equal(r.status, 422); assert.match(r.body, /Line 1: name is required/);
  r = await post(`/estimates/${estId}/descriptions`, { [`name_${lines[0]}`]: 'Cabinets', [`details_${lines[0]}`]: 'Shaker style, soft-close\nRemove old boxes',
    [`name_${lines[1]}`]: 'Labor', [`details_${lines[1]}`]: '' });
  assert.equal(r.location, `/jobs/${jobId}?msg=Scope+of+work+updated`);
  assert.equal((await dbClient.query('SELECT scope FROM jobs WHERE id = $1', [jobId])).rows[0].scope,
    '• Cabinets\nShaker style, soft-close\nRemove old boxes\n\n• Labor');
  assert.match((await getPage(`/estimates/${estId}`)).body, /class="li-details">Shaker style, soft-close\nRemove old boxes</);
  assert.equal(stat((await getPage(`/jobs/${jobId}`)).body, 'contract'), '$4,552.50', 'prices unchanged');
  assert.equal((await getPage(`/estimates/${estId}/pdf`)).type, 'application/pdf');
  r = await post(`/estimates/${estId}`, { client_id: String(clientId), project_name: 'Changed', item_desc: 'x', item_qty: '1', item_price: '1' });
  assert.equal(r.status, 409);
  r = await post(`/estimates/${estId}/status`, { status: 'declined' }); assert.equal(r.status, 409);
  assert.match((await getPage(`/estimates/${estId}`)).body, /locked/);

  // 6. Expenses (with a mistaken one corrected and another deleted)
  r = await post(`/jobs/${jobId}/expenses`, { description: 'Cabinet order', amount: '' });
  assert.equal(r.status, 422); assert.match(r.body, /Expense amount is required/); assert.match(r.body, /value="Cabinet order"/);
  r = await post(`/jobs/${jobId}/expenses`, { description: 'Cabinet order', amount: '1800.10' }); assert.equal(r.status, 303);
  r = await post(`/jobs/${jobId}/expenses`, { description: 'Lumber', amount: '99.99' }); assert.equal(r.status, 303);
  r = await post(`/jobs/${jobId}/expenses`, { description: 'Typo', amount: '5000' }); assert.equal(r.status, 303);
  let page = (await getPage(`/jobs/${jobId}`)).body;
  const expenseIds = [...page.matchAll(/\/expenses\/(\d+)\/edit/g)].map((m) => Number(m[1]));
  assert.equal(expenseIds.length, 3);
  r = await post(`/expenses/${expenseIds[1]}`, { description: 'Lumber', amount: '199.90' }); assert.equal(r.status, 303);
  r = await getPage(`/expenses/${expenseIds[2]}/delete`); assert.match(r.body, /Delete this entry\?/);
  r = await post(`/expenses/${expenseIds[2]}/delete`, {}); assert.equal(r.status, 303);

  // 7. Payments
  r = await post(`/jobs/${jobId}/payments`, { payment_amount: '-5', paid_on: '2026-10-01' }); assert.equal(r.status, 422);
  r = await post(`/jobs/${jobId}/payments`, { payment_amount: '100', paid_on: '2026-02-30' }); assert.equal(r.status, 422);
  r = await post(`/jobs/${jobId}/payments`, { payment_amount: '2000.00', paid_on: '2026-10-01' }); assert.equal(r.status, 303);
  r = await post(`/jobs/${jobId}/payments`, { payment_amount: '500.25', paid_on: '2026-10-15' }); assert.equal(r.status, 303);

  // Totals: contract 4552.50; expenses 1800.10 + 199.90 = 2000.00; payments 2500.25
  // balance 4552.50 - 2500.25 = 2052.25; gross profit 4552.50 - 2000.00 = 2552.50
  page = (await getPage(`/jobs/${jobId}`)).body;
  assert.equal(stat(page, 'expenses'), '$2,000.00');
  assert.equal(stat(page, 'payments'), '$2,500.25');
  assert.equal(stat(page, 'balance'), '$2,052.25');
  assert.equal(stat(page, 'profit'), '$2,552.50');
  // Outstanding only counts completed jobs, so nothing yet
  assert.match((await getPage('/')).body, /id="total-outstanding">\$0\.00</);

  // 8. Complete job (with start and end dates and notes); the end can't come before the start
  r = await post(`/jobs/${jobId}`, { status: 'completed', start_date: '2026-11-03', end_date: '2026-11-01', notes: 'Gate code 1234' });
  assert.equal(r.status, 422); assert.match(r.body, /End date can(&#39;|')t be before the start date/); assert.match(r.body, /Gate code 1234/);
  r = await post(`/jobs/${jobId}`, { status: 'completed', start_date: '2026-11-03', end_date: '2026-11-07', notes: 'Gate code 1234' }); assert.equal(r.status, 303);
  page = (await getPage(`/jobs/${jobId}`)).body;
  assert.match(page, /Gross profit \(final\)/); assert.doesNotMatch(page, /\(provisional\)/);
  assert.match(page, /Gate code 1234/); assert.match(page, /value="2026-11-03"/); assert.match(page, /value="2026-11-07"/);

  // Completed job leaves the active list but its balance still counts as outstanding;
  // its gross profit counts toward this month's gross profit (completed today).
  page = (await getPage('/')).body;
  assert.match(page, /id="month-profit">\$2,552\.50</); assert.match(page, /From 1 job completed this month/);
  assert.match(page, /No active jobs/); assert.match(page, /id="total-outstanding">\$2,052\.25</);

  // Client page shows estimates and jobs
  page = (await getPage(`/clients/${clientId}`)).body;
  assert.match(page, new RegExp(`/estimates/${estId}`)); assert.match(page, new RegExp(`/jobs/${jobId}`));

  // Estimate for a brand-new client in one step
  r = await post('/estimates', new URLSearchParams([
    ['client_id', 'new'], ['new_name', 'Sam Lee'], ['new_address', '9 Elm Rd'], ['project_name', 'Deck'],
    ['item_desc', 'Deck boards'], ['item_qty', '1'], ['item_price', '3000'],
  ]));
  assert.equal(r.status, 303);
  assert.match((await getPage('/clients?q=Sam')).body, /Sam Lee/);

  // Persistence: restart the server process, log in again, data is all still there.
  // Expired access token: the app refreshes the session silently.
  fakeAuth.expireAccessTokens();
  assert.equal((await getPage('/')).status, 200);
  assert.ok(jars.alice.sa, 'new access token stored');

  page = (await getPage(`/jobs/${jobId}`)).body;
  assert.equal(stat(page, 'balance'), '$2,052.25');
  assert.equal(stat(page, 'profit'), '$2,552.50');
  assert.match((await getPage(`/estimates/${estId}`)).body, /\$4,552\.50/);

  // ---- Teammates and other organizations ----
  as('carol'); await post('/signup', { email: 'carol@vista.test', password: 'carol-password' });
  as('bob'); await post('/signup', { email: 'bob@other.test', password: 'bob-password' });
  await post('/org/new', { name: 'Other Co' });

  // Alice adds Carol as an admin and Dave as a worker; unknown emails get a clear message
  // Dave fills in the optional details when signing up; they become his profile on first login
  as('dave'); await post('/signup', { email: 'dave@vista.test', password: 'dave-password', full_name: 'Dave Diaz', phone: '555-222-3333', zip: '78704' });
  assert.equal((await getPage('/')).location, '/welcome');
  as('alice');
  r = await post('/team/add', { email: 'nobody@x.test', role: 'worker' });
  assert.equal(r.status, 422); assert.match(r.body, /No account uses that email yet/);
  // The Free plan is one person
  assert.match((await getPage('/team')).body, /Free plan/);
  r = await post('/team/add', { email: 'carol@vista.test', role: 'admin' });
  assert.equal(r.status, 422); assert.match(r.body, /Free plan is for one person/);
  const vistaOrg = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  await dbClient.query("SELECT sync_org_subscription($1, 'cus_vista', 'sub_vista', 'team', 'month', 'active', now() + interval '30 days', false)", [vistaOrg]);
  r = await post('/team/add', { email: 'carol@vista.test', role: 'admin' }); assert.equal(r.status, 303);
  r = await post('/team/add', { email: 'dave@vista.test', role: 'worker' }); assert.equal(r.status, 303);
  page = (await getPage('/team')).body;
  assert.match(page, /carol@vista\.test/); assert.match(page, /Dave Diaz/); assert.match(page, /Team plan/); assert.match(page, /2 of 3 admins · 1 of 10 crew/);
  const daveId = (await dbClient.query("SELECT id FROM auth.users WHERE email = 'dave@vista.test'")).rows[0].id;
  page = (await getPage(`/team/${daveId}`)).body;
  assert.match(page, /<h1[^>]*>Dave Diaz/); assert.match(page, /555-222-3333/); assert.match(page, /78704/);
  // Alice edits her own details from Account
  r = await post('/account/profile', { full_name: 'Alice Avery', phone: 'call me', address: '' });
  assert.equal(r.status, 422); assert.match(r.body, /Phone number does not look valid/); assert.match(r.body, /value="Alice Avery"/);
  r = await post('/account/profile', { full_name: 'Alice Avery', phone: '(555) 111-2222', zip: '7870' });
  assert.equal(r.status, 422); assert.match(r.body, /ZIP code should be 5 digits/);
  r = await post('/account/profile', { full_name: 'Alice Avery', phone: '(555) 111-2222', zip: '78701' }); assert.equal(r.status, 303);
  page = (await getPage('/account')).body;
  assert.match(page, /value="\(555\) 111-2222"/); assert.match(page, /Plan (&amp;|&) billing/);
  assert.match((await getPage('/')).body, /Alice Avery/);

  // An open job for the worker schedule: approve and convert the deck estimate, schedule it
  const deckId = Number((await dbClient.query("SELECT id FROM estimates WHERE project_name = 'Deck'")).rows[0].id);
  await post(`/estimates/${deckId}/status`, { status: 'approved' });
  const deckJob = idFrom((await post(`/estimates/${deckId}/convert`, {})).location);
  await post(`/jobs/${deckJob}`, { status: 'in_progress', start_date: '2026-11-10', end_date: '2026-11-12', notes: 'Bring the long ladder' });
  const uid = async (email) => (await dbClient.query('SELECT id FROM auth.users WHERE email = $1', [email])).rows[0].id;
  r = await post(`/jobs/${deckJob}/assignments`, { user_id: await uid('dave@vista.test'), payout: 'abc' });
  assert.equal(r.status, 422); assert.match(r.body, /Payout must be a number/);
  r = await post(`/jobs/${deckJob}/assignments`, { user_id: await uid('bob@other.test'), payout: '10' });
  assert.equal(r.status, 422); assert.match(r.body, /not on this team/);
  r = await post(`/jobs/${deckJob}/assignments`, { user_id: await uid('dave@vista.test'), payout: '300' }); assert.equal(r.status, 303);
  r = await post(`/jobs/${deckJob}/assignments`, { user_id: await uid('dave@vista.test'), payout: '350.00' }); assert.equal(r.status, 303); // update
  r = await post(`/jobs/${deckJob}/assignments`, { user_id: await uid('carol@vista.test'), payout: '125.50' }); assert.equal(r.status, 303);
  page = (await getPage(`/jobs/${deckJob}`)).body;
  assert.equal(stat(page, 'payouts'), '$475.50');
  assert.equal(stat(page, 'profit'), '$2,524.50'); // 3000 - 0 expenses - 475.50 payouts
  assert.equal(stat(page, 'balance'), '$3,000.00');
  // Removing an assignment asks first
  assert.match((await getPage(`/jobs/${deckJob}/assignments/remove?user_id=${await uid('carol@vista.test')}`)).body, /Remove this assignment\?/);
  r = await post(`/jobs/${deckJob}/assignments/remove?user_id=${await uid('carol@vista.test')}`, {}); assert.equal(r.status, 303);
  assert.equal(stat((await getPage(`/jobs/${deckJob}`)).body, 'payouts'), '$350.00');

  // Carol (admin) sees Vista's data and can record a payment
  as('carol');
  page = (await getPage(`/jobs/${jobId}`)).body;
  assert.equal(stat(page, 'contract'), '$4,552.50');
  // Home shows this month's revenue: contract value of jobs completed this month (Pacific time by default); payments don't change it.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const monthRevenue = async () => (await getPage('/')).body.match(/id="month-revenue">([^<]+)</)[1];
  const expectedRevenue = async () => fmt(Number((await dbClient.query(
    `SELECT coalesce(sum(contract_cents), 0) AS c FROM jobs WHERE org_id = (SELECT org_id FROM jobs WHERE id = $2) AND status = 'completed'
      AND to_char(completed_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM') = $1`, [today.slice(0, 7), jobId])).rows[0].c));
  assert.equal(await monthRevenue(), await expectedRevenue());
  assert.match(await monthRevenue(), /^\$4,5/);
  const before = await monthRevenue();
  r = await post(`/jobs/${jobId}/payments`, { payment_amount: '52.25', paid_on: today }); assert.equal(r.status, 303);
  assert.equal(stat((await getPage(`/jobs/${jobId}`)).body, 'balance'), '$2,000.00');
  assert.equal(await monthRevenue(), before);
  page = (await getPage('/')).body;
  assert.match(page, /id="total-outstanding">\$2,000\.00</);
  assert.match(page, /id="revenue-chart"/); assert.match(page, /aria-label="[A-Z][a-z]+ \d{4}: \$4,5/);

  assert.match((await getPage('/')).body, /id="revenue-growth"/);

  // Jobs calendar: the deck job (Nov 10-12) shows on each of its days, and not after
  const dayList = async (d) => (await getPage(`/jobs?day=${d}`)).body.split('All jobs')[0];
  page = await dayList('2026-11-11');
  assert.match(page, /aria-label="2026-11-11, 1 job"/); assert.match(page, new RegExp(`href="/jobs/${deckJob}"`));
  assert.doesNotMatch(await dayList('2026-11-13'), new RegExp(`href="/jobs/${deckJob}"`));
  assert.match(await dayList('2026-11-13'), /No jobs scheduled this day/);
  assert.equal((await getPage('/jobs?month=2026-11')).status, 200);
  assert.equal((await getPage('/jobs?day=garbage')).status, 200);

  // Worker page: Dave's jobs and pay totals
  r = await getPage('/team');
  assert.match(r.body, new RegExp(`href="/team/${await uid('dave@vista.test')}"`));
  page = (await getPage(`/team/${await uid('dave@vista.test')}`)).body;
  assert.equal(stat(page, 'jobs-open'), '1'); assert.equal(stat(page, 'upcoming'), '$350.00'); assert.equal(stat(page, 'earned'), '$0.00');
  assert.match(page, /Deck/);
  assert.equal((await getPage(`/team/${await uid('bob@other.test')}`)).status, 404, 'no pages for people outside the team');

  // Company profile, logo, and PDFs
  r = await post('/settings', { name: '', phone: '555-000-1111' });
  assert.equal(r.status, 422); assert.match(r.body, /Company name is required/); assert.match(r.body, /value="555-000-1111"/);
  r = await post('/settings', { name: 'Vista Artisans', logo_data: 'data:image/png;base64,aGVsbG8=' });
  assert.equal(r.status, 422); assert.match(r.body, /must be a PNG or JPG/);
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  r = await post('/settings', { name: 'Vista Artisans', phone: '555-000-1111', license_number: 'CA-99', estimate_terms: 'Valid 30 days.',
    logo_data: `data:image/png;base64,${PNG}` });
  assert.equal(r.status, 303);
  r = await getPage('/settings/logo'); assert.equal(r.status, 200); assert.equal(r.type, 'image/png');
  assert.match((await getPage('/settings')).body, /value="CA-99"/);
  r = await getPage(`/estimates/${estId}/pdf`);
  assert.equal(r.status, 200); assert.equal(r.type, 'application/pdf'); assert.match(r.body, /^%PDF-/);
  r = await getPage(`/jobs/${deckJob}/work-order`); assert.equal(r.type, 'application/pdf');
  r = await getPage(`/jobs/${deckJob}/work-order?user_id=${await uid('dave@vista.test')}`); assert.equal(r.type, 'application/pdf');
  assert.equal((await getPage(`/jobs/${deckJob}/work-order?user_id=${await uid('bob@other.test')}`)).status, 404);

  // Erin joins with the company's join code (no company of her own needed) and becomes a worker
  as('alice');
  const code = (await getPage('/team')).body.match(/id="join-code">([A-Z0-9]{4}-[A-Z0-9]{4})</)[1];
  as('erin'); await post('/signup', { email: 'erin@vista.test', password: 'erin-password' });
  assert.equal((await getPage('/')).location, '/welcome');
  r = await post('/org/join', { code: 'ZZZZ-ZZZZ' }); assert.equal(r.status, 422); assert.match(r.body, /doesn(&#39;|')t match any company/);
  assert.equal((await dbClient.query('SELECT count(*)::int AS n FROM join_attempts')).rows[0].n, 1, 'failed attempt is counted');
  r = await post('/org/join', { code: code.toLowerCase() }); assert.equal(r.status, 303);
  page = (await getPage('/')).body;
  assert.match(page, /Overview/); assert.match(page, /Nothing scheduled/); assert.doesNotMatch(page, /id="month-revenue"/);
  // Crew menu: Overview, Jobs, Team (no Clients or Estimates)
  assert.match(page, /href="\/schedule"/); assert.match(page, /href="\/team"/);
  assert.doesNotMatch(page, /href="\/clients"/); assert.doesNotMatch(page, /href="\/estimates"/);
  page = (await getPage('/team')).body;
  assert.match(page, /alice@vista\.test/); assert.doesNotMatch(page, /join-code/); assert.doesNotMatch(page, /\$/, 'crew see no pay on the team page');
  assert.doesNotMatch(page, /href="\/team\//);
  // A new code stops the old one from working
  as('alice'); r = await post('/team/code', {}); assert.equal(r.status, 303);
  assert.notEqual((await getPage('/team')).body.match(/id="join-code">([^<]+)</)[1], code);
  as('bob'); r = await post('/org/join', { code }); assert.equal(r.status, 422);

  // Dave (worker) sees only his assigned jobs: date, address, scope and his own pay; no other money, no other pages
  as('dave');
  page = (await getPage('/')).body;
  assert.match(page, /Overview/); assert.match(page, /Deck/);
  assert.match(page, /datetime="2026-11-10"/); assert.match(page, /datetime="2026-11-12"/);
  assert.match(page, /data-k="upcoming-pay">\$350\.00</); assert.match(page, /data-k="open-jobs">1</);
  assert.deepEqual([...new Set(page.match(/\$[\d,.]+/g))].sort(), ['$0.00', '$350.00'], 'only his own pay is shown');
  assert.doesNotMatch(page, /Kitchen remodel/); assert.doesNotMatch(page, /id="month-revenue"/);
  page = (await getPage('/schedule?day=2026-11-11')).body;
  assert.match(page, /id="calendar"/); assert.match(page, /href="\/schedule\?day=2026-11-11"/);
  assert.match(page, /id="day-jobs">Wed, Nov 11/); assert.match(page, /Deck/); assert.doesNotMatch(page, /Kitchen remodel/);
  page = (await getPage(`/schedule/${deckJob}`)).body;
  assert.match(page, /Deck/); assert.match(page, /Bring the long ladder/);
  assert.match(page, /data-k="my-pay">\$350\.00</); assert.equal((page.match(/\$/g) || []).length, 1);
  for (const p of ['/clients', '/estimates', '/jobs', `/jobs/${deckJob}`, `/clients/${clientId}`, `/estimates/${deckId}`, `/team/${await uid('carol@vista.test')}`,
    '/settings', '/settings/logo', `/estimates/${deckId}/pdf`, `/jobs/${deckJob}/work-order`]) {
    assert.equal((await getPage(p)).status, 404, `worker gets 404 on ${p}`);
  }
  assert.equal((await post(`/jobs/${deckJob}/payments`, { payment_amount: '1', paid_on: '2026-10-19' })).status, 404);
  assert.equal((await post('/team/add', { email: 'bob@other.test', role: 'admin' })).status, 404);

  // Roles: the last admin can't be demoted; roles can be changed
  as('alice');
  const ids = Object.fromEntries((await dbClient.query('SELECT id, email FROM auth.users')).rows.map((u) => [u.email, u.id]));
  r = await post('/team/role', { user_id: ids['carol@vista.test'], role: 'worker' }); assert.equal(r.status, 303);
  r = await post('/team/role', { user_id: ids['alice@vista.test'], role: 'worker' });
  assert.equal(r.status, 422); assert.match(r.body, /at least one admin/);
  r = await post('/team/role', { user_id: ids['carol@vista.test'], role: 'admin' }); assert.equal(r.status, 303);

  // Deleting: an unconverted estimate, a client with no jobs (and its estimates); converted things are protected
  r = await post('/clients', { name: 'Temp Client', address: '1 Short St' });
  const tempClient = idFrom(r.location);
  r = await post('/estimates', new URLSearchParams([['client_id', String(tempClient)], ['project_name', 'Fence'],
    ['item_desc', 'Fence'], ['item_qty', '1'], ['item_price', '500']]));
  const fenceId = idFrom(r.location);
  r = await post('/estimates', new URLSearchParams([['client_id', String(tempClient)], ['project_name', 'Gate'],
    ['item_desc', 'Gate'], ['item_qty', '1'], ['item_price', '200']]));
  const gateId = idFrom(r.location);
  assert.match((await getPage(`/estimates/${fenceId}/delete`)).body, /Delete this estimate\?/);
  r = await post(`/estimates/${fenceId}/delete`, {}); assert.equal(r.status, 303);
  assert.equal((await getPage(`/estimates/${fenceId}`)).status, 404);
  assert.match((await getPage(`/clients/${tempClient}/delete`)).body, /along with 1 estimate/);
  r = await post(`/clients/${tempClient}/delete`, {}); assert.equal(r.status, 303);
  assert.equal((await getPage(`/clients/${tempClient}`)).status, 404);
  assert.equal((await getPage(`/estimates/${gateId}`)).status, 404);
  assert.equal((await getPage(`/estimates/${estId}/delete`)).status, 409);
  assert.equal((await post(`/estimates/${estId}/delete`, {})).status, 409);
  assert.equal((await getPage(`/clients/${clientId}/delete`)).status, 409);
  await post(`/clients/${clientId}/delete`, {});
  assert.equal((await getPage(`/clients/${clientId}`)).status, 200, 'client with jobs is kept');

  // Moving an estimate to a different client (edit, change client)
  const sam = (await dbClient.query("SELECT id FROM clients WHERE name = 'Sam Lee'")).rows[0].id;
  r = await post('/estimates', new URLSearchParams([['client_id', String(clientId)], ['project_name', 'Patio'],
    ['item_desc', 'Pavers'], ['item_qty', '1'], ['item_price', '900']]));
  const patioId = idFrom(r.location);
  r = await post(`/estimates/${patioId}`, new URLSearchParams([['client_id', String(sam)], ['project_name', 'Patio'],
    ['item_desc', 'Pavers'], ['item_qty', '1'], ['item_price', '900']]));
  assert.equal(r.status, 303);
  assert.match((await getPage(`/clients/${sam}`)).body, /Patio/);

  // Bob (another organization) can't see or change anything of Vista's
  as('bob');
  for (const p of [`/clients/${clientId}`, `/estimates/${estId}`, `/jobs/${jobId}`, `/clients/${clientId}/edit`,
    `/expenses/${expenseIds[0]}/edit`, `/estimates/${estId}/pdf`, `/jobs/${jobId}/work-order`]) {
    assert.equal((await getPage(p)).status, 404, `bob gets 404 on ${p}`);
  }
  for (const [p, f] of [[`/clients/${clientId}`, { name: 'Hacked' }], [`/jobs/${jobId}/payments`, { payment_amount: '1', paid_on: '2026-10-19' }],
    [`/expenses/${expenseIds[0]}/delete`, {}], [`/estimates/${estId}/convert`, {}], [`/jobs/${jobId}`, { status: 'not_started' }]]) {
    assert.equal((await post(p, f)).status, 404, `bob blocked on POST ${p}`);
  }
  page = (await getPage('/clients')).body;
  assert.doesNotMatch(page, /Jane Rivera/); assert.match(page, /No clients yet/);
  assert.match((await getPage('/')).body, /id="total-outstanding">\$0\.00</);
  assert.match((await getPage('/')).body, /id="month-revenue">\$0\.00</);
  // Bob can't switch into Vista by forging the organization cookie
  jars.bob.org = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  assert.doesNotMatch((await getPage('/clients')).body, /Jane Rivera/);

  // Persistence: restart the server; data and totals are unchanged (including Carol's payment).
  await stop(); await start();
  as('alice');
  page = (await getPage(`/jobs/${jobId}`)).body;
  assert.equal(stat(page, 'balance'), '$2,000.00');
  assert.equal(stat(page, 'profit'), '$2,552.50');
  assert.equal((await getPage(`/clients/${clientId}`)).status, 200);

  // Logout ends the session
  r = await post('/logout', {}); assert.equal(r.status, 303);
  assert.equal((await getPage('/jobs')).location, '/login');
});

test('invoices through Stripe Connect: connect, send, pay by webhook, void', async () => {
  const fakeStripe = await startFakeStripe('sk_test_fake');
  const vista = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  const kitchen = Number((await dbClient.query("SELECT id FROM jobs WHERE project_name = 'Kitchen remodel'")).rows[0].id);
  const deck = Number((await dbClient.query("SELECT id FROM jobs WHERE project_name = 'Deck'")).rows[0].id);
  as('alice'); await post('/login', { email: 'alice@vista.test', password: 'alice-password' });

  // Stripe not switched on for the app: the job and the profile page say so, and sending is refused
  let page = (await getPage(`/jobs/${kitchen}`)).body;
  assert.match(page, /Online invoicing isn(&#39;|')t set up yet/);
  assert.match((await getPage('/settings')).body, /Not available yet/);
  assert.equal((await post(`/jobs/${kitchen}/invoices`, { invoice_amount: '10', invoice_email: 'jane@example.com', days: '14' })).status, 409);

  const WHSEC = 'whsec_test_secret';
  await stop();
  await start({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: fakeStripe.url });
  const event = (type, obj, account) => JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, account, created: Math.floor(Date.now() / 1000), data: { object: obj } });
  const sign = (body, secret = WHSEC) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`; };
  const hook = (body, sig) => fetch(`${BASE}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
  try {
    // Each company connects its own Stripe account
    page = (await getPage('/settings')).body;
    assert.match(page, /Connect Stripe/); assert.match(page, /test mode/);
    assert.equal((await post(`/jobs/${kitchen}/invoices`, { invoice_amount: '10', invoice_email: 'jane@example.com', days: '14' })).status, 409);
    let r = await post('/settings/stripe/connect', {});
    assert.equal(r.status, 303); assert.match(r.location, /^https:\/\/connect\.stripe\.test\/setup\/acct_/);
    assert.match(decodeURIComponent(r.location), /\/settings\/stripe\/return$/);
    const vistaAcct = (await dbClient.query('SELECT account_id FROM stripe_accounts WHERE org_id = $1', [vista])).rows[0].account_id;
    const a = fakeStripe.state.accounts.get(vistaAcct);
    assert.equal(a.controller_dashboard, 'full'); assert.equal(a.fee_payer, 'account', 'the company owns its account and pays Stripe fees');
    // Clicking again reuses the same account
    r = await post('/settings/stripe/connect', {}); assert.match(r.location, new RegExp(vistaAcct));
    assert.equal(fakeStripe.state.accounts.size, 1);
    // Back from Stripe before onboarding is finished: still not ready
    r = await getPage('/settings/stripe/return'); assert.match(r.location, /more\+information/);
    assert.match((await getPage('/settings')).body, /Continue Stripe setup/);
    // Stripe says the account can take payments (via the account.updated webhook)
    a.charges_enabled = true; a.details_submitted = true;
    const upd = event('account.updated', a, vistaAcct);
    assert.equal((await hook(upd, sign(upd))).status, 200);
    assert.match((await getPage('/settings')).body, /Stripe connected/);
    // Admins can't point their company at another Stripe account directly
    await assert.rejects(dbClient.query(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', (SELECT id::text FROM auth.users WHERE email = 'alice@vista.test'), false);
      UPDATE stripe_accounts SET account_id = 'acct_evil'`).finally(() => dbClient.query('RESET ROLE')));

    page = (await getPage(`/jobs/${kitchen}`)).body;
    assert.match(page, /Send an invoice/); assert.match(page, /value="2000.00"/); assert.match(page, /Test mode/);
    // Validation keeps input; can't bill more than is owed
    r = await post(`/jobs/${kitchen}/invoices`, { invoice_amount: '2500', invoice_email: 'jane@example.com', days: '14', key: crypto.randomUUID() });
    assert.equal(r.status, 422); assert.match(r.body, /more than the outstanding balance/);
    r = await post(`/jobs/${kitchen}/invoices`, { invoice_amount: '100', invoice_email: 'nope', days: '14', key: crypto.randomUUID() });
    assert.equal(r.status, 422); assert.match(r.body, /Enter the email address/); assert.match(r.body, /value="100"/);
    // Stripe refusing is reported, nothing recorded
    r = await post(`/jobs/${kitchen}/invoices`, { invoice_amount: '666', invoice_email: 'jane@example.com', days: '14', key: crypto.randomUUID() });
    assert.equal(r.status, 502); assert.match(r.body, /Stripe didn(&#39;|')t accept the invoice/);
    assert.equal((await dbClient.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n, 0);

    // Send a $1,500 deposit invoice on Vista's own account; a double-submit (same form key) makes only one
    const key = crypto.randomUUID();
    const form = { invoice_amount: '1500', invoice_email: 'jane@example.com', days: '7', invoice_desc: 'Kitchen deposit', key };
    const [x, y] = await Promise.all([post(`/jobs/${kitchen}/invoices`, form), post(`/jobs/${kitchen}/invoices`, form)]);
    assert.equal(x.status, 303); assert.equal(y.status, 303);
    const invs = (await dbClient.query('SELECT * FROM invoices')).rows;
    assert.equal(invs.length, 1, 'one invoice despite two clicks');
    const inv = invs[0];
    assert.equal(fakeStripe.state.invoices.get(inv.stripe_invoice_id).account, vistaAcct, 'invoice lives on the company account');
    assert.equal(Number(inv.amount_cents), 150000); assert.equal(inv.status, 'open'); assert.equal(inv.sent_to, 'jane@example.com');
    page = (await getPage(`/jobs/${kitchen}`)).body;
    assert.match(page, /Kitchen deposit/); assert.match(page, /\$1,500\.00/); assert.match(page, />Sent</);
    assert.match(page, /value="500.00"/, 'next invoice defaults to the unbilled remainder');
    assert.equal(stat(page, 'balance'), '$2,000.00', 'sending an invoice does not change the balance');

    // Stripe reports it paid: payment recorded once, even if the event repeats
    const paidObj = { id: inv.stripe_invoice_id, object: 'invoice', amount_paid: 150000, number: inv.number,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, metadata: { job_id: String(kitchen), org_id: vista } };
    const paid = event('invoice.paid', paidObj, vistaAcct);
    assert.equal((await hook(paid, sign(paid, 'whsec_wrong'))).status, 400, 'bad signature rejected');
    assert.equal((await hook(paid, 'garbage')).status, 400);
    assert.equal((await hook(paid, sign(paid))).status, 200);
    assert.equal((await hook(paid, sign(paid))).status, 200);
    page = (await getPage(`/jobs/${kitchen}`)).body;
    assert.equal(stat(page, 'balance'), '$500.00'); assert.match(page, /Paid online/); assert.match(page, />Paid</);
    assert.equal((await dbClient.query('SELECT count(*)::int AS n FROM payments WHERE job_id = $1 AND amount_cents = 150000', [kitchen])).rows[0].n, 1);

    // Bob's company connects its own account; an event from Bob's account can't touch Vista's jobs
    as('bob');
    await post('/settings/stripe/connect', {});
    const bobOrg = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Other Co'")).rows[0].id;
    const bobAcct = (await dbClient.query('SELECT account_id FROM stripe_accounts WHERE org_id = $1', [bobOrg])).rows[0].account_id;
    assert.notEqual(bobAcct, vistaAcct);
    const spoof = event('invoice.paid', { ...paidObj, id: 'in_spoof', amount_paid: 999 }, bobAcct);
    assert.equal((await hook(spoof, sign(spoof))).status, 200);
    const unknown = event('invoice.paid', { ...paidObj, id: 'in_unknown', amount_paid: 999 }, 'acct_nobody');
    assert.equal((await hook(unknown, sign(unknown))).status, 200);
    assert.equal((await dbClient.query("SELECT count(*)::int AS n FROM payments WHERE amount_cents = 999")).rows[0].n, 0);
    assert.equal((await post(`/invoices/${inv.id}/resend`, {})).status, 404);

    // Void an open invoice on the deck job
    as('alice');
    r = await post(`/jobs/${deck}/invoices`, { invoice_amount: '300', invoice_email: 'sam@example.com', days: '0', key: crypto.randomUUID() });
    assert.equal(r.status, 303);
    const deckInv = (await dbClient.query('SELECT id FROM invoices WHERE job_id = $1', [deck])).rows[0].id;
    assert.equal((await post(`/invoices/${deckInv}/resend`, {})).status, 303);
    assert.equal((await post(`/invoices/${deckInv}/void`, {})).status, 303);
    assert.equal((await dbClient.query('SELECT status FROM invoices WHERE id = $1', [deckInv])).rows[0].status, 'void');
    assert.match((await getPage(`/jobs/${deck}`)).body, />Voided</);

    // Workers can't touch invoices or Stripe settings
    as('dave');
    assert.equal((await post(`/jobs/${deck}/invoices`, { invoice_amount: '1', invoice_email: 'x@y.z', days: '0' })).status, 404);
    assert.equal((await post(`/invoices/${deckInv}/void`, {})).status, 404);
    assert.equal((await post('/settings/stripe/connect', {})).status, 404);
  } finally {
    await fakeStripe.close();
  }
});

test('plans: Free limits, Stripe Checkout, webhook sync, billing portal, cancel', async () => {
  const fakeStripe = await startFakeStripe('sk_test_fake');
  const BILLING = 'whsec_billing_secret';
  const bobOrg = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Other Co'")).rows[0].id;
  const vista = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  const planOf = async (org) => (await dbClient.query('SELECT effective_plan($1) AS p', [org])).rows[0].p;
  as('bob'); await post('/login', { email: 'bob@other.test', password: 'bob-password' });

  // Billing not switched on yet: plans are shown but can't be bought
  let page = (await getPage('/billing')).body;
  assert.match(page, /data-k="plan">Free</); assert.match(page, /Paid plans aren(&#39;|')t available yet/);
  assert.doesNotMatch(page, /Choose Team/);

  await stop();
  await start({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_BILLING_WEBHOOK_SECRET: BILLING, STRIPE_API_BASE: fakeStripe.url });
  const event = (type, obj) => JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, created: Math.floor(Date.now() / 1000), data: { object: obj } });
  const sign = (body, secret = BILLING) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`; };
  const hook = (body, sig) => fetch(`${BASE}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
  try {
    page = (await getPage('/billing')).body;
    assert.match(page, /Choose Team/); assert.match(page, /\$49<small>\/mo/); assert.match(page, /First month \$24\.50/);
    page = (await getPage('/billing?interval=year')).body;
    assert.match(page, /\$499<small>\/yr/); assert.match(page, /\$1,009<small>\/yr/); assert.match(page, /save 15%/);

    // Bob is alone on Free and can't add anyone
    let r = await post('/team/add', { email: 'erin@vista.test', role: 'worker' });
    assert.equal(r.status, 422); assert.match(r.body, /Free plan is for one person/);

    // Choose Team monthly: Stripe Checkout with the 50% first-month coupon, on the app's own Stripe account
    r = await post('/billing/checkout', { plan: 'team', interval: 'month' });
    assert.equal(r.status, 303); assert.match(r.location, /^https:\/\/checkout\.stripe\.test\/cs_/);
    const cs = [...fakeStripe.state.sessions.values()].at(-1);
    assert.equal(cs.client_reference_id, bobOrg); assert.equal(cs.coupon, 'vista-first-month-50');
    assert.equal(fakeStripe.state.prices.get(cs.price).unit_amount, 4900);
    assert.equal(fakeStripe.state.customers.get(cs.customer).platform, true);
    assert.equal((await dbClient.query('SELECT stripe_customer_id FROM org_subscriptions WHERE org_id = $1', [bobOrg])).rows[0].stripe_customer_id, cs.customer);
    // Choosing again reuses the same Stripe customer
    r = await post('/billing/checkout', { plan: 'unlimited', interval: 'year' });
    const cs2 = [...fakeStripe.state.sessions.values()].at(-1);
    assert.equal(cs2.customer, cs.customer); assert.equal(cs2.coupon, null, 'the 50% coupon is for monthly plans');
    assert.equal(fakeStripe.state.prices.get(cs2.price).unit_amount, 100900);
    assert.equal(await planOf(bobOrg), 'free', 'nothing changes until payment');

    // Paid: coming back from Checkout activates the plan right away
    fakeStripe.completeCheckout(cs.id);
    as('alice'); await post('/login', { email: 'alice@vista.test', password: 'alice-password' });
    r = await getPage(`/billing?session_id=${cs.id}`); assert.equal(r.status, 200, "another company's checkout is ignored");
    assert.equal((await dbClient.query('SELECT stripe_subscription_id FROM org_subscriptions WHERE org_id = $1', [vista])).rows[0].stripe_subscription_id, 'sub_vista');
    as('bob');
    r = await getPage(`/billing?session_id=${cs.id}`); assert.equal(r.status, 303); assert.match(r.location, /plan\+is\+active/);
    assert.equal(await planOf(bobOrg), 'team');
    page = (await getPage('/billing')).body;
    assert.match(page, /data-k="plan">Team</); assert.match(page, /Manage billing/); assert.match(page, /Renews/); assert.doesNotMatch(page, /Choose Unlimited/);
    r = await post('/team/add', { email: 'erin@vista.test', role: 'worker' }); assert.equal(r.status, 303);

    // Already subscribed: plan changes go through Stripe's billing portal
    r = await post('/billing/checkout', { plan: 'unlimited', interval: 'month' });
    assert.equal(r.status, 303); assert.match(r.location, /^https:\/\/billing\.stripe\.test\//);
    r = await post('/billing/portal', {}); assert.match(r.location, new RegExp(cs.customer));
    assert.equal(fakeStripe.state.portalConfigs.length, 1, 'portal set up once and reused');

    // Team limits: at most 3 admins and 10 workers (checked in the database)
    const addPerson = async (email, role) => {
      const u = (await dbClient.query('INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id', [email])).rows[0].id;
      return dbClient.query('INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)', [bobOrg, u, role]);
    };
    await addPerson('a2@other.test', 'admin'); await addPerson('a3@other.test', 'admin');
    await assert.rejects(addPerson('a4@other.test', 'admin'), /up to 3 admins/);
    for (let i = 2; i <= 10; i++) await addPerson(`w${i}@other.test`, 'worker');
    await assert.rejects(addPerson('w11@other.test', 'worker'), /up to 10 crew members/);
    const erin = (await dbClient.query("SELECT id FROM auth.users WHERE email = 'erin@vista.test'")).rows[0].id;
    r = await post('/team/role', { user_id: erin, role: 'admin' }); assert.equal(r.status, 422); assert.match(r.body, /up to 3 admins/);
    assert.match((await getPage('/team')).body, /3 of 3 admins · 10 of 10 crew/);

    // Upgrading in the portal arrives by webhook; then no limits
    const sub = fakeStripe.state.subscriptions.get(fakeStripe.state.sessions.get(cs.id).subscription);
    const unl = [...fakeStripe.state.prices.values()].find((x) => x.lookup_key === 'vista_unlimited_month');
    sub.items.data[0].price = unl;
    let e = event('customer.subscription.updated', sub);
    assert.equal((await hook(e, sign(e, 'whsec_wrong'))).status, 400);
    assert.equal((await hook(e, sign(e))).status, 200);
    assert.equal(await planOf(bobOrg), 'unlimited');
    await addPerson('w11@other.test', 'worker');

    // An event naming Vista but carrying Bob's Stripe customer is ignored
    e = event('customer.subscription.deleted', { ...sub, id: 'sub_spoof', status: 'canceled', metadata: { org_id: vista } });
    assert.equal((await hook(e, sign(e))).status, 200);
    assert.equal(await planOf(vista), 'team');

    // Cancelling: shown as ending, then Free when Stripe ends it. Nobody is removed; nobody new can join.
    sub.cancel_at_period_end = true;
    e = event('customer.subscription.updated', sub); await hook(e, sign(e));
    assert.match((await getPage('/billing')).body, /Ends on/);
    sub.status = 'canceled';
    e = event('customer.subscription.deleted', sub); await hook(e, sign(e));
    assert.equal(await planOf(bobOrg), 'free');
    assert.equal((await dbClient.query('SELECT count(*)::int AS n FROM memberships WHERE org_id = $1', [bobOrg])).rows[0].n, 14);
    await assert.rejects(addPerson('late@other.test', 'worker'), /Free plan/);
    page = (await getPage('/billing')).body;
    assert.match(page, /data-k="plan">Free</); assert.match(page, /Choose Team/);
    assert.doesNotMatch(page, /First month/, 'the 50% first month is a one-time offer');
    r = await post('/billing/checkout', { plan: 'team', interval: 'month' });
    assert.equal([...fakeStripe.state.sessions.values()].at(-1).coupon, null);

    // A comped company (the app owner's) has nothing to buy
    await dbClient.query('UPDATE org_subscriptions SET comped = true WHERE org_id = $1', [vista]);
    as('alice'); page = (await getPage('/billing')).body;
    assert.match(page, /data-k="plan">Unlimited</); assert.match(page, /Free for Vista Artisans/); assert.doesNotMatch(page, /Choose/);
    // Workers can't see billing; admins can't write their own plan
    as('dave'); assert.equal((await getPage('/billing')).status, 404);
    await assert.rejects(dbClient.query(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', (SELECT id::text FROM auth.users WHERE email = 'bob@other.test'), false);
      UPDATE org_subscriptions SET comped = true`).finally(() => dbClient.query('RESET ROLE')));
  } finally {
    await fakeStripe.close();
  }
});

test('estimates: options, emailed link, online approval with signature and deposit, decline, automatic emails', async () => {
  const fakeStripe = await startFakeStripe('sk_test_fake');
  const mail = await startFakeEmail('re_test_key');
  const vista = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  const acct = (await dbClient.query('SELECT account_id FROM stripe_accounts WHERE org_id = $1', [vista])).rows[0].account_id;
  fakeStripe.state.accounts.set(acct, { id: acct, charges_enabled: true, details_submitted: true });
  const jane = (await dbClient.query("SELECT id FROM clients WHERE org_id = $1 AND name = 'Jane Rivera'", [vista])).rows[0].id;
  const q = async (sql, p = []) => (await dbClient.query(sql, p)).rows;
  const waitFor = async (fn, what) => {
    for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); }
    assert.fail(`timed out waiting for ${what}`);
  };
  await stop();
  await start({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_API_BASE: fakeStripe.url,
    RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'estimates@vista.test', EMAIL_API_BASE: mail.url, APP_URL: BASE, AUTOMATION_INTERVAL_MS: '300' });
  try {
    as('alice'); await post('/login', { email: 'alice@vista.test', password: 'alice-password' });
    // Options need at least two names; deposit must be a percent
    const form = (extra) => [['client_id', String(jane)], ['project_name', 'Countertops'], ['scope', 'New counters'], ['status', 'draft'],
      ['deposit_percent', '25'], ['estimated_cost', '1500'],
      ['item_desc', 'Demo and haul-away'], ['item_qty', '1'], ['item_price', '500'], ['item_option', ''],
      ['item_desc', 'Laminate counters'], ['item_qty', '1'], ['item_price', '2000'], ['item_option', 'Good'],
      ['item_desc', 'Quartz counters'], ['item_qty', '1'], ['item_price', '3500'], ['item_option', 'Better'], ...extra];
    let r = await post('/estimates', [...form([]).map(([k, val]) => [k, val === 'Better' ? 'Good' : val])]);
    assert.equal(r.status, 422); assert.match(r.body, /at least two options/);
    r = await post('/estimates', form([]).map(([k, val]) => [k, k === 'deposit_percent' ? '150' : val]));
    assert.equal(r.status, 422); assert.match(r.body, /whole percent/);
    r = await post('/estimates', form([])); assert.equal(r.status, 303);
    const est = idFrom(r.location);
    let page = (await getPage(`/estimates/${est}`)).body;
    assert.match(page, /Good \$2,500\.00 · Better \$4,000\.00/); assert.equal(stat(page, 'estimate-total'), '$2,500.00');
    assert.match(page, /Option: Better/); assert.match(page, /25% \(\$625\.00\)/);
    assert.equal((await getPage(`/estimates/${est}/pdf`)).type, 'application/pdf');

    // Email it to the client
    r = await post(`/estimates/${est}/send`, { send_to: 'nope', send_message: '' });
    assert.equal(r.status, 422); assert.match(r.body, /client(&#39;|')s email/);
    r = await post(`/estimates/${est}/send`, { send_to: 'bounce@example.com', send_message: '' });
    assert.equal(r.status, 502); assert.match(r.body, /could not be sent/);
    r = await post(`/estimates/${est}/send`, { send_to: 'jane@example.com', send_message: 'Great meeting you today!' });
    assert.equal(r.status, 303);
    const token = (await q('SELECT public_token FROM estimates WHERE id = $1', [est]))[0].public_token;
    assert.match(token, /^[0-9a-f]{64}$/);
    const m = mail.sent.at(-1);
    assert.deepEqual(m.to, ['jane@example.com']); assert.equal(m.from, 'Vista Artisans <estimates@vista.test>');
    assert.match(m.subject, /Estimate from Vista Artisans: Countertops/);
    assert.ok(m.html.includes(`${BASE}/e/${token}`)); assert.match(m.text, /Great meeting you today!/); assert.match(m.text, /Options from \$2,500\.00/);
    assert.equal((await q('SELECT status FROM estimates WHERE id = $1', [est]))[0].status, 'sent');
    page = (await getPage(`/estimates/${est}`)).body;
    assert.match(page, /Sent to jane@example\.com/); assert.match(page, /Not opened yet/); assert.match(page, /Estimate sent/); assert.match(page, />Failed</);

    // The client opens the link: no login, no internal numbers
    as('anon');
    assert.equal((await getPage(`/e/${'0'.repeat(64)}`)).status, 404);
    assert.equal((await getPage('/e/abc')).status, 404);
    page = (await getPage(`/e/${token}`)).body;
    assert.match(page, /Choose an option/); assert.match(page, /Quartz counters/); assert.match(page, /\$4,000\.00/);
    assert.match(page, /25% deposit: \$1,000\.00/); assert.doesNotMatch(page, /1,500|Estimated|profit/i);
    assert.equal((await getPage(`/e/${token}/pdf`)).type, 'application/pdf');
    assert.ok((await q('SELECT viewed_at FROM estimates WHERE id = $1', [est]))[0].viewed_at, 'opening is tracked');

    // Approving needs an option, a name and the checkbox
    r = await post(`/e/${token}/approve`, { signer_name: '', signature: '' });
    assert.equal(r.status, 422); assert.match(r.body, /Choose one of the options/); assert.match(r.body, /Type your full name/); assert.match(r.body, /Check the box/);
    r = await post(`/e/${token}/approve`, { option: 'Platinum', signer_name: 'Jane Rivera', agree: 'on' });
    assert.equal(r.status, 422);
    const sig = 'data:image/png;base64,' + 'iVBORw0KGgo'.padEnd(200, 'A');
    r = await post(`/e/${token}/approve`, { option: 'Better', signer_name: 'Jane Rivera', signature: sig, agree: 'on', deposit_email: 'jane@example.com' });
    assert.equal(r.status, 303); assert.match(decodeURIComponent(r.location), /Approved! You can pay the deposit/);
    const e = (await q('SELECT * FROM estimates WHERE id = $1', [est]))[0];
    assert.equal(e.status, 'approved'); assert.equal(e.chosen_option, 'Better'); assert.equal(e.signer_name, 'Jane Rivera');
    assert.equal(e.signature, sig); assert.ok(e.signer_ip); assert.ok(e.approved_at);
    const job = (await q('SELECT * FROM jobs WHERE estimate_id = $1', [est]))[0];
    assert.equal(Number(job.contract_cents), 400000, 'job is created for the chosen option');
    const dep = (await q('SELECT * FROM invoices WHERE job_id = $1', [job.id]))[0];
    assert.equal(Number(dep.amount_cents), 100000); assert.match(dep.description, /Deposit \(25%\) for Countertops/);
    assert.equal(fakeStripe.state.invoices.get(dep.stripe_invoice_id).account, acct, 'deposit goes to the company account');
    page = (await getPage(`/e/${token}`)).body;
    assert.match(page, /Approved by Jane Rivera/); assert.match(page, /Pay deposit · \$1,000\.00/); assert.doesNotMatch(page, /Approve estimate/);
    // Approving twice, or declining after approval, changes nothing
    r = await post(`/e/${token}/approve`, { option: 'Good', signer_name: 'Someone', agree: 'on' });
    assert.match(decodeURIComponent(r.location), /already approved/);
    await post(`/e/${token}/decline`, { reason: 'changed mind' });
    assert.equal((await q('SELECT count(*)::int AS n FROM jobs WHERE estimate_id = $1', [est]))[0].n, 1);
    assert.equal((await q('SELECT status, chosen_option FROM estimates WHERE id = $1', [est]))[0].chosen_option, 'Better');
    await waitFor(async () => mail.sent.some((x) => /Jane Rivera approved Countertops/.test(x.subject)), 'approval notice');
    const notice = mail.sent.find((x) => /approved Countertops/.test(x.subject));
    assert.match(notice.text, /\$4,000\.00/); assert.ok(notice.html.includes(`${BASE}/jobs/${job.id}`)); assert.equal(notice.from, 'Keystone <estimates@vista.test>');

    // The company sees the signature; the estimate is locked
    as('alice');
    page = (await getPage(`/estimates/${est}`)).body;
    assert.match(page, /Approved online by Jane Rivera/); assert.match(page, /class="sig-img"/);
    assert.equal((await post(`/estimates/${est}/send`, { send_to: 'jane@example.com' })).status, 409);
    // Admins can't forge a signature directly
    await assert.rejects(dbClient.query(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', (SELECT id::text FROM auth.users WHERE email = 'alice@vista.test'), false);
      UPDATE estimates SET signer_name = 'Forged' WHERE id = ${est}`).finally(() => dbClient.query('RESET ROLE')));

    // A second estimate is declined with a note
    r = await post('/estimates', [['client_id', String(jane)], ['project_name', 'Fence'], ['status', 'draft'], ['deposit_percent', '0'],
      ['item_desc', 'Cedar fence'], ['item_qty', '40'], ['item_price', '45']]);
    const fence = idFrom(r.location);
    const fenceToken = (await q('SELECT public_token FROM estimates WHERE id = $1', [fence]))[0].public_token;
    as('anon');
    r = await post(`/e/${fenceToken}/decline`, { reason: 'Going with a cheaper quote' }); assert.equal(r.status, 303);
    assert.deepEqual((await q('SELECT status, decline_reason FROM estimates WHERE id = $1', [fence]))[0], { status: 'declined', decline_reason: 'Going with a cheaper quote' });
    await waitFor(async () => mail.sent.some((x) => /declined Fence/.test(x.subject)), 'decline notice');
    // ... and they can still change their mind (no deposit: nothing to pay)
    r = await post(`/e/${fenceToken}/approve`, { signer_name: 'Jane Rivera', agree: 'on' });
    assert.match(decodeURIComponent(r.location), /Approved! Thank you/);
    assert.equal((await q('SELECT count(*)::int AS n FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE j.estimate_id = $1', [fence]))[0].n, 0);

    // ---- Automatic emails ----
    as('alice');
    r = await post('/settings/emails', { estimate_followup_days: '3', appointment_reminders: 'on', review_requests: 'on', review_url: '', default_deposit_percent: '10' });
    assert.equal(r.status, 422); assert.match(r.body, /Add your review link/);
    r = await post('/settings/emails', { estimate_followup_days: '3', appointment_reminders: 'on', review_requests: 'on', review_url: 'https://g.page/r/vista', default_deposit_percent: '10' });
    assert.equal(r.status, 303);
    assert.match((await getPage('/estimates/new')).body, /id="deposit_percent"[^>]*value="10"|value="10"[^>]*id="deposit_percent"/);
    // Follow-ups: after 3 days, again after 6, then stop
    r = await post('/estimates', [['client_id', String(jane)], ['project_name', 'Patio'], ['status', 'draft'], ['deposit_percent', '0'],
      ['item_desc', 'Pavers'], ['item_qty', '1'], ['item_price', '3000']]);
    const patio = idFrom(r.location);
    await post(`/estimates/${patio}/send`, { send_to: 'jane@example.com' });
    const reminders = async () => (await q("SELECT count(*)::int AS n FROM email_log WHERE estimate_id = $1 AND kind = 'estimate_reminder'", [patio]))[0].n;
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(await reminders(), 0, 'not before 3 days');
    await dbClient.query("UPDATE estimates SET sent_at = now() - interval '3 days 1 minute' WHERE id = $1", [patio]);
    await waitFor(async () => (await reminders()) === 1, 'first follow-up');
    assert.match(mail.sent.find((x) => /Reminder: your estimate/.test(x.subject)).text, /Patio/);
    await dbClient.query("UPDATE estimates SET sent_at = now() - interval '6 days 1 minute' WHERE id = $1", [patio]);
    await waitFor(async () => (await reminders()) === 2, 'second follow-up');
    await dbClient.query("UPDATE estimates SET sent_at = now() - interval '30 days' WHERE id = $1", [patio]);
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(await reminders(), 2, 'at most two follow-ups');

    // Appointment reminder the day before the job starts, once
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(Date.now() + 86400000));
    await post(`/jobs/${job.id}`, { status: 'not_started', start_date: tomorrow, end_date: '', notes: '' });
    const kindCount = async (kind) => (await q('SELECT count(*)::int AS n FROM email_log WHERE job_id = $1 AND kind = $2', [job.id, kind]))[0].n;
    await waitFor(async () => (await kindCount('appointment_reminder')) === 1, 'appointment reminder');
    assert.match(mail.sent.find((x) => /is scheduled for/.test(x.subject)).text, /Countertops/);
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(await kindCount('appointment_reminder'), 1);

    // Review request an hour after completion
    await post(`/jobs/${job.id}`, { status: 'completed', start_date: tomorrow, end_date: '', notes: '' });
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(await kindCount('review_request'), 0, 'waits an hour in case completion was a mistake');
    await dbClient.query("UPDATE jobs SET completed_at = now() - interval '2 hours' WHERE id = $1", [job.id]);
    await waitFor(async () => (await kindCount('review_request')) === 1, 'review request');
    assert.ok(mail.sent.find((x) => /How did we do/.test(x.subject)).html.includes('https://g.page/r/vista'));
    page = (await getPage(`/jobs/${job.id}`)).body;
    assert.match(page, /Appointment reminder/); assert.match(page, /Review request/);

    // Workers can't send estimates or change email settings
    as('dave');
    assert.equal((await post(`/estimates/${patio}/send`, { send_to: 'x@y.z' })).status, 404);
    assert.equal((await post('/settings/emails', {})).status, 404);
  } finally {
    await fakeStripe.close(); await mail.close();
  }
});

test('estimate address and appointment on the calendar, job address, client total value, crew wording', async () => {
  as('alice'); await post('/login', { email: 'alice@vista.test', password: 'alice-password' });
  const vista = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  const jane = (await dbClient.query("SELECT id FROM clients WHERE org_id = $1 AND name = 'Jane Rivera'", [vista])).rows[0].id;
  const base = [['client_id', String(jane)], ['status', 'approved'], ['deposit_percent', '0'],
    ['item_desc', 'Door'], ['item_qty', '1'], ['item_price', '1800']];
  let r = await post('/estimates', [...base, ['visit_time', '09:30']]);
  assert.equal(r.status, 422); assert.match(r.body, /Add a date for the estimate time/);
  r = await post('/estimates', [...base, ['visit_date', '2026-12-03'], ['visit_time', '25:00']]);
  assert.equal(r.status, 422); assert.match(r.body, /valid time/);
  // No address given: the client's address is used
  r = await post('/estimates', [...base, ['visit_date', '2026-12-03'], ['visit_time', '14:30']]);
  const plain = idFrom(r.location);
  assert.equal((await dbClient.query('SELECT address FROM estimates WHERE id = $1', [plain])).rows[0].address, '12 Oak St, Austin TX');
  r = await post('/estimates', [...base, ['address', '77 Lake Rd, Round Rock TX'], ['visit_date', '2026-12-03'], ['visit_time', '09:30']]);
  const est = idFrom(r.location);
  let page = (await getPage(`/estimates/${est}`)).body;
  assert.match(page, /77 Lake Rd, Round Rock TX/); assert.match(page, /id="appointment">.*Dec 3, 2026.* at 9:30 AM/s);
  // On the calendar, in time order
  page = (await getPage('/jobs?day=2026-12-03')).body;
  assert.match(page, /9:30 AM · Estimate: 77 Lake Rd, Round Rock TX[\s\S]*2:30 PM · Estimate: 12 Oak St, Austin TX/);
  assert.equal((await dbClient.query('SELECT project_name FROM estimates WHERE id = $1', [est])).rows[0].project_name, '77 Lake Rd, Round Rock TX', 'the address is the project name');
  assert.match(page, /class="visit"/); assert.match(page, />Estimate<\/span>/);
  assert.match((await getPage('/estimates/new?date=2026-12-03')).body, /value="2026-12-03"/);
  // The job takes the estimate's address, and it can be changed on the job
  const job = idFrom((await post(`/estimates/${est}/convert`, {})).location);
  assert.equal((await dbClient.query('SELECT address FROM jobs WHERE id = $1', [job])).rows[0].address, '77 Lake Rd, Round Rock TX');
  await post(`/jobs/${job}`, { status: 'not_started', start_date: '', end_date: '', notes: '', address: '78 Lake Rd, Round Rock TX' });
  assert.deepEqual((await dbClient.query('SELECT address, project_name FROM jobs WHERE id = $1', [job])).rows[0],
    { address: '78 Lake Rd, Round Rock TX', project_name: '78 Lake Rd, Round Rock TX' });
  // Client total value = their jobs' contract totals
  const expected = (await dbClient.query('SELECT sum(contract_cents)::bigint AS v FROM jobs WHERE client_id = $1', [jane])).rows[0].v;
  page = (await getPage(`/clients/${jane}`)).body;
  assert.equal(stat(page, 'client-value'), fmt(Number(expected)));
  assert.match((await getPage('/clients')).body, new RegExp(fmt(Number(expected)).replace(/[$.]/g, '\\$&')));
  // "Crew" instead of "Worker"
  page = (await getPage('/team')).body;
  assert.match(page, /Crew ·/); assert.doesNotMatch(page, />Worker</);
});

test('crew overview counts completed jobs; light and dark appearance', async () => {
  as('dave'); await post('/login', { email: 'dave@vista.test', password: 'dave-password' });
  const deck = (await dbClient.query(`SELECT j.id FROM jobs j JOIN job_assignments a ON a.job_id = j.id
    JOIN auth.users u ON u.id = a.user_id WHERE u.email = 'dave@vista.test' AND j.project_name = 'Deck'`)).rows[0].id;
  await dbClient.query("UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1", [deck]);
  let page = (await getPage('/')).body;
  assert.match(page, /data-k="done-year">1</); assert.match(page, /data-k="pay-year">\$350\.00</); assert.match(page, /data-k="open-jobs">0</);
  page = (await getPage('/schedule')).body;
  assert.match(page, /<h2>Completed<\/h2><div class="list">[\s\S]*Deck/);
  assert.match((await getPage(`/schedule/${deck}`)).body, /Bring the long ladder/);

  // Appearance: automatic by default; light or dark is remembered on this device
  page = (await getPage('/account')).body;
  assert.match(page, /<html lang="en">/); assert.match(page, /value="system" class="on"/);
  let r = await post('/account/theme', { theme: 'light' }); assert.equal(r.status, 303);
  page = (await getPage('/')).body;
  assert.match(page, /<html lang="en" data-theme="light">/); assert.match(page, /<meta name="theme-color" content="#f3f4f8">/);
  assert.doesNotMatch(page, /content="#0b0d14"/);
  assert.match((await getPage('/account')).body, /value="light" class="on"/);
  await post('/account/theme', { theme: 'dark' });
  assert.match((await getPage('/')).body, /data-theme="dark"/);
  await post('/account/theme', { theme: 'system' });
  assert.match((await getPage('/')).body, /<html lang="en">/);
});

test('week view, scope from line items with options, expense receipts', async () => {
  as('alice'); await post('/login', { email: 'alice@vista.test', password: 'alice-password' });
  const vista = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Vista Artisans'")).rows[0].id;
  const jane = (await dbClient.query("SELECT id FROM clients WHERE org_id = $1 AND name = 'Jane Rivera'", [vista])).rows[0].id;

  // Week view: Sunday to Saturday around the chosen day, with jobs and estimate appointments; no "appointment this day" button
  let page = (await getPage('/jobs?view=week&day=2026-12-03')).body;
  assert.match(page, /id="week"/); assert.match(page, /Nov 29 – Dec 5, 2026/);
  assert.match(page, /data-day="2026-12-03"[\s\S]*?Estimate: 77 Lake Rd/);
  assert.match(page, /href="\/jobs\?view=week(&amp;|&)day=2026-12-06"/); assert.doesNotMatch(page, /appointment this day/);
  assert.doesNotMatch((await getPage('/jobs?day=2026-12-03')).body, /appointment this day/);

  // Scope: every option until one is chosen, then shared lines plus the chosen option; the job copies it
  let r = await post('/estimates', [['client_id', String(jane)], ['project_name', 'Bath'], ['status', 'sent'], ['deposit_percent', '0'],
    ['item_desc', 'Demo'], ['item_qty', '1'], ['item_price', '500'], ['item_option', ''],
    ['item_desc', 'Tile shower'], ['item_qty', '1'], ['item_price', '4000'], ['item_option', 'Good'],
    ['item_desc', 'Stone shower'], ['item_qty', '1'], ['item_price', '7000'], ['item_option', 'Best']]);
  const bath = idFrom(r.location);
  const scope = async () => (await dbClient.query('SELECT scope FROM estimates WHERE id = $1', [bath])).rows[0].scope;
  assert.equal(await scope(), '• Demo\n\n• Good: Tile shower\n\n• Best: Stone shower');
  await post(`/estimates/${bath}/status`, { status: 'approved', chosen_option: 'Best' });
  assert.equal(await scope(), '• Demo\n\n• Stone shower');
  const job = idFrom((await post(`/estimates/${bath}/convert`, {})).location);
  assert.equal((await dbClient.query('SELECT scope FROM jobs WHERE id = $1', [job])).rows[0].scope, '• Demo\n\n• Stone shower');

  // Receipts: a photo or PDF on an expense, viewable, replaceable and removable; anything else is refused
  const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;
  const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 receipt').toString('base64')}`;
  r = await post(`/jobs/${job}/expenses`, { description: 'Tile', amount: '320', receipt_data: 'data:text/html;base64,PGI+', receipt_name: 'x.html' });
  assert.equal(r.status, 422); assert.match(r.body, /photo \(JPG or PNG\) or a PDF/);
  r = await post(`/jobs/${job}/expenses`, { description: 'Tile', amount: '320', receipt_data: `data:image/jpeg;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` });
  assert.equal(r.status, 422, 'the file contents must match');
  r = await post(`/jobs/${job}/expenses`, { description: 'Tile', amount: '320', receipt_data: jpg, receipt_name: 'tile.jpg' });
  assert.equal(r.status, 303);
  const exp = (await dbClient.query("SELECT id FROM expenses WHERE job_id = $1 AND description = 'Tile'", [job])).rows[0].id;
  page = (await getPage(`/jobs/${job}`)).body;
  assert.match(page, new RegExp(`href="/expenses/${exp}/receipt"`));
  r = await getPage(`/expenses/${exp}/receipt`);
  assert.equal(r.status, 200); assert.equal(r.type, 'image/jpeg');
  // A big PDF (about 4 MB) fits; replacing it keeps one receipt
  const bigPdf = `data:application/pdf;base64,${Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4_000_000, 32)]).toString('base64')}`;
  r = await post(`/expenses/${exp}`, { description: 'Tile', amount: '320', receipt_data: bigPdf, receipt_name: 'invoice.pdf' });
  assert.equal(r.status, 303);
  r = await getPage(`/expenses/${exp}/receipt`); assert.equal(r.type, 'application/pdf');
  r = await post(`/expenses/${exp}`, { description: 'Tile', amount: '320', receipt_data: pdf });
  assert.equal((await dbClient.query('SELECT count(*)::int AS n FROM expense_receipts WHERE expense_id = $1', [exp])).rows[0].n, 1);
  r = await post(`/expenses/${exp}`, { description: 'Tile', amount: '320', remove_receipt: '1' });
  assert.equal((await getPage(`/expenses/${exp}/receipt`)).status, 404);
  // Other companies and crew can't see receipts
  await post(`/expenses/${exp}`, { description: 'Tile', amount: '320', receipt_data: jpg });
  as('bob'); assert.equal((await getPage(`/expenses/${exp}/receipt`)).status, 404);
  as('dave'); assert.equal((await getPage(`/expenses/${exp}/receipt`)).status, 404);
  assert.match((await getPage('/schedule?view=week')).body, /id="week"/);
});

test('W-2 time clock vs subcontractor payouts, job photos, appearance stops forced dark', async () => {
  as('alice'); await post('/login', { email: 'alice@vista.test', password: 'alice-password' });
  const dave = (await dbClient.query("SELECT id FROM auth.users WHERE email = 'dave@vista.test'")).rows[0].id;
  const deck = (await dbClient.query(`SELECT j.id FROM jobs j JOIN job_assignments a ON a.job_id = j.id
    WHERE a.user_id = $1 AND j.project_name = 'Deck'`, [dave])).rows[0].id;
  await dbClient.query("UPDATE jobs SET status = 'in_progress', completed_at = null WHERE id = $1", [deck]);

  // Subcontractors can't clock in
  as('dave'); await post('/login', { email: 'dave@vista.test', password: 'dave-password' });
  let page = (await getPage(`/schedule/${deck}`)).body;
  assert.doesNotMatch(page, /id="clock"/);
  let r = await post(`/schedule/${deck}/clock-in`, {}); assert.match(r.location, /Only%20W-2/);

  // Admin makes Dave a W-2 employee at $30/hr
  as('alice');
  r = await post(`/team/${dave}/pay`, { pay_type: 'w2', hourly_rate: 'abc' }); assert.match(r.location, /Hourly/);
  r = await post(`/team/${dave}/pay`, { pay_type: 'w2', hourly_rate: '30' }); assert.equal(r.status, 303);
  assert.match((await getPage('/team')).body, /W-2 · \$30\.00\/hr/);
  assert.match((await getPage(`/team/${dave}`)).body, /value="w2" checked/);

  // Dave clocks in (once), works two hours, clocks out: labor = $60 on top of his $350 payout
  as('dave');
  r = await post(`/schedule/${deck}/clock-in`, {}); assert.equal(r.location, `/schedule/${deck}?msg=Clocked+in`);
  r = await post(`/schedule/${deck}/clock-in`, {}); assert.match(r.location, /already%20clocked%20in/);
  assert.match((await getPage('/')).body, /id="clocked-in"/);
  assert.match((await getPage(`/schedule/${deck}`)).body, /Clock out/);
  await dbClient.query("UPDATE time_entries SET clock_in = now() - interval '2 hours' WHERE user_id = $1 AND clock_out IS NULL", [dave]);
  r = await post(`/schedule/${deck}/clock-out`, {}); assert.equal(r.status, 303);
  page = (await getPage(`/schedule/${deck}`)).body;
  assert.match(page, /data-k="my-hours">2h 00m worked/); assert.equal(stat(page, 'my-pay'), '$410.00');

  // Admin sees the entry and labor in job costs, and can add time by hand ($30 x 4h = $120)
  as('alice');
  const payouts = async () => stat((await getPage(`/jobs/${deck}`)).body, 'payouts');
  assert.equal(await payouts(), '$410.00');
  page = (await getPage(`/jobs/${deck}`)).body;
  assert.match(page, /id="time-entries"/); assert.match(page, /2h 00m at \$30\.00\/hr/);
  r = await post(`/jobs/${deck}/time`, { user_id: dave, work_date: '2026-11-10', start_time: '8am', end_time: '12:00' }); assert.equal(r.status, 422);
  r = await post(`/jobs/${deck}/time`, { user_id: dave, work_date: '2026-11-10', start_time: '08:00', end_time: '12:00' }); assert.equal(r.status, 303);
  assert.equal(await payouts(), '$530.00');
  // A changed rate doesn't rewrite past entries
  await post(`/team/${dave}/pay`, { pay_type: 'w2', hourly_rate: '40' });
  assert.equal(await payouts(), '$530.00');
  const entry = (await dbClient.query('SELECT id FROM time_entries WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [deck])).rows[0].id;
  r = await post(`/time/${entry}/delete`, {}); assert.equal(r.status, 303);
  assert.equal(await payouts(), '$410.00');
  as('bob'); assert.equal((await post(`/time/${entry - 1}/delete`, {})).status, 404);

  // Photos: crew on the job add and see them; other companies can't
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  as('dave');
  r = await post(`/jobs/${deck}/photos`, { photo_data: 'data:image/svg+xml;base64,PHN2Zz4=' }); assert.equal(r.status, 422);
  r = await post(`/jobs/${deck}/photos`, { photo_data: png }); assert.equal(r.status, 303);
  const photo = (await dbClient.query('SELECT id FROM job_photos WHERE job_id = $1', [deck])).rows[0].id;
  assert.equal((await getPage(`/photos/${photo}`)).status, 200);
  assert.match((await getPage(`/schedule/${deck}`)).body, new RegExp(`/photos/${photo}/delete`));
  as('alice'); assert.match((await getPage(`/jobs/${deck}`)).body, new RegExp(`src="/photos/${photo}"`));
  as('bob');
  assert.equal((await getPage(`/photos/${photo}`)).status, 404);
  assert.equal((await post(`/jobs/${deck}/photos`, { photo_data: png })).status, 404);
  as('dave'); r = await post(`/photos/${photo}/delete`, {}); assert.match(r.location, /Photo\+deleted/);

  // Picking Light or Dark tells the browser not to recolor the page
  await post('/account/theme', { theme: 'light' });
  assert.match((await getPage('/')).body, /<meta name="color-scheme" content="only light">/);
  await post('/account/theme', { theme: 'system' });
  assert.match((await getPage('/')).body, /<meta name="color-scheme" content="light dark">/);
});

test('privacy policy and terms are public', async () => {
  for (const [p, t] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Use']]) {
    const r = await getPage(p, { auth: false }); assert.equal(r.status, 200); assert.match(r.body, new RegExp(`<h1>${t}</h1>`));
  }
  assert.match((await getPage('/signup', { auth: false })).body, /href="\/terms"/);
});

test('public home, support and data deletion pages; forgot password; delete company; delete account', async () => {
  for (const [p, t] of [['/support', 'Help &amp; support'], ['/data-deletion', 'Delete your data']]) {
    const r = await getPage(p, { auth: false }); assert.equal(r.status, 200); assert.match(r.body, new RegExp(`<h1>${t}</h1>`));
  }
  assert.match((await getPage('/login', { auth: false })).body, /href="\/forgot"/);

  // Frank runs a company with a converted job; Gina joins it as crew
  as('frank'); await post('/signup', { email: 'frank@keystone.test', password: 'frank-password' });
  let r = await post('/org/new', { name: 'Frank Painting' }); assert.equal(r.status, 303);
  const frankOrg = (await dbClient.query("SELECT id FROM organizations WHERE name = 'Frank Painting'")).rows[0].id;
  await dbClient.query(`INSERT INTO org_subscriptions (org_id, plan, comped) VALUES ($1, 'unlimited', true)
    ON CONFLICT (org_id) DO UPDATE SET plan = 'unlimited', comped = true`, [frankOrg]);
  r = await post('/clients', { name: 'Pat Lee', address: '9 Elm St' }); const client = idFrom(r.location);
  r = await post('/estimates', new URLSearchParams([['client_id', String(client)], ['status', 'approved'], ['deposit_percent', '0'],
    ['item_desc', 'Paint living room'], ['item_qty', '1'], ['item_price', '1200']]));
  assert.equal(r.status, 303); const est = idFrom(r.location);
  r = await post(`/estimates/${est}/convert`, {}); assert.equal(r.status, 303);
  const code = (await getPage('/team')).body.match(/id="join-code">([A-Z0-9]{4}-[A-Z0-9]{4})</)[1];
  as('gina'); await post('/signup', { email: 'gina@keystone.test', password: 'gina-password' });
  assert.equal((await post('/org/join', { code })).status, 303);

  // The only admin of a company with other people can't delete their account yet
  as('frank');
  let page = (await getPage('/account')).body; assert.match(page, /href="\/account\/delete"/);
  page = (await getPage('/account/delete')).body; assert.match(page, /only admin of <strong>Frank Painting<\/strong>/);
  assert.equal((await post('/account/delete', { confirm: 'DELETE' })).status, 409);

  // Forgot password: the emailed link returns to /reset with a one-time token
  as('anon');
  r = await post('/forgot', { email: 'nope' }); assert.equal(r.status, 422);
  r = await post('/forgot', { email: 'frank@keystone.test' }); assert.equal(r.status, 200); assert.match(r.body, /reset link is on its way/);
  r = await post('/forgot', { email: 'nobody@keystone.test' }); assert.equal(r.status, 200, 'never reveals whether an account exists');
  const rec = fakeAuth.recoveries.at(-1); assert.equal(rec.email, 'frank@keystone.test'); assert.equal(rec.redirectTo, `${BASE}/reset`);
  assert.equal((await getPage('/reset')).status, 200);
  r = await post('/reset', { token: rec.token, password: 'short' }); assert.equal(r.status, 422); assert.match(r.body, new RegExp(`value="${rec.token}"`));
  r = await post('/reset', { token: 'bad-token', password: 'long-enough-1' }); assert.equal(r.status, 400);
  r = await post('/reset', { token: rec.token, password: 'frank-new-password' }); assert.equal(r.status, 303); assert.match(r.location, /Password\+updated/);
  assert.equal((await post('/login', { email: 'frank@keystone.test', password: 'frank-password' })).status, 401);
  as('frank'); assert.equal((await post('/login', { email: 'frank@keystone.test', password: 'frank-new-password' })).status, 303);

  // Gina deletes her account: her login and membership go, Frank's company stays
  as('gina');
  page = (await getPage('/account/delete')).body; assert.match(page, /Type DELETE to confirm/); assert.doesNotMatch(page, /Because you're the only person/);
  assert.equal((await post('/account/delete', { confirm: 'nope' })).status, 422);
  r = await post('/account/delete', { confirm: 'delete' }); assert.equal(r.status, 303); assert.match(r.location, /account\+was\+deleted/);
  assert.match(r.setCookies.join(), /sa=;/);
  as('anon'); assert.equal((await post('/login', { email: 'gina@keystone.test', password: 'gina-password' })).status, 401);
  const gina = (await dbClient.query("SELECT count(*)::int AS n FROM auth.users WHERE email = 'gina@keystone.test'")).rows[0].n;
  assert.equal(gina, 0);
  as('frank'); assert.doesNotMatch((await getPage('/team')).body, /gina@keystone/);

  // Frank deletes the company (typed name must match); its converted job and estimate go with it
  page = (await getPage('/settings')).body; assert.match(page, /href="\/settings\/delete-company"/);
  assert.equal((await post('/settings/delete-company', { confirm: 'Frank' })).status, 422);
  r = await post('/settings/delete-company', { confirm: 'frank painting' }); assert.equal(r.status, 303);
  const left = await dbClient.query('SELECT (SELECT count(*) FROM organizations WHERE id = $1)::int AS orgs, (SELECT count(*) FROM jobs WHERE org_id = $1)::int AS jobs', [frankOrg]);
  assert.deepEqual(left.rows[0], { orgs: 0, jobs: 0 });
  assert.equal((await getPage('/')).location, '/welcome');

  // A company where Frank is the only person is deleted along with his account
  await post('/org/new', { name: 'Solo Co' });
  page = (await getPage('/account/delete')).body; assert.match(page, /this also deletes <strong>Solo Co<\/strong>/);
  r = await post('/account/delete', { confirm: 'DELETE' }); assert.equal(r.status, 303);
  assert.equal((await dbClient.query("SELECT count(*)::int AS n FROM organizations WHERE name = 'Solo Co'")).rows[0].n, 0);
  assert.equal((await getPage('/account')).location, '/login');
});

test('importer: CSV parsing, column guesses, dates and statuses', () => {
  const importer = require('../src/importer');
  const { headers, rows } = importer.parseCsv('﻿Name,Notes\r\n"Doe, Jane","Line one\nline ""two"""\r\n\r\nBob,\n');
  assert.deepEqual(headers, ['Name', 'Notes']);
  assert.deepEqual(rows, [['Doe, Jane', 'Line one\nline "two"'], ['Bob', '']]);
  const m = importer.guessMapping('clients', ['First Name', 'Last Name', 'Company Name', 'E-mail', 'Main Phone', 'Billing Street 1', 'Billing City', 'Billing State', 'Billing Zip code']);
  assert.deepEqual(m, { first_name: 0, last_name: 1, company: 2, email: 3, phone: 4, street: 5, city: 6, state: 7, zip: 8 });
  assert.equal(importer.guessMapping('jobs', ['Customer', 'Job Title', 'Total ($)', 'Scheduled Start', 'Job Status']).amount, 2);
  assert.equal(importer.parseDate('10/5/26').value, '2026-10-05');
  assert.equal(importer.parseDate('Oct 5, 2026 3:00 PM').value, '2026-10-05');
  assert.equal(importer.parseDate('2026-10-05T14:00:00Z').value, '2026-10-05');
  assert.ok(importer.parseDate('13/45/2026').error);
  assert.equal(importer.parseStatus('Completed'), 'completed'); assert.equal(importer.parseStatus('In Progress'), 'in_progress');
  assert.equal(importer.parseStatus('Scheduled'), 'not_started'); assert.equal(importer.parseStatus(''), null);
});

test('import clients and jobs from a CSV export', async () => {
  as('hank'); await post('/signup', { email: 'hank@keystone.test', password: 'hank-password' });
  await post('/org/new', { name: 'Hank Floors' });
  let page = (await getPage('/clients')).body; assert.match(page, /href="\/import"/);
  assert.equal((await getPage('/import')).status, 200);
  assert.equal((await post('/import/preview', { kind: 'clients', csv: '' })).status, 422);

  const clientsCsv = 'First Name,Last Name,Company Name,E-mail,Main Phone,Billing Street 1,Billing City,Billing State,Billing Zip code\n'
    + 'John,Smith,,john@example.com,555-0100,1 Main St,Lancaster,PA,17602\n'
    + ',,Acme Builders,office@acme.test,,,,,\n'
    + ',,,nobody@example.com,,,,,\n';
  let r = await post('/import/preview', { kind: 'clients', csv: clientsCsv, file_name: 'jobber-clients.csv' });
  assert.equal(r.status, 200);
  assert.equal(stat(r.body, 'ready'), '2'); assert.equal(stat(r.body, 'problems'), '1'); assert.match(r.body, /Line 4: no client name/);
  assert.match(r.body, /<option value="5" selected>Billing Street 1<\/option>/);
  r = await post('/import/run', { kind: 'clients', csv: clientsCsv, file_name: 'jobber-clients.csv' });
  assert.equal(r.status, 303); assert.match(decodeURIComponent(r.location), /Imported 2 clients \(1 skipped\)/);
  const john = (await dbClient.query("SELECT * FROM clients WHERE name = 'John Smith'")).rows[0];
  assert.equal(john.address, '1 Main St, Lancaster, PA 17602'); assert.equal(john.email, 'john@example.com');
  r = await post('/import/preview', { kind: 'clients', csv: clientsCsv });
  assert.equal(stat(r.body, 'ready'), '0'); assert.equal(stat(r.body, 'dupes'), '2');

  // Jobs: the owner fixes a column match (the amount is in "Grand Total"), reuses John Smith, creates a new client
  const jobsCsv = 'Customer,Job Title,Grand Total,Start,Finish,Job Status,Site\n'
    + 'John Smith,Install LVP,"$4,500.00",10/1/2026,10/3/2026,Completed,9 Oak Ave\n'
    + 'Mary Jones,Refinish floors,1200,2026-11-02,,Scheduled,\n'
    + 'Bad Row,Tile,abc,10/1/2026,,,\n';
  r = await post('/import/preview', { kind: 'jobs', csv: jobsCsv });
  assert.equal(stat(r.body, 'ready'), '2'); assert.equal(stat(r.body, 'problems'), '1');
  const form = { kind: 'jobs', csv: jobsCsv, map_name: '0', map_title: '1', map_amount: '2', map_start_date: '3', map_end_date: '4', map_status: '5', map_job_address: '6' };
  r = await post('/import/run', form); assert.equal(r.status, 303); assert.match(r.location, /^\/jobs\?msg=Imported%202%20jobs/);
  const jobs = (await dbClient.query(`SELECT j.*, c.name AS client, (j.completed_at AT TIME ZONE 'America/Los_Angeles')::date::text AS done
    FROM jobs j JOIN clients c ON c.id = j.client_id JOIN organizations o ON o.id = j.org_id WHERE o.name = 'Hank Floors' ORDER BY j.id`)).rows;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].client, 'John Smith'); assert.equal(Number(jobs[0].contract_cents), 450000); assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].address, '9 Oak Ave'); assert.equal(jobs[0].done, '2026-10-03'); assert.match(jobs[0].scope, /Install LVP/);
  assert.equal(jobs[1].client, 'Mary Jones'); assert.equal(jobs[1].status, 'not_started'); assert.equal(jobs[1].address, '');
  assert.equal((await dbClient.query("SELECT count(*)::int AS n FROM clients WHERE name = 'John Smith'")).rows[0].n, 1, 'reuses the client');
  r = await post('/import/preview', form); assert.equal(stat(r.body, 'dupes'), '2', 'importing the same file again skips its jobs');

  // Crew can't import
  as('erin'); assert.equal((await getPage('/import')).status, 404);
});

test('text message follow-ups: optional, only with consent and a registered sender, STOP respected', async () => {
  const { startFakeTwilio } = require('./fake-twilio');
  const twilio = await startFakeTwilio('ACtest', 'twilio-token');
  const q = async (sql, p = []) => (await dbClient.query(sql, p)).rows;
  const waitFor = async (fn, what) => {
    for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); }
    assert.fail(`timed out waiting for ${what}`);
  };
  await stop();
  await start({ TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-token', TWILIO_API_BASE: twilio.url, APP_URL: BASE, AUTOMATION_INTERVAL_MS: '300' });
  try {
    as('ivy'); await post('/signup', { email: 'ivy@keystone.test', password: 'ivy-password' });
    await post('/org/new', { name: 'Ivy Painting' });
    const org = (await q("SELECT id FROM organizations WHERE name = 'Ivy Painting'"))[0].id;
    const settings = { estimate_followup_days: '0', default_deposit_percent: '0', sms_estimate_followups: 'on', sms_appointment_reminders: 'on' };

    // Until the company's sender is registered, the text switches are off and can't be turned on
    let page = (await getPage('/settings')).body;
    assert.match(page, /name="sms_estimate_followups"  disabled/); assert.match(page, /not set up yet/);
    await post('/settings/emails', settings);
    assert.deepEqual((await q('SELECT sms_estimate_followups, sms_appointment_reminders FROM company_profiles WHERE org_id = $1', [org]))[0],
      { sms_estimate_followups: false, sms_appointment_reminders: false });
    await q("INSERT INTO sms_senders (org_id, messaging_service_sid, phone) VALUES ($1, 'MG0123456789abcdef0123456789abcdef', '+15550001111')", [org]);
    page = (await getPage('/settings')).body; assert.match(page, /\+15550001111/); assert.doesNotMatch(page, /not set up yet/);
    await post('/settings/emails', settings);
    assert.deepEqual((await q('SELECT sms_estimate_followups, sms_appointment_reminders, sms_review_requests FROM company_profiles WHERE org_id = $1', [org]))[0],
      { sms_estimate_followups: true, sms_appointment_reminders: true, sms_review_requests: false });

    // Pat agreed to texts; Quinn didn't
    let r = await post('/clients', { name: 'Pat Lee', phone: '(717) 555-0123', sms_consent: 'on' }); const pat = idFrom(r.location);
    r = await post('/clients', { name: 'Quinn Diaz', phone: '717-555-0456' }); const quinn = idFrom(r.location);
    assert.match((await getPage(`/clients/${pat}/edit`)).body, /name="sms_consent" checked/);
    const jobFor = async (client, addr) => {
      r = await post('/estimates', new URLSearchParams([['client_id', String(client)], ['status', 'approved'], ['deposit_percent', '0'], ['address', addr],
        ['item_desc', 'Interior painting'], ['item_qty', '1'], ['item_price', '2000']]));
      const est = idFrom(r.location); r = await post(`/estimates/${est}/convert`, {});
      return { est, job: idFrom(r.location) };
    };
    const a = await jobFor(pat, '1 Elm St'); const b = await jobFor(quinn, '2 Elm St');
    await q(`UPDATE jobs SET start_date = (now() AT TIME ZONE 'America/Los_Angeles')::date + 1 WHERE id = ANY($1)`, [[a.job, b.job]]);
    await waitFor(async () => twilio.sent.length >= 1, 'the day-before text');
    let m = twilio.sent[0];
    assert.equal(m.To, '+17175550123'); assert.equal(m.MessagingServiceSid, 'MG0123456789abcdef0123456789abcdef');
    assert.match(m.Body, /^Ivy Painting: Hi Pat, a reminder that we're scheduled to start 1 Elm St/); assert.match(m.Body, /Reply STOP to opt out\.$/);
    await waitFor(async () => (await q('SELECT count(*)::int AS n FROM jobs WHERE id = $1 AND reminder_sent_for IS NOT NULL', [b.job]))[0].n === 1, 'Quinn skipped');
    assert.equal(twilio.sent.filter((x) => x.To === '+17175550456').length, 0, 'no consent, no text');
    page = (await getPage(`/jobs/${a.job}`)).body; assert.match(page, /Appointment reminder \(text\)/);

    // Estimate follow-up by text (email follow-ups are off): every 3 days while it waits
    r = await post('/estimates', new URLSearchParams([['client_id', String(pat)], ['status', 'sent'], ['deposit_percent', '0'], ['address', '3 Elm St'],
      ['item_desc', 'Exterior painting'], ['item_qty', '1'], ['item_price', '5000']]));
    const est = idFrom(r.location);
    await q("UPDATE estimates SET sent_at = now() - interval '3 days 1 minute' WHERE id = $1", [est]);
    await waitFor(async () => twilio.sent.length >= 2, 'the estimate follow-up text');
    m = twilio.sent[1];
    assert.match(m.Body, /just checking in on your estimate for 3 Elm St\. Review and approve here: http:\/\/127\.0\.0\.1:\d+\/e\/\w+/);

    // Pat replies STOP: recorded on Pat (Twilio checks its signature), and no more texts
    const params = new URLSearchParams({ To: '+15550001111', From: '+17175550123', Body: 'Stop ' });
    const sig = (p) => require('node:crypto').createHmac('sha1', 'twilio-token')
      .update(`${BASE}/twilio/inbound` + [...p.keys()].sort().map((k) => k + p.get(k)).join('')).digest('base64');
    let res = await fetch(`${BASE}/twilio/inbound`, { method: 'POST', body: params, headers: { 'x-twilio-signature': 'forged' } });
    assert.equal(res.status, 403);
    res = await fetch(`${BASE}/twilio/inbound`, { method: 'POST', body: params, headers: { 'x-twilio-signature': sig(params) } });
    assert.equal(res.status, 200);
    assert.ok((await q('SELECT sms_opted_out_at FROM clients WHERE id = $1', [pat]))[0].sms_opted_out_at);
    assert.match((await getPage(`/clients/${pat}/edit`)).body, /replied STOP/);
    await q("UPDATE estimates SET sent_at = now() - interval '6 days 1 minute' WHERE id = $1", [est]);
    await waitFor(async () => (await q('SELECT reminders_sent FROM estimates WHERE id = $1', [est]))[0].reminders_sent === 2, 'second follow-up turn');
    assert.equal(twilio.sent.length, 2, 'no text after STOP');
  } finally {
    await stop(); await start(); await twilio.close();
  }
});
