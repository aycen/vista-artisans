'use strict';
const http = require('node:http');
const { pool, asUser, asServer, ESTIMATE_TOTAL_SQL, JOB_TOTALS_SQL, withJobMath } = require('./db');
const auth = require('./auth');
const { parseMoney, parseQty, plain, fmtQty, fmt } = require('./money');
const importer = require('./importer');
const sms = require('./sms');
const texting = require('./texting');
const v = require('./views');
const pdf = require('./pdf');
const stripe = require('./stripe');
const email = require('./email');
const mailer = require('./mailer');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Los_Angeles'; // decides which payments count as "this month"
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
// Forwarding from onrender.com to the custom domain is switched on separately (FORWARD_TO_APP_URL=1), only once the domain works.
const CANONICAL = (() => { try { const u = new URL(process.env.APP_URL); return process.env.FORWARD_TO_APP_URL !== '1' || /\.onrender\.com$/i.test(u.hostname) ? null : u; } catch { return null; } })();

// ---------- responses ----------
// Handlers return a response; it is sent only after the request's database transaction commits.
const page = (status, body, headers = {}) => ({ status, body, headers });
const ok = (body) => page(200, body);
const redirect = (to, headers = {}) => ({ status: 303, headers: { Location: to, ...headers } });
const notFound = () => page(404, v.messagePage('Not found', 'That record does not exist.'));
const str = (val, max = 2000) => String(val ?? '').trim().slice(0, max);
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const SAVE_FAILED = { _save: 'Could not save because of a server error. Your entries are still on this page; please try again.' };
const hasErrors = (e) => Object.keys(e).length > 0;

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}
const formObj = (params) => Object.fromEntries([...params.keys()].map((k) => [k, params.get(k)]));

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
const sessionCookies = (s) => [cookie('sa', s.access_token, 60 * 60 * 24 * 30), cookie('sr', s.refresh_token, 60 * 60 * 24 * 30)];
const clearCookies = [cookie('sa', '', 0), cookie('sr', '', 0)];
const THEMES = ['light', 'dark'];
const themeOf = (req) => { const t = parseCookies(req).theme; return THEMES.includes(t) ? t : ''; };

// Runs fn inside a savepoint so a failed save can be reported on the form without aborting the request.
async function attempt(db, fn) {
  await db.run('SAVEPOINT attempt');
  try {
    const r = await fn();
    await db.run('RELEASE SAVEPOINT attempt');
    return { value: r };
  } catch (e) {
    await db.run('ROLLBACK TO SAVEPOINT attempt');
    return { error: e };
  }
}
// Errors the database raises on purpose for the person using the app (SQLSTATE VA001) are safe to show.
const dbMessage = (e) => (e?.code === 'VA001' ? e.message : null);

// ---------- validation ----------
function validateClient(f, prefix = '') {
  const values = {}; const errors = {}; const clean = {};
  for (const k of ['name', 'phone', 'email', 'address']) values[prefix + k] = f[prefix + k] ?? '';
  clean.name = str(f[prefix + 'name'], 200);
  clean.phone = str(f[prefix + 'phone'], 50);
  clean.email = str(f[prefix + 'email'], 200);
  clean.address = str(f[prefix + 'address'], 500);
  clean.smsConsent = f[prefix + 'sms_consent'] === 'on';
  values[prefix + 'sms_consent'] = clean.smsConsent;
  if (!clean.name) errors[prefix + 'name'] = 'Client name is required.';
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) errors[prefix + 'email'] = 'Email address does not look valid.';
  if (clean.phone && !/^[0-9+().\-\s x]{7,}$/i.test(clean.phone)) errors[prefix + 'phone'] = 'Phone number does not look valid.';
  return { values, errors, clean };
}

async function validateEstimate(db, org, params) {
  const f = formObj(params);
  const errors = {};
  const values = {
    client_id: f.client_id ?? '',
    estimated_cost: f.estimated_cost ?? '', status: v.ESTIMATE_STATUS[f.status] ? f.status : 'draft',
    deposit_percent: f.deposit_percent ?? '0', address: f.address ?? '', visit_date: str(f.visit_date, 20), visit_time: str(f.visit_time, 10),
  };
  if (values.visit_date && !isDate(values.visit_date)) errors.visit_date = 'Estimate date must be a valid date.';
  if (values.visit_time && !/^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(values.visit_time)) errors.visit_time = 'Estimate time must be a valid time.';
  else if (values.visit_time && !values.visit_date) errors.visit_date = 'Add a date for the estimate time.';
  let newClient = null;
  if (values.client_id === 'new') {
    const c = validateClient(f, 'new_');
    Object.assign(values, c.values); Object.assign(errors, c.errors); newClient = c.clean;
  } else if (!/^\d{1,15}$/.test(values.client_id)
    || !(await db.get('SELECT id FROM clients WHERE id = ? AND org_id = ?', Number(values.client_id), org))) {
    errors.client_id = 'Choose a client, or pick "+ New client".';
  }
  const cost = parseMoney(values.estimated_cost, 'Estimated cost', { required: false });
  if (cost.error) errors.estimated_cost = cost.error;

  const deposit = /^\d{1,3}$/.test(String(values.deposit_percent).trim()) ? Number(String(values.deposit_percent).trim()) : NaN;
  if (!(deposit >= 0 && deposit <= 100)) errors.deposit_percent = 'Deposit must be a whole percent from 0 to 100.';

  const descs = params.getAll('item_desc'); const qtys = params.getAll('item_qty'); const prices = params.getAll('item_price');
  const opts = params.getAll('item_option'); const details = params.getAll('item_details');
  const items = []; const cleanItems = [];
  for (let i = 0; i < Math.max(descs.length, qtys.length, prices.length); i++) {
    const it = { desc: descs[i] ?? '', details: details[i] ?? '', qty: qtys[i] ?? '', price: prices[i] ?? '', option: opts[i] ?? '' };
    if (!it.desc.trim() && !it.details.trim() && !it.qty.trim() && !it.price.trim()) continue; // ignore blank rows
    const n = items.length; items.push(it);
    const problems = [];
    const desc = str(it.desc, 500);
    if (!desc) problems.push('name is required');
    const q = parseQty(it.qty, 'quantity'); if (q.error) problems.push(q.error.replace(/^q/, 'Q'));
    const p = parseMoney(it.price, 'unit price'); if (p.error) problems.push(p.error.replace(/^u/, 'U'));
    if (problems.length) errors[`item_${n}`] = `Line ${n + 1}: ${problems.join(' ')}`;
    else cleanItems.push({ desc, details: String(it.details).replace(/\r\n/g, '\n').trim().slice(0, 10000), qty: q.value, price: p.value, option: str(it.option, 60) });
  }
  if (!items.length) errors.items = 'Add at least one line item.';
  const optionNames = new Set(cleanItems.map((i) => i.option).filter(Boolean));
  if (optionNames.size === 1) errors.options = 'Give at least two options (for example Good and Better), or leave Option blank on every line.';
  return {
    values, items, errors,
    clean: { cost: cost.value ?? null, status: values.status, items: cleanItems, newClient,
      deposit: Number.isNaN(deposit) ? 0 : deposit, address: str(values.address, 500),
      visitDate: values.visit_date || null, visitTime: values.visit_time ? values.visit_time.slice(0, 5) : null },
  };
}

function validateExpense(f) {
  const values = { description: f.description ?? '', amount: f.amount ?? '' };
  const errors = {};
  const description = str(values.description, 500);
  if (!description) errors.description = 'Expense description is required.';
  const amt = parseMoney(values.amount, 'Expense amount', { allowZero: false });
  if (amt.error) errors.amount = amt.error;
  return { values, errors, clean: { description, amount: amt.value } };
}
// A receipt arrives as a data URL: photos are shrunk to JPEG in the browser, PDFs are sent as they are (5 MB at most).
const RECEIPT_MAX = 5 * 1024 * 1024;
const RECEIPT_BODY = 8_000_000; // base64 makes a 5 MB file about 6.7 MB
function parseReceipt(f) {
  if (!f.receipt_data) return {};
  const mm = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(f.receipt_data);
  const buf = mm ? Buffer.from(mm[2], 'base64') : null;
  const type = !buf ? null
    : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
    : buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
    : buf.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null;
  if (!type) return { error: 'The receipt must be a photo (JPG or PNG) or a PDF.' };
  if (buf.length > RECEIPT_MAX) return { error: 'The receipt is too large. Use a file under 5 MB.' };
  return { receipt: { data: buf, type, name: str(f.receipt_name, 200) } };
}
const saveReceipt = (db, org, expenseId, r) => db.run(`INSERT INTO expense_receipts (expense_id, org_id, data, content_type, filename)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT (expense_id) DO UPDATE SET data = excluded.data, content_type = excluded.content_type,
  filename = excluded.filename, created_at = now()`, expenseId, org, r.data, r.type, r.name);

function validatePayment(amount, paidOn) {
  const errors = {};
  const amt = parseMoney(amount, 'Payment amount', { allowZero: false });
  if (amt.error) errors.amount = amt.error;
  const date = str(paidOn, 20);
  if (!date) errors.paid_on = 'Date received is required.';
  else if (!isDate(date)) errors.paid_on = 'Date received must be a valid date.';
  return { errors, clean: { amount: amt.value, paidOn: date } };
}

// ---------- queries (always scoped to the current organization; RLS enforces membership too) ----------
const ESTIMATE_LIST_SQL = `SELECT estimates.*, clients.name AS client_name, ${ESTIMATE_TOTAL_SQL} AS total_cents,
  (SELECT id FROM jobs WHERE jobs.estimate_id = estimates.id) AS job_id
  FROM estimates JOIN clients ON clients.id = estimates.client_id`;
const JOB_LIST_SQL = `SELECT jobs.*, clients.name AS client_name, ${JOB_TOTALS_SQL}
  FROM jobs JOIN clients ON clients.id = jobs.client_id`;

const clientsForSelect = (db, org) => db.all('SELECT id, name FROM clients WHERE org_id = ? ORDER BY lower(name)', org);
const loadJob = async (db, org, id) => withJobMath(await db.get(`${JOB_LIST_SQL} WHERE jobs.id = ? AND jobs.org_id = ?`, id, org));
const jobFor = (db, estimateId) => db.get('SELECT id FROM jobs WHERE estimate_id = ?', estimateId);

// The company's linked Stripe account, if it can take payments (null otherwise).
async function payoutAccount(db, orgId) {
  if (!stripe.configured()) return null;
  const a = await db.get('SELECT * FROM stripe_accounts WHERE org_id = ?', orgId);
  return a && a.charges_enabled ? a.account_id : null;
}

async function renderJob(db, org, id, extra = {}, status = 200) {
  const job = await loadJob(db, org, id);
  if (!job) return notFound();
  return page(status, v.jobPage({
    job, ...extra,
    client: await db.get('SELECT * FROM clients WHERE id = ?', job.client_id),
    expenses: await db.all(`SELECT expenses.*, EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id = expenses.id) AS has_receipt
      FROM expenses WHERE job_id = ? ORDER BY id`, id),
    payments: await db.all(`SELECT payments.*, invoices.number AS invoice_number FROM payments
      LEFT JOIN invoices ON invoices.payment_id = payments.id WHERE payments.job_id = ? ORDER BY payments.paid_on, payments.id`, id),
    crew: await db.all('SELECT * FROM job_team(?)', id),
    subCrew: await db.all(`SELECT a.sub_id, a.payout_cents, s.name, s.company, s.email, s.phone FROM sub_assignments a
      JOIN subcontractors s ON s.id = a.sub_id WHERE a.job_id = ? ORDER BY lower(s.name)`, id),
    subs: await db.all('SELECT id, name, company FROM subcontractors WHERE org_id = ? ORDER BY lower(name)', org),
    canEmail: email.configured(),
    members: await db.all(`SELECT m.*, coalesce(p.pay_type, 'sub') AS pay_type, p.hourly_rate_cents FROM org_members(?) m
      LEFT JOIN member_pay p ON p.org_id = ? AND p.user_id = m.user_id`, org, org),
    photos: await photosFor(db, id),
    time: await timeFor(db, id),
    invoices: await db.all('SELECT * FROM invoices WHERE job_id = ? ORDER BY id DESC', id),
    invoicing: { enabled: !!(await payoutAccount(db, org)), testMode: stripe.testMode(), key: crypto.randomUUID() },
    emails: await db.all('SELECT * FROM email_log WHERE job_id = ? ORDER BY id DESC LIMIT 20', id),
  }));
}

async function renderEstimate(db, org, id, extra = {}, status = 200) {
  const estimate = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org);
  if (!estimate) return notFound();
  return page(status, v.estimatePage({
    estimate, ...extra,
    client: await db.get('SELECT * FROM clients WHERE id = ?', estimate.client_id),
    items: await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', id),
    totalCents: (await db.get(`SELECT ${ESTIMATE_TOTAL_SQL} AS t FROM estimates WHERE id = ?`, id)).t,
    job: await jobFor(db, id),
    options: (await mailer.estimateTotals(db, id)).options,
    emails: await db.all('SELECT * FROM email_log WHERE estimate_id = ? ORDER BY id DESC LIMIT 20', id),
    sending: { enabled: email.configured() },
  }));
}

// The scope of work is built from the line items (name, then its description): shared items plus the chosen option
// (or every option, labelled, until the client picks one). The job and work order get the same text, and it follows later edits.
async function refreshScope(db, estimateId) {
  await db.run(`UPDATE estimates e SET scope = coalesce((
      SELECT string_agg('• ' || CASE WHEN li.option_name <> '' AND e.chosen_option IS NULL THEN li.option_name || ': ' ELSE '' END || li.description
        || CASE WHEN li.details <> '' THEN E'\n' || li.details ELSE '' END, E'\n\n' ORDER BY li.position)
      FROM line_items li WHERE li.estimate_id = e.id
        AND (li.option_name = '' OR e.chosen_option IS NULL OR li.option_name = e.chosen_option)), '')
    WHERE e.id = ?`, estimateId);
  await db.run('UPDATE jobs SET scope = (SELECT scope FROM estimates WHERE id = ?) WHERE estimate_id = ?', estimateId, estimateId);
}

async function saveEstimate(db, org, estimateId, values, clean) {
  let clientId = Number(values.client_id);
  if (clean.newClient) {
    const c = clean.newClient;
    clientId = (await db.run('INSERT INTO clients (org_id, name, phone, email, address, sms_consent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      org, c.name, c.phone, c.email, c.address, c.smsConsent)).id;
  }
  // The job site defaults to the client's address, and the address is the project's name (the client's name if there's no address).
  const cl = await db.get('SELECT name, address FROM clients WHERE id = ?', clientId);
  const address = clean.address || cl.address;
  clean.projectName = str(address, 200) || cl.name;
  if (estimateId) {
    await db.run(`UPDATE estimates SET client_id = ?, project_name = ?, estimated_cost_cents = ?, status = ?, deposit_percent = ?,
      chosen_option = NULL, address = ?, visit_date = ?, visit_time = ?, updated_at = now() WHERE id = ? AND org_id = ?`,
    clientId, clean.projectName, clean.cost, clean.status, clean.deposit, address, clean.visitDate, clean.visitTime, estimateId, org);
    await db.run('DELETE FROM line_items WHERE estimate_id = ?', estimateId);
  } else {
    estimateId = (await db.run(`INSERT INTO estimates (org_id, client_id, project_name, estimated_cost_cents, status, deposit_percent,
      address, visit_date, visit_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    org, clientId, clean.projectName, clean.cost, clean.status, clean.deposit, address, clean.visitDate, clean.visitTime)).id;
  }
  for (const [i, it] of clean.items.entries()) {
    await db.run(`INSERT INTO line_items (org_id, estimate_id, position, description, details, qty_hundredths, unit_price_cents, option_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, org, estimateId, i, it.desc, it.details, it.qty, it.price, it.option);
  }
  await refreshScope(db, estimateId);
  return estimateId;
}

// ---------- routes ----------
// Each handler gets ctx = { req, url, id, db, user, org (current membership), orgs }.
// Routes are admin-only unless marked { worker: true }; the database enforces the same split.
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d{1,15})').replace(/:uid/g, '([0-9a-f-]{36})') + '$'), handler, uid: pattern.includes(':uid'), ...opts });

route('GET', '/', async (ctx) => {
  if (ctx.org.role !== 'admin') return crewHome(ctx);
  const { db, org, url } = ctx;
  const o = org.org_id;
  const openEstimates = await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.org_id = ? AND (estimates.status IN ('draft', 'sent')
    OR (estimates.status = 'approved' AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.estimate_id = estimates.id)))
    ORDER BY estimates.updated_at DESC`, o);
  const activeJobs = (await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? AND jobs.status = 'in_progress'
    ORDER BY jobs.start_date NULLS LAST, jobs.id`, o)).map(withJobMath);
  const allJobs = (await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ?`, o)).map(withJobMath);
  // Revenue = the contract value of completed jobs, counted in the month each was completed (APP_TIMEZONE).
  // Outstanding = what's still owed on completed jobs: their revenue minus payments received on them.
  const outstandingCents = allJobs.filter((j) => j.status === 'completed').reduce((s, j) => s + Math.max(0, j.balance_cents), 0);
  // Growth compares this month with the same days of last month (1st through today's day number), so early-month numbers are fair.
  // Gross profit this month = contract - expenses - payouts of jobs completed this month.
  const m = await db.get(`WITH d AS (SELECT (now() AT TIME ZONE ?)::date AS today),
      m AS (SELECT today, date_trunc('month', today)::date AS start, (date_trunc('month', today) - interval '1 month')::date AS prev FROM d),
      c AS (SELECT t.contract_cents, t.contract_cents - t.expenses_cents - t.payouts_cents AS profit, (j.completed_at AT TIME ZONE ?)::date AS day
        FROM job_totals t JOIN jobs j ON j.id = t.job_id WHERE j.org_id = ? AND j.status = 'completed' AND j.completed_at IS NOT NULL)
    SELECT to_char(m.start, 'FMMonth YYYY') AS label, to_char(m.prev, 'FMMonth') AS prev_label,
      (SELECT coalesce(sum(contract_cents), 0) FROM c WHERE day >= m.start AND day <= m.today) AS revenue,
      (SELECT coalesce(sum(contract_cents), 0) FROM c WHERE day >= m.prev AND day <= least(m.prev + (m.today - m.start), m.start - 1)) AS prev_revenue,
      (SELECT count(*) FROM c WHERE day >= m.start AND day <= m.today) AS completed_jobs,
      (SELECT coalesce(sum(profit), 0) FROM c WHERE day >= m.start AND day <= m.today) AS profit
    FROM m`, APP_TIMEZONE, APP_TIMEZONE, o);
  const month = { label: m.label, prevLabel: `same days of ${m.prev_label}`, revenueCents: m.revenue, prevCents: m.prev_revenue,
    completedJobs: Number(m.completed_jobs), profitCents: m.profit };
  // Revenue by month for the last 12 months; leading empty months are dropped (but at least 6 are shown).
  const series = await db.all(`WITH d AS (SELECT date_trunc('month', (now() AT TIME ZONE ?)::date)::date AS cur),
      ms AS (SELECT generate_series(cur - interval '11 months', cur, interval '1 month')::date AS start FROM d)
    SELECT to_char(ms.start, 'Mon') AS label, to_char(ms.start, 'FMMonth YYYY') AS long_label, coalesce(sum(j.contract_cents), 0) AS cents
    FROM ms LEFT JOIN jobs j ON j.org_id = ? AND j.status = 'completed'
      AND date_trunc('month', j.completed_at AT TIME ZONE ?)::date = ms.start
    GROUP BY ms.start ORDER BY ms.start`, APP_TIMEZONE, o, APP_TIMEZONE);
  const first = series.findIndex((r) => Number(r.cents) > 0);
  const revenueByMonth = series.slice(Math.min(first < 0 ? 6 : first, 6)).map((r) => ({ ...r, cents: Number(r.cents) }));
  return ok(v.homePage({ openEstimates, activeJobs, outstandingCents, month, revenueByMonth, flash: url.searchParams.get('msg') }));
}, { worker: true });

// Clients
route('GET', '/clients', async ({ db, org, url }) => {
  const q = str(url.searchParams.get('q'), 200);
  // Total value: what the client's jobs are worth (contract totals).
  const VALUE = '(SELECT coalesce(sum(contract_cents), 0) FROM jobs WHERE jobs.client_id = clients.id) AS value_cents';
  const clients = q
    ? await db.all(`SELECT *, ${VALUE} FROM clients WHERE org_id = ? AND name ILIKE ? ESCAPE '\\' ORDER BY lower(name)`,
      org.org_id, `%${q.replace(/[\\%_]/g, '\\$&')}%`)
    : await db.all(`SELECT *, ${VALUE} FROM clients WHERE org_id = ? ORDER BY lower(name)`, org.org_id);
  return ok(v.clientsPage({ clients, q, flash: url.searchParams.get('msg') }));
});
route('GET', '/clients/new', () => ok(v.clientFormPage({ values: {} })));
route('POST', '/clients', async ({ db, org, form }) => {
  const { values, errors, clean } = validateClient(formObj(form));
  if (hasErrors(errors)) return page(422, v.clientFormPage({ values, errors }));
  const r = await attempt(db, () => db.run('INSERT INTO clients (org_id, name, phone, email, address, sms_consent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    org.org_id, clean.name, clean.phone, clean.email, clean.address, clean.smsConsent));
  if (r.error) { console.error(r.error); return page(500, v.clientFormPage({ values, errors: SAVE_FAILED })); }
  return redirect(`/clients/${r.value.id}?msg=Client+saved`);
});
route('GET', '/clients/:id', async ({ db, org, id, url }) => {
  const client = await db.get('SELECT * FROM clients WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!client) return notFound();
  return ok(v.clientPage({
    client, flash: url.searchParams.get('msg'),
    estimates: await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.client_id = ? ORDER BY estimates.updated_at DESC`, id),
    jobs: (await db.all(`${JOB_LIST_SQL} WHERE jobs.client_id = ? ORDER BY jobs.id DESC`, id)).map(withJobMath),
  }));
});
route('GET', '/clients/:id/edit', async ({ db, org, id }) => {
  const client = await db.get('SELECT * FROM clients WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!client) return notFound();
  return ok(v.clientFormPage({ client, values: client }));
});
route('POST', '/clients/:id', async ({ db, org, id, form }) => {
  const client = await db.get('SELECT * FROM clients WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!client) return notFound();
  const { values, errors, clean } = validateClient(formObj(form));
  if (hasErrors(errors)) return page(422, v.clientFormPage({ client, values: { ...values, sms_opted_out_at: client.sms_opted_out_at }, errors }));
  // A STOP reply belongs to the number it came from, so a new number starts fresh.
  const r = await attempt(db, () => db.run(`UPDATE clients SET name = ?, phone = ?, email = ?, address = ?, sms_consent = ?,
      sms_opted_out_at = CASE WHEN phone = ? THEN sms_opted_out_at END, updated_at = now() WHERE id = ?`,
    clean.name, clean.phone, clean.email, clean.address, clean.smsConsent, clean.phone, id));
  if (r.error) { console.error(r.error); return page(500, v.clientFormPage({ client, values, errors: SAVE_FAILED })); }
  return redirect(`/clients/${id}?msg=Client+saved`);
});

// Estimates
route('GET', '/estimates', async ({ db, org, url }) => {
  const status = v.ESTIMATE_STATUS[url.searchParams.get('status')] ? url.searchParams.get('status') : '';
  const estimates = status
    ? await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.org_id = ? AND estimates.status = ? ORDER BY estimates.updated_at DESC`, org.org_id, status)
    : await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.org_id = ? ORDER BY estimates.updated_at DESC`, org.org_id);
  return ok(v.estimatesPage({ estimates, status }));
});
route('GET', '/estimates/new', async ({ db, org, url }) => {
  const clients = await clientsForSelect(db, org.org_id);
  const cid = url.searchParams.get('client_id');
  const dp = await db.get('SELECT default_deposit_percent FROM company_profiles WHERE org_id = ?', org.org_id);
  const values = { status: 'draft', client_id: cid && clients.some((c) => String(c.id) === cid) ? cid : (clients.length ? '' : 'new'),
    deposit_percent: String(dp?.default_deposit_percent ?? 0), visit_date: isDate(url.searchParams.get('date') || '') ? url.searchParams.get('date') : '' };
  return ok(v.estimateFormPage({ values, items: [], clients }));
});
route('POST', '/estimates', async ({ db, org, form }) => {
  const { values, items, errors, clean } = await validateEstimate(db, org.org_id, form);
  const rerender = async (status, errs) => page(status, v.estimateFormPage({ values, items, errors: errs, clients: await clientsForSelect(db, org.org_id) }));
  if (hasErrors(errors)) return rerender(422, errors);
  const r = await attempt(db, () => saveEstimate(db, org.org_id, null, values, clean));
  if (r.error) { console.error(r.error); return rerender(500, SAVE_FAILED); }
  return redirect(`/estimates/${r.value}?msg=Estimate+saved`);
});
const lockedMsg = { locked: 'This estimate has been converted to a job and is locked against editing.' };
route('GET', '/estimates/:id', ({ db, org, id, url }) => renderEstimate(db, org.org_id, id, { flash: url.searchParams.get('msg') }));
route('GET', '/estimates/:id/edit', async ({ db, org, id }) => {
  const e = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!e) return notFound();
  // After it becomes a job, prices are locked but line item names and descriptions can still be edited.
  if (await jobFor(db, id)) return redirect(`/estimates/${id}/descriptions`);
  const items = (await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', id))
    .map((i) => ({ desc: i.description, details: i.details, qty: fmtQty(i.qty_hundredths), price: plain(i.unit_price_cents), option: i.option_name }));
  const values = {
    client_id: String(e.client_id), status: e.status,
    estimated_cost: e.estimated_cost_cents == null ? '' : plain(e.estimated_cost_cents), deposit_percent: String(e.deposit_percent),
    address: e.address, visit_date: e.visit_date || '', visit_time: e.visit_time ? e.visit_time.slice(0, 5) : '',
  };
  return ok(v.estimateFormPage({ estimate: e, values, items, clients: await clientsForSelect(db, org.org_id) }));
});
// Line item names and descriptions, editable any time (also once the estimate is a job). Updates the scope of work.
async function renderDescriptions(db, org, id, extra = {}, status = 200) {
  const estimate = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!estimate) return notFound();
  const items = await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', id);
  return page(status, v.descriptionsPage({ estimate, items, job: await jobFor(db, id), ...extra }));
}
route('GET', '/estimates/:id/descriptions', ({ db, org, id }) => renderDescriptions(db, org, id));
route('POST', '/estimates/:id/descriptions', async ({ db, org, id, form }) => {
  const items = await db.all('SELECT id FROM line_items WHERE estimate_id = ? AND org_id = ? ORDER BY position', id, org.org_id);
  if (!items.length) return notFound();
  const errors = {}; const updates = [];
  for (const [n, it] of items.entries()) {
    const name = str(form.get(`name_${it.id}`), 500);
    const details = String(form.get(`details_${it.id}`) ?? '').replace(/\r\n/g, '\n').trim().slice(0, 10000);
    if (!name) errors[`item_${it.id}`] = `Line ${n + 1}: name is required.`;
    updates.push([name, details, it.id]);
  }
  if (hasErrors(errors)) return renderDescriptions(db, org, id, { errors, values: Object.fromEntries(updates.map(([a, b, i]) => [i, { name: a, details: b }])) }, 422);
  for (const [name, details, itemId] of updates) await db.run('UPDATE line_items SET description = ?, details = ? WHERE id = ?', name, details, itemId);
  await refreshScope(db, id);
  const job = await jobFor(db, id);
  return redirect(job ? `/jobs/${job.id}?msg=Scope+of+work+updated` : `/estimates/${id}?msg=Descriptions+saved`);
});
route('POST', '/estimates/:id', async ({ db, org, id, form }) => {
  const estimate = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!estimate) return notFound();
  if (await jobFor(db, id)) return renderEstimate(db, org.org_id, id, { errors: lockedMsg }, 409);
  const { values, items, errors, clean } = await validateEstimate(db, org.org_id, form);
  const rerender = async (status, errs) =>
    page(status, v.estimateFormPage({ estimate, values, items, errors: errs, clients: await clientsForSelect(db, org.org_id) }));
  if (hasErrors(errors)) return rerender(422, errors);
  const r = await attempt(db, () => saveEstimate(db, org.org_id, id, values, clean));
  if (r.error) {
    if (dbMessage(r.error)) return renderEstimate(db, org.org_id, id, { errors: lockedMsg }, 409);
    console.error(r.error); return rerender(500, SAVE_FAILED);
  }
  return redirect(`/estimates/${id}?msg=Estimate+saved`);
});
route('POST', '/estimates/:id/status', async ({ db, org, id, form }) => {
  const status = form.get('status');
  if (!(await db.get('SELECT id FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  if (await jobFor(db, id)) return renderEstimate(db, org.org_id, id, { errors: lockedMsg }, 409);
  if (!v.ESTIMATE_STATUS[status]) return renderEstimate(db, org.org_id, id, { errors: { status: 'Unknown status.' } }, 422);
  const { options } = await mailer.estimateTotals(db, id);
  const chosen = form.get('chosen_option');
  if (status === 'approved' && options.length && !options.some((o) => o.name === chosen)) {
    return renderEstimate(db, org.org_id, id, { errors: { status: 'Choose which option the client approved.' } }, 422);
  }
  await db.run('UPDATE estimates SET status = ?, chosen_option = ?, updated_at = now() WHERE id = ?',
    status, status === 'approved' && options.length ? chosen : null, id);
  await refreshScope(db, id);
  return redirect(`/estimates/${id}?msg=Status+updated`);
});
// Emailing the estimate to the client: a link to the online approval page.
route('POST', '/estimates/:id/send', async ({ db, org, id, form, req }) => {
  const estimate = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!estimate) return notFound();
  const values = { send_to: str(form.get('send_to'), 200), send_message: str(form.get('send_message'), 2000) };
  const fail = (status, msg) => renderEstimate(db, org.org_id, id, { sendForm: { values, errors: { send_to: msg } } }, status);
  if (await jobFor(db, id)) return fail(409, 'This estimate is already approved and converted to a job.');
  if (!email.configured()) return fail(409, 'Email sending is not set up for this app yet. Copy the link and send it yourself.');
  if (!email.validEmail(values.send_to)) return fail(422, "Enter the client's email address.");
  const client = await db.get('SELECT * FROM clients WHERE id = ?', estimate.client_id);
  const result = await asServer(async (sdb) => {
    const company = await mailer.companyOf(sdb, org.org_id);
    const t = mailer.templates.estimate({ company, estimate, client, totals: await mailer.estimateTotals(sdb, id),
      message: values.send_message, base: baseUrl(req) });
    return mailer.deliver(sdb, { orgId: org.org_id, kind: 'estimate', to: values.send_to, ...t, company, estimateId: id });
  });
  if (!result.ok) return fail(502, `The email could not be sent: ${result.error}`);
  await db.run(`UPDATE estimates SET status = CASE WHEN status IN ('draft', 'declined') THEN 'sent' ELSE status END,
    sent_to = ?, sent_at = now(), reminders_sent = 0, last_reminded_at = NULL, updated_at = now() WHERE id = ?`, values.send_to, id);
  if (!client.email) await db.run('UPDATE clients SET email = ? WHERE id = ?', values.send_to, client.id);
  return redirect(`/estimates/${id}?msg=${encodeURIComponent(`Estimate emailed to ${values.send_to}`)}`);
});
route('POST', '/estimates/:id/convert', async ({ db, org, id }) => {
  if (!(await db.get('SELECT id FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const existed = await jobFor(db, id);
  // The database function locks the estimate row and is idempotent, so repeated clicks return the same job.
  const r = await attempt(db, () => db.get('SELECT convert_estimate_to_job(?) AS id', id));
  if (r.error) {
    if (dbMessage(r.error)) return renderEstimate(db, org.org_id, id, { errors: { convert: dbMessage(r.error) } }, 422);
    throw r.error;
  }
  return redirect(`/jobs/${r.value.id}?msg=${existed ? 'This+estimate+was+already+converted' : 'Job+created+from+estimate'}`);
});

// Jobs
route('GET', '/jobs', async ({ db, org, url }) => {
  const status = v.JOB_STATUS[url.searchParams.get('status')] ? url.searchParams.get('status') : '';
  const jobs = (status
    ? await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? AND jobs.status = ? ORDER BY jobs.id DESC`, org.org_id, status)
    : await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? ORDER BY jobs.id DESC`, org.org_id)).map(withJobMath);
  // Calendar: a job shows on every day from its start date to its end date (or just its start date).
  const today = (await db.get('SELECT (now() AT TIME ZONE ?)::date::text AS d', APP_TIMEZONE)).d;
  const dayParam = url.searchParams.get('day'); const monthParam = url.searchParams.get('month');
  const day = dayParam && isDate(dayParam) ? dayParam
    : monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? (today.startsWith(monthParam) ? today : `${monthParam}-01`) : today;
  const month = day.slice(0, 7);
  const gridStart = (await db.get(`SELECT (?::date - extract(dow FROM ?::date)::int)::text AS d`, `${month}-01`, `${month}-01`)).d;
  const spans = await db.all(`SELECT d::date::text AS day, jobs.status FROM jobs,
      generate_series(greatest(jobs.start_date, ?::date), least(coalesce(jobs.end_date, jobs.start_date), ?::date + 41), interval '1 day') AS d
    WHERE jobs.org_id = ? AND jobs.start_date IS NOT NULL ORDER BY jobs.start_date, jobs.id`, gridStart, gridStart, org.org_id);
  const byDay = {};
  for (const sp of spans) (byDay[sp.day] ||= []).push(sp.status);
  // Estimate appointments (site visits) show as their own dot and list.
  const visits = await db.all(`SELECT visit_date::text AS day FROM estimates WHERE org_id = ? AND visit_date BETWEEN ?::date AND ?::date + 41
    ORDER BY visit_date, visit_time NULLS LAST`, org.org_id, gridStart, gridStart);
  for (const vs of visits) (byDay[vs.day] ||= []).push('visit');
  const dayVisits = await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.org_id = ? AND estimates.visit_date = ?::date
    ORDER BY estimates.visit_time NULLS LAST, estimates.id`, org.org_id, day);
  const dayJobs = (await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? AND jobs.start_date <= ?::date
    AND coalesce(jobs.end_date, jobs.start_date) >= ?::date ORDER BY jobs.start_date, jobs.id`, org.org_id, day, day)).map(withJobMath);
  const view = url.searchParams.get('view') === 'week' ? 'week' : 'month';
  let weekJobs = []; let weekVisits = [];
  if (view === 'week') {
    // The week (Sunday to Saturday) that holds the chosen day.
    const ws = (await db.get('SELECT (?::date - extract(dow FROM ?::date)::int)::text AS d', day, day)).d;
    weekJobs = await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? AND jobs.start_date <= ?::date + 6
      AND coalesce(jobs.end_date, jobs.start_date) >= ?::date ORDER BY jobs.start_date, jobs.id`, org.org_id, ws, ws);
    weekVisits = await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.org_id = ? AND estimates.visit_date BETWEEN ?::date AND ?::date + 6
      ORDER BY estimates.visit_date, estimates.visit_time NULLS LAST, estimates.id`, org.org_id, ws, ws);
  }
  return ok(v.jobsPage({ jobs, status, flash: url.searchParams.get('msg'), cal: { month, day, today, byDay, dayJobs, dayVisits, view, weekJobs, weekVisits } }));
});
route('GET', '/jobs/:id', ({ db, org, id, url }) => renderJob(db, org.org_id, id, { flash: url.searchParams.get('msg') }));
route('POST', '/jobs/:id', async ({ db, org, id, form }) => {
  const f = formObj(form);
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const values = { status: f.status, start_date: str(f.start_date, 20), end_date: str(f.end_date, 20), notes: f.notes ?? '', address: f.address };
  const errors = {};
  if (!v.JOB_STATUS[values.status]) errors.status = 'Choose a valid job status.';
  if (values.start_date && !isDate(values.start_date)) errors.start_date = 'Start date must be a valid date.';
  if (values.end_date && !isDate(values.end_date)) errors.end_date = 'End date must be a valid date.';
  if (!hasErrors(errors) && values.start_date && values.end_date && values.end_date < values.start_date) {
    errors.end_date = 'End date can\'t be before the start date.';
  }
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { job: { values, errors } } }, 422);
  const r = await attempt(db, () => db.run(`UPDATE jobs SET status = ?, start_date = ?, end_date = ?, notes = ?, address = coalesce(?, address),
      project_name = coalesce(nullif(?, ''), project_name),
    updated_at = now() WHERE id = ?`, values.status, values.start_date || null, values.end_date || null, str(values.notes, 10000),
  values.address === undefined ? null : str(values.address, 500), values.address === undefined ? null : str(values.address, 200), id));
  if (r.error) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { job: { values, errors: SAVE_FAILED } } }, 500); }
  return redirect(`/jobs/${id}?msg=Job+saved`);
});
route('POST', '/jobs/:id/expenses', async ({ db, org, id, form }) => {
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const f = formObj(form);
  const { values, errors, clean } = validateExpense(f);
  const rc = parseReceipt(f);
  if (rc.error) errors.receipt = rc.error;
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { expense: { values, errors } } }, 422);
  const r = await attempt(db, async () => {
    const ex = await db.run('INSERT INTO expenses (org_id, job_id, description, amount_cents) VALUES (?, ?, ?, ?) RETURNING id',
      org.org_id, id, clean.description, clean.amount);
    if (rc.receipt) await saveReceipt(db, org.org_id, ex.id, rc.receipt);
  });
  if (r.error) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { expense: { values, errors: SAVE_FAILED } } }, 500); }
  return redirect(`/jobs/${id}?msg=Expense+added`);
}, { maxBody: RECEIPT_BODY });
route('GET', '/expenses/:id/receipt', async ({ db, org, id }) => {
  const rc = await db.get('SELECT data, content_type, filename FROM expense_receipts WHERE expense_id = ? AND org_id = ?', id, org.org_id);
  if (!rc) return notFound();
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[rc.content_type];
  const name = (rc.filename || `receipt-${id}.${ext}`).replace(/[^\w.\- ]+/g, '_');
  return { status: 200, headers: { 'Content-Type': rc.content_type, 'Content-Disposition': `inline; filename="${name}"` }, body: rc.data };
});
// Job photos: admins and the crew assigned to a job add them (RLS decides who); photos are shrunk to JPEG in the browser.
function parsePhoto(data) {
  const mm = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(data || '');
  const buf = mm ? Buffer.from(mm[2], 'base64') : null;
  const type = !buf ? null : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
    : buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png' : null;
  if (!type) return { error: 'Photos must be JPG or PNG images.' };
  if (buf.length > RECEIPT_MAX) return { error: 'That photo is too large. Use one under 5 MB.' };
  return { photo: { data: buf, type } };
}
const jobHref = (org, jobId) => (org.role === 'admin' ? `/jobs/${jobId}` : `/schedule/${jobId}`);
route('POST', '/jobs/:id/photos', async ({ db, org, id, form }) => {
  const ph = parsePhoto(form.get('photo_data'));
  if (ph.error) return page(422, ph.error, { 'Content-Type': 'text/plain; charset=utf-8' });
  const r = await attempt(db, () => db.run('INSERT INTO job_photos (org_id, job_id, data, content_type) VALUES (?, ?, ?, ?)',
    org.org_id, id, ph.photo.data, ph.photo.type));
  if (r.error) return page(404, 'You can only add photos to your own jobs.', { 'Content-Type': 'text/plain; charset=utf-8' });
  return redirect(`${jobHref(org, id)}?msg=Photo+added#photos`);
}, { worker: true, maxBody: RECEIPT_BODY });
route('GET', '/photos/:id', async ({ db, org, id }) => {
  const ph = await db.get('SELECT data, content_type FROM job_photos WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!ph) return notFound();
  return { status: 200, headers: { 'Content-Type': ph.content_type, 'Cache-Control': 'private, max-age=604800' }, body: ph.data };
}, { worker: true });
route('POST', '/photos/:id/delete', async ({ db, org, id }) => {
  const ph = await db.get('SELECT job_id FROM job_photos WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!ph) return notFound();
  const n = (await db.run('DELETE FROM job_photos WHERE id = ?', id)).changes;
  return redirect(`${jobHref(org, ph.job_id)}?msg=${n ? 'Photo+deleted' : 'Only+the+person+who+added+a+photo+can+delete+it'}#photos`);
}, { worker: true });
const photosFor = (db, jobId) => db.all(`SELECT id, uploaded_by, created_at FROM job_photos WHERE job_id = ? ORDER BY created_at DESC, id DESC`, jobId);

// Time clock: W-2 crew clock in and out on their own jobs; admins can add, end or delete entries.
route('POST', '/schedule/:id/clock-in', async ({ db, org, id }) => {
  const r = await attempt(db, () => db.get('SELECT clock_in(?) AS id', id));
  if (r.error) {
    const msg = dbMessage(r.error); if (!msg) throw r.error;
    return redirect(`${jobHref(org, id)}?msg=${encodeURIComponent(msg)}`);
  }
  return redirect(`/schedule/${id}?msg=Clocked+in`);
}, { worker: true });
route('POST', '/schedule/:id/clock-out', async ({ db, id }) => {
  await db.run('SELECT clock_out()');
  return redirect(`/schedule/${id}?msg=Clocked+out`);
}, { worker: true });
route('POST', '/jobs/:id/time', async ({ db, org, id, form }) => {
  const f = formObj(form);
  const values = { user_id: str(f.user_id, 64), work_date: str(f.work_date, 20), start_time: str(f.start_time, 10), end_time: str(f.end_time, 10) };
  const errors = {};
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!UUID_RE.test(values.user_id)) errors.time_user = 'Choose who worked.';
  if (!isDate(values.work_date)) errors.work_date = 'Enter the date worked.';
  if (!time.test(values.start_time)) errors.start_time = 'Enter a start time.';
  if (!time.test(values.end_time)) errors.end_time = 'Enter an end time.';
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { time: { values, errors } } }, 422);
  const pay = await db.get('SELECT hourly_rate_cents FROM member_pay WHERE org_id = ? AND user_id = ?::uuid', org.org_id, values.user_id);
  if (!pay || pay.hourly_rate_cents == null) {
    return renderJob(db, org.org_id, id, { forms: { time: { values, errors: { time_user: 'Set an hourly rate for this person on their Team page first.' } } } }, 422);
  }
  // An end time earlier than the start means the shift ran past midnight.
  const r = await attempt(db, () => db.run(`INSERT INTO time_entries (org_id, job_id, user_id, clock_in, clock_out, rate_cents)
    SELECT ?, ?, ?::uuid, s, CASE WHEN e > s THEN e ELSE e + interval '1 day' END, ?
    FROM (SELECT (?::date + ?::time) AT TIME ZONE ? AS s, (?::date + ?::time) AT TIME ZONE ? AS e) t`,
  org.org_id, id, values.user_id, pay.hourly_rate_cents, values.work_date, values.start_time, APP_TIMEZONE, values.work_date, values.end_time, APP_TIMEZONE));
  if (r.error) {
    const msg = dbMessage(r.error); if (!msg) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { time: { values, errors: SAVE_FAILED } } }, 500); }
    return renderJob(db, org.org_id, id, { forms: { time: { values, errors: { time_user: msg } } } }, 422);
  }
  return redirect(`/jobs/${id}?msg=Time+added#time`);
});
async function timeEntry(db, org, id) { return db.get('SELECT * FROM time_entries WHERE id = ? AND org_id = ?', id, org.org_id); }
route('POST', '/time/:id/end', async ({ db, org, id }) => {
  const t = await timeEntry(db, org, id); if (!t) return notFound();
  await db.run(`UPDATE time_entries SET clock_out = least(greatest(now(), clock_in + interval '1 second'), clock_in + interval '24 hours')
    WHERE id = ? AND clock_out IS NULL`, id);
  return redirect(`/jobs/${t.job_id}?msg=Clocked+out#time`);
});
route('POST', '/time/:id/delete', async ({ db, org, id }) => {
  const t = await timeEntry(db, org, id); if (!t) return notFound();
  await db.run('DELETE FROM time_entries WHERE id = ?', id);
  return redirect(`/jobs/${t.job_id}?msg=Time+entry+deleted#time`);
});
const timeFor = (db, jobId) => db.all(`SELECT t.id, t.user_id, t.rate_cents, t.clock_out IS NULL AS open,
    to_char(t.clock_in AT TIME ZONE ?, 'YYYY-MM-DD') AS day, to_char(t.clock_in AT TIME ZONE ?, 'HH24:MI') AS start_t,
    to_char(t.clock_out AT TIME ZONE ?, 'HH24:MI') AS end_t,
    (extract(epoch from (coalesce(t.clock_out, now()) - t.clock_in)) / 60)::int AS minutes,
    labor_cents(t.clock_in, t.clock_out, t.rate_cents) AS cost_cents
  FROM time_entries t WHERE t.job_id = ? ORDER BY t.clock_in DESC`, APP_TIMEZONE, APP_TIMEZONE, APP_TIMEZONE, jobId);

route('POST', '/jobs/:id/payments', async ({ db, org, id, form }) => {
  const f = formObj(form);
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const values = { payment_amount: f.payment_amount ?? '', paid_on: f.paid_on ?? '' };
  const { errors: found, clean } = validatePayment(values.payment_amount, values.paid_on);
  const errors = {};
  if (found.amount) errors.payment_amount = found.amount;
  if (found.paid_on) errors.paid_on = found.paid_on;
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { payment: { values, errors } } }, 422);
  const r = await attempt(db, () => db.run('INSERT INTO payments (org_id, job_id, amount_cents, paid_on) VALUES (?, ?, ?, ?)',
    org.org_id, id, clean.amount, clean.paidOn));
  if (r.error) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { payment: { values, errors: SAVE_FAILED } } }, 500); }
  return redirect(`/jobs/${id}?msg=Payment+recorded`);
});

// Worker assignments and payouts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Invoices through Stripe: Stripe emails the client a pay link; the webhook below records the payment when paid.
route('POST', '/jobs/:id/invoices', async ({ db, org, id, form }) => {
  const job = await loadJob(db, org.org_id, id);
  if (!job) return notFound();
  const account = await payoutAccount(db, org.org_id);
  if (!account) return renderJob(db, org.org_id, id, { forms: { invoice: { values: {}, errors: { invoice_amount: 'Online invoicing is not set up for this company.' } } } }, 409);
  const f = formObj(form);
  const values = { invoice_amount: f.invoice_amount ?? '', invoice_email: str(f.invoice_email, 200), days: f.days ?? '14',
    invoice_desc: f.invoice_desc ?? '', key: str(f.key, 64) };
  const errors = {};
  const amt = parseMoney(values.invoice_amount, 'Invoice amount', { allowZero: false });
  if (amt.error) errors.invoice_amount = amt.error;
  else if (amt.value > job.balance_cents) errors.invoice_amount = `Invoice amount can't be more than the outstanding balance (${fmt(job.balance_cents)}).`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.invoice_email)) errors.invoice_email = 'Enter the email address to send the invoice to.';
  const days = ['0', '7', '14', '30'].includes(values.days) ? Number(values.days) : null;
  if (days == null) errors.days = 'Choose when payment is due.';
  if (!/^[0-9a-f-]{36}$/.test(values.key)) values.key = crypto.randomUUID();
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { invoice: { values, errors } } }, 422);
  const description = str(values.invoice_desc, 500) || job.project_name;
  const client = await db.get('SELECT * FROM clients WHERE id = ?', job.client_id);
  let inv;
  try {
    const customerId = await stripe.ensureCustomer(account, client, values.invoice_email, org.org_id);
    if (customerId !== client.stripe_customer_id) {
      await db.run('UPDATE clients SET stripe_customer_id = ?, stripe_customer_account = ? WHERE id = ?', customerId, account, client.id);
    }
    inv = await stripe.sendInvoice({ account, customerId, amountCents: amt.value, description, daysUntilDue: days,
      jobId: id, orgId: org.org_id, key: values.key });
  } catch (e) {
    console.error('Stripe invoice failed:', e.message);
    const msg = e instanceof stripe.StripeError ? `Stripe didn't accept the invoice: ${e.message}` : 'Could not reach Stripe. Nothing was sent; please try again.';
    return renderJob(db, org.org_id, id, { forms: { invoice: { values, errors: { invoice_amount: msg } } } }, 502);
  }
  await db.run(`INSERT INTO invoices (org_id, job_id, stripe_invoice_id, number, amount_cents, description, sent_to, due_date, hosted_url, pdf_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, (now() AT TIME ZONE ?)::date + ?::int, ?, ?) ON CONFLICT (stripe_invoice_id) DO NOTHING`,
  org.org_id, id, inv.id, inv.number || '', amt.value, description, values.invoice_email, APP_TIMEZONE, days, inv.hosted_invoice_url || '', inv.invoice_pdf || '');
  return redirect(`/jobs/${id}?msg=Invoice+sent+to+${encodeURIComponent(values.invoice_email)}`);
});
async function invoiceAction(db, org, id, fn, msg) {
  const inv = await db.get('SELECT * FROM invoices WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!inv) return notFound();
  const account = await payoutAccount(db, org.org_id);
  if (inv.status !== 'open' || !account) return redirect(`/jobs/${inv.job_id}`);
  try { await fn(inv, account); } catch (e) {
    console.error('Stripe action failed:', e.message);
    return renderJob(db, org.org_id, inv.job_id, { forms: { invoice: { values: {}, errors: { invoice_amount: `Stripe error: ${e.message}` } } } }, 502);
  }
  return redirect(`/jobs/${inv.job_id}?msg=${msg}`);
}
route('POST', '/invoices/:id/resend', ({ db, org, id }) => invoiceAction(db, org, id, (inv, account) => stripe.resendInvoice(account, inv.stripe_invoice_id), 'Invoice+sent+again'));
route('POST', '/invoices/:id/void', ({ db, org, id }) => invoiceAction(db, org, id, async (inv, account) => {
  await stripe.voidInvoice(account, inv.stripe_invoice_id);
  await db.run("UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
}, 'Invoice+voided'));

route('POST', '/jobs/:id/assignments', async ({ db, org, id, form }) => {
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const values = { user_id: str(form.get('user_id'), 64), payout: form.get('payout') ?? '' };
  const errors = {};
  const subId = /^sub:(\d{1,15})$/.exec(values.user_id)?.[1];
  if (!UUID_RE.test(values.user_id) && !subId) errors.user_id = 'Choose who to assign.';
  const amt = String(values.payout).trim() === '' ? { value: 0 } : parseMoney(values.payout, 'Payout');
  if (amt.error) errors.payout = amt.error;
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { assign: { values, errors } } }, 422);
  if (subId) {
    if (!(await db.get('SELECT id FROM subcontractors WHERE id = ? AND org_id = ?', Number(subId), org.org_id))) {
      return renderJob(db, org.org_id, id, { forms: { assign: { values, errors: { user_id: 'Choose who to assign.' } } } }, 422);
    }
    await db.run(`INSERT INTO sub_assignments (org_id, job_id, sub_id, payout_cents) VALUES (?, ?, ?, ?)
      ON CONFLICT (job_id, sub_id) DO UPDATE SET payout_cents = excluded.payout_cents, updated_at = now()`, org.org_id, id, Number(subId), amt.value);
    return redirect(`/jobs/${id}?msg=Payout+saved`);
  }
  const r = await attempt(db, () => db.run(`INSERT INTO job_assignments (org_id, job_id, user_id, payout_cents) VALUES (?, ?, ?, ?)
    ON CONFLICT (job_id, user_id) DO UPDATE SET payout_cents = excluded.payout_cents, updated_at = now()`,
  org.org_id, id, values.user_id, amt.value));
  if (r.error) {
    const msg = dbMessage(r.error);
    if (!msg) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { assign: { values, errors: SAVE_FAILED } } }, 500); }
    return renderJob(db, org.org_id, id, { forms: { assign: { values, errors: { user_id: msg } } } }, 422);
  }
  return redirect(`/jobs/${id}?msg=Payout+saved`);
});
async function loadAssignment(db, org, id, userId) {
  if (!UUID_RE.test(userId || '')) return null;
  const job = await db.get('SELECT * FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id);
  const crew = job && (await db.get('SELECT * FROM job_team(?) WHERE user_id = ?', id, userId));
  return crew ? { job, crew } : null;
}
route('GET', '/jobs/:id/assignments/remove', async ({ db, org, id, url }) => {
  const userId = url.searchParams.get('user_id');
  const found = await loadAssignment(db, org, id, userId);
  if (!found) return notFound();
  return ok(v.confirmPage({ title: 'Remove this assignment?', button: 'Yes, remove',
    action: `/jobs/${id}/assignments/remove?user_id=${encodeURIComponent(userId)}`, cancelHref: `/jobs/${id}`,
    message: `${found.crew.email} will be taken off "${found.job.project_name}" and their payout record deleted.` }));
});
route('POST', '/jobs/:id/assignments/remove', async ({ db, org, id, url }) => {
  const userId = url.searchParams.get('user_id');
  if (!(await loadAssignment(db, org, id, userId))) return notFound();
  await db.run('DELETE FROM job_assignments WHERE job_id = ? AND user_id = ?', id, userId);
  return redirect(`/jobs/${id}?msg=Assignment+removed`);
});

// Taking a subcontractor (without an account) off a job
async function loadSubAssignment(db, org, id, subId) {
  if (!/^\d{1,15}$/.test(subId || '')) return null;
  return db.get(`SELECT a.*, s.name, j.project_name FROM sub_assignments a JOIN subcontractors s ON s.id = a.sub_id JOIN jobs j ON j.id = a.job_id
    WHERE a.job_id = ? AND a.sub_id = ? AND a.org_id = ?`, id, Number(subId), org.org_id);
}
route('GET', '/jobs/:id/subs/remove', async ({ db, org, id, url }) => {
  const subId = url.searchParams.get('sub_id');
  const a = await loadSubAssignment(db, org, id, subId);
  if (!a) return notFound();
  return ok(v.confirmPage({ title: 'Remove this assignment?', button: 'Yes, remove',
    action: `/jobs/${id}/subs/remove?sub_id=${a.sub_id}`, cancelHref: `/jobs/${id}`,
    message: `${a.name} will be taken off "${a.project_name}" and their payout record deleted.` }));
});
route('POST', '/jobs/:id/subs/remove', async ({ db, org, id, url }) => {
  const a = await loadSubAssignment(db, org, id, url.searchParams.get('sub_id'));
  if (!a) return notFound();
  await db.run('DELETE FROM sub_assignments WHERE job_id = ? AND sub_id = ?', id, a.sub_id);
  return redirect(`/jobs/${id}?msg=Assignment+removed`);
});

// Expense / payment correction and deletion
for (const kind of ['expenses', 'payments']) {
  const load = async (db, org, id) => {
    const entry = await db.get(`SELECT *${kind === 'expenses' ? ', EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id = expenses.id) AS has_receipt' : ''}
      FROM ${kind} WHERE id = ? AND org_id = ?`, id, org.org_id);
    return entry && { entry, job: await db.get('SELECT * FROM jobs WHERE id = ?', entry.job_id) };
  };
  route('GET', `/${kind}/:id/edit`, async ({ db, org, id }) => {
    const found = await load(db, org, id); if (!found) return notFound();
    const e = found.entry;
    return ok(v.entryFormPage({ kind, ...found, values: { description: e.description, amount: plain(e.amount_cents), paid_on: e.paid_on } }));
  });
  route('POST', `/${kind}/:id`, async ({ db, org, id, form }) => {
    const f = formObj(form);
    const found = await load(db, org, id); if (!found) return notFound();
    let values; let errors; let clean;
    let rc = {};
    if (kind === 'expenses') {
      ({ values, errors, clean } = validateExpense(f));
      rc = parseReceipt(f);
      if (rc.error) errors.receipt = rc.error;
    } else { values = { amount: f.amount ?? '', paid_on: f.paid_on ?? '' }; ({ errors, clean } = validatePayment(values.amount, values.paid_on)); }
    if (hasErrors(errors)) return page(422, v.entryFormPage({ kind, ...found, values, errors }));
    const r = await attempt(db, async () => {
      if (kind !== 'expenses') return db.run('UPDATE payments SET amount_cents = ?, paid_on = ? WHERE id = ?', clean.amount, clean.paidOn, id);
      await db.run('UPDATE expenses SET description = ?, amount_cents = ? WHERE id = ?', clean.description, clean.amount, id);
      if (rc.receipt) await saveReceipt(db, org.org_id, id, rc.receipt);
      else if (f.remove_receipt) await db.run('DELETE FROM expense_receipts WHERE expense_id = ?', id);
    });
    if (r.error) { console.error(r.error); return page(500, v.entryFormPage({ kind, ...found, values, errors: SAVE_FAILED })); }
    return redirect(`/jobs/${found.job.id}?msg=Entry+updated`);
  }, { maxBody: RECEIPT_BODY });
  route('GET', `/${kind}/:id/delete`, async ({ db, org, id }) => {
    const found = await load(db, org, id); if (!found) return notFound();
    return ok(v.confirmDeletePage({ kind, ...found }));
  });
  route('POST', `/${kind}/:id/delete`, async ({ db, org, id }) => {
    const found = await load(db, org, id); if (!found) return notFound();
    await db.run(`DELETE FROM ${kind} WHERE id = ?`, id);
    return redirect(`/jobs/${found.job.id}?msg=Entry+deleted`);
  });
}

// Crew: an overview and the jobs they're assigned to (open and completed), from crew_jobs().
const crewJobs = (db, org) => db.all(`SELECT *, start_date::text AS start_date, end_date::text AS end_date,
    to_char(completed_at AT TIME ZONE ?, 'YYYY') AS completed_year FROM crew_jobs(?)`, APP_TIMEZONE, org.org_id);
const todayIn = async (db) => (await db.get('SELECT (now() AT TIME ZONE ?)::date::text AS d', APP_TIMEZONE)).d;
async function crewHome({ db, org, url }) {
  const today = await todayIn(db);
  return ok(v.crewHomePage({ jobs: await crewJobs(db, org), today, year: today.slice(0, 4), flash: url.searchParams.get('msg') }));
}
// Admins can open /schedule too: every open job (worker_schedule()).
route('GET', '/schedule', async ({ db, org, url }) => {
  if (org.role === 'admin') {
    return ok(v.schedulePage({ jobs: await db.all('SELECT * FROM worker_schedule(?)', org.org_id), flash: url.searchParams.get('msg') }));
  }
  const jobs = await crewJobs(db, org);
  const today = await todayIn(db);
  const dayParam = url.searchParams.get('day'); const monthParam = url.searchParams.get('month');
  const day = dayParam && isDate(dayParam) ? dayParam
    : monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? (today.startsWith(monthParam) ? today : `${monthParam}-01`) : today;
  const byDay = {};
  for (const j of jobs.filter((x) => x.start_date)) {
    const [a, b] = [j.start_date, j.end_date || j.start_date];
    for (let d = new Date(`${a}T00:00:00Z`), n = 0; d.toISOString().slice(0, 10) <= b && n < 400; d.setUTCDate(d.getUTCDate() + 1), n++) {
      (byDay[d.toISOString().slice(0, 10)] ||= []).push(j.status);
    }
  }
  const view = url.searchParams.get('view') === 'week' ? 'week' : 'month';
  return ok(v.crewJobsPage({ jobs, cal: { month: day.slice(0, 7), day, today, byDay, view }, flash: url.searchParams.get('msg') }));
}, { worker: true });
route('GET', '/schedule/:id', async (ctx) => {
  const { db, org, id, url } = ctx;
  const job = org.role === 'admin' ? await db.get('SELECT * FROM worker_schedule(?) WHERE job_id = ?', org.org_id, id)
    : (await crewJobs(db, org)).find((j) => Number(j.job_id) === id);
  if (!job) return notFound();
  return ok(v.scheduleJobPage({ job, me: ctx.user.id, photos: await photosFor(db, id), flash: url.searchParams.get('msg') }));
}, { worker: true });

// Deleting estimates and clients (with a confirmation page first)
route('GET', '/estimates/:id/delete', async ({ db, org, id }) => {
  const e = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!e) return notFound();
  if (await jobFor(db, id)) return renderEstimate(db, org.org_id, id, { errors: { del: 'This estimate has been converted to a job, so it cannot be deleted.' } }, 409);
  return ok(v.confirmPage({ title: 'Delete this estimate?', action: `/estimates/${id}/delete`, cancelHref: `/estimates/${id}`,
    message: `"${e.project_name}" and all of its line items will be permanently deleted.` }));
});
route('POST', '/estimates/:id/delete', async ({ db, org, id }) => {
  const e = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!e) return notFound();
  const r = await attempt(db, () => db.run('DELETE FROM estimates WHERE id = ?', id));
  if (r.error) {
    if (!dbMessage(r.error)) throw r.error;
    return renderEstimate(db, org.org_id, id, { errors: { del: 'This estimate has been converted to a job, so it cannot be deleted.' } }, 409);
  }
  return redirect(`/clients/${e.client_id}?msg=Estimate+deleted`);
});
async function clientDeleteCheck(db, org, id) {
  const client = await db.get('SELECT * FROM clients WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!client) return {};
  const jobs = (await db.get('SELECT count(*) AS n FROM jobs WHERE client_id = ?', id)).n;
  const estimates = (await db.get('SELECT count(*) AS n FROM estimates WHERE client_id = ?', id)).n;
  return { client, jobs, estimates };
}
route('GET', '/clients/:id/delete', async ({ db, org, id }) => {
  const { client, jobs, estimates } = await clientDeleteCheck(db, org, id);
  if (!client) return notFound();
  if (jobs) {
    return page(409, v.messagePage('Cannot delete this client',
      `${client.name} has ${jobs} job${jobs > 1 ? 's' : ''}. Clients with jobs are kept so job, expense and payment records stay complete.`));
  }
  return ok(v.confirmPage({ title: 'Delete this client?', action: `/clients/${id}/delete`, cancelHref: `/clients/${id}`,
    message: `${client.name} will be permanently deleted${estimates ? `, along with ${estimates} estimate${estimates > 1 ? 's' : ''}` : ''}.` }));
});
route('POST', '/clients/:id/delete', async ({ db, org, id }) => {
  const { client, jobs } = await clientDeleteCheck(db, org, id);
  if (!client) return notFound();
  if (jobs) return redirect(`/clients/${id}/delete`);
  await db.run('DELETE FROM clients WHERE id = ?', id);
  return redirect('/clients?msg=Client+deleted');
});

// Team
async function renderTeam(db, org, user, extra = {}, status = 200) {
  // Crew see who's on the team (names, roles, email), nothing about pay or the join code.
  if (org.role !== 'admin') return page(status, v.teamPage({ org, members: await db.all('SELECT * FROM org_members(?)', org.org_id), me: user.id, ...extra }));
  const members = await db.all(`SELECT m.*,
      (SELECT count(*)::int FROM job_assignments a WHERE a.org_id = ? AND a.user_id = m.user_id) AS job_count,
      (SELECT coalesce(sum(a.payout_cents), 0) FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.org_id = ? AND a.user_id = m.user_id AND j.status = 'completed')
      + (SELECT coalesce(sum(labor_cents(t.clock_in, t.clock_out, t.rate_cents)), 0) FROM time_entries t JOIN jobs j ON j.id = t.job_id
        WHERE t.org_id = ? AND t.user_id = m.user_id AND j.status = 'completed') AS earned_cents,
      coalesce(p.pay_type, 'sub') AS pay_type, p.hourly_rate_cents
    FROM org_members(?) m LEFT JOIN member_pay p ON p.org_id = ? AND p.user_id = m.user_id`, org.org_id, org.org_id, org.org_id, org.org_id, org.org_id);
  const joinCode = org.role === 'admin' ? (await db.get('SELECT org_join_code(?) AS code', org.org_id)).code : null;
  const plan = (await db.get('SELECT effective_plan(?) AS p', org.org_id)).p;
  const subs = await db.all(`SELECT s.*, (SELECT count(*)::int FROM sub_assignments a WHERE a.sub_id = s.id) AS job_count,
      (SELECT coalesce(sum(a.payout_cents), 0) FROM sub_assignments a JOIN jobs j ON j.id = a.job_id WHERE a.sub_id = s.id AND j.status = 'completed') AS earned_cents
    FROM subcontractors s WHERE s.org_id = ? ORDER BY lower(s.name)`, org.org_id);
  return page(status, v.teamPage({ org, members, me: user.id, joinCode, plan, subs, ...extra }));
}
route('GET', '/team', ({ db, org, user, url }) => renderTeam(db, org, user, { flash: url.searchParams.get('msg') }), { worker: true });
route('POST', '/team/add', async ({ db, org, user, form }) => {
  const email = str(form.get('email'), 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return renderTeam(db, org, user, { values: { email, role: form.get('role') }, errors: { email: 'Enter a valid email address.' } }, 422);
  const role = form.get('role') === 'admin' ? 'admin' : 'worker';
  const r = await attempt(db, () => db.get('SELECT add_member_by_email(?, ?, ?) AS id', org.org_id, email, role));
  if (r.error) {
    if (!dbMessage(r.error)) throw r.error;
    return renderTeam(db, org, user, { values: { email, role }, errors: { email: dbMessage(r.error) } }, 422);
  }
  return redirect('/team?msg=Teammate+added');
});
// Subcontractors without accounts
function validateSub(f) {
  const values = { name: str(f.get('name'), 200), company: str(f.get('company'), 200), email: str(f.get('email'), 200), phone: str(f.get('phone'), 50) };
  const errors = {};
  if (!values.name) errors.name = 'Name is required.';
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Email address does not look valid.';
  if (values.phone && !/^[0-9+().\-\s x]{7,}$/i.test(values.phone)) errors.phone = 'Phone number does not look valid.';
  return { values, errors };
}
route('POST', '/team/subs', async ({ db, org, user, form }) => {
  const { values, errors } = validateSub(form);
  if (hasErrors(errors)) return renderTeam(db, org, user, { subForm: { values, errors } }, 422);
  const r = await db.run('INSERT INTO subcontractors (org_id, name, company, email, phone) VALUES (?, ?, ?, ?, ?) RETURNING id',
    org.org_id, values.name, values.company, values.email, values.phone);
  return redirect(`/team/subs/${r.id}?msg=Subcontractor+added`);
});
async function renderSub(db, org, id, extra = {}, status = 200) {
  const sub = await db.get('SELECT * FROM subcontractors WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!sub) return notFound();
  const jobs = await db.all(`SELECT jobs.id, jobs.project_name, jobs.status, jobs.start_date, jobs.end_date, clients.name AS client_name, a.payout_cents
    FROM sub_assignments a JOIN jobs ON jobs.id = a.job_id JOIN clients ON clients.id = jobs.client_id WHERE a.sub_id = ?
    ORDER BY jobs.status = 'completed', coalesce(jobs.end_date, jobs.start_date) DESC NULLS LAST, jobs.id DESC`, id);
  const sum = (list) => list.reduce((t, j) => t + j.payout_cents, 0);
  const totals = { earned: sum(jobs.filter((j) => j.status === 'completed')), upcoming: sum(jobs.filter((j) => j.status !== 'completed')) };
  const members = await db.all('SELECT * FROM org_members(?)', org.org_id);
  return page(status, v.subPage({ sub, jobs, totals, members, ...extra }));
}
route('GET', '/team/subs/:id', ({ db, org, id, url }) => renderSub(db, org, id, { flash: url.searchParams.get('msg') }));
route('POST', '/team/subs/:id', async ({ db, org, id, form }) => {
  if (!(await db.get('SELECT id FROM subcontractors WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const { values, errors } = validateSub(form);
  if (hasErrors(errors)) return renderSub(db, org, id, { form: { values, errors } }, 422);
  await db.run('UPDATE subcontractors SET name = ?, company = ?, email = ?, phone = ?, updated_at = now() WHERE id = ?',
    values.name, values.company, values.email, values.phone, id);
  return redirect(`/team/subs/${id}?msg=Saved`);
});
route('POST', '/team/subs/:id/link', async ({ db, org, id, form }) => {
  const userId = str(form.get('user_id'), 64);
  if (!UUID_RE.test(userId)) return renderSub(db, org, id, { errors: { link: 'Choose their account.' } }, 422);
  const r = await attempt(db, () => db.run('SELECT link_subcontractor(?, ?::uuid)', id, userId));
  if (r.error) {
    if (!dbMessage(r.error)) throw r.error;
    return renderSub(db, org, id, { errors: { link: dbMessage(r.error) } }, 422);
  }
  return redirect(`/team/${userId}?msg=Linked.+Their+jobs+and+pay+are+on+their+account+now.`);
});
route('POST', '/team/subs/:id/delete', async ({ db, org, id }) => {
  const sub = await db.get('SELECT * FROM subcontractors WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!sub) return notFound();
  if (await db.get('SELECT 1 FROM sub_assignments WHERE sub_id = ?', id)) return renderSub(db, org, id, { errors: { del: 'Remove them from their jobs first.' } }, 409);
  await db.run('DELETE FROM subcontractors WHERE id = ?', id);
  return redirect('/team?msg=Subcontractor+deleted#subs');
});
route('POST', '/team/role', async ({ db, org, user, form }) => {
  const r = await attempt(db, () => db.run('SELECT set_member_role(?, ?::uuid, ?)', org.org_id, str(form.get('user_id'), 64), str(form.get('role'), 20)));
  if (r.error) {
    if (!dbMessage(r.error)) throw r.error;
    return renderTeam(db, org, user, { errors: { role: dbMessage(r.error) } }, 422);
  }
  return redirect(`/team/${str(form.get('user_id'), 64)}?msg=Role+updated`);
});
route('GET', '/team/:uid', async ({ db, org, user, uid, url }) => {
  const member = await db.get('SELECT * FROM org_members(?) WHERE user_id = ?::uuid', org.org_id, uid);
  if (!member) return notFound();
  const jobs = await db.all(`SELECT jobs.id, jobs.project_name, jobs.status, jobs.start_date, jobs.end_date, jobs.completed_at,
      clients.name AS client_name, a.payout_cents + (SELECT coalesce(sum(labor_cents(t.clock_in, t.clock_out, t.rate_cents)), 0)
        FROM time_entries t WHERE t.job_id = jobs.id AND t.user_id = a.user_id) AS payout_cents
    FROM job_assignments a JOIN jobs ON jobs.id = a.job_id JOIN clients ON clients.id = jobs.client_id
    WHERE a.org_id = ? AND a.user_id = ?::uuid
    ORDER BY jobs.status = 'completed', coalesce(jobs.end_date, jobs.start_date) DESC NULLS LAST, jobs.id DESC`, org.org_id, uid);
  const year = (await db.get("SELECT to_char(now() AT TIME ZONE ?, 'YYYY') AS y", APP_TIMEZONE)).y;
  const sum = (list) => list.reduce((t, j) => t + j.payout_cents, 0);
  const done = jobs.filter((j) => j.status === 'completed');
  const totals = {
    earned: sum(done), upcoming: sum(jobs.filter((j) => j.status !== 'completed')), yearLabel: year,
    year: sum(done.filter((j) => j.completed_at && new Date(j.completed_at).toLocaleString('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric' }) === year)),
  };
  const pay = (await db.get('SELECT pay_type, hourly_rate_cents FROM member_pay WHERE org_id = ? AND user_id = ?::uuid', org.org_id, uid))
    || { pay_type: 'sub', hourly_rate_cents: null };
  return ok(v.memberPage({ org, member, me: user.id, jobs, totals, pay, flash: url.searchParams.get('msg') }));
});
// Subcontractor (fixed payout per job) or W-2 employee (clocks in; hours x hourly rate).
route('POST', '/team/:uid/pay', async ({ db, org, uid, form }) => {
  const member = await db.get('SELECT user_id FROM org_members(?) WHERE user_id = ?::uuid', org.org_id, uid);
  if (!member) return notFound();
  const type = form.get('pay_type') === 'w2' ? 'w2' : 'sub';
  const raw = String(form.get('hourly_rate') ?? '').trim();
  let rate = null;
  if (type === 'w2') {
    const amt = parseMoney(raw, 'Hourly rate', { allowZero: false });
    if (amt.error) return redirect(`/team/${uid}?msg=${encodeURIComponent(amt.error)}#pay`);
    rate = amt.value;
  }
  await db.run(`INSERT INTO member_pay (org_id, user_id, pay_type, hourly_rate_cents) VALUES (?, ?::uuid, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET pay_type = excluded.pay_type,
      hourly_rate_cents = coalesce(excluded.hourly_rate_cents, member_pay.hourly_rate_cents), updated_at = now()`, org.org_id, uid, type, rate);
  return redirect(`/team/${uid}?msg=Pay+saved#pay`);
});
route('POST', '/team/code', async ({ db, org }) => {
  await db.get('SELECT regenerate_join_code(?) AS code', org.org_id);
  return redirect('/team?msg=New+join+code+made');
});
route('POST', '/team/remove', async ({ db, org, user, form }) => {
  const r = await attempt(db, () => db.run('SELECT remove_member(?, ?::uuid)', org.org_id, str(form.get('user_id'), 64)));
  if (r.error) {
    if (!dbMessage(r.error)) throw r.error;
    return renderTeam(db, org, user, { errors: { remove: dbMessage(r.error) } }, 422);
  }
  return redirect('/team?msg=Teammate+removed');
});

// Company profile (logo and details printed on estimates and work orders)
const PROFILE_FIELDS = { phone: 50, email: 200, address: 500, website: 200, license_number: 100, estimate_terms: 5000, work_order_terms: 5000 };
async function companyFor(db, org) {
  const p = (await db.get('SELECT * FROM company_profiles WHERE org_id = ?', org.org_id)) || {};
  const out = { name: org.name, logo: p.logo || null };
  for (const k of Object.keys(PROFILE_FIELDS)) out[k] = p[k] || '';
  return out;
}
// Import clients and jobs from another app's CSV export (see importer.js).
const IMPORT_BODY = 7_000_000; // a 3 MB CSV, form-encoded
async function importExisting(db, org, kind) {
  if (kind === 'clients') {
    const rows = await db.all('SELECT lower(name) AS n, lower(email) AS e FROM clients WHERE org_id = ?', org);
    return { names: rows.map((r) => r.n), emails: rows.map((r) => r.e).filter(Boolean), jobs: [] };
  }
  const rows = await db.all(`SELECT lower(c.name) || '|' || lower(j.address) || '|' || j.contract_cents AS k
    FROM jobs j JOIN clients c ON c.id = j.client_id WHERE j.org_id = ?`, org);
  return { names: [], emails: [], jobs: rows.map((r) => r.k) };
}
async function importState(db, org, form) {
  const kind = form.get('kind') === 'jobs' ? 'jobs' : 'clients';
  const csv = String(form.get('csv') ?? '');
  const fileName = str(form.get('file_name'), 200);
  if (!csv.trim()) return { kind, fileName, error: 'Choose a CSV file, or paste the CSV text.' };
  if (csv.length > importer.MAX_CSV) return { kind, fileName, error: 'That file is over 3 MB. Split it into smaller files and import each one.' };
  const { headers, rows } = importer.parseCsv(csv);
  if (headers.length < 1 || !rows.length) return { kind, fileName, csv, error: 'We couldn\'t find any rows in that file. Make sure it\'s a CSV with column names in the first row.' };
  if (rows.length > importer.MAX_ROWS) return { kind, fileName, error: `That file has ${rows.length} rows. Import at most ${importer.MAX_ROWS} at a time.` };
  const map = form.has('map_name') || [...form.keys()].some((k) => k.startsWith('map_')) ? importer.mappingFrom(kind, form, headers) : importer.guessMapping(kind, headers);
  const result = importer.check(kind, rows, map, await importExisting(db, org, kind));
  result.total = rows.length;
  return { kind, fileName, csv, headers, map, result, fields: importer.FIELDS[kind] };
}
route('GET', '/import', () => ok(v.importPage({})));
route('POST', '/import/preview', async ({ db, org, form }) => {
  const st = await importState(db, org.org_id, form);
  if (!st.result) return page(422, v.importPage(st));
  return ok(v.importPage({ ...st, step: 2, preview: st.result.ok.slice(0, 8) }));
}, { maxBody: IMPORT_BODY });
route('POST', '/import/run', async ({ db, org, form }) => {
  const st = await importState(db, org.org_id, form);
  if (!st.result) return page(422, v.importPage(st));
  const o = org.org_id; const rows = st.result.ok;
  if (st.kind === 'clients') {
    for (const r of rows) {
      await db.run('INSERT INTO clients (org_id, name, phone, email, address) VALUES (?, ?, ?, ?, ?)', o, r.client.name, r.client.phone, r.client.email, r.client.address);
    }
  } else {
    const clientIds = new Map((await db.all('SELECT id, lower(name) AS n FROM clients WHERE org_id = ? ORDER BY id DESC', o)).map((c) => [c.n, c.id]));
    for (const r of rows) {
      let clientId = clientIds.get(r.client.name.toLowerCase());
      if (!clientId) {
        clientId = (await db.run('INSERT INTO clients (org_id, name, phone, email, address) VALUES (?, ?, ?, ?, ?) RETURNING id',
          o, r.client.name, r.client.phone, r.client.email, r.client.address)).id;
        clientIds.set(r.client.name.toLowerCase(), clientId);
      }
      // Each job gets an approved one-line estimate (the work at the contract amount), as if it had been sold in Keystone.
      const j = r.job;
      const est = (await db.run(`INSERT INTO estimates (org_id, client_id, project_name, address, status, scope)
        VALUES (?, ?, ?, ?, 'sent', ?) RETURNING id`, o, clientId, str(j.address, 200) || r.client.name, j.address, `• ${j.title}`)).id;
      await db.run('INSERT INTO line_items (org_id, estimate_id, position, description, qty_hundredths, unit_price_cents) VALUES (?, ?, 0, ?, 100, ?)',
        o, est, j.title, j.amount);
      await db.run("UPDATE estimates SET status = 'approved' WHERE id = ?", est);
      const jobId = (await db.get('SELECT convert_estimate_to_job(?) AS id', est)).id;
      await db.run('UPDATE jobs SET status = ?, start_date = ?, end_date = ?, notes = ? WHERE id = ?',
        j.status, j.start_date, j.end_date, j.notes ? `${j.notes}\n\nImported from ${st.fileName || 'a CSV file'}.` : `Imported from ${st.fileName || 'a CSV file'}.`, jobId);
      // Completed jobs count as revenue in the month they finished, not the day they were imported.
      const done = j.end_date || j.start_date;
      if (j.status === 'completed' && done) {
        await db.run("UPDATE jobs SET completed_at = least(now(), (?::date + time '17:00') AT TIME ZONE ?) WHERE id = ?", done, APP_TIMEZONE, jobId);
      }
    }
  }
  const skipped = st.result.dupes + st.result.problems.length;
  const msg = `Imported ${rows.length} ${st.kind === 'clients' ? (rows.length === 1 ? 'client' : 'clients') : (rows.length === 1 ? 'job' : 'jobs')}${skipped ? ` (${skipped} skipped)` : ''}`;
  return redirect(`/${st.kind}?msg=${encodeURIComponent(msg)}`);
}, { maxBody: IMPORT_BODY });
route('GET', '/settings/delete-company', ({ org }) => ok(v.deleteCompanyPage({ org })));
route('POST', '/settings/delete-company', async ({ db, org, form }) => {
  if (str(form.get('confirm'), 200).toLowerCase() !== org.name.trim().toLowerCase()) {
    return page(422, v.deleteCompanyPage({ org, error: 'Type the company name exactly as shown to confirm.' }));
  }
  try { await cancelPlan(db, org.org_id); } catch (e) {
    console.error('Cancel plan failed:', e.message);
    return page(502, v.deleteCompanyPage({ org, error: 'We couldn\'t cancel the paid plan with Stripe, so nothing was deleted. Try again, or cancel it in Plan & billing first.' }));
  }
  const smsReg = await db.get('SELECT * FROM sms_registrations WHERE org_id = ?', org.org_id);
  await db.run('SELECT delete_organization(?)', org.org_id);
  await texting.release(smsReg);
  return redirect(`/account?msg=${encodeURIComponent(`${org.name} was deleted.`)}`);
});
// Texting is ready once the app has Twilio and this company's registered sender has been added (sms_senders).
async function textingFor(db, orgId) {
  const s = await db.get('SELECT phone FROM sms_senders WHERE org_id = ?', orgId);
  const reg = await db.get('SELECT status FROM sms_registrations WHERE org_id = ?', orgId);
  return { ready: !!(s && sms.configured()), phone: s?.phone || '', pending: reg?.status === 'pending' };
}

// Self-serve texting setup: business details -> toll-free number + carrier verification (see texting.js).
async function renderTexting(db, org, extra = {}, status = 200) {
  const reg = await db.get('SELECT * FROM sms_registrations WHERE org_id = ?', org.org_id);
  const plan = (await db.get('SELECT effective_plan(?) AS p', org.org_id)).p;
  let values = extra.values;
  if (!values) {
    const p = (await db.get('SELECT * FROM company_profiles WHERE org_id = ?', org.org_id)) || {};
    values = reg || { business_name: org.name, contact_email: p.email || '', contact_phone: p.phone || '', website: p.website || '' };
  }
  return page(status, v.textingPage({ reg, plan, configured: sms.configured(), ...extra, values }));
}
// ---------- Texts tab: setup, conversations with clients, sending a text by hand ----------
// Texts with one client: automatic ones (email_log, matched by phone) and replies / hand-sent ones (sms_messages).
const SMS_THREAD_SQL = `
  SELECT 'out' AS direction, l.subject AS body, l.status, l.created_at FROM email_log l
    WHERE l.org_id = $1 AND l.channel = 'sms' AND length(regexp_replace($3::text, '\\D', '', 'g')) >= 10
      AND right(regexp_replace(l.to_email, '\\D', '', 'g'), 10) = right(regexp_replace($3::text, '\\D', '', 'g'), 10)
  UNION ALL
  SELECT direction, body, status, created_at FROM sms_messages WHERE org_id = $1 AND client_id = $2`;
route('GET', '/texts', async ({ db, org, url }) => {
  const t = await textingFor(db, org.org_id);
  const flash = url.searchParams.get('msg');
  if (!t.ready) {
    await texting.check(org.org_id);
    const reg = await db.get('SELECT * FROM sms_registrations WHERE org_id = ?', org.org_id);
    const plan = (await db.get('SELECT effective_plan(?) AS p', org.org_id)).p;
    if (reg?.status === 'approved') return redirect('/texts');
    return ok(v.textsPage({ ready: false, setup: { configured: sms.configured(), reg, plan }, flash }));
  }
  const convos = await db.all(`SELECT DISTINCT ON (c.id) c.id AS client_id, c.name, m.direction, m.body, m.created_at,
      (SELECT count(*)::int FROM sms_messages u WHERE u.client_id = c.id AND u.direction = 'in' AND u.read_at IS NULL) AS unread
    FROM clients c CROSS JOIN LATERAL (${SMS_THREAD_SQL.replace(/\$1/g, 'c.org_id').replace(/\$2/g, 'c.id').replace(/\$3/g, 'c.phone')}) m
    WHERE c.org_id = ? ORDER BY c.id, m.created_at DESC`, org.org_id);
  convos.sort((a, b) => b.created_at - a.created_at);
  const unknown = await db.all(`SELECT phone, body, created_at FROM sms_messages WHERE org_id = ? AND client_id IS NULL AND direction = 'in'
    ORDER BY created_at DESC LIMIT 20`, org.org_id);
  const clients = await db.all(`SELECT id, name FROM clients WHERE org_id = ? AND sms_consent AND sms_opted_out_at IS NULL AND phone <> ''
    ORDER BY lower(name)`, org.org_id);
  return ok(v.textsPage({ ready: true, phone: t.phone, convos, unknown, clients, flash }));
});
route('GET', '/texts/open', async ({ url }) => {
  const id = url.searchParams.get('client_id');
  return redirect(/^\d{1,15}$/.test(id || '') ? `/texts/${id}` : '/texts');
});
async function renderThread(db, org, id, extra = {}, status = 200) {
  const client = await db.get('SELECT * FROM clients WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!client) return notFound();
  const messages = await db.all(`${SMS_THREAD_SQL} ORDER BY created_at`, org.org_id, id, client.phone || '');
  await db.run("UPDATE sms_messages SET read_at = now() WHERE org_id = ? AND client_id = ? AND direction = 'in' AND read_at IS NULL", org.org_id, id);
  const t = await textingFor(db, org.org_id);
  const why = !t.ready ? 'setup' : !sms.e164(client.phone) ? 'phone' : client.sms_opted_out_at ? 'stop' : !client.sms_consent ? 'consent' : '';
  return page(status, v.textThreadPage({ client, messages, canText: !why, why, ...extra }));
}
route('GET', '/texts/:id', ({ db, org, id, url }) => renderThread(db, org, id, { flash: url.searchParams.get('msg') }));
route('POST', '/texts/:id', async ({ db, org, id, form }) => {
  const client = await db.get('SELECT * FROM clients WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!client) return notFound();
  const body = str(form.get('body'), 1000);
  if (!body) return renderThread(db, org, id, { errors: { body: 'Type a message to send.' } }, 422);
  const result = await asServer(async (sdb) => {
    const company = await mailer.companyOf(sdb, org.org_id);
    const to = mailer.textable(company, client);
    if (!to) return { skipped: true };
    const text = `${company.name}: ${body}`.slice(0, 1600);
    let providerId = ''; let error = '';
    try { providerId = await sms.send({ messagingServiceSid: company.sms_sender, to, body: text }); } catch (e) {
      error = e.message.slice(0, 500);
      if (e.code === sms.UNSUBSCRIBED) await sdb.run('UPDATE clients SET sms_opted_out_at = now() WHERE id = ?', client.id);
    }
    await sdb.run(`INSERT INTO sms_messages (org_id, client_id, direction, phone, body, status, error, provider_id) VALUES (?, ?, 'out', ?, ?, ?, ?, ?)`,
      org.org_id, client.id, to, text, error ? 'failed' : 'sent', error, providerId);
    return { error };
  });
  if (result.skipped) return renderThread(db, org, id, {}, 409);
  if (result.error) return renderThread(db, org, id, { values: { body }, errors: { body: `The text could not be sent: ${result.error}` } }, 502);
  return redirect(`/texts/${id}`);
});

route('GET', '/settings/texting', async ({ db, org, url }) => {
  await texting.check(org.org_id);
  return renderTexting(db, org, { flash: url.searchParams.get('msg'), editing: url.searchParams.get('edit') === '1' });
});
route('POST', '/settings/texting', async ({ db, org, form, req }) => {
  const reg = await db.get('SELECT status FROM sms_registrations WHERE org_id = ?', org.org_id);
  const plan = (await db.get('SELECT effective_plan(?) AS p', org.org_id)).p;
  if (!sms.configured() || plan === 'free' || reg?.status === 'approved') return redirect('/settings/texting');
  const { values, errors } = texting.validate(form);
  if (hasErrors(errors)) return renderTexting(db, org, { values: { ...values, agree: form.get('agree') === 'on' }, errors, editing: true }, 422);
  const r = await texting.submit(org.org_id, values, baseUrl(req));
  return redirect(`/settings/texting?msg=${encodeURIComponent(r.status === 'pending' ? `Submitted. Your number is ${r.phone}.` : 'Setup did not finish. See below.')}`);
});
route('GET', '/settings', async ({ db, org, url }) => {
  const c = await companyFor(db, org);
  const acct = await db.get('SELECT * FROM stripe_accounts WHERE org_id = ?', org.org_id);
  const ep = (await db.get('SELECT * FROM company_profiles WHERE org_id = ?', org.org_id)) || {};
  const emailValues = { estimate_followup_days: ep.estimate_followup_days ?? 3, appointment_reminders: ep.appointment_reminders ?? true,
    sms_estimate_followups: !!ep.sms_estimate_followups, sms_appointment_reminders: !!ep.sms_appointment_reminders, sms_review_requests: !!ep.sms_review_requests,
    review_requests: ep.review_requests ?? false, review_url: ep.review_url || '', default_deposit_percent: String(ep.default_deposit_percent ?? 0) };
  return ok(v.settingsPage({ org, values: c, hasLogo: !!c.logo, flash: url.searchParams.get('msg'), emailValues, emailEnabled: email.configured(),
    texting: await textingFor(db, org.org_id),
    payments: { configured: stripe.configured(), testMode: stripe.testMode(), account: acct || null } }));
});

// Linking the company's own Stripe account (Stripe Connect). The account row is written by the server as the
// database owner, never by people directly, so a company can't point itself at another company's account.
const baseUrl = (req) => process.env.APP_URL?.replace(/\/$/, '') || `${COOKIE_SECURE ? 'https' : 'http'}://${req.headers.host}`;
async function connectStripe({ db, org, req }) {
  if (!stripe.configured()) return redirect('/settings');
  let acct = await db.get('SELECT * FROM stripe_accounts WHERE org_id = ?', org.org_id);
  try {
    if (!acct) {
      const p = await db.get('SELECT email FROM company_profiles WHERE org_id = ?', org.org_id);
      const a = await stripe.createAccount({ orgId: org.org_id, name: org.name, email: p?.email });
      await pool.query('INSERT INTO stripe_accounts (org_id, account_id) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING', [org.org_id, a.id]);
      acct = { account_id: (await pool.query('SELECT account_id FROM stripe_accounts WHERE org_id = $1', [org.org_id])).rows[0].account_id };
    }
    return redirect(await stripe.onboardingLink(acct.account_id, baseUrl(req)));
  } catch (e) {
    console.error('Stripe connect failed:', e.message);
    return page(502, v.messagePage('Could not reach Stripe', `Stripe said: ${e.message}. Please try again from Company profile.`));
  }
}
route('POST', '/settings/stripe/connect', connectStripe);
route('GET', '/settings/stripe/connect', connectStripe); // Stripe sends people here when an onboarding link expires
route('GET', '/settings/stripe/return', async ({ db, org }) => {
  const acct = await db.get('SELECT * FROM stripe_accounts WHERE org_id = ?', org.org_id);
  if (!acct) return redirect('/settings');
  try {
    const a = await stripe.getAccount(acct.account_id);
    await pool.query('SELECT update_stripe_account($1, $2, $3)', [acct.account_id, !!a.charges_enabled, !!a.details_submitted]);
    return redirect(`/settings?msg=${a.charges_enabled ? 'Stripe+connected.+You+can+send+invoices+now.' : 'Stripe+needs+a+bit+more+information+before+you+can+send+invoices.'}`);
  } catch (e) {
    console.error('Stripe account check failed:', e.message);
    return redirect('/settings?msg=Could+not+check+with+Stripe+yet.+Refresh+in+a+minute.');
  }
});
route('GET', '/settings/logo', async ({ db, org }) => {
  const p = await db.get('SELECT logo, logo_type FROM company_profiles WHERE org_id = ?', org.org_id);
  if (!p?.logo) return notFound();
  return { status: 200, body: p.logo, headers: { 'Content-Type': p.logo_type, 'Cache-Control': 'private, no-store' } };
});
route('POST', '/settings', async ({ db, org, form }) => {
  const f = formObj(form);
  const values = { name: f.name ?? '' }; const errors = {};
  for (const [k, max] of Object.entries(PROFILE_FIELDS)) values[k] = str(f[k], max);
  values.name = str(values.name, 200);
  if (!values.name) errors.name = 'Company name is required.';
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Email address does not look valid.';
  let logo; let logoType;
  if (f.logo_data) {
    const mm = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(f.logo_data);
    const buf = mm ? Buffer.from(mm[2], 'base64') : null;
    const isPng = buf && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isJpg = buf && buf[0] === 0xff && buf[1] === 0xd8;
    if (!buf || !(isPng || isJpg)) errors.logo = 'The logo must be a PNG or JPG image.';
    else if (buf.length > 1_500_000) errors.logo = 'The logo is too large. Use an image under 1.5 MB.';
    else { logo = buf; logoType = isPng ? 'image/png' : 'image/jpeg'; }
  }
  const hasLogo = !!(await db.get('SELECT 1 FROM company_profiles WHERE org_id = ? AND logo IS NOT NULL', org.org_id));
  if (hasErrors(errors)) return page(422, v.settingsPage({ org, values, hasLogo, errors }));
  await db.run('UPDATE organizations SET name = ? WHERE id = ?', values.name, org.org_id);
  await db.run(`INSERT INTO company_profiles (org_id, phone, email, address, website, license_number, estimate_terms, work_order_terms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET phone = excluded.phone, email = excluded.email, address = excluded.address, website = excluded.website,
      license_number = excluded.license_number, estimate_terms = excluded.estimate_terms, work_order_terms = excluded.work_order_terms, updated_at = now()`,
  org.org_id, values.phone, values.email, values.address, values.website, values.license_number, values.estimate_terms, values.work_order_terms);
  if (logo) await db.run('UPDATE company_profiles SET logo = ?, logo_type = ? WHERE org_id = ?', logo, logoType, org.org_id);
  else if (f.remove_logo === '1') await db.run('UPDATE company_profiles SET logo = NULL, logo_type = NULL WHERE org_id = ?', org.org_id);
  return redirect('/settings?msg=Profile+saved');
});

route('POST', '/settings/emails', async ({ db, org, form }) => {
  const f = formObj(form);
  const values = {
    estimate_followup_days: ['0', '2', '3', '5', '7'].includes(f.estimate_followup_days) ? Number(f.estimate_followup_days) : 3,
    appointment_reminders: f.appointment_reminders === 'on', review_requests: f.review_requests === 'on',
    sms_estimate_followups: f.sms_estimate_followups === 'on', sms_appointment_reminders: f.sms_appointment_reminders === 'on', sms_review_requests: f.sms_review_requests === 'on',
    review_url: str(f.review_url, 500), default_deposit_percent: str(f.default_deposit_percent, 5),
  };
  const errors = {};
  if (values.review_url && !/^https?:\/\/\S+\.\S+/i.test(values.review_url)) errors.review_url = 'Review link must be a web address starting with https://';
  if ((values.review_requests || values.sms_review_requests) && !values.review_url) errors.review_url = 'Add your review link (for example your Google review page) to send review requests.';
  const dep = /^\d{1,3}$/.test(values.default_deposit_percent) ? Number(values.default_deposit_percent) : NaN;
  if (!(dep >= 0 && dep <= 100)) errors.default_deposit_percent = 'Deposit must be a whole percent from 0 to 100.';
  if (hasErrors(errors)) {
    const c = await companyFor(db, org);
    const acct = await db.get('SELECT * FROM stripe_accounts WHERE org_id = ?', org.org_id);
    return page(422, v.settingsPage({ org, values: c, hasLogo: !!c.logo, emailValues: values, emailErrors: errors, emailEnabled: email.configured(),
      texting: await textingFor(db, org.org_id),
      payments: { configured: stripe.configured(), testMode: stripe.testMode(), account: acct || null } }));
  }
  // Text switches only stick once texting is set up for the company (a disabled checkbox isn't sent, so keep what's saved).
  const ready = (await textingFor(db, org.org_id)).ready;
  await db.run(`INSERT INTO company_profiles (org_id, estimate_followup_days, appointment_reminders, review_requests, review_url, default_deposit_percent,
      sms_estimate_followups, sms_appointment_reminders, sms_review_requests)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET estimate_followup_days = excluded.estimate_followup_days,
      appointment_reminders = excluded.appointment_reminders, review_requests = excluded.review_requests, review_url = excluded.review_url,
      default_deposit_percent = excluded.default_deposit_percent,
      sms_estimate_followups = CASE WHEN ? THEN excluded.sms_estimate_followups ELSE company_profiles.sms_estimate_followups END,
      sms_appointment_reminders = CASE WHEN ? THEN excluded.sms_appointment_reminders ELSE company_profiles.sms_appointment_reminders END,
      sms_review_requests = CASE WHEN ? THEN excluded.sms_review_requests ELSE company_profiles.sms_review_requests END, updated_at = now()`,
  org.org_id, values.estimate_followup_days, values.appointment_reminders, values.review_requests, values.review_url, dep,
  ready && values.sms_estimate_followups, ready && values.sms_appointment_reminders, ready && values.sms_review_requests, ready, ready, ready);
  return redirect('/settings?msg=Email+settings+saved#emails');
});

const pdfResponse = (buf, name) => ({ status: 200, body: buf, headers: {
  'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w .-]/g, '').slice(0, 80)}.pdf"`,
} });
route('GET', '/estimates/:id/pdf', async ({ db, org, id }) => {
  const estimate = await db.get('SELECT * FROM estimates WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!estimate) return notFound();
  const buf = await pdf.estimatePdf({
    company: await companyFor(db, org), estimate,
    client: await db.get('SELECT * FROM clients WHERE id = ?', estimate.client_id),
    items: await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', id),
    totalCents: (await db.get(`SELECT ${ESTIMATE_TOTAL_SQL} AS t FROM estimates WHERE id = ?`, id)).t,
    options: (await mailer.estimateTotals(db, id)).options,
  });
  return pdfResponse(buf, `Estimate E-${id} ${estimate.project_name}`);
});
route('GET', '/jobs/:id/work-order', async ({ db, org, id, url }) => {
  const job = await db.get('SELECT * FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!job) return notFound();
  const assignee = await workOrderAssignee(db, id, url.searchParams);
  if (assignee === undefined) return notFound();
  const buf = await pdf.workOrderPdf({ company: await companyFor(db, org), job, assignee,
    client: await db.get('SELECT * FROM clients WHERE id = ?', job.client_id) });
  return pdfResponse(buf, `Work order WO-${id} ${job.project_name}`);
});
// Who a work order is for: a teammate (user_id), a subcontractor without an account (sub_id), or nobody (the general one).
// undefined = asked for someone who isn't on this job.
async function workOrderAssignee(db, jobId, params) {
  const uid = params.get('user_id'); const subId = params.get('sub_id');
  if (uid) return (UUID_RE.test(uid) && (await db.get('SELECT * FROM job_team(?) WHERE user_id = ?::uuid', jobId, uid))) || undefined;
  if (subId) {
    const s = /^\d{1,15}$/.test(subId) && await db.get(`SELECT s.name AS full_name, s.email, s.phone, a.payout_cents, 0 AS labor_cents
      FROM sub_assignments a JOIN subcontractors s ON s.id = a.sub_id WHERE a.job_id = ? AND a.sub_id = ?`, jobId, Number(subId));
    return s || undefined;
  }
  return null;
}
route('POST', '/jobs/:id/work-order/send', async ({ db, org, id, form }) => {
  const job = await db.get('SELECT * FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!job) return notFound();
  const assignee = await workOrderAssignee(db, id, form);
  if (!assignee) return notFound();
  const back = (msg) => redirect(`/jobs/${id}?msg=${encodeURIComponent(msg)}`);
  if (!email.configured()) return back('Email sending is not set up for this app yet. Download the work order and send it yourself.');
  if (!email.validEmail(assignee.email)) return back(`Add an email address for ${assignee.full_name || 'them'} first.`);
  const company = await companyFor(db, org);
  const buf = await pdf.workOrderPdf({ company, job, assignee, client: await db.get('SELECT * FROM clients WHERE id = ?', job.client_id) });
  const result = await asServer(async (sdb) => {
    const c = await mailer.companyOf(sdb, org.org_id);
    const t = mailer.templates.work_order({ company: c, job, name: assignee.full_name || assignee.email, payout: assignee.payout_cents });
    return mailer.deliver(sdb, { orgId: org.org_id, kind: 'work_order', to: assignee.email, ...t, company: c, jobId: id,
      attachments: [{ filename: `Work order WO-${id}.pdf`, content: buf }] });
  });
  return back(result.ok ? `Work order emailed to ${assignee.email}` : `The work order could not be sent: ${result.error}`);
});

// Joining or creating a company, and the account page (these work before the user belongs to one)
const ORG_ROUTES = new Set(['/welcome', '/org/new', '/org/join', '/org/switch', '/account', '/account/profile', '/account/theme', '/account/delete']);
const orgCookie = (id) => cookie('org', id, 60 * 60 * 24 * 365);
route('GET', '/welcome', ({ orgs }) => ok(v.welcomePage({ hasOrgs: orgs.length > 0 })), { worker: true });
route('GET', '/org/new', () => redirect('/welcome'), { worker: true });
route('POST', '/org/new', async ({ db, orgs, form }) => {
  const name = str(form.get('name'), 200);
  if (!name) return page(422, v.welcomePage({ hasOrgs: orgs.length > 0, values: { name }, errors: { name: 'Company name is required.' } }));
  const { id } = await db.get('SELECT create_organization(?) AS id', name);
  return redirect('/?msg=Company+created', { 'Set-Cookie': orgCookie(id) });
}, { worker: true });
route('POST', '/org/join', async ({ db, orgs, form }) => {
  const code = str(form.get('code'), 40);
  const fail = (msg) => page(422, v.welcomePage({ hasOrgs: orgs.length > 0, values: { code }, errors: { code: msg } }));
  if (!code) return fail('Enter the join code from your admin.');
  const r = await attempt(db, () => db.get('SELECT join_organization(?) AS id', code));
  if (r.error) {
    if (!dbMessage(r.error)) throw r.error;
    // The failed call was rolled back, so count the miss separately (limits guessing).
    if (/doesn't match/.test(r.error.message)) await db.run('SELECT record_failed_join()');
    return fail(dbMessage(r.error));
  }
  const already = orgs.some((o) => o.org_id === r.value.id);
  return redirect(`/?msg=${already ? 'You+are+already+in+that+company' : 'Welcome+to+the+team'}`, { 'Set-Cookie': orgCookie(r.value.id) });
}, { worker: true });
route('POST', '/org/switch', async ({ orgs, form }) => {
  const target = orgs.find((o) => o.org_id === form.get('org_id'));
  if (!target) return notFound();
  return redirect('/', { 'Set-Cookie': orgCookie(target.org_id) });
}, { worker: true });
async function renderAccount({ req, db, user, org, orgs }, extra = {}, status = 200) {
  const profile = (await db.get('SELECT * FROM profiles WHERE user_id = ?', user.id)) || { full_name: '', phone: '', zip: '' };
  const plan = org && org.role === 'admin' ? (await db.get('SELECT effective_plan(?) AS p', org.org_id)).p : null;
  return page(status, v.accountPage({ user, org, orgs, plan, theme: themeOf(req), values: extra.values || profile, ...extra }));
}
// Light or dark look, saved per device in a cookie; "system" follows the device setting.
route('POST', '/account/theme', ({ form }) => {
  const t = form.get('theme');
  return redirect('/account?msg=Appearance+saved#appearance', { 'Set-Cookie': THEMES.includes(t) ? cookie('theme', t, 60 * 60 * 24 * 365) : cookie('theme', '', 0) });
}, { worker: true });
route('GET', '/account', (ctx) => renderAccount(ctx, { flash: ctx.url.searchParams.get('msg') }), { worker: true });
// Deleting your own account: companies you're the only person in go with it; a company with other people needs another admin first.
async function renderDeleteAccount({ db, user }, extra = {}, status = 200) {
  const sole = await db.all('SELECT * FROM my_sole_admin_orgs()');
  return page(status, v.deleteAccountPage({ user, blockers: sole.filter((o) => o.others > 0), companies: sole.filter((o) => o.others === 0), ...extra }));
}
// Stops billing before a company is deleted, so nobody is charged for a company that no longer exists.
async function cancelPlan(db, orgId) {
  const sub = await db.get('SELECT stripe_subscription_id, status FROM org_subscriptions WHERE org_id = ?', orgId);
  if (sub?.stripe_subscription_id && !['canceled', 'incomplete_expired', 'none'].includes(sub.status)) {
    await stripe.cancelSubscription(sub.stripe_subscription_id);
  }
}
route('GET', '/account/delete', (ctx) => renderDeleteAccount(ctx), { worker: true });
route('POST', '/account/delete', async (ctx) => {
  const { db, user, form } = ctx;
  if (String(form.get('confirm') ?? '').trim().toUpperCase() !== 'DELETE') return renderDeleteAccount(ctx, { error: 'Type DELETE to confirm.' }, 422);
  if (!auth.canDeleteUsers()) {
    return renderDeleteAccount(ctx, { error: 'Account deletion is temporarily unavailable. Email support@keystonefsm.com and we\'ll delete it for you.' }, 503);
  }
  const sole = await db.all('SELECT * FROM my_sole_admin_orgs()');
  if (sole.some((o) => o.others > 0)) return renderDeleteAccount(ctx, {}, 409);
  try { for (const o of sole) await cancelPlan(db, o.org_id); } catch (e) {
    console.error('Cancel plan failed:', e.message);
    return renderDeleteAccount(ctx, { error: 'We couldn\'t cancel your paid plan with Stripe, so nothing was deleted. Try again, or cancel it in Plan & billing first.' }, 502);
  }
  await db.run('SELECT delete_my_data()');
  await auth.deleteUser(user.id); // if this fails, the database changes above roll back
  return redirect('/login?msg=Your+account+was+deleted.', { 'Set-Cookie': clearCookies });
}, { worker: true });
route('POST', '/account/profile', async (ctx) => {
  const f = formObj(ctx.form);
  const values = { full_name: str(f.full_name, 200), phone: str(f.phone, 50), zip: str(f.zip, 10) };
  const errors = {};
  if (values.phone && !/^[0-9+().\-\s x]{7,}$/i.test(values.phone)) errors.phone = 'Phone number does not look valid.';
  if (values.zip && !ZIP_RE.test(values.zip)) errors.zip = 'ZIP code should be 5 digits.';
  if (hasErrors(errors)) return renderAccount(ctx, { values, errors }, 422);
  await ctx.db.run(`INSERT INTO profiles (user_id, full_name, phone, zip) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET full_name = excluded.full_name, phone = excluded.phone, zip = excluded.zip, updated_at = now()`,
  ctx.user.id, values.full_name, values.phone, values.zip);
  return redirect('/account?msg=Profile+saved');
}, { worker: true });

// ---------- Plans (Stripe Billing on the app's own Stripe account) ----------
async function syncSubscription(orgId, customerId, sub) {
  const d = stripe.describeSubscription(sub);
  await pool.query('SELECT sync_org_subscription($1, $2, $3, $4, $5, $6, $7, $8)',
    [orgId, customerId, sub.id, d.plan, d.interval, d.status, d.periodEnd, d.cancelAtEnd]);
}
async function renderBilling({ db, org, url }, extra = {}, status = 200) {
  const sub = (await db.get('SELECT * FROM org_subscriptions WHERE org_id = ?', org.org_id)) || {};
  const plan = (await db.get('SELECT effective_plan(?) AS p', org.org_id)).p;
  const counts = await db.get(`SELECT count(*) FILTER (WHERE role = 'admin')::int AS admins, count(*) FILTER (WHERE role = 'worker')::int AS workers
    FROM org_members(?)`, org.org_id);
  return page(status, v.billingPage({ org, sub, plan, counts, enabled: stripe.billingConfigured(), testMode: stripe.testMode(),
    interval: url?.searchParams.get('interval') === 'year' ? 'year' : 'month', flash: url?.searchParams.get('msg'), ...extra }));
}
route('GET', '/billing', async (ctx) => {
  const sessionId = ctx.url.searchParams.get('session_id');
  if (sessionId && stripe.billingConfigured()) {
    // Back from Stripe Checkout: record the new plan right away instead of waiting for the webhook.
    try {
      const cs = await stripe.getCheckoutSession(sessionId);
      if (cs.client_reference_id === ctx.org.org_id && cs.subscription && typeof cs.subscription === 'object') {
        await syncSubscription(ctx.org.org_id, cs.customer, cs.subscription);
        return redirect('/billing?msg=Thanks!+Your+plan+is+active.');
      }
    } catch (e) { console.error('Checkout check failed:', e.message); }
  }
  return renderBilling(ctx);
});
route('POST', '/billing/checkout', async (ctx) => {
  const { db, org, req, form } = ctx;
  if (!stripe.billingConfigured()) return redirect('/billing');
  const plan = form.get('plan'); const interval = form.get('interval');
  if (!stripe.PLANS[plan] || !['month', 'year'].includes(interval)) return redirect('/billing');
  const sub = (await db.get('SELECT * FROM org_subscriptions WHERE org_id = ?', org.org_id)) || {};
  if (sub.comped) return redirect('/billing');
  try {
    // Already paying: plan changes and cancelling happen in Stripe's billing portal.
    if (sub.stripe_customer_id && ['active', 'trialing', 'past_due'].includes(sub.status)) {
      return redirect(await stripe.portalSession(sub.stripe_customer_id, `${baseUrl(req)}/billing`));
    }
    let customer = sub.stripe_customer_id;
    if (!customer) {
      const p = await db.get('SELECT email FROM company_profiles WHERE org_id = ?', org.org_id);
      customer = await stripe.billingCustomer({ orgId: org.org_id, name: org.name, email: p?.email || ctx.user.email });
      await pool.query(`INSERT INTO org_subscriptions (org_id, stripe_customer_id) VALUES ($1, $2)
        ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id = coalesce(org_subscriptions.stripe_customer_id, excluded.stripe_customer_id)`, [org.org_id, customer]);
      customer = (await pool.query('SELECT stripe_customer_id FROM org_subscriptions WHERE org_id = $1', [org.org_id])).rows[0].stripe_customer_id;
    }
    const discount = interval === 'month' && !sub.first_month_discount_used;
    const cs = await stripe.checkoutSession({ customerId: customer, orgId: org.org_id, plan, interval, discount, baseUrl: baseUrl(req) });
    return redirect(cs.url);
  } catch (e) {
    console.error('Checkout failed:', e.message);
    return renderBilling(ctx, { error: `Stripe said: ${e.message}` }, 502);
  }
});
route('POST', '/billing/portal', async (ctx) => {
  const sub = await ctx.db.get('SELECT * FROM org_subscriptions WHERE org_id = ?', ctx.org.org_id);
  if (!sub?.stripe_customer_id || !stripe.billingConfigured()) return redirect('/billing');
  try { return redirect(await stripe.portalSession(sub.stripe_customer_id, `${baseUrl(ctx.req)}/billing`)); } catch (e) {
    console.error('Portal failed:', e.message);
    return renderBilling(ctx, { error: `Stripe said: ${e.message}` }, 502);
  }
});

// Public files for the home-screen app icon (no login needed).
const fs = require('node:fs');
const path = require('node:path');
const STATIC = {
  'manifest.webmanifest': 'application/manifest+json', 'icon.svg': 'image/svg+xml',
  'icon-192.png': 'image/png', 'icon-512.png': 'image/png', 'apple-touch-icon.png': 'image/png',
};
const staticCache = new Map();
function staticFile(name) {
  if (!STATIC[name]) return null;
  if (!staticCache.has(name)) staticCache.set(name, fs.readFileSync(path.join(__dirname, '..', 'public', name)));
  return { status: 200, body: staticCache.get(name), headers: { 'Content-Type': STATIC[name], 'Cache-Control': 'public, max-age=86400' } };
}

// ---------- server ----------
async function currentUser(cookies) {
  if (cookies.sa) {
    const user = await auth.getUser(cookies.sa);
    if (user) return { user };
  }
  if (cookies.sr) {
    const s = await auth.refresh(cookies.sr);
    if (s) {
      const user = await auth.getUser(s.access_token);
      if (user) return { user, setCookies: sessionCookies(s) };
    }
  }
  return {};
}

async function publicRoute(req, url) {
  if (url.pathname === '/login') {
    if (req.method === 'GET') return ok(v.loginPage({ notice: url.searchParams.get('msg') }));
    const f = formObj(await readBody(req));
    const email = str(f.email, 200);
    const r = await auth.signIn(email, f.password || '');
    if (r.error) return page(401, v.loginPage({ error: r.error, email }));
    return redirect('/', { 'Set-Cookie': sessionCookies(r.session) });
  }
  if (url.pathname === '/forgot') {
    if (req.method === 'GET') return ok(v.forgotPage());
    const email = str(formObj(await readBody(req)).email, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return page(422, v.forgotPage({ email, error: 'Enter a valid email address.' }));
    const r = await auth.recover(email, `${baseUrl(req)}/reset`);
    if (r.error) return page(502, v.forgotPage({ email, error: r.error }));
    return ok(v.forgotPage({ email, sent: true }));
  }
  if (url.pathname === '/reset') {
    if (req.method === 'GET') return ok(v.resetPage());
    const f = formObj(await readBody(req));
    const token = str(f.token, 4000);
    if (!token) return page(400, v.resetPage());
    if ((f.password || '').length < 8) return page(422, v.resetPage({ token, error: 'Password must be at least 8 characters.' }));
    const r = await auth.updatePassword(token, f.password);
    if (r.error === 'expired') return page(400, v.resetPage());
    if (r.error) return page(422, v.resetPage({ token, error: r.error }));
    return redirect('/login?msg=Password+updated.+Log+in+with+your+new+password.');
  }
  if (url.pathname === '/signup') {
    if (req.method === 'GET') return ok(v.signupPage());
    const f = formObj(await readBody(req));
    const values = { email: str(f.email, 200), full_name: str(f.full_name, 200), phone: str(f.phone, 50), zip: str(f.zip, 10) };
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address.';
    if ((f.password || '').length < 8) errors.password = 'Password must be at least 8 characters.';
    if (values.zip && !ZIP_RE.test(values.zip)) errors.zip = 'ZIP code should be 5 digits.';
    if (hasErrors(errors)) return page(422, v.signupPage({ values, errors }));
    const r = await auth.signUp(values.email, f.password, { full_name: values.full_name, phone: values.phone, zip: values.zip });
    if (r.error) return page(422, v.signupPage({ values, errors: { email: r.error } }));
    if (!r.session) return redirect('/login?msg=Check+your+email+to+confirm+your+account%2C+then+log+in.');
    return redirect('/', { 'Set-Cookie': sessionCookies(r.session) });
  }
  return null;
}

// Public diagnostics: says which dependency is failing, never any data or secrets.
// Stripe webhook: records paid invoices as payments. Runs as the database owner (there is no signed-in user);
// it only acts on events with a valid signature, for the company Stripe is set up for.
async function stripeWebhook(req) {
  const raw = await readRaw(req);
  const event = stripe.verifyEvent(raw, req.headers['stripe-signature']);
  if (!event) return { status: 400, body: 'Invalid signature', headers: { 'Content-Type': 'text/plain' } };
  const obj = event.data?.object || {};
  const ack = { status: 200, body: '{"received":true}', headers: { 'Content-Type': 'application/json' } };
  if (!event.account && (event.type.startsWith('customer.subscription.') || event.type === 'checkout.session.completed')) {
    // Plan purchases happen on the app's own Stripe account, so these events have no `account`.
    let sub = obj; let customer = obj.customer;
    if (event.type === 'checkout.session.completed') {
      if (obj.mode !== 'subscription' || !obj.subscription) return ack;
      sub = await stripe.getSubscription(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id);
      customer = obj.customer;
    }
    const orgId = sub.metadata?.org_id;
    if (!orgId) return ack;
    // Only accept it for the company that owns this Stripe customer (or that has none yet).
    const row = (await pool.query('SELECT stripe_customer_id FROM org_subscriptions WHERE org_id = $1', [orgId])).rows[0];
    if (!(await pool.query('SELECT 1 FROM organizations WHERE id = $1', [orgId])).rowCount) return ack;
    if (row?.stripe_customer_id && row.stripe_customer_id !== customer) return ack;
    await syncSubscription(orgId, customer, sub);
    return ack;
  }
  if (event.type === 'account.updated') {
    await pool.query('SELECT update_stripe_account($1, $2, $3)', [obj.id, !!obj.charges_enabled, !!obj.details_submitted]);
    return ack;
  }
  // Invoice events come from a company's connected account; only trust jobs of the company that owns that account.
  const owner = event.account ? (await pool.query('SELECT org_for_stripe_account($1) AS org', [event.account])).rows[0].org : null;
  const orgId = obj.metadata?.org_id; const jobId = Number(obj.metadata?.job_id);
  if (!owner || orgId !== owner || !Number.isInteger(jobId)) return ack; // not one of ours
  if (event.type === 'invoice.paid') {
    const paidAt = new Date(((obj.status_transitions && obj.status_transitions.paid_at) || event.created || Date.now() / 1000) * 1000);
    const paidOn = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(paidAt);
    await pool.query('SELECT record_stripe_payment($1, $2, $3, $4, $5, $6, $7, $8)',
      [orgId, jobId, obj.id, obj.amount_paid, paidOn, obj.number || '', obj.hosted_invoice_url || '', obj.invoice_pdf || '']);
  } else if (event.type === 'invoice.voided' || event.type === 'invoice.marked_uncollectible') {
    await pool.query('SELECT set_stripe_invoice_status($1, $2)', [obj.id, event.type === 'invoice.voided' ? 'void' : 'uncollectible']);
  }
  return ack;
}
// Twilio tells us about replies to a company's number. STOP and START are recorded on the matching client;
// Twilio itself blocks further texts and sends the carrier-required confirmation.
async function twilioInbound(req, url) {
  const params = await readBody(req);
  const signed = `${process.env.APP_URL?.replace(/\/$/, '') || `https://${req.headers.host}`}${url.pathname}`;
  if (!sms.validSignature(signed, params, req.headers['x-twilio-signature'])) return { status: 403, body: 'Invalid signature', headers: { 'Content-Type': 'text/plain' } };
  const k = sms.keyword(params.get('Body'));
  if (k) await pool.query('SELECT record_sms_reply($1, $2, $3)', [str(params.get('To'), 20), str(params.get('From'), 20), k === 'stop']);
  await pool.query('SELECT record_sms_inbound($1, $2, $3, $4)', [str(params.get('To'), 20), str(params.get('From'), 20), str(params.get('Body'), 1600), str(params.get('MessageSid'), 64)]);
  return { status: 200, body: '<Response></Response>', headers: { 'Content-Type': 'text/xml' } };
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1_000_000) { req.destroy(); reject(new Error('Body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function health() {
  const check = async (fn) => {
    try { await fn(); return 'ok'; } catch (e) {
      // Strip anything that looks like a URL with credentials so a misplaced secret is never echoed.
      const msg = String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']*/gi, '[url hidden]').slice(0, 200);
      return `error ${e.code || ''} ${msg}`.trim();
    }
  };
  const result = {
    database: await check(() => pool.query('SELECT 1')),
    database_as_user: await check(() => asUser('00000000-0000-0000-0000-000000000000', (db) => db.get('SELECT count(*) FROM organizations'))),
    database_schema: await check(async () => {
      const r = await pool.query(`SELECT to_regclass('public.job_assignments') IS NOT NULL AS payouts,
        to_regclass('public.join_attempts') IS NOT NULL AS join_codes, to_regclass('public.company_profiles') IS NOT NULL AS profiles,
        to_regclass('public.invoices') IS NOT NULL AS invoices,
        to_regclass('public.org_subscriptions') IS NOT NULL AS plans, to_regclass('public.email_log') IS NOT NULL AS emails,
        to_regprocedure('public.crew_jobs(uuid)') IS NOT NULL AS crew, to_regclass('public.expense_receipts') IS NOT NULL AS receipts,
        to_regclass('public.time_entries') IS NOT NULL AS time_clock, to_regprocedure('public.delete_my_data()') IS NOT NULL AS deletion,
        to_regclass('public.sms_senders') IS NOT NULL AS texting, to_regclass('public.subcontractors') IS NOT NULL AS subs,
        to_regclass('public.sms_registrations') IS NOT NULL AS sms_signup,
        to_regclass('public.sms_messages') IS NOT NULL AS sms_inbox`);
      if (!r.rows[0].payouts) throw new Error('Run supabase/migrations/0003_payouts.sql in the Supabase SQL Editor.');
      if (!r.rows[0].join_codes) throw new Error('Run supabase/migrations/0004_join_codes_and_job_dates.sql in the Supabase SQL Editor.');
      if (!r.rows[0].profiles) throw new Error('Run supabase/migrations/0005_company_profile_and_completion.sql in the Supabase SQL Editor.');
      if (!r.rows[0].invoices) throw new Error('Run supabase/migrations/0006_invoices.sql in the Supabase SQL Editor.');
      if (!r.rows[0].plans) throw new Error('Run supabase/migrations/0007_profiles_and_plans.sql in the Supabase SQL Editor.');
      if (!r.rows[0].emails) throw new Error('Run supabase/migrations/0008_estimate_approval_and_emails.sql in the Supabase SQL Editor.');
      if (!r.rows[0].crew) throw new Error('Run supabase/migrations/0010_crew_jobs.sql in the Supabase SQL Editor.');
      if (!r.rows[0].receipts) throw new Error('Run supabase/migrations/0011_expense_receipts.sql in the Supabase SQL Editor.');
      if (!r.rows[0].time_clock) throw new Error('Run supabase/migrations/0013_time_clock_photos.sql in the Supabase SQL Editor.');
      if (!r.rows[0].deletion) throw new Error('Run supabase/migrations/0014_account_deletion.sql in the Supabase SQL Editor.');
      if (!r.rows[0].texting) throw new Error('Run supabase/migrations/0015_text_messages.sql in the Supabase SQL Editor.');
      if (!r.rows[0].subs) throw new Error('Run supabase/migrations/0016_subcontractors.sql in the Supabase SQL Editor.');
      if (!r.rows[0].sms_signup) throw new Error('Run supabase/migrations/0017_texting_signup.sql in the Supabase SQL Editor.');
      if (!r.rows[0].sms_inbox) throw new Error('Run supabase/migrations/0018_text_inbox.sql in the Supabase SQL Editor.');
    }),
    auth: await check(async () => { if ((await auth.getUser('not-a-real-token')) !== null) throw new Error('unexpected'); }),
  };
  let target = 'unparseable';
  try { const u = new URL(process.env.DATABASE_URL); target = `${u.hostname}:${u.port || 5432} as ${decodeURIComponent(u.username)}`; } catch {}
  const healthy = Object.values(result).every((x) => x === 'ok');
  result.database_target = target; // host, port and user only; never the password
  return { status: healthy ? 200 : 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
}

// ---------- The client's estimate page (no login: the link's secret token is the key) ----------
const PUBLIC_RE = /^\/e\/([0-9a-f]{64})(?:\/(logo|pdf|approve|decline))?$/;
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);

async function publicEstimateData(db, estimate) {
  const company = await mailer.companyOf(db, estimate.org_id);
  const profile = (await db.get('SELECT estimate_terms, website, license_number, logo IS NOT NULL AS has_logo FROM company_profiles WHERE org_id = ?', estimate.org_id)) || {};
  const job = await db.get('SELECT id FROM jobs WHERE estimate_id = ?', estimate.id);
  return {
    estimate, company: { ...company, terms: profile.estimate_terms || '', website: profile.website || '', license_number: profile.license_number || '' },
    hasLogo: !!profile.has_logo, job,
    client: await db.get('SELECT * FROM clients WHERE id = ?', estimate.client_id),
    items: await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', estimate.id),
    totals: await mailer.estimateTotals(db, estimate.id),
    invoices: job ? await db.all("SELECT * FROM invoices WHERE job_id = ? AND status IN ('open', 'paid') ORDER BY id", job.id) : [],
    canPayOnline: !!(await payoutAccount(db, estimate.org_id)),
  };
}
// Who to tell when a client approves or declines: the company email, or else its admins.
async function companyRecipients(db, orgId, company) {
  if (email.validEmail(company.email)) return [company.email];
  return (await db.all(`SELECT u.email FROM memberships m JOIN auth.users u ON u.id = m.user_id
    WHERE m.org_id = ? AND m.role = 'admin' ORDER BY m.created_at LIMIT 3`, orgId)).map((r) => r.email);
}
async function notifyCompany(kind, estimateId, extra) {
  if (!email.configured()) return;
  try {
    await asServer(async (db) => {
      const estimate = await db.get('SELECT * FROM estimates WHERE id = ?', estimateId);
      const company = await mailer.companyOf(db, estimate.org_id);
      const client = await db.get('SELECT * FROM clients WHERE id = ?', estimate.client_id);
      const t = mailer.templates[kind]({ company, estimate, client, base: mailer.appUrl() || extra.base, ...extra });
      // The company's own copy comes "from Keystone" so it doesn't look like it came from the client.
      for (const to of await companyRecipients(db, estimate.org_id, company)) {
        await mailer.deliver(db, { orgId: estimate.org_id, kind, to, ...t, company: { ...company, name: 'Keystone' }, estimateId });
      }
    });
  } catch (e) { console.error(`Could not notify the company (${kind}):`, e.message); }
}

async function publicEstimate(req, url) {
  const m = url.pathname.match(PUBLIC_RE);
  if (!m) return page(404, v.messagePage('Link not found', 'This estimate link is not valid. Please check the link or contact the company that sent it.'));
  const [, token, action] = m;
  const notFoundLink = () => page(404, v.messagePage('Link not found', 'This estimate link is not valid or the estimate was deleted. Please contact the company that sent it.'));

  if (req.method === 'GET' && !action) {
    return asServer(async (db) => {
      const estimate = await db.get('SELECT * FROM estimates WHERE public_token = ?', token);
      if (!estimate) return notFoundLink();
      // First time the client opens it (the company's own preview doesn't count).
      if (!estimate.viewed_at && !url.searchParams.has('preview')) {
        await db.run('UPDATE estimates SET viewed_at = now() WHERE id = ?', estimate.id);
      }
      return ok(v.publicEstimatePage({ ...(await publicEstimateData(db, estimate)), token, flash: url.searchParams.get('msg'),
        preview: url.searchParams.has('preview') }));
    });
  }
  if (req.method === 'GET' && action === 'logo') {
    const r = await asServer((db) => db.get(`SELECT p.logo, p.logo_type FROM estimates e JOIN company_profiles p ON p.org_id = e.org_id
      WHERE e.public_token = ?`, token));
    if (!r?.logo) return page(404, 'Not found');
    return { status: 200, body: r.logo, headers: { 'Content-Type': r.logo_type, 'Cache-Control': 'private, max-age=3600' } };
  }
  if (req.method === 'GET' && action === 'pdf') {
    return asServer(async (db) => {
      const estimate = await db.get('SELECT * FROM estimates WHERE public_token = ?', token);
      if (!estimate) return notFoundLink();
      const org = { org_id: estimate.org_id, name: (await db.get('SELECT name FROM organizations WHERE id = ?', estimate.org_id)).name };
      const buf = await pdf.estimatePdf({
        company: await companyFor(db, org), estimate,
        client: await db.get('SELECT * FROM clients WHERE id = ?', estimate.client_id),
        items: await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', estimate.id),
        totalCents: (await db.get('SELECT estimate_total(?) AS t', estimate.id)).t,
        options: (await mailer.estimateTotals(db, estimate.id)).options,
      });
      return pdfResponse(buf, `Estimate E-${estimate.id} ${estimate.project_name}`);
    });
  }
  if (req.method !== 'POST' || !['approve', 'decline'].includes(action)) return page(405, v.messagePage('Not allowed', 'That action is not allowed.'));
  const form = await readBody(req);
  const f = formObj(form);

  if (action === 'decline') {
    const id = await asServer(async (db) => {
      const e = await db.get('SELECT * FROM estimates WHERE public_token = ? FOR UPDATE', token);
      if (!e || e.status === 'approved' || await db.get('SELECT 1 FROM jobs WHERE estimate_id = ?', e.id)) return e ? -1 : null;
      await db.run("UPDATE estimates SET status = 'declined', decline_reason = ?, updated_at = now() WHERE id = ?", str(f.reason, 2000), e.id);
      return e.id;
    });
    if (id === null) return notFoundLink();
    if (id > 0) await notifyCompany('estimate_declined', id, { base: baseUrl(req) });
    return redirect(`/e/${token}?msg=${encodeURIComponent(id > 0 ? 'Thanks for letting us know.' : 'This estimate was already approved.')}`);
  }

  // Approve: choose an option, sign, agree. The estimate becomes a job right away.
  const values = { option: str(f.option, 60), signer_name: str(f.signer_name, 200), signature: String(f.signature || ''),
    agree: f.agree === 'on', deposit_email: str(f.deposit_email, 200) };
  const outcome = await asServer(async (db) => {
    const e = await db.get('SELECT * FROM estimates WHERE public_token = ? FOR UPDATE', token);
    if (!e) return { notFound: true };
    if (e.status === 'approved' || await db.get('SELECT 1 FROM jobs WHERE estimate_id = ?', e.id)) return { already: true };
    const totals = await mailer.estimateTotals(db, e.id);
    const errors = {};
    if (totals.options.length && !totals.options.some((o) => o.name === values.option)) errors.option = 'Choose one of the options.';
    if (!values.signer_name) errors.signer_name = 'Type your full name.';
    if (values.signature && !/^data:image\/png;base64,[A-Za-z0-9+/=]{100,300000}$/.test(values.signature)) errors.signature = 'Please sign again.';
    if (!values.agree) errors.agree = 'Check the box to approve the estimate.';
    if (values.deposit_email && !email.validEmail(values.deposit_email)) errors.deposit_email = 'Email address does not look valid.';
    if (hasErrors(errors)) return { errors, data: await publicEstimateData(db, e) };
    await db.run(`UPDATE estimates SET status = 'approved', chosen_option = ?, approved_at = now(), signer_name = ?, signature = ?,
      signer_ip = ?, signer_agent = ?, decline_reason = NULL, updated_at = now() WHERE id = ?`,
    totals.options.length ? values.option : null, values.signer_name, values.signature || null, clientIp(req),
    str(req.headers['user-agent'], 300), e.id);
    await refreshScope(db, e.id);
    const jobId = (await db.get('SELECT convert_estimate_to_job(?) AS id', e.id)).id;
    const client = await db.get('SELECT * FROM clients WHERE id = ?', e.client_id);
    const total = (await db.get('SELECT estimate_total(?) AS t', e.id)).t;
    return { estimate: e, jobId, client, total, account: await payoutAccount(db, e.org_id) };
  });
  if (outcome.notFound) return notFoundLink();
  if (outcome.already) return redirect(`/e/${token}?msg=${encodeURIComponent('This estimate is already approved.')}`);
  if (outcome.errors) return page(422, v.publicEstimatePage({ ...outcome.data, token, values, errors: outcome.errors }));

  // Deposit: a Stripe invoice on the company's own account; the client goes straight to its pay page.
  const { estimate: e, jobId, client, total, account } = outcome;
  const deposit = Math.round((total * e.deposit_percent) / 100);
  const to = values.deposit_email || client.email;
  let payUrl = null;
  if (deposit > 0 && account && email.validEmail(to)) {
    try {
      const customerId = await stripe.ensureCustomer(account, client, to, e.org_id);
      const description = `Deposit (${e.deposit_percent}%) for ${e.project_name}`;
      const inv = await stripe.sendInvoice({ account, customerId, amountCents: deposit, description, daysUntilDue: 7,
        jobId, orgId: e.org_id, key: `deposit-${e.id}` });
      await asServer(async (db) => {
        if (customerId !== client.stripe_customer_id) {
          await db.run('UPDATE clients SET stripe_customer_id = ?, stripe_customer_account = ? WHERE id = ?', customerId, account, client.id);
        }
        await db.run(`INSERT INTO invoices (org_id, job_id, stripe_invoice_id, number, amount_cents, description, sent_to, due_date, hosted_url, pdf_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, (now() AT TIME ZONE ?)::date + 7, ?, ?) ON CONFLICT (stripe_invoice_id) DO NOTHING`,
        e.org_id, jobId, inv.id, inv.number || '', deposit, description, to, APP_TIMEZONE, inv.hosted_invoice_url || '', inv.invoice_pdf || '');
      });
      payUrl = inv.hosted_invoice_url || null;
    } catch (err) { console.error('Deposit invoice failed:', err.message); }
  }
  await notifyCompany('estimate_approved', e.id, { job: jobId, total, deposit: payUrl ? deposit : 0, base: baseUrl(req) });
  return redirect(`/e/${token}?msg=${encodeURIComponent(payUrl ? 'Approved! You can pay the deposit below.' : 'Approved! Thank you.')}`);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const cookies = parseCookies(req);

  // Once APP_URL is the custom domain (https://keystonefsm.com) and forwarding is on, pages opened on the old onrender.com address move there.
  // Webhooks (POST) and the health check keep working on either address.
  if (CANONICAL && ['GET', 'HEAD'].includes(req.method) && url.pathname !== '/healthz'
    && /\.onrender\.com$/i.test(String(req.headers.host || '').split(':')[0]) && req.headers.host !== CANONICAL.host) {
    return { status: 301, headers: { Location: `${CANONICAL.origin}${url.pathname}${url.search}` } };
  }

  if (url.pathname === '/stripe/webhook' && req.method === 'POST') return stripeWebhook(req);
  if (url.pathname === '/twilio/inbound' && req.method === 'POST') return twilioInbound(req, url);

  // Reject cross-site form posts (defence in depth on top of SameSite cookies).
  if (req.method === 'POST' && req.headers.origin) {
    let host = null;
    try { host = new URL(req.headers.origin).host; } catch {}
    if (host !== req.headers.host) return page(403, v.messagePage('Forbidden', 'Cross-site request blocked.'));
  }

  if (['/login', '/signup', '/forgot', '/reset'].includes(url.pathname) && ['GET', 'POST'].includes(req.method)) return publicRoute(req, url);
  if (url.pathname === '/healthz' && req.method === 'GET') return health();
  if (['/privacy', '/terms', '/support', '/data-deletion'].includes(url.pathname) && req.method === 'GET') return ok(v.legalPage(url.pathname.slice(1)));
  if (url.pathname === '/texting' && req.method === 'GET') return ok(v.textingPolicyPage(String(url.searchParams.get('company') || '').trim().slice(0, 100)));
  if (url.pathname.startsWith('/e/')) return publicEstimate(req, url);
  if (url.pathname.startsWith('/static/') && req.method === 'GET') return staticFile(url.pathname.slice(8)) || page(404, 'Not found');

  const { user, setCookies = [] } = await currentUser(cookies);
  if (!user) {
    // Logged-out visitors to the home page see what Keystone is (app stores and API reviewers check this page too).
    if (url.pathname === '/' && req.method === 'GET') return page(200, v.landingPage(), cookies.sa || cookies.sr ? { 'Set-Cookie': clearCookies } : {});
    if (req.method === 'GET') return redirect('/login', { 'Set-Cookie': clearCookies });
    return page(401, v.messagePage('Logged out', 'Your session has ended. Please log in again.'), { 'Set-Cookie': clearCookies });
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    await auth.signOut(cookies.sa);
    return redirect('/login', { 'Set-Cookie': clearCookies });
  }

  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return notFound();
  const form = req.method === 'POST' ? await readBody(req, r.maxBody) : null;
  const m = url.pathname.match(r.re);

  const result = await asUser(user.id, async (db) => {
    const orgs = await db.all(`SELECT m.org_id, m.role, o.name FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY o.name`, user.id);
    // Details typed at sign-up wait on the Supabase user until the first login, then become the profile.
    let profile = await db.get('SELECT full_name FROM profiles WHERE user_id = ?', user.id);
    if (!profile && user.signupProfile) {
      const sp = user.signupProfile;
      profile = { full_name: str(sp.full_name, 200) };
      await db.run(`INSERT INTO profiles (user_id, full_name, phone, address, zip) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING`,
        user.id, profile.full_name, str(sp.phone, 50), str(sp.address, 500), ZIP_RE.test(str(sp.zip, 10)) ? str(sp.zip, 10) : '');
    }
    user.name = profile?.full_name || '';
    const org = orgs.find((o) => o.org_id === cookies.org) || orgs[0] || null;
    if (!org && !ORG_ROUTES.has(url.pathname)) return { ...redirect('/welcome'), nav: { user, org, orgs } };
    if (org && org.role !== 'admin' && !r.worker) return { ...notFound(), nav: { user, org, orgs } };
    const out = await r.handler({ req, url, form, db, user, org, orgs, id: m[1] && !r.uid ? Number(m[1]) : undefined, uid: r.uid ? m[1] : undefined });
    return { ...out, nav: { user, org, orgs }, path: url.pathname };
  });
  const existing = [].concat(result.headers?.['Set-Cookie'] || []);
  return { ...result, headers: { ...result.headers, 'Set-Cookie': [...setCookies, ...existing] } };
}

function respond(res, out, req) {
  const headers = {
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
    ...out.headers,
  };
  if (Array.isArray(headers['Set-Cookie']) && !headers['Set-Cookie'].length) delete headers['Set-Cookie'];
  let body = out.body || '';
  if (typeof body === 'string' && body) {
    headers['Content-Type'] ||= 'text/html; charset=utf-8';
    const n = out.nav?.user ? v.nav({ ...out.nav, path: out.path }) : { nav: '', avatar: '' };
    body = body.replace('<!--NAV-->', n.nav).replace('<!--AVATAR-->', n.avatar);
    const theme = req ? themeOf(req) : '';
    if (theme && body.startsWith('<!doctype html>')) {
      // "only light/dark" also stops phone browsers from auto-darkening (or lightening) the page.
      body = body.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`)
        .replace('<meta name="color-scheme" content="light dark">', `<meta name="color-scheme" content="only ${theme}">`)
        .replace(/<meta name="theme-color" content="[^"]*" media="\(prefers-color-scheme: (light|dark)\)">/g,
          (tag, scheme) => (scheme === theme ? tag.replace(/ media="[^"]*"/, '') : ''));
    }
  }
  res.writeHead(out.status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  handle(req, res).then((out) => respond(res, out, req)).catch((e) => {
    console.error(e);
    if (!res.headersSent && ['42P01', '42703', '42883'].includes(e.code)) {
      // Missing table, column or function: the code was deployed before its database migration ran.
      respond(res, page(503, v.messagePage('Database update needed',
        'This part of the app needs a database update that hasn\'t been run yet. An admin should run the newest file in supabase/migrations in the Supabase SQL Editor (the /healthz page names it). Nothing was saved.')));
      return;
    }
    if (!res.headersSent) {
      respond(res, page(e.status || 500, v.messagePage('Something went wrong',
        'The request could not be completed and nothing was saved. Use your browser\'s Back button to return to your entries and try again.')));
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Keystone running on http://localhost:${PORT}`));
  mailer.startAutomations();
}
module.exports = { server };
