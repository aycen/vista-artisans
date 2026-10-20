'use strict';
// A stand-in for Twilio's send-message endpoint, for tests. Numbers ending in 9999 have replied STOP (error 21610).
const http = require('node:http');

function startFakeTwilio(sid, token) {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`) return send(401, { code: 20003, message: 'Authenticate' });
    if (req.method !== 'POST' || req.url !== `/2010-04-01/Accounts/${sid}/Messages.json`) return send(404, { message: 'Not found' });
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    if (body.To.endsWith('9999')) return send(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' });
    const m = { sid: `SM${sent.length + 1}`, ...body };
    sent.push(m);
    return send(201, { sid: m.sid });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, sent, close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { startFakeTwilio };
