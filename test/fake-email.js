'use strict';
// A stand-in for Resend's send-email endpoint, for tests. Mail to an address starting with "bounce" is refused.
const http = require('node:http');

function startFakeEmail(apiKey) {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { message: 'API key is invalid' });
    if (req.method !== 'POST' || req.url !== '/emails') return send(404, { message: 'Not found' });
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.to.some((t) => t.startsWith('bounce'))) return send(422, { message: 'Invalid `to` field' });
    const m = { id: `em_${sent.length + 1}`, ...body };
    sent.push(m);
    return send(200, { id: m.id });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, sent, close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { startFakeEmail };
