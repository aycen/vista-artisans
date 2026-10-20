'use strict';
// Minimal Stripe client over its REST API (no SDK): customers, invoices, and webhook signature checks.
// Turned on by STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET, and only for the company named in STRIPE_ORG_ID,
// because all money goes to that one Stripe account.
const crypto = require('node:crypto');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ORG_ID = process.env.STRIPE_ORG_ID || '';
const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');

const configured = () => !!(KEY && WEBHOOK_SECRET && ORG_ID);
const enabledFor = (orgId) => configured() && orgId === ORG_ID;
const testMode = () => KEY.startsWith('sk_test_') || KEY.startsWith('rk_test_');

// Stripe takes form-encoded bodies with bracketed keys: metadata[job_id]=1
function encode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out); else out.append(key, String(v));
  }
  return out;
}

class StripeError extends Error {}

async function call(method, path, params, idempotencyKey) {
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: params ? encode(params).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(data.error?.message || `Stripe returned ${res.status}`);
  return data;
}

// Creates the Stripe customer for a client once, and keeps its name and email current.
async function ensureCustomer(client, email, orgId) {
  const fields = { name: client.name, email, metadata: { client_id: client.id, org_id: orgId } };
  if (client.stripe_customer_id) return (await call('POST', `/customers/${encodeURIComponent(client.stripe_customer_id)}`, fields)).id;
  return (await call('POST', '/customers', fields)).id;
}

// Creates, finalizes and emails an invoice. `key` makes a double-submitted form create only one invoice.
async function sendInvoice({ customerId, amountCents, description, daysUntilDue, jobId, orgId, key }) {
  const meta = { job_id: jobId, org_id: orgId };
  const inv = await call('POST', '/invoices', {
    customer: customerId, collection_method: 'send_invoice', days_until_due: daysUntilDue, description,
    auto_advance: 'false', pending_invoice_items_behavior: 'exclude', metadata: meta,
  }, `${key}-invoice`);
  await call('POST', '/invoiceitems', {
    customer: customerId, invoice: inv.id, amount: amountCents, currency: 'usd', description, metadata: meta,
  }, `${key}-item`);
  const final = await call('POST', `/invoices/${inv.id}/finalize`, { auto_advance: 'true' }, `${key}-finalize`);
  await call('POST', `/invoices/${inv.id}/send`, {}, `${key}-send`);
  return final;
}

const resendInvoice = (id) => call('POST', `/invoices/${encodeURIComponent(id)}/send`, {});
const voidInvoice = (id) => call('POST', `/invoices/${encodeURIComponent(id)}/void`, {});

// Verifies the Stripe-Signature header (HMAC-SHA256 of "timestamp.body") and returns the event, or null.
function verifyEvent(rawBody, header, toleranceSeconds = 300) {
  if (!WEBHOOK_SECRET || !header) return null;
  const parts = {};
  const sigs = [];
  for (const p of header.split(',')) {
    const [k, v] = p.split('=');
    if (k === 't') parts.t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!parts.t || !sigs.length) return null;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSeconds) return null;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${parts.t}.${rawBody}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

module.exports = { configured, enabledFor, testMode, ensureCustomer, sendInvoice, resendInvoice, voidInvoice, verifyEvent, StripeError, ORG_ID };
