'use strict';
// Sends text messages through Twilio's REST API (no SDK). Keystone has one Twilio account; each company texts from
// its own registered Messaging Service (US carriers require every business to be registered, A2P 10DLC).
const crypto = require('node:crypto');

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const API = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');

const configured = () => !!(SID && TOKEN);

// US and Canada numbers to E.164 (+15551234567); null when it isn't one.
function e164(phone) {
  const s = String(phone || '').trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+') && /^\d{8,15}$/.test(digits)) return `+${digits}`;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

class SmsError extends Error { constructor(message, code) { super(message); this.code = code; } }

async function send({ messagingServiceSid, to, body }) {
  if (!configured()) throw new SmsError('Texting is not set up.');
  const res = await fetch(`${API}/2010-04-01/Accounts/${encodeURIComponent(SID)}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessagingServiceSid: messagingServiceSid, To: to, Body: body }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SmsError(data.message || `Twilio returned ${res.status}`, data.code);
  return data.sid || '';
}
// Twilio's error when the person replied STOP to this sender.
const UNSUBSCRIBED = 21610;

// Twilio signs each webhook: HMAC-SHA1 of the full URL followed by every POST field (sorted by name) as name+value.
function validSignature(url, params, signature) {
  if (!TOKEN || !signature) return false;
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join('');
  const expected = crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Carrier keywords: Twilio already blocks texts after STOP and sends the confirmation; we record it on the client.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const keyword = (body) => {
  const w = String(body || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return STOP_WORDS.has(w) ? 'stop' : START_WORDS.has(w) ? 'start' : null;
};

module.exports = { configured, send, e164, validSignature, keyword, SmsError, UNSUBSCRIBED };
