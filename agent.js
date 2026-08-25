#!/usr/bin/env node
// Runnable AAOSA agent microservice for mimOE. Zero dependencies, Node 18+.
//
// One file runs any role; configuration decides what the agent is.
//
//   NAME=front_man DESCRIPTION="Coordinates IT inquiries" PORT=9100 \
//   PEERS="http://127.0.0.1:9101,http://127.0.0.1:9102" \
//   INFERENCE_URL=http://127.0.0.1:8083/v1 ROUTING_MODEL=Qwen3.6-35B-A3B-Q4_K_M \
//   node agent.js
//
// Endpoints:
//   POST /aaosa                          AAOSA protocol (determine | fulfil)
//   POST /chat {"message": "..."}        user entry point (front-man usage)
//   GET  /descriptor                     discovery descriptor
//   GET  /api/v1/<name>/function         neuro-san compat
//   POST /api/v1/<name>/streaming_chat   neuro-san compat

'use strict';

const http = require('node:http');
const { createAgent } = require('./lib/aaosa');
const { makeLlm } = require('./lib/llm');
const { compatRoutes } = require('./lib/compat-neurosan');

const NAME = process.env.NAME ?? 'front_man';
const PORT = Number(process.env.PORT ?? 9100);

const llm = makeLlm({
  // TODO(mimOE): point at this node's local OpenAI-compatible inference endpoint.
  baseUrl: process.env.INFERENCE_URL ?? 'http://127.0.0.1:8083/v1',
  apiKey: process.env.INFERENCE_API_KEY,
  maxTokens: Number(process.env.INFERENCE_MAX_TOKENS) || undefined,
  enableThinking: process.env.INFERENCE_ENABLE_THINKING === '1',
  timeoutMs: Number(process.env.INFERENCE_TIMEOUT_MS) || undefined,
});

// Dynamic membership (same model as the mim): announced peers are consulted
// while fresh; consult outcomes drive the /mesh view. See mim/src/index.js.
const STALE_MS = Number(process.env.STALE_MS ?? 90000);
const peerTable = new Map();

function upsertAnnounce(body) {
  if (!body?.name || !body?.url) throw new Error('announce needs {name, url, description}');
  const prev = peerTable.get(body.name) || {};
  peerTable.set(body.name, {
    ...prev, name: body.name, url: String(body.url).replace(/\/+$/, ''),
    description: body.description || prev.description || '',
    lastSeen: Date.now(), state: 'announced', stateAt: Date.now(),
  });
}

const agent = createAgent({
  name: NAME,
  nodeId: process.env.MIMOE_NODE_ID ?? NAME,
  description: process.env.DESCRIPTION ?? 'General coordinator agent.',
  instructions: process.env.INSTRUCTIONS ?? 'Answer helpfully within your specialty.',
  llm,
  // Either name alone configures both phases.
  routingModel: process.env.ROUTING_MODEL ?? process.env.WORK_MODEL ?? 'Qwen3.6-35B-A3B-Q4_K_M',
  workModel: process.env.WORK_MODEL ?? process.env.ROUTING_MODEL ?? 'Qwen3.6-35B-A3B-Q4_K_M',
  contextToDownstream: (process.env.CTX_TO_DOWNSTREAM ?? '').split(',').filter(Boolean),
  contextFromDownstream: (process.env.CTX_FROM_DOWNSTREAM ?? '').split(',').filter(Boolean),
  tuning: { deadlineMs: Number(process.env.DEADLINE_MS ?? 15000) },

  onPeerOutcome(name, outcome) {
    const e = peerTable.get(name);
    if (e) { e.state = outcome; e.stateAt = Date.now(); }
  },

  // Fresh announced peers first (announce IS the liveness signal), then any
  // static PEERS urls not already announced, probed via /descriptor.
  // TODO(mimOE): the mesh-discovery upgrade replaces both paths.
  async discoverPeers() {
    const now = Date.now();
    const announced = [...peerTable.values()]
      .filter((p) => now - p.lastSeen < STALE_MS)
      .map((p) => ({ name: p.name, url: p.url, description: p.description }));
    const have = new Set(announced.map((p) => p.name));

    const urls = (process.env.PEERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const probed = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(`${url}/descriptor`, { signal: AbortSignal.timeout(1500) });
          const d = await res.json();
          return have.has(d.name) ? null : { name: d.name, url, description: d.description };
        } catch {
          return null;
        }
      })
    );
    return [...announced, ...probed.filter(Boolean)];
  },
});

const compat = compatRoutes(agent);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/descriptor') {
      return sendJson(res, 200, agent.descriptor);
    }
    if (req.method === 'GET' && url.pathname === '/mesh') {
      const now = Date.now();
      return sendJson(res, 200, {
        self: NAME,
        staleMs: STALE_MS,
        peers: [...peerTable.values()].map((p) => ({
          name: p.name, url: p.url, state: p.state,
          lastSeenAgoMs: now - p.lastSeen, fresh: now - p.lastSeen < STALE_MS,
        })),
        staticPeers: (process.env.PEERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      });
    }
    if (req.method === 'POST' && url.pathname === '/announce') {
      const body = await readJson(req);
      upsertAnnounce(body);
      return sendJson(res, 200, { registered: body.name, peers: peerTable.size });
    }
    if (req.method === 'GET' && url.pathname === `/api/v1/${NAME}/function`) {
      return sendJson(res, 200, compat.functionSpec());
    }
    if (req.method === 'POST' && url.pathname === `/api/v1/${NAME}/streaming_chat`) {
      return compat.streamingChat(await readJson(req), res);
    }
    if (req.method === 'POST' && url.pathname === '/aaosa') {
      const out = await agent.handleAaosa(await readJson(req));
      return sendJson(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const { message } = await readJson(req);
      const up = await agent.orchestrate(message);
      if (up.contributors > 0) return sendJson(res, 200, { answer: up.answer, trace: up.trace });
      // No peer claimed it: answer locally through fulfil.
      const own = await agent.handleAaosa({
        v: '0.1', id: require('node:crypto').randomUUID(), corr: up.corr,
        mode: 'fulfil', inquiry: message, context: {}, hops: 0, ttl: 1,
        visited: [], deadlineMs: 20000,
      });
      return sendJson(res, 200, { answer: own.answer ?? '', trace: own.trace ?? [] });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[aaosa] ${NAME} listening on :${PORT}`);
});

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
