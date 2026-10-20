'use strict';
// QuickBooks Online sync (no SDK). Each company links its own QuickBooks through Intuit's sign-in (OAuth 2).
// Keystone only pushes: clients become customers, jobs become invoices (one per job, for the contract total),
// and payments are applied to those invoices. Only jobs and payments dated on or after the company's
// "sync from" date are sent, so work already entered in QuickBooks isn't duplicated.
// The app's Intuit keys: QBO_CLIENT_ID and QBO_CLIENT_SECRET (Render environment only).
const { pool } = require('./db');

const CLIENT_ID = process.env.QBO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const SANDBOX = process.env.QBO_ENVIRONMENT === 'sandbox';
const API = (process.env.QBO_API_BASE || (SANDBOX ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com')).replace(/\/$/, '');
const TOKEN_URL = process.env.QBO_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = process.env.QBO_REVOKE_URL || 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const AUTH_URL = process.env.QBO_AUTH_URL || 'https://appcenter.intuit.com/connect/oauth2';
const MINOR = 75;
const ITEM_NAME = 'Keystone job';

const configured = () => !!(CLIENT_ID && CLIENT_SECRET);
const sandbox = () => SANDBOX;

class QboError extends Error {}

const authorizeUrl = (state, redirectUri) => `${AUTH_URL}?${new URLSearchParams({
  client_id: CLIENT_ID, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri, state })}`;

async function tokenCall(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new QboError(data.error_description || data.error || `QuickBooks sign-in failed (${res.status})`);
  return data;
}
const tokenRow = (t) => ({
  access_token: t.access_token, refresh_token: t.refresh_token,
  access_expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60_000),
  refresh_expires_at: t.x_refresh_token_expires_in ? new Date(Date.now() + Number(t.x_refresh_token_expires_in) * 1000) : null,
});

// After Intuit sends the person back: trade the code for tokens and save the connection.
async function connect(orgId, code, realmId, redirectUri, syncFrom) {
  const t = tokenRow(await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
  await pool.query(`INSERT INTO qbo_connections (org_id, realm_id, access_token, refresh_token, access_expires_at, refresh_expires_at, sync_from)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (org_id) DO UPDATE SET realm_id = excluded.realm_id, access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at,
      item_id = CASE WHEN qbo_connections.realm_id = excluded.realm_id THEN qbo_connections.item_id END,
      last_error = '', connected_at = now()`,
  [orgId, realmId, t.access_token, t.refresh_token, t.access_expires_at, t.refresh_expires_at, syncFrom]);
  const conn = await load(orgId);
  try {
    const info = await api(conn, 'GET', `companyinfo/${encodeURIComponent(realmId)}`);
    await pool.query('UPDATE qbo_connections SET company_name = $2 WHERE org_id = $1', [orgId, String(info.CompanyInfo?.CompanyName || '').slice(0, 200)]);
  } catch (e) { console.error('QuickBooks company info failed:', e.message); }
}

async function disconnect(orgId) {
  const conn = await load(orgId);
  if (!conn) return;
  try {
    await fetch(REVOKE_URL, { method: 'POST', body: JSON.stringify({ token: conn.refresh_token }),
      headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/json' } });
  } catch (e) { console.error('QuickBooks revoke failed:', e.message); }
  await pool.query('DELETE FROM qbo_connections WHERE org_id = $1', [orgId]);
}

const load = async (orgId) => (await pool.query('SELECT * FROM qbo_connections WHERE org_id = $1', [orgId])).rows[0];

async function freshToken(conn) {
  if (new Date(conn.access_expires_at) > new Date()) return conn.access_token;
  const t = tokenRow(await tokenCall({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }));
  await pool.query(`UPDATE qbo_connections SET access_token = $2, refresh_token = $3, access_expires_at = $4,
    refresh_expires_at = coalesce($5, refresh_expires_at) WHERE org_id = $1`,
  [conn.org_id, t.access_token, t.refresh_token, t.access_expires_at, t.refresh_expires_at]);
  Object.assign(conn, t);
  return t.access_token;
}

async function api(conn, method, path, body) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API}/v3/company/${encodeURIComponent(conn.realm_id)}/${path}${sep}minorversion=${MINOR}`, {
    method,
    headers: { authorization: `Bearer ${await freshToken(conn)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.Fault) {
    const err = data.Fault?.Error?.[0] || data.fault?.error?.[0] || {};
    const e = new QboError(err.Detail || err.Message || err.message || `QuickBooks returned ${res.status}`);
    e.code = String(err.code || res.status);
    throw e;
  }
  return data;
}
const query = async (conn, q) => (await api(conn, 'GET', `query?query=${encodeURIComponent(q)}`)).QueryResponse || {};
const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const money = (cents) => Math.round(Number(cents)) / 100;

async function link(conn, kind, localId, qboId) {
  await pool.query(`INSERT INTO qbo_links (org_id, realm_id, kind, local_id, qbo_id) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (org_id, realm_id, kind, local_id) DO UPDATE SET qbo_id = excluded.qbo_id, synced_at = now()`,
  [conn.org_id, conn.realm_id, kind, localId, String(qboId)]);
}
async function linked(conn, kind, localId) {
  return (await pool.query('SELECT qbo_id FROM qbo_links WHERE org_id = $1 AND realm_id = $2 AND kind = $3 AND local_id = $4',
    [conn.org_id, conn.realm_id, kind, localId])).rows[0]?.qbo_id;
}

// The service item every invoice line uses (made once, under the first income account).
async function ensureItem(conn) {
  if (conn.item_id) return conn.item_id;
  let item = (await query(conn, `select Id from Item where Name = '${ITEM_NAME}'`)).Item?.[0];
  if (!item) {
    const acct = (await query(conn, "select Id from Account where AccountType = 'Income' maxresults 1")).Account?.[0];
    if (!acct) throw new QboError('QuickBooks has no income account to record job revenue in. Add one in QuickBooks, then sync again.');
    item = (await api(conn, 'POST', 'item', { Name: ITEM_NAME, Type: 'Service', IncomeAccountRef: { value: acct.Id } })).Item;
  }
  await pool.query('UPDATE qbo_connections SET item_id = $2 WHERE org_id = $1', [conn.org_id, item.Id]);
  conn.item_id = item.Id;
  return item.Id;
}

async function ensureCustomer(conn, clientId) {
  const have = await linked(conn, 'client', clientId);
  if (have) return have;
  const c = (await pool.query('SELECT * FROM clients WHERE id = $1 AND org_id = $2', [clientId, conn.org_id])).rows[0];
  const name = c.name.slice(0, 100);
  let id;
  try {
    id = (await api(conn, 'POST', 'customer', {
      DisplayName: name,
      ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}),
      ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
      ...(c.address ? { BillAddr: { Line1: c.address.slice(0, 500) } } : {}),
    })).Customer.Id;
  } catch (e) {
    // Already a customer with that name in QuickBooks: use it.
    if (e.code !== '6240') throw e;
    id = (await query(conn, `select Id from Customer where DisplayName = '${quote(name)}'`)).Customer?.[0]?.Id;
    if (!id) throw e;
  }
  await link(conn, 'client', clientId, id);
  return id;
}

async function pushJob(conn, job) {
  const itemId = await ensureItem(conn);
  const customer = await ensureCustomer(conn, job.client_id);
  const items = (await pool.query(`SELECT li.description, li.qty_hundredths, li.unit_price_cents, li.line_total_cents
      FROM line_items li JOIN estimates e ON e.id = li.estimate_id
      WHERE li.estimate_id = $1 AND (li.option_name = '' OR li.option_name = coalesce(e.chosen_option,
        (SELECT l2.option_name FROM line_items l2 WHERE l2.estimate_id = $1 AND l2.option_name <> '' ORDER BY l2.position LIMIT 1)))
      ORDER BY li.position`, [job.estimate_id])).rows;
  const line = (description, amountCents, qty, unitCents) => ({
    DetailType: 'SalesItemLineDetail', Amount: money(amountCents), Description: description.slice(0, 4000),
    SalesItemLineDetail: { ItemRef: { value: itemId }, ...(qty != null ? { Qty: qty, UnitPrice: money(unitCents) } : {}) },
  });
  const sum = items.reduce((t, li) => t + Number(li.line_total_cents), 0);
  const lines = items.length && sum === Number(job.contract_cents)
    ? items.map((li) => (Math.round(li.qty_hundredths * li.unit_price_cents / 100) === Number(li.line_total_cents)
      ? line(li.description, li.line_total_cents, li.qty_hundredths / 100, li.unit_price_cents) : line(li.description, li.line_total_cents)))
    : [line(job.project_name, job.contract_cents)];
  const inv = (await api(conn, 'POST', 'invoice', {
    CustomerRef: { value: customer }, TxnDate: job.txn_date, Line: lines,
    PrivateNote: `Keystone job #${job.id}: ${job.project_name}`.slice(0, 4000),
    ...(job.address ? { ShipAddr: { Line1: job.address.slice(0, 500) } } : {}),
  })).Invoice;
  await link(conn, 'job', job.id, inv.Id);
}

async function pushPayment(conn, p) {
  const invoiceId = await linked(conn, 'job', p.job_id);
  const customer = await ensureCustomer(conn, p.client_id);
  const pay = (await api(conn, 'POST', 'payment', {
    CustomerRef: { value: customer }, TotalAmt: money(p.amount_cents), TxnDate: p.paid_on,
    Line: [{ Amount: money(p.amount_cents), LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }],
    PrivateNote: `Keystone payment #${p.id}${p.invoice_number ? ` (Stripe ${p.invoice_number})` : ''}`,
  })).Payment;
  await link(conn, 'payment', p.id, pay.Id);
}

// Sends everything new for one company. Jobs go once they're completed or paid on (from the sync-from date on);
// then every payment on a job that's in QuickBooks, so its balance there matches Keystone.
const running = new Set();
async function syncOrg(orgId) {
  if (running.has(orgId)) return { busy: true };
  running.add(orgId);
  const conn = await load(orgId);
  const sent = { jobs: 0, payments: 0 };
  try {
    if (!conn) return sent;
    const jobs = (await pool.query(`SELECT j.*, coalesce((j.completed_at AT TIME ZONE $3)::date,
          (SELECT min(paid_on) FROM payments p WHERE p.job_id = j.id))::text AS txn_date
        FROM jobs j WHERE j.org_id = $1
          AND (((j.completed_at AT TIME ZONE $3)::date >= $2 AND j.status = 'completed')
            OR EXISTS (SELECT 1 FROM payments p WHERE p.job_id = j.id AND p.paid_on >= $2))
          AND NOT EXISTS (SELECT 1 FROM qbo_links l WHERE l.org_id = j.org_id AND l.realm_id = $4 AND l.kind = 'job' AND l.local_id = j.id)
        ORDER BY j.id`, [orgId, conn.sync_from, process.env.APP_TIMEZONE || 'America/Los_Angeles', conn.realm_id])).rows;
    for (const j of jobs) { await pushJob(conn, j); sent.jobs++; }
    const payments = (await pool.query(`SELECT p.*, p.paid_on::text AS paid_on, j.client_id, i.number AS invoice_number
        FROM payments p JOIN jobs j ON j.id = p.job_id LEFT JOIN invoices i ON i.payment_id = p.id
        WHERE p.org_id = $1
          AND EXISTS (SELECT 1 FROM qbo_links l WHERE l.org_id = p.org_id AND l.realm_id = $2 AND l.kind = 'job' AND l.local_id = p.job_id)
          AND NOT EXISTS (SELECT 1 FROM qbo_links l WHERE l.org_id = p.org_id AND l.realm_id = $2 AND l.kind = 'payment' AND l.local_id = p.id)
        ORDER BY p.paid_on, p.id`, [orgId, conn.realm_id])).rows;
    for (const p of payments) { await pushPayment(conn, p); sent.payments++; }
    await pool.query("UPDATE qbo_connections SET last_synced_at = now(), last_error = '' WHERE org_id = $1", [orgId]);
  } catch (e) {
    console.error('QuickBooks sync failed:', e.message);
    const msg = /invalid_grant/i.test(e.message) ? 'QuickBooks sign-in expired. Disconnect and connect again.' : String(e.message).slice(0, 500);
    await pool.query('UPDATE qbo_connections SET last_error = $2 WHERE org_id = $1', [orgId, msg]);
    sent.error = msg;
  } finally {
    running.delete(orgId);
  }
  return sent;
}

async function syncAll() {
  if (!configured()) return;
  const orgs = (await pool.query('SELECT org_id FROM qbo_connections')).rows;
  for (const o of orgs) await syncOrg(o.org_id);
}
function startSync(intervalMs = Number(process.env.QBO_SYNC_INTERVAL_MS || 15 * 60_000)) {
  const tick = () => syncAll().catch((e) => console.error('QuickBooks sync loop failed:', e.message));
  setTimeout(tick, Math.min(60_000, intervalMs)).unref();
  setInterval(tick, intervalMs).unref();
}

module.exports = { configured, sandbox, authorizeUrl, connect, disconnect, syncOrg, syncAll, startSync, QboError };
