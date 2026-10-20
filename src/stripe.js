'use strict';
// Minimal Stripe Connect client over Stripe's REST API (no SDK).
// The app's own Stripe account is the "platform" (STRIPE_SECRET_KEY). Each company links its own Stripe account
// through Stripe's hosted onboarding; invoices are created on that company's account (Stripe-Account header),
// so clients pay the company directly and the company pays Stripe's fees.
const crypto = require('node:crypto');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');

const configured = () => !!(KEY && WEBHOOK_SECRET);
const testMode = () => KEY.startsWith('sk_test_') || KEY.startsWith('rk_test_');

// Stripe takes form-encoded bodies with bracketed keys: metadata[job_id]=1
function encode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? encode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

class StripeError extends Error {}

async function call(method, path, params, { account, idempotencyKey } = {}) {
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(account ? { 'stripe-account': account } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: params && method !== 'GET' ? encode(params).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(data.error?.message || `Stripe returned ${res.status}`);
  return data;
}

// ---------- Connecting a company's Stripe account ----------
// A connected account the company fully owns: its own Stripe dashboard, it pays Stripe's fees and handles disputes.
async function createAccount({ orgId, name, email }) {
  return call('POST', '/accounts', {
    controller: { stripe_dashboard: { type: 'full' }, fees: { payer: 'account' }, losses: { payments: 'stripe' } },
    email: email || undefined,
    business_profile: { name },
    metadata: { org_id: orgId },
  });
  // No idempotency key here: Stripe replays a keyed request's first answer for 24 hours, errors included, so a retry
  // after fixing the Stripe setup would keep getting the old error. Duplicate accounts are prevented by the database row.
}
const getAccount = (id) => call('GET', `/accounts/${encodeURIComponent(id)}`);
// A one-time link to Stripe's hosted onboarding (it expires after a few minutes, so make one per click).
async function onboardingLink(accountId, baseUrl) {
  return (await call('POST', '/account_links', {
    account: accountId, type: 'account_onboarding',
    refresh_url: `${baseUrl}/settings/stripe/connect`, return_url: `${baseUrl}/settings/stripe/return`,
  })).url;
}

// ---------- Invoices (on the company's own account) ----------
// Creates the Stripe customer for a client once per Stripe account, and keeps its name and email current.
async function ensureCustomer(account, client, email, orgId) {
  const fields = { name: client.name, email, metadata: { client_id: client.id, org_id: orgId } };
  if (client.stripe_customer_id && client.stripe_customer_account === account) {
    return (await call('POST', `/customers/${encodeURIComponent(client.stripe_customer_id)}`, fields, { account })).id;
  }
  return (await call('POST', '/customers', fields, { account })).id;
}

// Creates, finalizes and emails an invoice. `key` makes a double-submitted form create only one invoice.
async function sendInvoice({ account, customerId, amountCents, description, daysUntilDue, jobId, orgId, key }) {
  const meta = { job_id: jobId, org_id: orgId };
  const opts = (step) => ({ account, idempotencyKey: `${key}-${step}` });
  const inv = await call('POST', '/invoices', {
    customer: customerId, collection_method: 'send_invoice', days_until_due: daysUntilDue, description,
    auto_advance: 'false', pending_invoice_items_behavior: 'exclude', metadata: meta,
  }, opts('invoice'));
  await call('POST', '/invoiceitems', {
    customer: customerId, invoice: inv.id, amount: amountCents, currency: 'usd', description, metadata: meta,
  }, opts('item'));
  const final = await call('POST', `/invoices/${inv.id}/finalize`, { auto_advance: 'true' }, opts('finalize'));
  await call('POST', `/invoices/${inv.id}/send`, {}, opts('send'));
  return final;
}

const resendInvoice = (account, id) => call('POST', `/invoices/${encodeURIComponent(id)}/send`, {}, { account });
const voidInvoice = (account, id) => call('POST', `/invoices/${encodeURIComponent(id)}/void`, {}, { account });

// Verifies the Stripe-Signature header (HMAC-SHA256 of "timestamp.body") and returns the event, or null.
function verifyEvent(rawBody, header, toleranceSeconds = 300) {
  if (!WEBHOOK_SECRET || !header) return null;
  let t = null; const sigs = [];
  for (const p of header.split(',')) {
    const [k, v] = p.split('=');
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length) return null;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return null;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

module.exports = {
  configured, testMode, createAccount, getAccount, onboardingLink,
  ensureCustomer, sendInvoice, resendInvoice, voidInvoice, verifyEvent, StripeError,
};
