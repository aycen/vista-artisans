'use strict';
// Minimal Stripe Connect client over Stripe's REST API (no SDK).
// The app's own Stripe account is the "platform" (STRIPE_SECRET_KEY). Each company links its own Stripe account
// through Stripe's hosted onboarding; invoices are created on that company's account (Stripe-Account header),
// so clients pay the company directly and the company pays Stripe's fees.
const crypto = require('node:crypto');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''; // Connect endpoint (events on connected accounts)
const BILLING_WEBHOOK_SECRET = process.env.STRIPE_BILLING_WEBHOOK_SECRET || ''; // endpoint for the app's own account (plans)
const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');

const configured = () => !!(KEY && WEBHOOK_SECRET);
const billingConfigured = () => !!(KEY && BILLING_WEBHOOK_SECRET);
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
    try {
      return (await call('POST', `/customers/${encodeURIComponent(client.stripe_customer_id)}`, fields, { account })).id;
    } catch (e) {
      if (!(e instanceof StripeError)) throw e; // deleted in Stripe: make a new one below
    }
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

// ---------- Subscription plans (on the app's own Stripe account) ----------
// Prices are found by lookup key and created on first use, so there is nothing to set up by hand in Stripe.
const PLANS = {
  team: { name: 'Keystone Team', month: 4900, year: 49900 },
  unlimited: { name: 'Keystone Unlimited', month: 9900, year: 100900 },
};
const FIRST_MONTH_COUPON = 'vista-first-month-50';
const lookupKey = (plan, interval) => `vista_${plan}_${interval}`;
const priceCache = new Map();

async function priceFor(plan, interval) {
  const key = lookupKey(plan, interval);
  if (priceCache.has(key)) return priceCache.get(key);
  const found = await call('GET', `/prices?active=true&lookup_keys[]=${encodeURIComponent(key)}&expand[]=data.product`);
  let price = found.data && found.data[0];
  // Products made before the app was renamed keep their old name until updated here.
  if (price && typeof price.product === 'object' && price.product.name !== PLANS[plan].name) {
    await call('POST', `/products/${encodeURIComponent(price.product.id)}`, { name: PLANS[plan].name }).catch(() => {});
  }
  if (!price) {
    // Reuse the plan's product if the other interval already made it.
    const other = (await call('GET', `/prices?active=true&lookup_keys[]=${encodeURIComponent(lookupKey(plan, interval === 'month' ? 'year' : 'month'))}`)).data?.[0];
    const product = other ? other.product : (await call('POST', '/products', { name: PLANS[plan].name, metadata: { vista_plan: plan } })).id;
    price = await call('POST', '/prices', {
      product, currency: 'usd', unit_amount: PLANS[plan][interval], recurring: { interval }, lookup_key: key,
      metadata: { vista_plan: plan },
    });
  }
  priceCache.set(key, price);
  return price;
}

async function firstMonthCoupon() {
  try { return (await call('GET', `/coupons/${FIRST_MONTH_COUPON}`)).id; } catch {
    return (await call('POST', '/coupons', { id: FIRST_MONTH_COUPON, percent_off: 50, duration: 'once', name: '50% off your first month' })).id;
  }
}

async function billingCustomer({ orgId, name, email }) {
  return (await call('POST', '/customers', { name, email: email || undefined, metadata: { org_id: orgId } })).id;
}

async function checkoutSession({ customerId, orgId, plan, interval, discount, baseUrl }) {
  const price = await priceFor(plan, interval);
  return call('POST', '/checkout/sessions', {
    mode: 'subscription', customer: customerId, client_reference_id: orgId,
    line_items: [{ price: price.id, quantity: 1 }],
    discounts: discount ? [{ coupon: await firstMonthCoupon() }] : undefined,
    allow_promotion_codes: discount ? undefined : 'true',
    subscription_data: { metadata: { org_id: orgId } },
    metadata: { org_id: orgId },
    success_url: `${baseUrl}/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/billing`,
  });
}
const getCheckoutSession = (id) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`);
const getSubscription = (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`);
const cancelSubscription = (id) => call('DELETE', `/subscriptions/${encodeURIComponent(id)}`);

// The customer portal lets admins change plan, update their card, see invoices and cancel.
let portalConfig = null;
async function portalSession(customerId, returnUrl) {
  if (!portalConfig) {
    const existing = (await call('GET', '/billing_portal/configurations?active=true&limit=100')).data
      ?.find((c) => c.metadata?.vista === 'v1');
    if (existing) {
      portalConfig = existing.id;
      if (existing.business_profile?.headline !== 'Manage your Keystone plan') {
        await call('POST', `/billing_portal/configurations/${encodeURIComponent(existing.id)}`,
          { business_profile: { headline: 'Manage your Keystone plan' } }).catch(() => {});
      }
    }
    else {
      const prices = await Promise.all(['team', 'unlimited'].flatMap((p) => ['month', 'year'].map((i) => priceFor(p, i))));
      const products = {};
      for (const pr of prices) {
        const pid = typeof pr.product === 'string' ? pr.product : pr.product.id;
        (products[pid] ||= []).push(pr.id);
      }
      portalConfig = (await call('POST', '/billing_portal/configurations', {
        business_profile: { headline: 'Manage your Keystone plan' },
        features: {
          customer_update: { enabled: 'true', allowed_updates: ['email', 'address'] },
          invoice_history: { enabled: 'true' },
          payment_method_update: { enabled: 'true' },
          subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
          subscription_update: { enabled: 'true', default_allowed_updates: ['price'], proration_behavior: 'create_prorations',
            products: Object.entries(products).map(([product, ps]) => ({ product, prices: ps })) },
        },
        metadata: { vista: 'v1' },
      })).id;
    }
  }
  return (await call('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl, configuration: portalConfig })).url;
}

// Reads plan details out of a Stripe subscription object.
function describeSubscription(sub) {
  const item = sub.items?.data?.[0] || {};
  const price = item.price || {};
  const plan = price.metadata?.vista_plan || (price.lookup_key || '').split('_')[1];
  const end = item.current_period_end || sub.current_period_end;
  return {
    plan: PLANS[plan] ? plan : 'free', interval: price.recurring?.interval || null, status: sub.status,
    periodEnd: end ? new Date(end * 1000).toISOString() : null, cancelAtEnd: !!sub.cancel_at_period_end,
  };
}

// Verifies the Stripe-Signature header (HMAC-SHA256 of "timestamp.body") and returns the event, or null.
function verifyEvent(rawBody, header, toleranceSeconds = 300) {
  const secrets = [WEBHOOK_SECRET, BILLING_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.length || !header) return null;
  let t = null; const sigs = [];
  for (const p of header.split(',')) {
    const [k, v] = p.split('=');
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length) return null;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return null;
  const ok = secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  });
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

module.exports = {
  configured, billingConfigured, testMode, PLANS, billingCustomer, checkoutSession, getCheckoutSession, getSubscription, cancelSubscription,
  portalSession, describeSubscription, createAccount, getAccount, onboardingLink,
  ensureCustomer, sendInvoice, resendInvoice, voidInvoice, verifyEvent, StripeError,
};
