'use strict';
// A small stand-in for the parts of Stripe's API the app uses (Connect, invoices, and plan billing), for tests.
const http = require('node:http');

function startFakeStripe(secretKey) {
  const state = { accounts: new Map(), customers: new Map(), invoices: new Map(), sent: [], requests: 0,
    prices: new Map(), products: new Map(), coupons: new Map(), sessions: new Map(), subscriptions: new Map(), portalConfigs: [], portalSessions: [] };
  const idem = new Map();
  let n = 0;
  const id = (p) => `${p}_${++n}`;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${secretKey}`) return send(401, { error: { message: 'Invalid API Key provided' } });
    const key = req.headers['idempotency-key'];
    if (key && idem.has(key)) return send(200, idem.get(key));
    state.requests++;
    const done = (data) => { if (key) idem.set(key, data); send(200, data); };
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    const acct = req.headers['stripe-account'];
    let m;
    if (p === '/v1/accounts' && req.method === 'POST') {
      const a = { id: id('acct'), charges_enabled: false, details_submitted: false, email: form.email,
        controller_dashboard: form['controller[stripe_dashboard][type]'], fee_payer: form['controller[fees][payer]'], metadata: { org_id: form['metadata[org_id]'] } };
      state.accounts.set(a.id, a); return done(a);
    }
    if ((m = p.match(/^\/v1\/accounts\/([^/]+)$/))) {
      const a = state.accounts.get(m[1]); return a ? send(200, a) : send(404, { error: { message: 'No such account' } });
    }
    if (p === '/v1/account_links') {
      if (!state.accounts.has(form.account)) return send(400, { error: { message: 'No such account' } });
      return done({ url: `https://connect.stripe.test/setup/${form.account}?return=${encodeURIComponent(form.return_url)}`, return_url: form.return_url, refresh_url: form.refresh_url });
    }
    // ---- Plan billing, on the platform's own account (no Stripe-Account header) ----
    if (!acct) {
      if (p === '/v1/prices' && req.method === 'GET') {
        const keys = u.searchParams.getAll('lookup_keys[]');
        const data = [...state.prices.values()].filter((x) => keys.includes(x.lookup_key))
          .map((x) => (u.searchParams.getAll('expand[]').includes('data.product') ? { ...x, product: state.products.get(x.product) } : x));
        return send(200, { data });
      }
      if (p === '/v1/products') { const pr = { id: id('prod'), name: form.name, metadata: { vista_plan: form['metadata[vista_plan]'] } }; state.products.set(pr.id, pr); return done(pr); }
      if (p === '/v1/prices') {
        const pr = { id: id('price'), product: form.product, unit_amount: Number(form.unit_amount), lookup_key: form.lookup_key,
          recurring: { interval: form['recurring[interval]'] }, metadata: { vista_plan: form['metadata[vista_plan]'] } };
        state.prices.set(pr.id, pr); return done(pr);
      }
      if ((m = p.match(/^\/v1\/coupons\/([^/]+)$/))) { const c = state.coupons.get(m[1]); return c ? send(200, c) : send(404, { error: { message: 'No such coupon' } }); }
      if (p === '/v1/coupons') { const c = { id: form.id, percent_off: Number(form.percent_off), duration: form.duration }; state.coupons.set(c.id, c); return done(c); }
      if (p === '/v1/customers') { const c = { id: id('cus'), name: form.name, email: form.email, platform: true, metadata: { org_id: form['metadata[org_id]'] } }; state.customers.set(c.id, c); return done(c); }
      if (p === '/v1/checkout/sessions' && req.method === 'POST') {
        const cs = { id: id('cs'), mode: form.mode, customer: form.customer, client_reference_id: form.client_reference_id,
          price: form['line_items[0][price]'], coupon: form['discounts[0][coupon]'] || null, sub_meta_org: form['subscription_data[metadata][org_id]'],
          success_url: form.success_url, cancel_url: form.cancel_url, subscription: null };
        cs.url = `https://checkout.stripe.test/${cs.id}`;
        state.sessions.set(cs.id, cs); return done(cs);
      }
      if ((m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
        const cs = state.sessions.get(m[1]); if (!cs) return send(404, { error: { message: 'No such checkout session' } });
        return send(200, { ...cs, subscription: cs.subscription ? state.subscriptions.get(cs.subscription) : null });
      }
      if ((m = p.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
        const sub = state.subscriptions.get(m[1]); return sub ? send(200, sub) : send(404, { error: { message: 'No such subscription' } });
      }
      if (p === '/v1/billing_portal/configurations' && req.method === 'GET') return send(200, { data: state.portalConfigs });
      if (p === '/v1/billing_portal/configurations') { const c = { id: id('bpc'), metadata: { vista: form['metadata[vista]'] }, form }; state.portalConfigs.push(c); return done(c); }
      if (p === '/v1/billing_portal/sessions') {
        const ps = { id: id('bps'), customer: form.customer, configuration: form.configuration, url: `https://billing.stripe.test/${form.customer}` };
        state.portalSessions.push(ps); return done(ps);
      }
    }
    // Everything below happens on a connected account.
    if (!acct || !state.accounts.has(acct)) return send(400, { error: { message: 'Missing or unknown Stripe-Account header' } });
    if (p === '/v1/customers') { const c = { id: id('cus'), name: form.name, email: form.email, account: acct }; state.customers.set(c.id, c); return done(c); }
    if ((m = p.match(/^\/v1\/customers\/([^/]+)$/))) {
      const c = state.customers.get(m[1]); if (!c || c.account !== acct) return send(404, { error: { message: 'No such customer' } });
      Object.assign(c, { name: form.name, email: form.email }); return done(c);
    }
    if (p === '/v1/invoices') {
      if (state.customers.get(form.customer)?.account !== acct) return send(400, { error: { message: 'No such customer' } });
      const inv = { id: id('in'), account: acct, customer: form.customer, status: 'draft', amount_due: 0, description: form.description,
        metadata: { job_id: form['metadata[job_id]'], org_id: form['metadata[org_id]'] }, days_until_due: Number(form.days_until_due) };
      state.invoices.set(inv.id, inv); return done(inv);
    }
    if (p === '/v1/invoiceitems') {
      const inv = state.invoices.get(form.invoice);
      if (Number(form.amount) === 66600) return send(402, { error: { message: 'Your card was declined (test)' } });
      inv.amount_due += Number(form.amount); return done({ id: id('ii'), amount: Number(form.amount) });
    }
    if ((m = p.match(/^\/v1\/invoices\/([^/]+)\/(finalize|send|void)$/))) {
      const inv = state.invoices.get(m[1]); if (!inv || inv.account !== acct) return send(404, { error: { message: 'No such invoice' } });
      if (m[2] === 'finalize') Object.assign(inv, { status: 'open', number: `VA-${String(n).padStart(4, '0')}`,
        hosted_invoice_url: `https://invoice.stripe.test/${inv.id}`, invoice_pdf: `https://invoice.stripe.test/${inv.id}/pdf` });
      if (m[2] === 'send') state.sent.push(inv.id);
      if (m[2] === 'void') inv.status = 'void';
      return done(inv);
    }
    send(404, { error: { message: `Unrecognized request URL ${p}` } });
  });
  // What Stripe does when someone pays on the Checkout page: it creates the subscription.
  function completeCheckout(sessionId) {
    const cs = state.sessions.get(sessionId); const price = state.prices.get(cs.price);
    const sub = { id: id('sub'), object: 'subscription', customer: cs.customer, status: 'active', cancel_at_period_end: false,
      metadata: { org_id: cs.sub_meta_org }, items: { data: [{ price, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } };
    state.subscriptions.set(sub.id, sub); cs.subscription = sub.id;
    return sub;
  }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, state, completeCheckout, close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { startFakeStripe };
