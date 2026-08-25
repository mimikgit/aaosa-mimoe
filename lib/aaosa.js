// AAOSA-over-mimOE core library. Zero dependencies, Node 18+.
// Implements the envelope spec in spec/aaosa-envelope-spec.md:
// two modes (determine | fulfil), parallel fan-out, structured claims,
// LLM adjudication and synthesis, cycle guard, context allowlists.

'use strict';

// Runtime-agnostic: runs as a plain Node process AND inside mimOE's serverless
// JS environment (bundled). Node-only APIs are optional fallbacks.
let nodeCrypto = null;
try { nodeCrypto = require('node:crypto'); } catch { /* mimOE serverless env */ }

const PROTO_V = '0.1';

function fallbackUuid() {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Create an AAOSA agent runtime.
 *
 * @param {object} cfg
 * @param {string}   cfg.name          agent name (unique in the mesh)
 * @param {string}   cfg.description   routing signal shown to up-chains
 * @param {string}   cfg.instructions  domain instructions for fulfil
 * @param {object}   cfg.llm           from makeLlm(). Used for fulfil, and for
 *                                     routing too unless cfg.routingLlm is given.
 * @param {object}   [cfg.routingLlm]  from makeLlm(). A SEPARATE client for the
 *                                     routing phases (determine, adjudicate,
 *                                     synthesize), so a node can reason about
 *                                     routing on another node's model while
 *                                     answering on its own, or the reverse.
 *                                     Defaults to cfg.llm, which keeps the
 *                                     single-endpoint behaviour.
 * @param {string}   [cfg.routingModel] model for determine/adjudicate/synthesize.
 *                                     Defaults to cfg.workModel.
 * @param {string}   [cfg.workModel]   model for fulfil. Defaults to
 *                                     cfg.routingModel. Set either one alone
 *                                     and both phases use it.
 * @param {function} cfg.discoverPeers async () => [{name, url, description}]
 *                                     TODO(mimOE): back this with mesh discovery
 *                                     (node/proximity/account scope). The scope you
 *                                     query here IS the trust boundary.
 * @param {string[]} [cfg.contextToDownstream]   allowlisted context keys, outbound
 * @param {string[]} [cfg.contextFromDownstream] allowlisted context keys, inbound
 * @param {function} [cfg.gatherFacts] async (envelope) => object. Coded-tool hook:
 *                                     real device/system data collected at fulfil
 *                                     time and injected into the work prompt.
 * @param {string}   [cfg.nodeId]        stamped into envelope origin.node
 * @param {function} [cfg.onPeerOutcome] (peerName, outcome) => void. Observer for
 *                                     live membership: outcome is claimed |
 *                                     declined | unreachable | ok | timeout.
 * @param {function} [cfg.postJson]    async (url, body, timeoutMs) => object.
 *                                     Transport override; REQUIRED inside mimOE
 *                                     serverless (wrap context.http.request).
 *                                     Defaults to Node fetch when absent.
 * @param {function} [cfg.uuid]        () => string, id generator override
 * @param {object}   [cfg.tuning]      { ttl, deadlineMs, shortCircuitStrength }
 */
function createAgent(cfg) {
  const postJson = cfg.postJson ?? defaultPostJson;
  // Routing (determine / adjudicate / synthesize) may run on a DIFFERENT
  // endpoint from work (fulfil). Falls back to cfg.llm, so a node with one
  // inference endpoint behaves exactly as before.
  const routingLlm = cfg.routingLlm ?? cfg.llm;
  // One model per node is the common case, so the two model names default to
  // EACH OTHER: set either cfg.workModel or cfg.routingModel alone and both
  // phases use it. Only a node that deliberately splits them needs both.
  const workModel = cfg.workModel ?? cfg.routingModel;
  const routingModel = cfg.routingModel ?? cfg.workModel;
  const uuid = cfg.uuid ?? (nodeCrypto ? () => nodeCrypto.randomUUID() : fallbackUuid);
  const tuning = {
    ttl: 4,
    deadlineMs: 8000,
    shortCircuit: true,          // allow a confident one-shot determine answer to win
    shortCircuitStrength: 0.8,
    shortCircuitMinChars: 24,    // but only if that answer is substantive, not "Full"
    dedupWindowMs: 60000,
    ...cfg.tuning,
  };
  const seenIds = new Map(); // envelope id -> timestamp, cycle/replay guard

  // ---------- inbound: handle POST /aaosa ----------

  async function handleAaosa(envelope) {
    const guard = cycleGuard(envelope);
    if (guard) return guard;

    if (envelope.mode === 'determine') return determine(envelope);
    if (envelope.mode === 'fulfil') return fulfil(envelope);
    return claimNone('unknown mode');
  }

  function cycleGuard(env) {
    const now = Date.now();
    for (const [id, t] of seenIds) if (now - t > tuning.dedupWindowMs) seenIds.delete(id);
    if (env.id && seenIds.has(env.id)) return claimNone('duplicate envelope');
    if (env.id) seenIds.set(env.id, now);
    if ((env.hops ?? 0) >= (env.ttl ?? tuning.ttl)) return claimNone('ttl exceeded');
    if ((env.visited ?? []).includes(cfg.name)) return claimNone('cycle: already visited');
    return null;
  }

  function claimNone(reason) {
    return { v: PROTO_V, agent: cfg.name, canHandle: false, coverage: 'none', strength: 0, parts: [], requirements: [], reason };
  }

  // ---------- determine: structured claim, speculative when confident ----------

  async function determine(env) {
    // A data-backed agent (has gatherFacts) is blind to its own live data at
    // determine time: gatherFacts runs only in fulfil. It must never emit a
    // speculative one-shot answer, or an up-chain will short-circuit on
    // description-only boilerplate instead of the real fulfil (telemetry) read.
    const speculate = tuning.shortCircuit && !cfg.gatherFacts;
    const out = await routingLlm.chat({
      model: routingModel,
      json: true,
      system:
        `You are the agent "${cfg.name}". ${cfg.description}\n` +
        `Decide whether any part of the inquiry is yours. Respond with JSON only:\n` +
        `{"canHandle":bool,"coverage":"full|partial|none","strength":0..1,` +
        `"parts":[strings],"requirements":[{"key":str,"description":str}],` +
        (speculate ? `"speculative":str|null,` : ``) +
        `"reason":str}\n` +
        `If the inquiry is within your specialty, set canHandle=true even when you ` +
        `lack specifics: capture what you'd need as "requirements" and still plan to ` +
        `give general guidance. Missing details are requirements, NOT grounds to ` +
        `decline. Set canHandle=false only when the inquiry is genuinely outside ` +
        `your domain.\n` +
        (speculate
          ? `Set "speculative" to a COMPLETE, self-contained answer of at least a full ` +
            `sentence ONLY if coverage is full, you are confident, and no requirements ` +
            `are missing. A single word or fragment (e.g. "Full") is NOT a valid answer — ` +
            `use null in that case. Otherwise null. `
          : ``) +
        `Output ONLY the JSON object: no prose, no markdown, no thinking tags.`,
      user: `Inquiry: ${env.inquiry}\nContext: ${JSON.stringify(filterKeys(env.context, cfg.contextFromDownstream))}`,
    }).catch((e) => ({ canHandle: false, coverage: 'none', strength: 0, parts: [], requirements: [], reason: `determine error: ${e.message}` }));

    // Belt and suspenders: drop a speculative even if the model volunteers one.
    if (cfg.gatherFacts && out && typeof out === 'object') out.speculative = null;
    return { v: PROTO_V, agent: cfg.name, ...out };
  }

  // ---------- fulfil: answer own parts, optionally recurse to peers ----------

  async function fulfil(env) {
    const t0 = Date.now();
    // Recurse first ONLY if this agent delegates. A coordinator (front-man) may
    // have a down-chain that owns parts of the task, so it re-orchestrates. A
    // LEAF specialist/device must NOT: re-orchestrating re-discovers the mesh and
    // re-consults its own peers (including the caller), adding a whole determine
    // round — often a near-cycle cut only by ttl — on top of its own work call.
    // On a slow node that pushes its /aaosa reply past mimOE's ~20s read ceiling,
    // so the caller times it out (observed: network_agent fulfil timeout at 20s).
    // Default: only the front-man delegates; override per node with FULFIL_RECURSE.
    const sub = (cfg.delegatesInFulfil !== false)
      ? await orchestrate(env.inquiry, {
          context: filterKeys(env.context, cfg.contextFromDownstream),
          hops: (env.hops ?? 0) + 1,
          ttl: env.ttl ?? tuning.ttl,
          visited: [...(env.visited ?? []), cfg.name],
          corr: env.corr,
          deadlineMs: env.deadlineMs ?? tuning.deadlineMs,
          allowSelfAnswerOnly: true, // don't error when no peers exist
        })
      : { answer: '', contributors: 0, corr: env.corr, trace: [] };

    const facts = cfg.gatherFacts ? await cfg.gatherFacts(env).catch(() => null) : null;

    let llmError = null;
    const answer = await cfg.llm.chat({
      model: workModel,
      system:
        `You are the agent "${cfg.name}". ${cfg.description}\n${cfg.instructions}\n` +
        (env.parts?.length
          ? `Answer the parts of the inquiry you were tasked with. Be direct and complete.`
          : `Answer the inquiry directly and completely.`) +
        (facts ? ` Ground your answer in the live device data provided; quote actual numbers.` : ''),
      user:
        `Inquiry: ${env.inquiry}\n` +
        (env.parts?.length ? `Your tasked parts: ${JSON.stringify(env.parts)}\n` : '') +
        (env.requirements ? `Requirement values: ${JSON.stringify(env.requirements)}\n` : '') +
        (facts ? `Live device data: ${JSON.stringify(facts)}\n` : '') +
        (sub.contributors > 0 ? `Findings from your down-chain agents:\n${sub.answer}\n` : ''),
    }).catch((e) => { llmError = e && e.message ? e.message : String(e); return null; });

    if (answer == null) {
      return { v: PROTO_V, agent: cfg.name, status: 'cannot_contribute', answer: '', reason: `work llm failed: ${llmError}`, contextOut: {}, trace: [] };
    }
    return {
      v: PROTO_V,
      agent: cfg.name,
      status: 'ok',
      answer,
      contextOut: filterKeys(env.context, cfg.contextToDownstream),
      trace: [...sub.trace, { agent: cfg.name, mode: 'fulfil', ms: Date.now() - t0 }],
    };
  }

  // ---------- outbound: full pipeline for an inquiry this agent received ----------

  /**
   * Run the whole protocol as up-chain: discover, determine fan-out,
   * short-circuit or adjudicate, fulfil fan-out, synthesize.
   * This is what a front-man calls on a user message, and what fulfil()
   * uses to recurse.
   */
  async function orchestrate(inquiry, opts = {}) {
    const corr = opts.corr ?? uuid();
    const hops = opts.hops ?? 0;
    const ttl = opts.ttl ?? tuning.ttl;
    const visited = opts.visited ?? [cfg.name];
    const deadlineMs = opts.deadlineMs ?? tuning.deadlineMs;
    const trace = [];

    let rawPeers = [];
    let discoverError = null;
    try {
      rawPeers = (await cfg.discoverPeers()) || [];
    } catch (e) {
      discoverError = e && e.message ? e.message : String(e);
      rawPeers = [];
    }
    const peers = rawPeers.filter((p) => !visited.includes(p.name));
    // Always record the discovery step: this is the trace line that explains
    // an empty fan-out (found 0? discovery threw? peers filtered by visited?).
    trace.push({
      mode: 'discover',
      found: rawPeers.length,
      consultable: peers.length,
      ...(discoverError ? { error: discoverError } : {}),
      ...(hops >= ttl ? { ttlStop: true } : {}),
    });

    if (peers.length === 0 || hops >= ttl) {
      return { answer: '', contributors: 0, trace, corr };
    }

    // 1. Parallel determine fan-out. A timeout IS a cannot-contribute claim.
    //    Per-peer outcomes land in the trace and in cfg.onPeerOutcome so the
    //    host can render live membership (claimed | declined | unreachable).
    const t0 = Date.now();
    const claims = await Promise.all(
      peers.map((p) =>
        postJson(`${p.url}/aaosa`, envelopeFor('determine', inquiry, { corr, hops, ttl, visited, deadlineMs, opts }), deadlineMs)
          .then((c) => ({ ...c, _peer: p, _outcome: c.canHandle ? 'claimed' : 'declined' }))
          .catch(() => ({ agent: p.name, canHandle: false, coverage: 'none', strength: 0, _peer: p, _outcome: 'unreachable' }))
      )
    );
    for (const c of claims) { try { cfg.onPeerOutcome?.(c._peer.name, c._outcome); } catch { /* observer only */ } }
    trace.push({
      mode: 'determine', ms: Date.now() - t0,
      peers: claims.map((c) => ({
        name: c._peer.name,
        outcome: c._outcome,
        // Surface WHY a peer declined (model judgment vs claim-parse error).
        ...(c._outcome === 'declined' && c.reason ? { reason: String(c.reason).slice(0, 200) } : {}),
      })),
    });

    const positive = claims.filter((c) => c.canHandle && c.coverage !== 'none');
    if (positive.length === 0) return { answer: '', contributors: 0, trace, corr };

    // 2. Short-circuit: one confident full-coverage speculative answer wins.
    // Guard the speculative HARD: a model (especially a small, token-capped one)
    // can claim full coverage yet hand back a junk "answer" — empty, the literal
    // "null"/"none", or a truncated fragment like "Full". Returning that verbatim
    // is the "answer":"Full" failure. Require a SUBSTANTIVE answer (min length +
    // more than a couple of words + not a known junk token); otherwise fall
    // through to the real fulfil pass, which produces a genuine answer.
    const solo = positive.length === 1 ? positive[0] : null;
    const spec = typeof solo?.speculative === 'string' ? solo.speculative.trim() : '';
    const realSpec = spec
      && !/^(null|none|n\/?a|undefined|tbd|full|partial|yes|no|ok|maybe|unknown)$/i.test(spec)
      && spec.length >= (tuning.shortCircuitMinChars || 24)
      && spec.split(/\s+/).length >= 5;
    if (tuning.shortCircuit && solo && solo.coverage === 'full'
        && (solo.strength ?? 0) >= tuning.shortCircuitStrength && realSpec) {
      trace.push({ mode: 'short_circuit', agent: solo.agent });
      return { answer: spec, contributors: 1, trace, corr };
    }

    // 3. Adjudicate structured claims with a routing-grade model.
    const plan = await routingLlm.chat({
      model: routingModel,
      json: true,
      system:
        `You are the orchestrator "${cfg.name}". Given an inquiry and structured claims from ` +
        `candidate agents, decide the delegation plan. Respond with JSON only:\n` +
        `{"tasks":[{"agent":str,"parts":[str],"requirements":{key:value}}]}\n` +
        `Resolve requirement values from the inquiry and context when possible. ` +
        `Only task agents whose claims justify it. ` +
        `Output ONLY the JSON object: no prose, no markdown, no thinking tags.`,
      user:
        `Inquiry: ${inquiry}\n` +
        `Context: ${JSON.stringify(opts.context ?? {})}\n` +
        `Claims: ${JSON.stringify(positive.map(({ _peer, _outcome, ...c }) => c))}`,
    }).catch(() => ({ tasks: positive.map((c) => ({ agent: c.agent, parts: c.parts ?? [], requirements: {} })) }));

    let tasked = (plan.tasks ?? []).map((t) => ({ t, claim: positive.find((c) => c.agent === t.agent) })).filter((x) => x.claim);
    // A flaky adjudicator can return an empty or agent-mismatched plan even
    // though peers claimed in determine. Don't silently drop a valid claim and
    // self-answer: fall back to tasking every positive claimant with the parts
    // it declared, and record it so the trace shows what happened.
    if (tasked.length === 0) {
      tasked = positive.map((c) => ({ t: { agent: c.agent, parts: c.parts ?? [], requirements: {} }, claim: c }));
      trace.push({ mode: 'adjudicate', outcome: 'empty_plan_defaulted', tasked: tasked.map((x) => x.claim.agent) });
    }

    // 4. Parallel fulfil fan-out.
    const t1 = Date.now();
    const results = await Promise.all(
      tasked.map(({ t, claim }) =>
        postJson(`${claim._peer.url}/aaosa`, envelopeFor('fulfil', inquiry, { corr, hops, ttl, visited, deadlineMs, opts, parts: t.parts, requirements: t.requirements }), deadlineMs * 2)
          .catch(() => ({ agent: claim.agent, status: 'timeout', answer: '' }))
      )
    );
    // status:ok with an empty body is NOT a contribution (e.g. a thinking
    // model that returned no visible content). Surface it as 'empty' so the
    // trace stops reading as a successful hand-off, and exclude it below.
    const outcomeOf = (r) => (r.status === 'ok' ? (String(r.answer ?? '').trim() ? 'ok' : 'empty') : r.status);
    for (const r of results) { try { cfg.onPeerOutcome?.(r.agent, outcomeOf(r)); } catch { /* observer only */ } }
    trace.push({
      mode: 'fulfil', ms: Date.now() - t1,
      peers: results.map((r) => ({ name: r.agent, outcome: outcomeOf(r) })),
    });

    const ok = results.filter((r) => outcomeOf(r) === 'ok');
    if (ok.length === 0) return { answer: '', contributors: 0, trace, corr };
    if (ok.length === 1) return { answer: ok[0].answer, contributors: 1, trace, corr };

    // 5. Synthesize multiple contributions.
    const merged = await routingLlm.chat({
      model: routingModel,
      system: `Merge the agent contributions into one coherent answer to the inquiry. No preamble.`,
      user: `Inquiry: ${inquiry}\n` + ok.map((r) => `[${r.agent}]\n${r.answer}`).join('\n\n'),
    }).catch(() => ok.map((r) => `${r.agent}: ${r.answer}`).join('\n'));

    return { answer: merged, contributors: ok.length, trace, corr };
  }

  function envelopeFor(mode, inquiry, { corr, hops, ttl, visited, deadlineMs, opts, parts, requirements }) {
    return {
      v: PROTO_V,
      id: uuid(),
      corr,
      mode,
      inquiry,
      ...(parts ? { parts } : {}),
      ...(requirements ? { requirements } : {}),
      context: filterKeys(opts?.context ?? {}, cfg.contextToDownstream),
      origin: { agent: cfg.name, node: cfg.nodeId || 'unknown' },
      hops,
      ttl,
      visited,
      deadlineMs,
    };
  }

  // discoverPeers is re-exposed so the mim's /mesh view and the consult path
  // (orchestrate) resolve membership through the exact same function — the /mesh
  // list can never drift from who orchestrate would actually fan out to.
  return {
    name: cfg.name,
    description: cfg.description,
    handleAaosa,
    orchestrate,
    discoverPeers: cfg.discoverPeers,
    descriptor: descriptor(cfg),
  };
}

// ---------- helpers ----------

function descriptor(cfg) {
  return {
    name: cfg.name,
    description: cfg.description,
    tags: cfg.tags ?? [],
    aaosa: { v: PROTO_V, endpoint: '/aaosa' },
    compat: { neuroSan: `/api/v1/${cfg.name}` },
  };
}

// Default-deny allowlist filter for context keys.
function filterKeys(obj, allow) {
  if (!obj) return {};
  const set = new Set(allow ?? []);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => set.has(k)));
}

async function defaultPostJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createAgent, PROTO_V };
