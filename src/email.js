'use strict';
// Sends email through Resend's REST API (no SDK). One sending address for the whole app (EMAIL_FROM); each email
// shows the company's name as the sender and replies go to the company's own email address.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = (process.env.EMAIL_FROM || '').trim(); // e.g. estimates@keystonefsm.com
const API = (process.env.EMAIL_API_BASE || 'https://api.resend.com').replace(/\/$/, '');

const configured = () => !!(KEY && FROM);
const validEmail = (e) => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(String(e || ''));
// Display names can't carry quotes, angle brackets or line breaks.
const displayName = (name) => String(name || 'Keystone').replace(/["<>\r\n\\]/g, '').slice(0, 80).trim() || 'Keystone';

// attachments: [{ filename, content: Buffer }]
async function send({ fromName, to, replyTo, subject, html, text, attachments = [] }) {
  if (!configured()) throw new Error('Email is not set up.');
  const res = await fetch(`${API}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${displayName(fromName)} <${FROM}>`, to: [to], subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200),
      html, text, ...(validEmail(replyTo) ? { reply_to: replyTo } : {}),
      ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error?.message || `Email service returned ${res.status}`);
  return data.id || '';
}

module.exports = { configured, send, validEmail };
