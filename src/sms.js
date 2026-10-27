'use strict';
// Sends text messages through Twilio's REST API (no SDK). Keystone has one Twilio account; each company texts from
// its own registered Messaging Service (US carriers require every business to be registered, A2P 10DLC).
const crypto = require('node:crypto');

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const API = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
const MSG_API = (process.env.TWILIO_MESSAGING_API_BASE || process.env.TWILIO_API_BASE?.replace(/\/$/, '') || 'https://messaging.twilio.com').replace(/\/$/, '');

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

// One Twilio REST call. params: an object (arrays become repeated fields) sent form-encoded; GET/DELETE send none.
async function call(method, url, params) {
  if (!configured()) throw new SmsError('Texting is not set up.');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) for (const x of [].concat(v)) if (x != null && x !== '') body.append(k, String(x));
  const res = await fetch(url, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: params ? body.toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SmsError(data.message || `Twilio returned ${res.status}`, data.code);
  return data;
}
const account = (path) => `${API}/2010-04-01/Accounts/${encodeURIComponent(SID)}${path}`;
const messaging = (path) => `${MSG_API}/v1${path}`;

async function send({ messagingServiceSid, to, body }) {
  const data = await call('POST', account('/Messages.json'), { MessagingServiceSid: messagingServiceSid, To: to, Body: body });
  return data.sid || '';
}

// ---- Self-serve setup: each company gets its own toll-free number in its own Messaging Service, and Keystone files
// the number's carrier verification (toll-free verification) with the company's business details.
async function buyTollFreeNumber(friendlyName) {
  const found = await call('GET', account('/AvailablePhoneNumbers/US/TollFree.json?SmsEnabled=true&PageSize=1'));
  const pick = found.available_phone_numbers?.[0]?.phone_number;
  if (!pick) throw new SmsError('No toll-free numbers are available right now. Try again in a little while.');
  const n = await call('POST', account('/IncomingPhoneNumbers.json'), { PhoneNumber: pick, FriendlyName: friendlyName });
  return { sid: n.sid, phone: n.phone_number };
}
async function createService({ name, inboundUrl }) {
  const s = await call('POST', messaging('/Services'), { FriendlyName: name, InboundRequestUrl: inboundUrl, InboundMethod: 'POST', UseInboundWebhookOnNumber: 'false' });
  return s.sid;
}
const addNumberToService = (serviceSid, numberSid) => call('POST', messaging(`/Services/${encodeURIComponent(serviceSid)}/PhoneNumbers`), { PhoneNumberSid: numberSid });
const submitVerification = (fields) => call('POST', messaging('/Tollfree/Verifications'), fields);
const updateVerification = (sid, fields) => call('POST', messaging(`/Tollfree/Verifications/${encodeURIComponent(sid)}`), fields);
const deleteVerification = (sid) => call('DELETE', messaging(`/Tollfree/Verifications/${encodeURIComponent(sid)}`));
const getVerification = (sid) => call('GET', messaging(`/Tollfree/Verifications/${encodeURIComponent(sid)}`));
const releaseNumber = (sid) => call('DELETE', account(`/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`));
const deleteService = (sid) => call('DELETE', messaging(`/Services/${encodeURIComponent(sid)}`));
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

module.exports = { configured, send, e164, validSignature, keyword, SmsError, UNSUBSCRIBED,
  buyTollFreeNumber, createService, addNumberToService, submitVerification, updateVerification, deleteVerification, getVerification, releaseNumber, deleteService };
