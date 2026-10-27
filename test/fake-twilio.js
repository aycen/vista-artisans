'use strict';
// A stand-in for Twilio's send-message, phone number, Messaging Service and toll-free verification endpoints, for tests. Numbers ending in 9999 have replied STOP (error 21610).
const http = require('node:http');

function startFakeTwilio(sid, token) {
  const sent = []; const calls = []; const numbers = new Map(); const services = new Map(); const verifications = new Map(); const state = {};
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`) return send(401, { code: 20003, message: 'Authenticate' });
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    const acct = `/2010-04-01/Accounts/${sid}`;
    const path = req.url.split('?')[0];
    calls.push(`${req.method} ${path}`);
    // Self-serve setup: toll-free numbers, Messaging Services, toll-free verifications
    if (req.method === 'GET' && path === `${acct}/AvailablePhoneNumbers/US/TollFree.json`) return send(200, { available_phone_numbers: [{ phone_number: `+1833555${String(1000 + numbers.size).slice(-4)}` }] });
    if (req.method === 'POST' && path === `${acct}/IncomingPhoneNumbers.json`) {
      const n = { sid: `PN${String(numbers.size + 1).padStart(32, '0')}`, phone_number: params.get('PhoneNumber') };
      numbers.set(n.sid, n); return send(201, n);
    }
    let m;
    if (req.method === 'DELETE' && (m = new RegExp(`^${acct}/IncomingPhoneNumbers/(PN\\w+)\\.json$`).exec(path))) { numbers.delete(m[1]); res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && path === '/v1/Services') {
      const svc = { sid: `MG${String(services.size + 1).padStart(32, '0')}`, inbound: params.get('InboundRequestUrl'), numbers: [] };
      services.set(svc.sid, svc); return send(201, svc);
    }
    if (req.method === 'POST' && (m = /^\/v1\/Services\/(MG\w+)\/PhoneNumbers$/.exec(path))) { services.get(m[1]).numbers.push(params.get('PhoneNumberSid')); return send(201, { sid: params.get('PhoneNumberSid') }); }
    if (req.method === 'DELETE' && (m = /^\/v1\/Services\/(MG\w+)$/.exec(path))) { services.delete(m[1]); res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && path === '/v1/Tollfree/Verifications') {
      if (state.failVerification) return send(400, { code: 21600, message: state.failVerification });
      if (state.deleting > 0) { state.deleting--; return send(409, { code: 20409, message: 'A verification delete is in progress and must complete before a new verification can be created. Try again in a few seconds.' }); }
      const v = { sid: `HH${String(verifications.size + 1).padStart(32, '0')}`, status: 'PENDING_REVIEW', fields: params, edits: 0 };
      verifications.set(v.sid, v); return send(201, { sid: v.sid, status: v.status });
    }
    if ((m = /^\/v1\/Tollfree\/Verifications\/(HH\w+)$/.exec(path))) {
      const v = verifications.get(m[1]);
      if (!v) return send(404, { message: 'Not found' });
      if (req.method === 'GET') return send(200, { sid: v.sid, status: v.status, rejection_reasons: v.reasons || [], edit_allowed: !!v.editAllowed });
      if (req.method === 'POST') { v.fields = params; v.edits++; v.status = 'PENDING_REVIEW'; return send(200, { sid: v.sid, status: v.status }); }
      if (req.method === 'DELETE') { verifications.delete(v.sid); res.writeHead(204); return res.end(); }
    }
    if (req.method !== 'POST' || req.url !== `${acct}/Messages.json`) return send(404, { message: 'Not found' });
    const body = Object.fromEntries(params);
    if (body.To.endsWith('9999')) return send(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' });
    const msg = { sid: `SM${sent.length + 1}`, ...body };
    sent.push(msg);
    return send(201, { sid: msg.sid });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, sent, calls, numbers, services, verifications, state, close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { startFakeTwilio };
