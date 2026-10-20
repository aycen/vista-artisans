'use strict';
// A small stand-in for Supabase Auth's REST API (signup, password login, refresh, user, logout),
// so the app's real login code can be tested against a local Postgres. Users go into auth.users.
const http = require('node:http');
const crypto = require('node:crypto');

function startFakeAuth(pgClient, anonKey, serviceKey = 'test-service-key') {
  const recoveries = []; // { email, redirectTo, token } of reset emails "sent"
  const users = new Map(); // email -> { id, email, password }
  const access = new Map(); // token -> user
  const refresh = new Map(); // token -> user

  const session = (u) => {
    const a = crypto.randomBytes(24).toString('hex'); const r = crypto.randomBytes(24).toString('hex');
    access.set(a, u); refresh.set(r, u);
    return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: 3600, user: { id: u.id, email: u.email } };
  };

  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const url = new URL(req.url, 'http://x');
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const admin = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
    if (admin && req.method === 'DELETE') {
      if (req.headers.apikey !== serviceKey) return send(401, { message: 'Invalid API key' });
      if (!body.should_soft_delete) return send(400, { msg: 'expected a soft delete' });
      for (const [email, u] of users) if (u.id === admin[1]) users.delete(email);
      for (const m of [access, refresh]) for (const [k, u] of m) if (u.id === admin[1]) m.delete(k);
      await pgClient.query("UPDATE auth.users SET email = NULL WHERE id = $1", [admin[1]]);
      return send(200, {});
    }
    if (req.headers.apikey !== anonKey) return send(401, { message: 'Invalid API key' });
    if (url.pathname === '/auth/v1/recover') {
      const token = crypto.randomBytes(24).toString('hex');
      if (users.has(body.email)) { access.set(token, users.get(body.email)); recoveries.push({ email: body.email, redirectTo: url.searchParams.get('redirect_to'), token }); }
      return send(200, {});
    }
    if (url.pathname === '/auth/v1/user' && req.method === 'PUT') {
      const u = access.get(bearer);
      if (!u) return send(401, { msg: 'invalid JWT' });
      if (body.password) u.password = body.password;
      return send(200, { id: u.id, email: u.email });
    }

    if (url.pathname === '/auth/v1/signup') {
      if (users.has(body.email)) return send(422, { msg: 'User already registered' });
      const u = { id: crypto.randomUUID(), email: body.email, password: body.password, user_metadata: body.data || {} };
      await pgClient.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [u.id, u.email]);
      users.set(u.email, u);
      return send(200, session(u));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = users.get(body.email);
      if (!u || u.password !== body.password) return send(400, { error_description: 'Invalid login credentials' });
      return send(200, session(u));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const u = refresh.get(body.refresh_token);
      if (!u) return send(400, { error_description: 'Invalid Refresh Token' });
      refresh.delete(body.refresh_token);
      return send(200, session(u));
    }
    if (url.pathname === '/auth/v1/user') {
      const u = access.get(bearer);
      return u ? send(200, { id: u.id, email: u.email, user_metadata: u.user_metadata }) : send(401, { msg: 'invalid JWT' });
    }
    if (url.pathname === '/auth/v1/logout') {
      access.delete(bearer);
      return send(204, {});
    }
    send(404, { msg: 'not found' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    expireAccessTokens: () => access.clear(),
    recoveries,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeAuth };
