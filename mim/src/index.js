// AAOSA agent as a mimOE edge microservice (mim).
//
// Programming model verified against mimik's own published example
// (github.com/mimikgit/mIoT): the runtime calls the global entry
//     mimikModule.exports = (context, req, res) => { ... }
// with context.env (container env vars), context.http (outbound calls:
// http.request({type, url, data, success, error})), and context.edge.
// No Node core modules exist here; lib/aaosa.js and lib/llm.js are
// runtime-agnostic and receive a transport wrapped over context.http.
//
// Deployed via mCM (see mim/deploy.sh) and reached at
//     http://<node-ip>:8083<MCM.BASE_API_PATH>/<route>
// e.g. http://192.168.1.101:8083/aaosa/v1/chat
//
// Container env vars (set at deploy time):
//   NAME, DESCRIPTION, INSTRUCTIONS       agent identity
//   AGENT_KIND                            frontman | specialist | device
//   PEERS                                 comma-separated peer mim base URLs
//   INFERENCE_URL                         OpenAI-compatible base, e.g.
//                                         http://<MBP1_IP>:8083/mimik-ai/openai/v1
//   ROUTING_MODEL, WORK_MODEL, DEADLINE_MS, CTX_TO_DOWNSTREAM, CTX_FROM_DOWNSTREAM
//   ROUTING_INFERENCE_URL                 OPTIONAL: run determine/adjudicate/
//                                         synthesize on ANOTHER node's model.
//                                         Unset -> routing shares INFERENCE_URL.
//                                         Companions: ROUTING_INFERENCE_API_KEY,
//                                         ROUTING_INFERENCE_MAX_TOKENS

'use strict';

const { createAgent } = require('../../lib/aaosa');
const { makeLlm } = require('../../lib/llm');
const { extractAaosaPeerUrls } = require('../../lib/discovery');
const { McpServer, z } = require('@mimik/mcp-kit');

// Last-resort model name when neither ROUTING_MODEL nor WORK_MODEL is set.
const DEFAULT_MODEL = 'Qwen3.6-35B-A3B-Q4_K_M';
const SERVICE_VERSION = '0.2.0';

// ---------- module state (lives for the container's lifetime) ----------

let agent = null;
let cfgSnapshot = '';

// PERSISTENT STATE. The serverless engine gives each request a fresh isolate
// (verified: module state written by one request is gone on the next), so the
// mesh peer table and device telemetry live in context.storage, the
// localStorage-like synchronous API mimik's own mims (e.g. mBeam) use:
// getItem/setItem/eachItem. CTX is rebound at every entry.
let CTX = null;
const STATE_KEY = 'aaosa_state_v1';
const memFallback = {}; // used only when context.storage is absent (dev hosts)

function loadState() {
  try {
    const raw = CTX && CTX.storage ? CTX.storage.getItem(STATE_KEY) : memFallback[STATE_KEY];
    const st = raw ? JSON.parse(raw) : null;
    if (st && st.peers) return st;
  } catch (e) { /* corrupt -> reset */ }
  return { peers: {}, telemetry: null };
}

function saveState(st) {
  const raw = JSON.stringify(st);
  if (CTX && CTX.storage) CTX.storage.setItem(STATE_KEY, raw);
  else memFallback[STATE_KEY] = raw;
}

function upsertAnnounce(body) {
  if (!body || !body.name || !body.url) throw new Error('announce needs {name, url, description}');
  const st = loadState();
  const prev = st.peers[body.name] || {};
  st.peers[body.name] = {
    ...prev,
    name: body.name,
    url: String(body.url).replace(/\/+$/, ''),
    description: body.description || prev.description || '',
    lastSeen: Date.now(),
    state: 'announced',
    stateAt: Date.now(),
  };
  saveState(st);
  return Object.keys(st.peers).length;
}

// Same output shape as before, but the peer list is supplied by discovery
// (mInsight) rather than read from the announce table. `state` still reflects
// the last consult outcome (claimed/ok/unreachable) cached by onPeerOutcome;
// membership + freshness now come from mimOE, so discovered peers are fresh.
function meshView(env, selfName, peers) {
  const st = loadState();
  return {
    self: selfName,
    staleMs: Number(env.STALE_MS || 90000),
    peers: (peers || []).map((p) => {
      const s = st.peers[p.name] || {};
      return {
        name: p.name,
        url: p.url,
        state: s.state || 'announced',
        lastSeenAgoMs: 0,
        fresh: true,
      };
    }),
    staticPeers: (env.PEERS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// ---------- mimik-native discovery (replaces announce/heartbeat) ----------
// Ask THIS node's mimOE mesh service (mInsight) which nodes are nearby and what
// mims they run, then keep the aaosa agents on OTHER nodes. mimOE tracks
// liveness, so there is no announce and no STALE_MS. mInsight carries the mimOE
// service identity, not the agent's aaosa name/description, so we probe each
// candidate's /descriptor (the same probe the old static-PEERS path used).
async function discoverViaInsight(env, transport, selfName) {
  const url = env.INSIGHT_URL ||
    `http://127.0.0.1:8083/mimik-mesh/insight/v1/nodes?type=${env.DISCOVERY_SCOPE || 'linkLocal'}`;
  const token = env.INSIGHT_TOKEN || env.EDGE_ACCESS_TOKEN || '';
  let body;
  try {
    body = await transport.withAuth(token ? `Bearer ${token}` : '')
      .getJson(url, Number(env.DISCOVERY_TIMEOUT_MS || 4000));
  } catch (e) {
    return []; // mInsight unreachable / 401 (token unset or expired) -> no peers
  }
  // The peer base path comes from each node's own aaosa service `self` in the
  // mInsight record (built inside extractAaosaPeerUrls); AAOSA_BASE_PATH is only
  // an override for the rare case a node advertises a different mount.
  const urls = extractAaosaPeerUrls(body, {
    match: env.AAOSA_SERVICE_MATCH || 'aaosa',
    basePath: env.AAOSA_BASE_PATH || '',
  });
  const probed = await Promise.all(urls.map((u) =>
    transport.getJson(`${u}/descriptor`, 3000)
      .then((d) => (d && d.name && d.name !== selfName
        ? { name: d.name, url: u, description: d.description }
        : null))
      .catch(() => null)
  ));
  return probed.filter(Boolean);
}

// ---------- transport over context.http ----------

function makeTransport(http) {
  function raw(type, url, data, timeoutMs, authorization) {
    const call = new Promise((resolve, reject) => {
      http.request({
        type,
        url,
        // context.http.request supports an `authorization` field (see mIoT's
        // sep-helper): its value lands in the Authorization header.
        ...(authorization ? { authorization } : {}),
        ...(data != null ? { data: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
        success: (result) => resolve(result && result.data != null ? result.data : ''),
        error: (err) => reject(new Error((err && err.message) || 'http error')),
      });
    });
    if (typeof setTimeout === 'undefined' || !timeoutMs) return call;
    return Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
  }
  return {
    postJson: (url, body, timeoutMs) => raw('POST', url, body, timeoutMs).then(parseJson),
    getJson: (url, timeoutMs) => raw('GET', url, null, timeoutMs).then(parseJson),
    // Same transport with a bearer key attached: used ONLY for inference
    // calls, so the key never rides along on peer /aaosa traffic.
    withAuth: (authorization) => ({
      postJson: (url, body, timeoutMs) => raw('POST', url, body, timeoutMs, authorization).then(parseJson),
      getJson: (url, timeoutMs) => raw('GET', url, null, timeoutMs, authorization).then(parseJson),
    }),
  };
}

function parseJson(text) {
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { throw new Error(`expected JSON, got: ${String(text).slice(0, 120)}`); }
}

// ---------- agent construction from container env ----------

function getAgent(context) {
  const env = context.env || {};
  const snap = JSON.stringify(env);
  if (agent && snap === cfgSnapshot) return agent;
  cfgSnapshot = snap;

  const transport = makeTransport(context.http);
  // Inference auth: a CLEAN bearer value. Do not smuggle extra headers via
  // CRLF in the authorization field: the engine's HTTP client sanitizes that
  // (header-injection defense) and the Authorization header is lost entirely
  // (observed: 403 Forbidden from mimik-ai). The engine sets a JSON content
  // type for string data POSTs on its own. INFERENCE_CT_INJECT=1 re-enables
  // the legacy CRLF trick for old engines only.
  const inferenceAuth =
    (env.INFERENCE_API_KEY ? `Bearer ${env.INFERENCE_API_KEY}` : '') +
    (env.INFERENCE_CT_INJECT === '1' ? '\r\nContent-Type: application/json' : '');
  const llm = makeLlm({
    baseUrl: env.INFERENCE_URL,
    postJson: transport.withAuth(inferenceAuth).postJson,
    maxTokens: Number(env.INFERENCE_MAX_TOKENS) || undefined,
    enableThinking: env.INFERENCE_ENABLE_THINKING === '1',
    timeoutMs: Number(env.INFERENCE_TIMEOUT_MS) || undefined,
  });

  // OPTIONAL second client for the routing phases (determine, adjudicate,
  // synthesize). Set ROUTING_INFERENCE_URL to run routing on ANOTHER node's
  // model while this node answers (fulfil) on its own, or the reverse. Unset,
  // or equal to INFERENCE_URL, means one endpoint and identical behaviour.
  //
  // Why you would: routing is small structured JSON, and a small quantized
  // model truncates it ("Full", or determine error: expected JSON). Pointing
  // routing at a larger model fixes that while long generations stay local.
  // Why you would not: determine runs on EVERY inquiry and the up-chain's
  // DEADLINE_MS covers a peer's whole reply INCLUDING its inference, so an
  // off-node routing call adds a LAN round trip inside that budget.
  //
  // The routing endpoint has its own key and token budget: it is a different
  // node's mimik ai, and routing JSON needs far fewer tokens than an answer.
  const routingBase = env.ROUTING_INFERENCE_URL || '';
  let routingLlm;
  if (routingBase && routingBase !== env.INFERENCE_URL) {
    const routingKey = env.ROUTING_INFERENCE_API_KEY || env.INFERENCE_API_KEY;
    const routingAuth =
      (routingKey ? `Bearer ${routingKey}` : '') +
      (env.INFERENCE_CT_INJECT === '1' ? '\r\nContent-Type: application/json' : '');
    routingLlm = makeLlm({
      baseUrl: routingBase,
      postJson: transport.withAuth(routingAuth).postJson,
      maxTokens: Number(env.ROUTING_INFERENCE_MAX_TOKENS) || Number(env.INFERENCE_MAX_TOKENS) || undefined,
      enableThinking: env.INFERENCE_ENABLE_THINKING === '1',
      timeoutMs: Number(env.ROUTING_INFERENCE_TIMEOUT_MS) || Number(env.INFERENCE_TIMEOUT_MS) || undefined,
    });
  }

  agent = createAgent({
    name: env.NAME || 'aaosa_agent',
    nodeId: env.MIMOE_NODE_ID || env.NAME || 'unknown',
    description: env.DESCRIPTION || 'General agent.',
    instructions: env.INSTRUCTIONS || 'Answer helpfully within your specialty.',
    llm,
    routingLlm,        // undefined -> lib/aaosa.js falls back to llm
    // Either name alone configures both phases; lib/aaosa.js also cross-fills.
    routingModel: env.ROUTING_MODEL || env.WORK_MODEL || DEFAULT_MODEL,
    workModel: env.WORK_MODEL || env.ROUTING_MODEL || DEFAULT_MODEL,
    contextToDownstream: (env.CTX_TO_DOWNSTREAM || '').split(',').filter(Boolean),
    contextFromDownstream: (env.CTX_FROM_DOWNSTREAM || '').split(',').filter(Boolean),
    postJson: transport.postJson,
    // Only the coordinator re-orchestrates inside fulfil; a leaf specialist/device
    // answers directly (see fulfil() in lib/aaosa.js). FULFIL_RECURSE=1/0 overrides.
    delegatesInFulfil: env.FULFIL_RECURSE ? env.FULFIL_RECURSE === '1' : env.AGENT_KIND === 'frontman',
    // shortCircuit off (SHORT_CIRCUIT=0) makes determine skip the speculative
    // answer entirely (faster routing) and always run the real fulfil pass — the
    // right default for a slow, token-capped node whose one-shot answer is junk.
    tuning: {
      deadlineMs: Number(env.DEADLINE_MS || 15000),
      shortCircuit: env.SHORT_CIRCUIT !== '0',
    },

    // Device agents ground answers in telemetry pushed into the mim
    // (a serverless mim cannot read sysfs; sensors POST /telemetry,
    // exactly the mIoT pattern). Facts absent until first push.
    gatherFacts: env.AGENT_KIND === 'device'
      ? async () => loadState().telemetry
      : undefined,

    // Consult-outcome observer feeds the live /mesh view (persisted).
    onPeerOutcome(name, outcome) {
      // State cache for the /mesh view. Upsert (not gated on an announce entry)
      // so consult outcomes are tracked for mInsight-discovered peers too.
      const st = loadState();
      st.peers[name] = Object.assign({}, st.peers[name], { name, state: outcome, stateAt: Date.now() });
      saveState(st);
    },

    // Membership via mimik-native discovery: interrogate this node's mimOE mesh
    // (mInsight) and keep the aaosa agents running on OTHER nodes. Announce/
    // heartbeat is retired; a peer is "here" iff mimOE currently reports it.
    // Static PEERS and any still-fresh announced peers remain ONLY as a
    // bootstrap fallback (e.g. the offline test host), deduped by name.
    async discoverPeers() {
      const self = env.NAME || 'aaosa_agent';
      const byName = {};
      (await discoverViaInsight(env, transport, self)).forEach((p) => { byName[p.name] = p; });

      // fallback: still-fresh announced peers (empty in production once
      // heartbeats stop; keeps the offline test/sim host working).
      const staleMs = Number(env.STALE_MS || 90000);
      const now = Date.now();
      const st = loadState();
      Object.keys(st.peers).forEach((k) => {
        const p = st.peers[k];
        if (p && p.url && p.name !== self && !byName[p.name] && (now - (p.lastSeen || 0) < staleMs)) {
          byName[p.name] = { name: p.name, url: p.url, description: p.description };
        }
      });

      // fallback: static PEERS probed via /descriptor.
      const staticUrls = (env.PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const probed = await Promise.all(staticUrls.map((url) =>
        transport.getJson(`${url}/descriptor`, 3000)
          .then((d) => (d && d.name && d.name !== self && !byName[d.name]
            ? { name: d.name, url, description: d.description } : null))
          .catch(() => null)
      ));
      probed.filter(Boolean).forEach((p) => { byName[p.name] = p; });

      return Object.keys(byName).map((k) => byName[k]);
    },
  });
  return agent;
}

// ---------- MCP (Model Context Protocol) tool surface ----------
// The agent is exposed as ONE MCP tool: tools/call { inquiry } runs the mesh
// (same path as POST /chat) and returns the answer as text content. MCP clients
// connect to whatever URL you give them, so serving this under the mim's base
// path (…/mimik-aaosa/agent/v1/mcp) needs no adapter or base-path change.

async function runMeshTool(a, env, inquiry) {
  const up = await a.orchestrate(inquiry || '');
  if (up.contributors > 0) return up.answer;
  const own = await a.handleAaosa({
    v: '0.1', id: `mcp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, corr: up.corr,
    mode: 'fulfil', inquiry: inquiry || '', context: {}, hops: 0, ttl: 1,
    visited: [], deadlineMs: Number(env.DEADLINE_MS || 20000),
  });
  return own.answer || '';
}

// Build an MCP server (via @mimik/mcp-kit, purpose-built for the mimOE
// serverless runtime) exposing THIS agent as one tool. tools/call { inquiry }
// runs the mesh; the kit handles JSON-RPC, schema validation and result
// wrapping. Returns { server, descriptor } — descriptor is the kit-converted
// JSON tool spec, reused for /mcp/descriptor and registration.
function mcpServerFor(a, env) {
  const toolName = env.MCP_TOOL_NAME || a.name;
  const description = env.MCP_TOOL_DESCRIPTION || a.description;
  const server = new McpServer({ name: `aaosa-${a.name}`, version: SERVICE_VERSION });
  server.tool(
    toolName,
    description,
    { inquiry: z.string().describe('The natural-language inquiry for this agent.') },
    (args) => runMeshTool(a, env, args.inquiry)
  );
  return { server, toolName, descriptor: server.tools.get(toolName) };
}

// Announce this agent's MCP tool to the mimik MCP server. THE REGISTRATION
// ENVELOPE IS THE SEAM: mimik's registry API is proprietary, so we POST a
// neutral record (name / description / inputSchema / this mim's /mcp url) to
// MCP_REGISTRY_URL with a bearer token. The tool spec itself comes from the kit
// (mcpServerFor); if your mimik MCP server wants a different envelope, adjust the
// record built here — nothing else changes.
async function registerWithMcp(context, a) {
  const env = context.env || {};
  const registryUrl = env.MCP_REGISTRY_URL;
  if (!registryUrl) return { registered: false, reason: 'MCP_REGISTRY_URL not set' };
  const selfUrl = env.MCP_SELF_URL ||
    (env.SELF_URL ? `${String(env.SELF_URL).replace(/\/+$/, '')}/mcp` : '');
  const d = mcpServerFor(a, env).descriptor;
  const record = {
    name: d.name, description: d.description, inputSchema: d.inputSchema,
    transport: 'streamable-http', url: selfUrl, agent: a.name, type: 'mcp-tool',
  };
  const transport = makeTransport(context.http);
  const auth = env.MCP_REGISTER_TOKEN || env.INSIGHT_TOKEN || '';
  try {
    const result = await transport.withAuth(auth ? `Bearer ${auth}` : '')
      .postJson(registryUrl, record, Number(env.MCP_REGISTER_TIMEOUT_MS || 5000));
    return { registered: true, registryUrl, record, result };
  } catch (e) {
    return { registered: false, registryUrl, record, error: e && e.message ? e.message : String(e) };
  }
}

// ---------- tiny router (method + exact path, base path already stripped) ----------

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

async function handle(context, req, res) {
  CTX = context; // rebind per request: fresh isolate per request (verified)
  const a = getAgent(context);
  const path = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const method = String(req.method || 'GET').toUpperCase();
  const body = req.body ? parseJson(req.body) : {};

  if (method === 'GET' && (path === '/healthcheck' || path === '/')) {
    return sendJson(res, 200, { status: 'ok', agent: a.name });
  }
  if (method === 'GET' && path === '/descriptor') {
    return sendJson(res, 200, { ...a.descriptor, kind: context.env.AGENT_KIND || 'specialist' });
  }
  if (method === 'GET' && path === '/metrics') {
    return sendJson(res, 200, loadState().telemetry || { note: 'no telemetry pushed yet' });
  }
  if (method === 'GET' && path === '/debug/inference') {
    // Probe the inference plane from INSIDE the mim with four header
    // strategies, reporting which ones this engine accepts. The agent's
    // default is 'plain'; set INFERENCE_CT_INJECT=1 only if 'crlf' is the
    // sole passing strategy (old engines).
    const env = context.env || {};
    const url = `${String(env.INFERENCE_URL || '').replace(/\/$/, '')}/chat/completions`;
    const model = env.ROUTING_MODEL || env.WORK_MODEL || DEFAULT_MODEL;
    const bearer = env.INFERENCE_API_KEY ? `Bearer ${env.INFERENCE_API_KEY}` : '';
    const payload = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });

    function attempt(opts) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        try {
          context.http.request({
            type: 'POST', url, data: payload,
            ...opts,
            success: (result) => {
              const raw = result && result.data != null ? String(result.data) : '';
              try {
                const j = JSON.parse(raw);
                const text = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : raw.slice(0, 120);
                finish({ ok: true, reply: String(text).slice(0, 60) });
              } catch (e) { finish({ ok: false, error: `non-json: ${raw.slice(0, 120)}` }); }
            },
            error: (err) => finish({ ok: false, error: String((err && err.message) || 'http error').slice(0, 160) }),
          });
        } catch (e) { finish({ ok: false, error: `threw: ${e.message}` }); }
        if (typeof setTimeout !== 'undefined') setTimeout(() => finish({ ok: false, error: 'timeout 30s' }), 30000);
      });
    }

    const strategies = {
      plain_authorization: { authorization: bearer },
      authorization_plus_contentType_field: { authorization: bearer, contentType: 'application/json' },
      headers_object: { headers: { Authorization: bearer, 'Content-Type': 'application/json' } },
      legacy_crlf_inject: { authorization: bearer + '\r\nContent-Type: application/json' },
    };
    const results = {};
    for (const name of Object.keys(strategies)) {
      results[name] = await attempt(strategies[name]);
    }
    return sendJson(res, 200, { url, model, results });
  }
  if (method === 'GET' && path === '/mesh') {
    const peers = await a.discoverPeers();
    return sendJson(res, 200, meshView(context.env || {}, a.name, peers));
  }
  if (method === 'POST' && path === '/announce') {
    const count = upsertAnnounce(body);
    return sendJson(res, 200, { registered: body.name, peers: count });
  }
  if (method === 'POST' && path === '/telemetry') {
    const st = loadState();
    st.telemetry = { ...body, receivedAt: new Date().toISOString() };
    saveState(st);
    return sendJson(res, 200, { stored: true });
  }
  if (method === 'POST' && path === '/aaosa') {
    return sendJson(res, 200, await a.handleAaosa(body));
  }
  if (method === 'POST' && path === '/chat') {
    const up = await a.orchestrate(body.message || '');
    if (up.contributors > 0) return sendJson(res, 200, { answer: up.answer, trace: up.trace });
    const own = await a.handleAaosa({
      v: '0.1', id: `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, corr: up.corr,
      mode: 'fulfil', inquiry: body.message || '', context: {}, hops: 0, ttl: 1,
      visited: [], deadlineMs: Number(context.env.DEADLINE_MS || 20000),
    });
    return sendJson(res, 200, {
      answer: own.answer || '',
      reason: own.reason,
      trace: [...(up.trace || []), ...(own.trace || [])],
    });
  }

  // ---------- MCP: this agent as an MCP tool ----------
  if (path === '/mcp') {
    if (method === 'GET') {
      // No server->client SSE stream offered; per MCP streamable-HTTP the client
      // then uses plain POST request/response.
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: 'SSE not supported; POST JSON-RPC to /mcp' }));
    }
    if (method === 'POST') {
      const { server } = mcpServerFor(a, context.env || {});
      const response = await server.handleMcpRequest(body);
      // handleMcpRequest returns null for notifications -> 202 Accepted, no body.
      if (!response) { res.statusCode = 202; return res.end(''); }
      return sendJson(res, 200, response);
    }
  }
  if (method === 'POST' && path === '/mcp/register') {
    return sendJson(res, 200, await registerWithMcp(context, a));
  }
  if (method === 'GET' && path === '/mcp/descriptor') {
    const d = mcpServerFor(a, context.env || {}).descriptor;
    return sendJson(res, 200, { name: d.name, description: d.description, inputSchema: d.inputSchema });
  }

  sendJson(res, 404, { error: `no route ${method} ${path}` });
}

// ---------- mimOE serverless entry ----------

mimikModule.exports = (context, req, res) => {
  handle(context, req, res).catch((e) => sendJson(res, 500, { error: e.message }));
};
