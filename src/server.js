'use strict';
const http = require('node:http');
const { pool, asUser, ESTIMATE_TOTAL_SQL, JOB_TOTALS_SQL, withJobMath } = require('./db');
const auth = require('./auth');
const { parseMoney, parseQty, plain, fmtQty, fmt } = require('./money');
const v = require('./views');
const pdf = require('./pdf');
const stripe = require('./stripe');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Los_Angeles'; // decides which payments count as "this month"
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

// ---------- responses ----------
// Handlers return a response; it is sent only after the request's database transaction commits.
const page = (status, body, headers = {}) => ({ status, body, headers });
const ok = (body) => page(200, body);
const redirect = (to, headers = {}) => ({ status: 303, headers: { Location: to, ...headers } });
const notFound = () => page(404, v.messagePage('Not found', 'That record does not exist.'));
const str = (val, max = 2000) => String(val ?? '').trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const SAVE_FAILED = { _save: 'Could not save because of a server error. Your entries are still on this page; please try again.' };
const hasErrors = (e) => Object.keys(e).length > 0;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
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
  if (!clean.name) errors[prefix + 'name'] = 'Client name is required.';
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) errors[prefix + 'email'] = 'Email address does not look valid.';
  if (clean.phone && !/^[0-9+().\-\s x]{7,}$/i.test(clean.phone)) errors[prefix + 'phone'] = 'Phone number does not look valid.';
  return { values, errors, clean };
}

async function validateEstimate(db, org, params) {
  const f = formObj(params);
  const errors = {};
  const values = {
    client_id: f.client_id ?? '', project_name: f.project_name ?? '', scope: f.scope ?? '',
    estimated_cost: f.estimated_cost ?? '', status: v.ESTIMATE_STATUS[f.status] ? f.status : 'draft',
  };
  let newClient = null;
  if (values.client_id === 'new') {
    const c = validateClient(f, 'new_');
    Object.assign(values, c.values); Object.assign(errors, c.errors); newClient = c.clean;
  } else if (!/^\d{1,15}$/.test(values.client_id)
    || !(await db.get('SELECT id FROM clients WHERE id = ? AND org_id = ?', Number(values.client_id), org))) {
    errors.client_id = 'Choose a client, or pick "+ New client".';
  }
  const projectName = str(values.project_name, 200);
  if (!projectName) errors.project_name = 'Project name is required.';
  const cost = parseMoney(values.estimated_cost, 'Estimated cost', { required: false });
  if (cost.error) errors.estimated_cost = cost.error;

  const descs = params.getAll('item_desc'); const qtys = params.getAll('item_qty'); const prices = params.getAll('item_price');
  const items = []; const cleanItems = [];
  for (let i = 0; i < Math.max(descs.length, qtys.length, prices.length); i++) {
    const it = { desc: descs[i] ?? '', qty: qtys[i] ?? '', price: prices[i] ?? '' };
    if (!it.desc.trim() && !it.qty.trim() && !it.price.trim()) continue; // ignore blank rows
    const n = items.length; items.push(it);
    const problems = [];
    const desc = str(it.desc, 500);
    if (!desc) problems.push('description is required');
    const q = parseQty(it.qty, 'quantity'); if (q.error) problems.push(q.error.replace(/^q/, 'Q'));
    const p = parseMoney(it.price, 'unit price'); if (p.error) problems.push(p.error.replace(/^u/, 'U'));
    if (problems.length) errors[`item_${n}`] = `Line ${n + 1}: ${problems.join(' ')}`;
    else cleanItems.push({ desc, qty: q.value, price: p.value });
  }
  if (!items.length) errors.items = 'Add at least one line item.';
  return {
    values, items, errors,
    clean: { projectName, scope: str(values.scope, 10000), cost: cost.value ?? null, status: values.status, items: cleanItems, newClient },
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

async function renderJob(db, org, id, extra = {}, status = 200) {
  const job = await loadJob(db, org, id);
  if (!job) return notFound();
  return page(status, v.jobPage({
    job, ...extra,
    client: await db.get('SELECT * FROM clients WHERE id = ?', job.client_id),
    expenses: await db.all('SELECT * FROM expenses WHERE job_id = ? ORDER BY id', id),
    payments: await db.all(`SELECT payments.*, invoices.number AS invoice_number FROM payments
      LEFT JOIN invoices ON invoices.payment_id = payments.id WHERE payments.job_id = ? ORDER BY payments.paid_on, payments.id`, id),
    crew: await db.all('SELECT * FROM job_team(?)', id),
    members: await db.all('SELECT * FROM org_members(?)', org),
    invoices: await db.all('SELECT * FROM invoices WHERE job_id = ? ORDER BY id DESC', id),
    invoicing: { enabled: stripe.enabledFor(org), testMode: stripe.testMode(), key: crypto.randomUUID() },
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
  }));
}

async function saveEstimate(db, org, estimateId, values, clean) {
  let clientId = Number(values.client_id);
  if (clean.newClient) {
    const c = clean.newClient;
    clientId = (await db.run('INSERT INTO clients (org_id, name, phone, email, address) VALUES (?, ?, ?, ?, ?) RETURNING id',
      org, c.name, c.phone, c.email, c.address)).id;
  }
  if (estimateId) {
    await db.run(`UPDATE estimates SET client_id = ?, project_name = ?, scope = ?, estimated_cost_cents = ?, status = ?, updated_at = now()
      WHERE id = ? AND org_id = ?`, clientId, clean.projectName, clean.scope, clean.cost, clean.status, estimateId, org);
    await db.run('DELETE FROM line_items WHERE estimate_id = ?', estimateId);
  } else {
    estimateId = (await db.run(`INSERT INTO estimates (org_id, client_id, project_name, scope, estimated_cost_cents, status)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, org, clientId, clean.projectName, clean.scope, clean.cost, clean.status)).id;
  }
  for (const [i, it] of clean.items.entries()) {
    await db.run(`INSERT INTO line_items (org_id, estimate_id, position, description, qty_hundredths, unit_price_cents)
      VALUES (?, ?, ?, ?, ?, ?)`, org, estimateId, i, it.desc, it.qty, it.price);
  }
  return estimateId;
}

// ---------- routes ----------
// Each handler gets ctx = { req, url, id, db, user, org (current membership), orgs }.
// Routes are admin-only unless marked { worker: true }; the database enforces the same split.
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d{1,15})').replace(/:uid/g, '([0-9a-f-]{36})') + '$'), handler, uid: pattern.includes(':uid'), ...opts });

route('GET', '/', async (ctx) => {
  if (ctx.org.role !== 'admin') return schedule(ctx);
  const { db, org, url } = ctx;
  const o = org.org_id;
  const openEstimates = await db.all(`${ESTIMATE_LIST_SQL} WHERE estimates.org_id = ? AND (estimates.status IN ('draft', 'sent')
    OR (estimates.status = 'approved' AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.estimate_id = estimates.id)))
    ORDER BY estimates.updated_at DESC`, o);
  const activeJobs = (await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? AND jobs.status IN ('not_started', 'in_progress')
    ORDER BY jobs.start_date NULLS LAST, jobs.id`, o)).map(withJobMath);
  const allJobs = (await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ?`, o)).map(withJobMath);
  const outstandingCents = allJobs.reduce((s, j) => s + Math.max(0, j.balance_cents), 0);
  // Revenue this month = payments dated in the current calendar month (APP_TIMEZONE).
  // Growth compares it with the same days of last month (1st through today's day number), so early-month numbers are fair.
  // Gross profit this month = contract - expenses - payouts of jobs completed this month.
  const m = await db.get(`WITH d AS (SELECT (now() AT TIME ZONE ?)::date AS today),
      m AS (SELECT today, date_trunc('month', today)::date AS start, (date_trunc('month', today) - interval '1 month')::date AS prev FROM d)
    SELECT to_char(m.start, 'FMMonth YYYY') AS label, to_char(m.prev, 'FMMonth') AS prev_label,
      (SELECT coalesce(sum(amount_cents), 0) FROM payments WHERE org_id = ? AND paid_on >= m.start AND paid_on <= m.today) AS revenue,
      (SELECT coalesce(sum(amount_cents), 0) FROM payments WHERE org_id = ? AND paid_on >= m.prev
        AND paid_on <= least(m.prev + (m.today - m.start), m.start - 1)) AS prev_revenue,
      (SELECT count(*) FROM jobs WHERE org_id = ? AND status = 'completed'
        AND (completed_at AT TIME ZONE ?)::date >= m.start AND (completed_at AT TIME ZONE ?)::date <= m.today) AS completed_jobs,
      (SELECT coalesce(sum(t.contract_cents - t.expenses_cents - t.payouts_cents), 0) FROM job_totals t JOIN jobs j ON j.id = t.job_id
        WHERE j.org_id = ? AND j.status = 'completed'
        AND (j.completed_at AT TIME ZONE ?)::date >= m.start AND (j.completed_at AT TIME ZONE ?)::date <= m.today) AS profit
    FROM m`, APP_TIMEZONE, o, o, o, APP_TIMEZONE, APP_TIMEZONE, o, APP_TIMEZONE, APP_TIMEZONE);
  const month = { label: m.label, prevLabel: `same days of ${m.prev_label}`, revenueCents: m.revenue, prevCents: m.prev_revenue,
    completedJobs: Number(m.completed_jobs), profitCents: m.profit };
  return ok(v.homePage({ openEstimates, activeJobs, outstandingCents, month, flash: url.searchParams.get('msg') }));
}, { worker: true });

// Clients
route('GET', '/clients', async ({ db, org, url }) => {
  const q = str(url.searchParams.get('q'), 200);
  const clients = q
    ? await db.all("SELECT * FROM clients WHERE org_id = ? AND name ILIKE ? ESCAPE '\\' ORDER BY lower(name)",
      org.org_id, `%${q.replace(/[\\%_]/g, '\\$&')}%`)
    : await db.all('SELECT * FROM clients WHERE org_id = ? ORDER BY lower(name)', org.org_id);
  return ok(v.clientsPage({ clients, q }));
});
route('GET', '/clients/new', () => ok(v.clientFormPage({ values: {} })));
route('POST', '/clients', async ({ db, org, form }) => {
  const { values, errors, clean } = validateClient(formObj(form));
  if (hasErrors(errors)) return page(422, v.clientFormPage({ values, errors }));
  const r = await attempt(db, () => db.run('INSERT INTO clients (org_id, name, phone, email, address) VALUES (?, ?, ?, ?, ?) RETURNING id',
    org.org_id, clean.name, clean.phone, clean.email, clean.address));
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
  if (hasErrors(errors)) return page(422, v.clientFormPage({ client, values, errors }));
  const r = await attempt(db, () => db.run('UPDATE clients SET name = ?, phone = ?, email = ?, address = ?, updated_at = now() WHERE id = ?',
    clean.name, clean.phone, clean.email, clean.address, id));
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
  const values = { status: 'draft', client_id: cid && clients.some((c) => String(c.id) === cid) ? cid : (clients.length ? '' : 'new') };
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
  if (await jobFor(db, id)) return renderEstimate(db, org.org_id, id, { errors: lockedMsg }, 409);
  const items = (await db.all('SELECT * FROM line_items WHERE estimate_id = ? ORDER BY position', id))
    .map((i) => ({ desc: i.description, qty: fmtQty(i.qty_hundredths), price: plain(i.unit_price_cents) }));
  const values = {
    client_id: String(e.client_id), project_name: e.project_name, scope: e.scope, status: e.status,
    estimated_cost: e.estimated_cost_cents == null ? '' : plain(e.estimated_cost_cents),
  };
  return ok(v.estimateFormPage({ estimate: e, values, items, clients: await clientsForSelect(db, org.org_id) }));
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
  await db.run('UPDATE estimates SET status = ?, updated_at = now() WHERE id = ?', status, id);
  return redirect(`/estimates/${id}?msg=Status+updated`);
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
  const dayJobs = (await db.all(`${JOB_LIST_SQL} WHERE jobs.org_id = ? AND jobs.start_date <= ?::date
    AND coalesce(jobs.end_date, jobs.start_date) >= ?::date ORDER BY jobs.start_date, jobs.id`, org.org_id, day, day)).map(withJobMath);
  return ok(v.jobsPage({ jobs, status, cal: { month, day, today, byDay, dayJobs } }));
});
route('GET', '/jobs/:id', ({ db, org, id, url }) => renderJob(db, org.org_id, id, { flash: url.searchParams.get('msg') }));
route('POST', '/jobs/:id', async ({ db, org, id, form }) => {
  const f = formObj(form);
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const values = { status: f.status, start_date: str(f.start_date, 20), end_date: str(f.end_date, 20), notes: f.notes ?? '' };
  const errors = {};
  if (!v.JOB_STATUS[values.status]) errors.status = 'Choose a valid job status.';
  if (values.start_date && !isDate(values.start_date)) errors.start_date = 'Start date must be a valid date.';
  if (values.end_date && !isDate(values.end_date)) errors.end_date = 'End date must be a valid date.';
  if (!hasErrors(errors) && values.start_date && values.end_date && values.end_date < values.start_date) {
    errors.end_date = 'End date can\'t be before the start date.';
  }
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { job: { values, errors } } }, 422);
  const r = await attempt(db, () => db.run('UPDATE jobs SET status = ?, start_date = ?, end_date = ?, notes = ?, updated_at = now() WHERE id = ?',
    values.status, values.start_date || null, values.end_date || null, str(values.notes, 10000), id));
  if (r.error) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { job: { values, errors: SAVE_FAILED } } }, 500); }
  return redirect(`/jobs/${id}?msg=Job+saved`);
});
route('POST', '/jobs/:id/expenses', async ({ db, org, id, form }) => {
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const { values, errors, clean } = validateExpense(formObj(form));
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { expense: { values, errors } } }, 422);
  const r = await attempt(db, () => db.run('INSERT INTO expenses (org_id, job_id, description, amount_cents) VALUES (?, ?, ?, ?)',
    org.org_id, id, clean.description, clean.amount));
  if (r.error) { console.error(r.error); return renderJob(db, org.org_id, id, { forms: { expense: { values, errors: SAVE_FAILED } } }, 500); }
  return redirect(`/jobs/${id}?msg=Expense+added`);
});
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
  if (!stripe.enabledFor(org.org_id)) return renderJob(db, org.org_id, id, { forms: { invoice: { values: {}, errors: { invoice_amount: 'Online invoicing is not set up for this company.' } } } }, 409);
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
    const customerId = await stripe.ensureCustomer(client, values.invoice_email, org.org_id);
    if (customerId !== client.stripe_customer_id) await db.run('UPDATE clients SET stripe_customer_id = ? WHERE id = ?', customerId, client.id);
    inv = await stripe.sendInvoice({ customerId, amountCents: amt.value, description, daysUntilDue: days,
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
  if (inv.status !== 'open' || !stripe.enabledFor(org.org_id)) return redirect(`/jobs/${inv.job_id}`);
  try { await fn(inv); } catch (e) {
    console.error('Stripe action failed:', e.message);
    return renderJob(db, org.org_id, inv.job_id, { forms: { invoice: { values: {}, errors: { invoice_amount: `Stripe error: ${e.message}` } } } }, 502);
  }
  return redirect(`/jobs/${inv.job_id}?msg=${msg}`);
}
route('POST', '/invoices/:id/resend', ({ db, org, id }) => invoiceAction(db, org, id, (inv) => stripe.resendInvoice(inv.stripe_invoice_id), 'Invoice+sent+again'));
route('POST', '/invoices/:id/void', ({ db, org, id }) => invoiceAction(db, org, id, async (inv) => {
  await stripe.voidInvoice(inv.stripe_invoice_id);
  await db.run("UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
}, 'Invoice+voided'));

route('POST', '/jobs/:id/assignments', async ({ db, org, id, form }) => {
  if (!(await db.get('SELECT id FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id))) return notFound();
  const values = { user_id: str(form.get('user_id'), 64), payout: form.get('payout') ?? '' };
  const errors = {};
  if (!UUID_RE.test(values.user_id)) errors.user_id = 'Choose who to assign.';
  const amt = parseMoney(values.payout, 'Payout');
  if (amt.error) errors.payout = amt.error;
  if (hasErrors(errors)) return renderJob(db, org.org_id, id, { forms: { assign: { values, errors } } }, 422);
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

// Expense / payment correction and deletion
for (const kind of ['expenses', 'payments']) {
  const load = async (db, org, id) => {
    const entry = await db.get(`SELECT * FROM ${kind} WHERE id = ? AND org_id = ?`, id, org.org_id);
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
    if (kind === 'expenses') ({ values, errors, clean } = validateExpense(f));
    else { values = { amount: f.amount ?? '', paid_on: f.paid_on ?? '' }; ({ errors, clean } = validatePayment(values.amount, values.paid_on)); }
    if (hasErrors(errors)) return page(422, v.entryFormPage({ kind, ...found, values, errors }));
    const r = await attempt(db, () => (kind === 'expenses'
      ? db.run('UPDATE expenses SET description = ?, amount_cents = ? WHERE id = ?', clean.description, clean.amount, id)
      : db.run('UPDATE payments SET amount_cents = ?, paid_on = ? WHERE id = ?', clean.amount, clean.paidOn, id)));
    if (r.error) { console.error(r.error); return page(500, v.entryFormPage({ kind, ...found, values, errors: SAVE_FAILED })); }
    return redirect(`/jobs/${found.job.id}?msg=Entry+updated`);
  });
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

// Worker schedule (admins can open it too)
async function schedule({ db, org, url }) {
  return ok(v.schedulePage({ jobs: await db.all('SELECT * FROM worker_schedule(?)', org.org_id), flash: url.searchParams.get('msg') }));
}
route('GET', '/schedule', schedule, { worker: true });
route('GET', '/schedule/:id', async ({ db, org, id }) => {
  const job = await db.get('SELECT * FROM worker_schedule(?) WHERE job_id = ?', org.org_id, id);
  return job ? ok(v.scheduleJobPage({ job })) : notFound();
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
  const members = await db.all(`SELECT m.*,
      (SELECT count(*)::int FROM job_assignments a WHERE a.org_id = ? AND a.user_id = m.user_id) AS job_count,
      (SELECT coalesce(sum(a.payout_cents), 0) FROM job_assignments a JOIN jobs j ON j.id = a.job_id
        WHERE a.org_id = ? AND a.user_id = m.user_id AND j.status = 'completed') AS earned_cents
    FROM org_members(?) m`, org.org_id, org.org_id, org.org_id);
  const joinCode = org.role === 'admin' ? (await db.get('SELECT org_join_code(?) AS code', org.org_id)).code : null;
  return page(status, v.teamPage({ org, members, me: user.id, joinCode, ...extra }));
}
route('GET', '/team', ({ db, org, user, url }) => renderTeam(db, org, user, { flash: url.searchParams.get('msg') }));
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
      clients.name AS client_name, a.payout_cents
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
  return ok(v.memberPage({ org, member, me: user.id, jobs, totals, flash: url.searchParams.get('msg') }));
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
route('GET', '/settings', async ({ db, org, url }) => {
  const c = await companyFor(db, org);
  return ok(v.settingsPage({ org, values: c, hasLogo: !!c.logo, flash: url.searchParams.get('msg'),
    payments: { enabled: stripe.enabledFor(org.org_id), configured: stripe.configured(), testMode: stripe.testMode() } }));
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
  });
  return pdfResponse(buf, `Estimate E-${id} ${estimate.project_name}`);
});
route('GET', '/jobs/:id/work-order', async ({ db, org, id, url }) => {
  const job = await db.get('SELECT * FROM jobs WHERE id = ? AND org_id = ?', id, org.org_id);
  if (!job) return notFound();
  const who = url.searchParams.get('user_id');
  let assignee = null;
  if (who) {
    assignee = /^[0-9a-f-]{36}$/.test(who) ? await db.get('SELECT * FROM job_team(?) WHERE user_id = ?::uuid', id, who) : null;
    if (!assignee) return notFound();
  }
  const buf = await pdf.workOrderPdf({ company: await companyFor(db, org), job, assignee,
    client: await db.get('SELECT * FROM clients WHERE id = ?', job.client_id) });
  return pdfResponse(buf, `Work order WO-${id} ${job.project_name}`);
});

// Joining or creating a company, and the account page (these work before the user belongs to one)
const ORG_ROUTES = new Set(['/welcome', '/org/new', '/org/join', '/org/switch', '/account']);
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
route('GET', '/account', ({ user, org, orgs, url }) => ok(v.accountPage({ user, org, orgs, flash: url.searchParams.get('msg') })), { worker: true });

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
  if (url.pathname === '/signup') {
    if (req.method === 'GET') return ok(v.signupPage());
    const f = formObj(await readBody(req));
    const values = { email: str(f.email, 200) };
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address.';
    if ((f.password || '').length < 8) errors.password = 'Password must be at least 8 characters.';
    if (hasErrors(errors)) return page(422, v.signupPage({ values, errors }));
    const r = await auth.signUp(values.email, f.password);
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
  const orgId = obj.metadata?.org_id; const jobId = Number(obj.metadata?.job_id);
  const ack = { status: 200, body: '{"received":true}', headers: { 'Content-Type': 'application/json' } };
  if (orgId !== stripe.ORG_ID || !Number.isInteger(jobId)) return ack; // not one of ours
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
        to_regclass('public.invoices') IS NOT NULL AS invoices`);
      if (!r.rows[0].payouts) throw new Error('Run supabase/migrations/0003_payouts.sql in the Supabase SQL Editor.');
      if (!r.rows[0].join_codes) throw new Error('Run supabase/migrations/0004_join_codes_and_job_dates.sql in the Supabase SQL Editor.');
      if (!r.rows[0].profiles) throw new Error('Run supabase/migrations/0005_company_profile_and_completion.sql in the Supabase SQL Editor.');
      if (!r.rows[0].invoices) throw new Error('Run supabase/migrations/0006_invoices.sql in the Supabase SQL Editor.');
    }),
    auth: await check(async () => { if ((await auth.getUser('not-a-real-token')) !== null) throw new Error('unexpected'); }),
  };
  let target = 'unparseable';
  try { const u = new URL(process.env.DATABASE_URL); target = `${u.hostname}:${u.port || 5432} as ${decodeURIComponent(u.username)}`; } catch {}
  const healthy = Object.values(result).every((x) => x === 'ok');
  result.database_target = target; // host, port and user only; never the password
  return { status: healthy ? 200 : 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const cookies = parseCookies(req);

  if (url.pathname === '/stripe/webhook' && req.method === 'POST') return stripeWebhook(req);

  // Reject cross-site form posts (defence in depth on top of SameSite cookies).
  if (req.method === 'POST' && req.headers.origin) {
    let host = null;
    try { host = new URL(req.headers.origin).host; } catch {}
    if (host !== req.headers.host) return page(403, v.messagePage('Forbidden', 'Cross-site request blocked.'));
  }

  if (['/login', '/signup'].includes(url.pathname) && ['GET', 'POST'].includes(req.method)) return publicRoute(req, url);
  if (url.pathname === '/healthz' && req.method === 'GET') return health();
  if (url.pathname.startsWith('/static/') && req.method === 'GET') return staticFile(url.pathname.slice(8)) || page(404, 'Not found');

  const { user, setCookies = [] } = await currentUser(cookies);
  if (!user) {
    if (req.method === 'GET') return redirect('/login', { 'Set-Cookie': clearCookies });
    return page(401, v.messagePage('Logged out', 'Your session has ended. Please log in again.'), { 'Set-Cookie': clearCookies });
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    await auth.signOut(cookies.sa);
    return redirect('/login', { 'Set-Cookie': clearCookies });
  }

  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return notFound();
  const form = req.method === 'POST' ? await readBody(req) : null;
  const m = url.pathname.match(r.re);

  const result = await asUser(user.id, async (db) => {
    const orgs = await db.all(`SELECT m.org_id, m.role, o.name FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY o.name`, user.id);
    const org = orgs.find((o) => o.org_id === cookies.org) || orgs[0] || null;
    if (!org && !ORG_ROUTES.has(url.pathname)) return { ...redirect('/welcome'), nav: { user, org, orgs } };
    if (org && org.role !== 'admin' && !r.worker) return { ...notFound(), nav: { user, org, orgs } };
    const out = await r.handler({ req, url, form, db, user, org, orgs, id: m[1] && !r.uid ? Number(m[1]) : undefined, uid: r.uid ? m[1] : undefined });
    return { ...out, nav: { user, org, orgs }, path: url.pathname };
  });
  const existing = [].concat(result.headers?.['Set-Cookie'] || []);
  return { ...result, headers: { ...result.headers, 'Set-Cookie': [...setCookies, ...existing] } };
}

function respond(res, out) {
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
  }
  res.writeHead(out.status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  handle(req, res).then((out) => respond(res, out)).catch((e) => {
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
  server.listen(PORT, () => console.log(`Vista Artisans running on http://localhost:${PORT}`));
}
module.exports = { server };
