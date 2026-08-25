#!/usr/bin/env node
// End-to-end test for neuro-san/adapter.js WITHOUT a real neuro-san server or
// real mims: a fake mim records which mesh endpoint each call lands on, and we
// drive the adapter exactly as neuro-san would (GET /function, POST
// /streaming_chat with {user_message:{text}}), asserting the neuro-san wire
// shape and the mesh-vs-direct routing per agent.
'use strict';

const http = require('node:http');
const assert = require('node:assert');

const FAKE_PORT = 8791;
const ADAPTER_PORT = 8792;

// Point the three agents at one fake mim, distinguished by base path.
process.env.FRONT_URL = `http://127.0.0.1:${FAKE_PORT}/front`;
process.env.NET_URL = `http://127.0.0.1:${FAKE_PORT}/net`;
process.env.PI_URL = `http://127.0.0.1:${FAKE_PORT}/pi`;

const hits = [];
function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
}

// Fake mim: /front/chat is the MESH entry (returns {answer,trace}); /net/aaosa
// and /pi/aaosa are DIRECT specialist fulfil calls (return handleAaosa shape).
const fakeMim = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const body = await readBody(req);
  hits.push({ path, body });
  res.writeHead(200, { 'content-type': 'application/json' });
  if (path === '/front/chat') {
    return res.end(JSON.stringify({ answer: `MESH answer for: ${body.message}`, trace: [{ mode: 'discover', found: 2 }] }));
  }
  if (path === '/net/aaosa') {
    assert.strictEqual(body.mode, 'fulfil'); assert.strictEqual(body.ttl, 1); // direct, no fan-out
    return res.end(JSON.stringify({ v: '0.1', agent: 'network_agent', status: 'ok', answer: `NET answer for: ${body.inquiry}` }));
  }
  if (path === '/pi/aaosa') {
    assert.strictEqual(body.mode, 'fulfil'); assert.strictEqual(body.ttl, 1);
    return res.end(JSON.stringify({ v: '0.1', agent: 'pi_device_agent', status: 'ok', answer: `PI answer for: ${body.inquiry}` }));
  }
  res.writeHead(404); res.end('{}');
});

const { server: adapter } = require('../neuro-san/adapter');

function get(path) { return fetch(`http://127.0.0.1:${ADAPTER_PORT}${path}`).then((r) => r.json()); }
async function streamingChat(name, text, extra) {
  const r = await fetch(`http://127.0.0.1:${ADAPTER_PORT}/api/v1/${name}/streaming_chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_message: { text }, ...(extra || {}) }),
  });
  const txt = await r.text();
  // ndjson: parse the last non-empty line as the final chunk.
  const lines = txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, lines, last: lines[lines.length - 1] };
}

(async () => {
  await new Promise((r) => fakeMim.listen(FAKE_PORT, r));
  await new Promise((r) => adapter.listen(ADAPTER_PORT, r));

  // 1) /function signature shape (what neuro-san reads to learn the agent).
  const fn = await get('/api/v1/front_man/function');
  assert.ok(fn.function && fn.function.description, 'function has a description');
  assert.deepStrictEqual(fn.function.parameters.required, ['inquiry'], 'function requires `inquiry`');
  console.log('1. GET /function: PASS (neuro-san callable signature)');

  // 2) front_man -> MESH (/chat). Answer proves it, chat_context+sly_data echo.
  const fm = await streamingChat('front_man', 'is the pi hot and can we add a second pi?', { chat_context: { k: 1 }, sly_data: { s: 2 } });
  assert.strictEqual(fm.status, 200);
  assert.strictEqual(fm.last.response.type, 'AI', 'final chunk is an AI message');
  assert.match(fm.last.response.text, /^MESH answer for:/, 'front_man routed through the mesh /chat');
  assert.deepStrictEqual(fm.last.response.chat_context, { k: 1 }, 'chat_context echoed inside response');
  assert.deepStrictEqual(fm.last.response.sly_data, { s: 2 }, 'sly_data echoed inside response');
  assert.ok(hits.some((h) => h.path === '/front/chat'), 'hit the mesh endpoint');
  console.log('2. front_man -> mesh /chat: PASS (nested response.type/text, chat_context+sly_data echoed)');

  // 3) network_agent -> DIRECT (/aaosa fulfil, no fan-out).
  const na = await streamingChat('network_agent', 'what subnet for a new pi?');
  assert.match(na.last.response.text, /^NET answer for:/, 'network_agent answered directly');
  assert.ok(hits.some((h) => h.path === '/net/aaosa'), 'hit the direct specialist endpoint');
  assert.ok(!hits.some((h) => h.path === '/net/chat'), 'did NOT fan out via /chat');
  console.log('3. network_agent -> direct /aaosa fulfil: PASS (no mesh fan-out)');

  // 4) pi_device_agent -> DIRECT.
  const pi = await streamingChat('pi_device_agent', 'current cpu temp?');
  assert.match(pi.last.response.text, /^PI answer for:/, 'pi answered directly');
  assert.ok(hits.some((h) => h.path === '/pi/aaosa'), 'hit the pi direct endpoint');
  console.log('4. pi_device_agent -> direct /aaosa fulfil: PASS');

  // 5) unknown agent -> 404.
  const unk = await fetch(`http://127.0.0.1:${ADAPTER_PORT}/api/v1/nope/function`).then((r) => r.status);
  assert.strictEqual(unk, 404, 'unknown agent name 404s');
  console.log('5. unknown agent -> 404: PASS');

  console.log('\nNEUROSAN_ADAPTER_SIM_PASS');
  fakeMim.close(); adapter.close();
  process.exit(0);
})().catch((e) => { console.error('NEUROSAN_ADAPTER_SIM_FAIL:', e.message); process.exit(1); });
