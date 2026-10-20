'use strict';
// A small stand-in for Intuit's OAuth and the QuickBooks Online accounting API calls the app uses, for tests.
const http = require('node:http');

function startFakeQuickbooks(clientId, clientSecret) {
  const state = { codes: new Map(), tokens: new Set(), refresh: new Set(), revoked: [], requests: [],
    items: [], accounts: [{ Id: '79', Name: 'Sales', AccountType: 'Income' }], customers: [], invoices: [], payments: [] };
  let n = 100;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const fault = (status, code, msg) => send(status, { Fault: { Error: [{ Message: msg, Detail: msg, code }], type: 'ValidationFault' } });
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    state.requests.push(`${req.method} ${p}`);
    const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    if (p === '/token') {
      if (req.headers.authorization !== basic) return send(401, { error: 'invalid_client' });
      const f = Object.fromEntries(new URLSearchParams(raw));
      if (f.grant_type === 'authorization_code' && !state.codes.has(f.code)) return send(400, { error: 'invalid_grant' });
      if (f.grant_type === 'refresh_token' && !state.refresh.has(f.refresh_token)) return send(400, { error: 'invalid_grant' });
      state.codes.delete(f.code);
      const t = { access_token: `at_${++n}`, refresh_token: `rt_${++n}`, expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: 'bearer' };
      state.tokens.add(t.access_token); state.refresh.add(t.refresh_token);
      return send(200, t);
    }
    if (p === '/revoke') { state.revoked.push(JSON.parse(raw).token); return send(200, {}); }
    if (!state.tokens.has((req.headers.authorization || '').replace('Bearer ', ''))) return send(401, { fault: { error: [{ message: 'AuthenticationFailed', code: '3200' }] } });
    const m = p.match(/^\/v3\/company\/(\d+)\/(.+)$/);
    if (!m) return send(404, {});
    const [, realm, rest] = m;
    const body = raw ? JSON.parse(raw) : {};
    if (rest.startsWith('companyinfo/')) return send(200, { CompanyInfo: { CompanyName: `Books ${realm}` } });
    if (rest === 'query') {
      const q = u.searchParams.get('query');
      let mm;
      if ((mm = q.match(/from Item where Name = '(.+)'/))) return send(200, { QueryResponse: { Item: state.items.filter((i) => i.Name === mm[1]) } });
      if (/from Account where AccountType = 'Income'/.test(q)) return send(200, { QueryResponse: { Account: state.accounts.slice(0, 1) } });
      if ((mm = q.match(/from Customer where DisplayName = '(.+)'/))) {
        const name = mm[1].replace(/\\'/g, "'");
        return send(200, { QueryResponse: { Customer: state.customers.filter((c) => c.DisplayName === name) } });
      }
      return send(400, {});
    }
    if (rest === 'item') { const i = { ...body, Id: String(++n) }; state.items.push(i); return send(200, { Item: i }); }
    if (rest === 'customer') {
      if (state.customers.some((c) => c.DisplayName === body.DisplayName)) return fault(400, '6240', 'Duplicate Name Exists Error');
      const c = { ...body, Id: String(++n) }; state.customers.push(c); return send(200, { Customer: c });
    }
    if (rest === 'invoice') {
      if (!state.customers.some((c) => c.Id === body.CustomerRef.value)) return fault(400, '2500', 'Invalid Reference Id');
      for (const l of body.Line) {
        if (!state.items.some((i) => i.Id === l.SalesItemLineDetail.ItemRef.value)) return fault(400, '2500', 'Invalid item');
        const d = l.SalesItemLineDetail;
        if (d.Qty != null && Math.abs(d.Qty * d.UnitPrice - l.Amount) > 0.005) return fault(400, '6070', 'Amount is not equal to UnitPrice * Qty');
      }
      const total = Math.round(body.Line.reduce((t, l) => t + l.Amount, 0) * 100) / 100;
      const i = { ...body, Id: String(++n), TotalAmt: total, Balance: total }; state.invoices.push(i); return send(200, { Invoice: i });
    }
    if (rest === 'payment') {
      for (const l of body.Line) {
        const inv = state.invoices.find((i) => i.Id === l.LinkedTxn[0].TxnId);
        if (!inv) return fault(400, '2500', 'Invalid invoice');
        if (l.Amount > inv.Balance + 0.005) return fault(400, '6000', 'Payment is more than the invoice balance');
        inv.Balance = Math.round((inv.Balance - l.Amount) * 100) / 100;
      }
      const pm = { ...body, Id: String(++n) }; state.payments.push(pm); return send(200, { Payment: pm });
    }
    return send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, state, issueCode: (code) => state.codes.set(code, true), close: () => server.close(),
      env: { QBO_CLIENT_ID: clientId, QBO_CLIENT_SECRET: clientSecret, QBO_API_BASE: url, QBO_TOKEN_URL: `${url}/token`,
        QBO_REVOKE_URL: `${url}/revoke`, QBO_AUTH_URL: 'https://appcenter.intuit.test/connect/oauth2', QBO_SYNC_INTERVAL_MS: '3600000' } });
  }));
}

module.exports = { startFakeQuickbooks };
