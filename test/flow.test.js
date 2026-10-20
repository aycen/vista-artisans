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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgresql://postgres@localhost:5432/postgres';
const DB_NAME = `vista_test_${process.pid}`;
const DB_URL = ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`);
const ANON = 'test-anon-key';
const PORT = 7000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
let proc; let fakeAuth; let dbClient;

async function start() {
  proc = spawn(process.execPath, ['--no-warnings', path.join(root, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL, DATABASE_SSL: '0', SUPABASE_URL: fakeAuth.url, SUPABASE_ANON_KEY: ANON },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.once('data', resolve));
}
async function stop() { proc.kill(); await new Promise((r) => proc.once('exit', r)); }

// One cookie jar per person.
const jars = { alice: {}, bob: {}, carol: {}, dave: {}, erin: {}, anon: {} };
let who = 'alice';
const as = (name) => { who = name; };
async function req(method, p, form, { auth = true } = {}) {
  const jar = auth ? jars[who] : {};
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: {
      cookie: Object.entries(jar).map(([k, val]) => `${k}=${val}`).join('; '),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
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
  for (const p of ['/', '/clients', '/estimates', '/jobs', '/clients/1', '/team']) {
    const r = await getPage(p);
    assert.equal(r.status, 303); assert.equal(r.location, '/login');
  }
  assert.equal((await post('/clients', { name: 'Hacker' })).status, 401);
  jars.anon = { sa: 'forged', sr: 'forged' };
  assert.equal((await getPage('/')).location, '/login');

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
  assert.match(r.body, /Jane Rivera/); assert.match(r.body, /12 Oak St, Austin TX/);
  assert.match(r.body, /Replace cabinets and counters/);
  assert.equal(stat(r.body, 'contract'), '$4,552.50');
  assert.match(r.body, /\(provisional\)/);

  // Converted estimate is locked
  r = await getPage(`/estimates/${estId}/edit`); assert.equal(r.status, 409);
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
  assert.match((await getPage('/')).body, /id="total-outstanding">\$2,052\.25</);

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
  as('dave'); await post('/signup', { email: 'dave@vista.test', password: 'dave-password' });
  as('alice');
  r = await post('/team/add', { email: 'nobody@x.test', role: 'worker' });
  assert.equal(r.status, 422); assert.match(r.body, /No account uses that email yet/);
  r = await post('/team/add', { email: 'carol@vista.test', role: 'admin' }); assert.equal(r.status, 303);
  r = await post('/team/add', { email: 'dave@vista.test', role: 'worker' }); assert.equal(r.status, 303);
  page = (await getPage('/team')).body;
  assert.match(page, /carol@vista\.test/); assert.match(page, /dave@vista\.test/);

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
  // Home shows this month's revenue: payments dated in the current month (Pacific time by default).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const monthRevenue = async () => (await getPage('/')).body.match(/id="month-revenue">([^<]+)</)[1];
  const expectedRevenue = async () => fmt(Number((await dbClient.query(
    'SELECT coalesce(sum(amount_cents), 0) AS c FROM payments WHERE to_char(paid_on, \'YYYY-MM\') = $1', [today.slice(0, 7)])).rows[0].c));
  assert.equal(await monthRevenue(), await expectedRevenue());
  const before = await monthRevenue();
  r = await post(`/jobs/${jobId}/payments`, { payment_amount: '52.25', paid_on: today }); assert.equal(r.status, 303);
  assert.equal(stat((await getPage(`/jobs/${jobId}`)).body, 'balance'), '$2,000.00');
  assert.notEqual(await monthRevenue(), before); assert.equal(await monthRevenue(), await expectedRevenue());
  assert.match(await monthRevenue(), /^\$\d/);

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
  assert.match(page, /Schedule/); assert.doesNotMatch(page, /id="month-revenue"/); assert.doesNotMatch(page, /join-code/);
  assert.equal((await getPage('/team')).status, 404);
  // A new code stops the old one from working
  as('alice'); r = await post('/team/code', {}); assert.equal(r.status, 303);
  assert.notEqual((await getPage('/team')).body.match(/id="join-code">([^<]+)</)[1], code);
  as('bob'); r = await post('/org/join', { code }); assert.equal(r.status, 422);

  // Dave (worker) sees only his assigned jobs: date, address, scope and his own pay; no other money, no other pages
  as('dave');
  page = (await getPage('/')).body;
  assert.match(page, /Schedule/); assert.match(page, /Deck/); assert.match(page, /9 Elm Rd/);
  assert.match(page, /datetime="2026-11-10"/); assert.match(page, /datetime="2026-11-12"/);
  assert.match(page, /\$350\.00/); assert.equal((page.match(/\$/g) || []).length, 1, 'only his own pay is shown');
  assert.doesNotMatch(page, /Kitchen remodel/);
  page = (await getPage(`/schedule/${deckJob}`)).body;
  assert.match(page, /Deck/); assert.match(page, /Bring the long ladder/);
  assert.match(page, /data-k="my-pay">\$350\.00</); assert.equal((page.match(/\$/g) || []).length, 1);
  for (const p of ['/clients', '/estimates', '/jobs', `/jobs/${deckJob}`, `/clients/${clientId}`, `/estimates/${deckId}`, '/team',
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
  assert.equal((await getPage('/')).location, '/login');
});
