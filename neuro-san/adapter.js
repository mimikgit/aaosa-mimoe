#!/usr/bin/env node
// neuro-san <-> mimOE AAOSA adapter.
//
// Presents the three mimOE agents as neuro-san EXTERNAL AGENTS. A neuro-san
// network references an external agent by URL and then speaks its HTTP surface:
//
//   GET  /api/v1/<name>/function        -> the agent's callable signature
//   POST /api/v1/<name>/streaming_chat  -> run, stream newline-delimited JSON
//
// neuro-san expects that surface at the host ROOT (http://host:port/<name> ->
// http://host:port/api/v1/<name>/streaming_chat). The mimOE mim, by contrast,
// lives under its MCM base path (…/mimik-aaosa/agent/v1) and speaks a different
// vocabulary (/chat, /aaosa). This adapter is the bridge: it serves the exact
// neuro-san surface at the root and translates each call into the mesh.
//
// Routing per agent (see AGENTS):
//   front_man      -> POST {base}/chat         (the WHOLE mesh: determine ->
//                                                adjudicate -> parallel fulfil)
//   network_agent  -> POST {base}/aaosa fulfil (that ONE specialist, no fan-out)
//   pi_device_agent-> POST {base}/aaosa fulfil (   "     "      "        "     )
//
// So a neuro-san coordinator can call the mesh as a whole (front_man) OR reach a
// single specialist directly — the "expose all three" topology.
//
// Zero dependencies. Run one adapter anywhere neuro-san can reach (it can sit on
// the neuro-san host); it fans out to the three mim nodes over the LAN.
//
//   FRONT_URL=http://192.168.1.214:8083/mimik-aaosa/agent/v1 \
//   NET_URL=http://192.168.1.11:8083/mimik-aaosa/agent/v1 \
//   PI_URL=http://192.168.1.103:8083/mimik-aaosa/agent/v1 \
//   PORT=4747 node neuro-san/adapter.js

'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4747);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 30000);

// name -> how to reach it and how to invoke it. `mode:'mesh'` calls /chat (the
// front-man fans out); `mode:'direct'` calls /aaosa in fulfil mode so exactly
// that specialist answers, with no fan-out back across the mesh.
const AGENTS = {
  front_man: {
    base: (process.env.FRONT_URL || 'http://192.168.1.214:8083/mimik-aaosa/agent/v1').replace(/\/+$/, ''),
    mode: 'mesh',
    description:
      'Lab operations coordinator. Delegate any lab inquiry here to have the mesh ' +
      'route it across the network and device specialists and synthesize one answer. ' +
      'Best for compound or ambiguous questions that may span more than one specialty.',
  },
  network_agent: {
    base: (process.env.NET_URL || 'http://192.168.1.11:8083/mimik-aaosa/agent/v1').replace(/\/+$/, ''),
    mode: 'direct',
    description:
      'Network specialist for the lab: topology, LAN/WiFi, firewalls, adding devices ' +
      'to the mesh, connectivity troubleshooting. Call directly for pure network questions.',
  },
  pi_device_agent: {
    base: (process.env.PI_URL || 'http://192.168.1.103:8083/mimik-aaosa/agent/v1').replace(/\/+$/, ''),
    mode: 'direct',
    description:
      "Raspberry Pi health specialist: live CPU temperature, load, memory, uptime. " +
      "Call directly for questions about this device's current state or capacity.",
  },
};

// ---------- outbound HTTP to a mim (zero-dep) ----------

function postJson(urlStr, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); }
          catch (e) { reject(new Error(`bad JSON from ${urlStr}: ${data.slice(0, 160)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout calling ${urlStr}`)));
    req.end(payload);
  });
}

// Ask the mesh (or a single specialist) and return a plain answer string.
async function askAgent(name, text, deadlineMs) {
  const a = AGENTS[name];
  if (a.mode === 'mesh') {
    const r = await postJson(`${a.base}/chat`, { message: text }, deadlineMs);
    return String(r.answer || '');
  }
  // direct specialist: fulfil-only envelope, ttl:1 so it never fans back out.
  const r = await postJson(
    `${a.base}/aaosa`,
    {
      v: '0.1', id: crypto.randomUUID(), corr: crypto.randomUUID(),
      mode: 'fulfil', inquiry: text, context: {}, hops: 0, ttl: 1,
      visited: [], deadlineMs,
    },
    deadlineMs
  );
  return r && r.status === 'ok' ? String(r.answer || '') : '';
}

// ---------- neuro-san surface ----------

// GET /api/v1/<name>/function  -> callable signature neuro-san reads to know how
// to invoke this agent (single string arg `inquiry`).
function functionSpec(name) {
  return {
    function: {
      description: AGENTS[name].description,
      parameters: {
        type: 'object',
        properties: { inquiry: { type: 'string', description: 'The inquiry for this agent.' } },
        required: ['inquiry'],
      },
    },
  };
}

// POST /api/v1/<name>/streaming_chat
// Request : { user_message: { text }, chat_context?, sly_data? }
// Response: newline-delimited JSON; each line { response: { type, text,
//           chat_context, sly_data } }. We emit one AGENT_FRAMEWORK ack then one
//           AI answer, matching neuro-san's chunk shape (verified against
//           docs/clients.md: response.type / response.text / response.chat_context
//           / response.sly_data, all nested under `response`).
async function streamingChat(name, reqBody, res) {
  const text =
    (reqBody && reqBody.user_message && reqBody.user_message.text) ||
    reqBody.inquiry || reqBody.message || '';
  const chatContext = reqBody.chat_context || {};
  const slyData = reqBody.sly_data || {};

  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const line = (obj) => res.write(JSON.stringify(obj) + '\n');

  let answer = '';
  let err = null;
  try {
    answer = await askAgent(name, text, DEADLINE_MS);
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }

  if (err) {
    line({ response: { type: 'AGENT_FRAMEWORK', text: `adapter error reaching ${name}: ${err}`, chat_context: chatContext, sly_data: slyData } });
    return res.end();
  }
  // Final answer as an AI message; echo chat_context and sly_data so a caller
  // threading state keeps working. (No mid-stream tokens: the mim answers in one
  // shot, so one AI chunk is the whole reply.)
  line({ response: { type: 'AI', text: answer, chat_context: chatContext, sly_data: slyData } });
  res.end();
}

// ---------- router ----------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0].replace(/\/+$/, '');
    // /api/v1/<name>/<verb>
    const m = path.match(/^\/api\/v1\/([^/]+)\/([^/]+)$/);
    if (m) {
      const [, name, verb] = m;
      if (!AGENTS[name]) return sendJson(res, 404, { error: `unknown agent ${name}` });
      if (req.method === 'GET' && verb === 'function') return sendJson(res, 200, functionSpec(name));
      if (req.method === 'POST' && verb === 'streaming_chat') return streamingChat(name, await readBody(req), res);
      // Best-effort: some neuro-san clients probe /connectivity. A leaf external
      // agent has no internal graph to expose. Verify the exact shape against
      // your neuro-san version if it relies on this.
      if (req.method === 'GET' && verb === 'connectivity') return sendJson(res, 200, { connectivity: [{ origin: name, tools: [] }] });
      return sendJson(res, 404, { error: `no route ${req.method} ${path}` });
    }
    if (req.method === 'GET' && (path === '' || path === '/health')) {
      return sendJson(res, 200, { status: 'ok', agents: Object.keys(AGENTS) });
    }
    sendJson(res, 404, { error: `no route ${req.method} ${path}` });
  } catch (e) {
    sendJson(res, 500, { error: e && e.message ? e.message : String(e) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[neuro-san adapter] :${PORT}  agents: ${Object.keys(AGENTS).join(', ')}`);
    for (const [n, a] of Object.entries(AGENTS)) console.log(`  ${n} (${a.mode}) -> ${a.base}`);
  });
}

module.exports = { AGENTS, askAgent, functionSpec, streamingChat, server };
