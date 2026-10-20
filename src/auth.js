'use strict';
// Supabase Auth over its REST API (email + password). Tokens live in HttpOnly cookies.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set. See README.md.');
  process.exit(1);
}

async function call(path, { method = 'POST', body, token } = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    // New-style publishable keys (sb_publishable_...) go only in the apikey header, never as a Bearer token.
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const message = (data, fallback) => data.msg || data.error_description || data.message || fallback;

async function signIn(email, password) {
  const r = await call('/token?grant_type=password', { body: { email, password } });
  if (!r.ok) return { error: r.status === 400 ? 'Incorrect email or password, or the email is not confirmed yet.' : message(r.data, 'Could not log in.') };
  return { session: r.data };
}

// `profile` (optional name, phone, address) is kept on the Supabase user until the app saves it on first login.
async function signUp(email, password, profile = {}) {
  const r = await call('/signup', { body: { email, password, data: { vista_profile: profile } } });
  if (!r.ok) return { error: message(r.data, 'Could not create the account.') };
  // With email confirmation on, Supabase returns the user but no session.
  return { session: r.data.access_token ? r.data : null };
}

async function refresh(refreshToken) {
  const r = await call('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
  return r.ok ? r.data : null;
}

// Short cache so every page view doesn't round-trip to Supabase.
const cache = new Map();
async function getUser(accessToken) {
  const hit = cache.get(accessToken);
  if (hit && hit.until > Date.now()) return hit.user;
  const r = await call('/user', { method: 'GET', token: accessToken });
  const user = r.ok && r.data.id ? { id: r.data.id, email: r.data.email, signupProfile: r.data.user_metadata?.vista_profile || null } : null;
  if (cache.size > 1000) cache.clear();
  if (user) cache.set(accessToken, { user, until: Date.now() + 60_000 });
  return user;
}

async function signOut(accessToken) {
  cache.delete(accessToken);
  await call('/logout', { token: accessToken }).catch(() => {});
}

module.exports = { signIn, signUp, refresh, getUser, signOut };
