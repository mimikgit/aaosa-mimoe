// Verifies the split routing endpoint: when cfg.routingLlm is given, the
// ROUTING phases (determine, adjudicate, synthesize) must go to that client
// while WORK (fulfil) stays on cfg.llm. Without it, everything falls back to
// cfg.llm, which is the single-endpoint behaviour every existing node has.
const assert = require('assert');
const { createAgent } = require('../lib/aaosa.js');

// A client that records every call it receives and answers plausibly for both
// the JSON routing calls and the prose work call.
function recorder(tag, calls) {
  return {
    async chat({ model, json }) {
      calls.push({ endpoint: tag, model, json: !!json });
      if (json) {
        // Serves both determine (a claim) and adjudicate (a plan). The agent
        // reads whichever fields it needs and ignores the rest.
        return {
          canHandle: true, coverage: 'partial', strength: 0.5,
          parts: ['x'], requirements: [], speculative: null,
          tasks: [{ agent: 'peer_agent', parts: ['x'], requirements: {} }],
        };
      }
      return `${tag} prose answer`;
    },
  };
}

function agentWith(routingLlm, calls) {
  return createAgent({
    name: 'network_agent', description: 'net', instructions: 'net',
    llm: recorder('WORK', calls),
    ...(routingLlm ? { routingLlm } : {}),
    routingModel: 'routing-model', workModel: 'work-model',
    delegatesInFulfil: false,
    discoverPeers: async () => [],
    postJson: async () => { throw new Error('no peers in this test'); },
  });
}

(async () => {
  // ---- 1. split: determine on ROUTE, fulfil on WORK ----
  let calls = [];
  let agent = agentWith(recorder('ROUTE', calls), calls);

  await agent.handleAaosa({ v: '0.1', id: 'd1', mode: 'determine', inquiry: 'q', hops: 0, ttl: 4, visited: [] });
  const determineCall = calls.find((c) => c.model === 'routing-model');
  assert.ok(determineCall, 'determine made a routing-model call');
  assert.strictEqual(determineCall.endpoint, 'ROUTE',
    'determine must use the routing endpoint, not the work endpoint');

  calls.length = 0;
  await agent.handleAaosa({ v: '0.1', id: 'f1', mode: 'fulfil', inquiry: 'q', hops: 0, ttl: 4, visited: [] });
  const workCall = calls.find((c) => c.model === 'work-model');
  assert.ok(workCall, 'fulfil made a work-model call');
  assert.strictEqual(workCall.endpoint, 'WORK',
    'fulfil must stay on the work endpoint even when routing is split off-node');
  assert.ok(!calls.some((c) => c.endpoint === 'ROUTE'),
    'fulfil must not touch the routing endpoint');

  // ---- 2. no routingLlm: everything falls back to cfg.llm ----
  calls = [];
  agent = agentWith(null, calls);
  await agent.handleAaosa({ v: '0.1', id: 'd2', mode: 'determine', inquiry: 'q', hops: 0, ttl: 4, visited: [] });
  await agent.handleAaosa({ v: '0.1', id: 'f2', mode: 'fulfil', inquiry: 'q', hops: 0, ttl: 4, visited: [] });
  assert.ok(calls.length >= 2, 'both phases called the llm');
  assert.ok(calls.every((c) => c.endpoint === 'WORK'),
    'with no routingLlm every phase must use cfg.llm (unchanged single-endpoint behaviour)');

  // ---- 3. the models are still distinct per phase ----
  assert.ok(calls.some((c) => c.model === 'routing-model'), 'routing model still used for determine');
  assert.ok(calls.some((c) => c.model === 'work-model'), 'work model still used for fulfil');

  // ---- 4. the two model names default to each other ----
  // Only workModel given: routing must reuse it, not fall back to undefined.
  calls = [];
  let onlyWork = createAgent({
    name: 'a', description: 'd', instructions: 'i',
    llm: recorder('WORK', calls), workModel: 'solo-model',
    delegatesInFulfil: false, discoverPeers: async () => [],
    postJson: async () => { throw new Error('none'); },
  });
  await onlyWork.handleAaosa({ v: '0.1', id: 'd3', mode: 'determine', inquiry: 'q', hops: 0, ttl: 4, visited: [] });
  assert.strictEqual(calls[0].model, 'solo-model',
    'routingModel must default to workModel when only workModel is set');

  // Only routingModel given: fulfil must reuse it.
  calls = [];
  let onlyRouting = createAgent({
    name: 'a', description: 'd', instructions: 'i',
    llm: recorder('WORK', calls), routingModel: 'solo-model',
    delegatesInFulfil: false, discoverPeers: async () => [],
    postJson: async () => { throw new Error('none'); },
  });
  await onlyRouting.handleAaosa({ v: '0.1', id: 'f3', mode: 'fulfil', inquiry: 'q', hops: 0, ttl: 4, visited: [] });
  assert.strictEqual(calls[0].model, 'solo-model',
    'workModel must default to routingModel when only routingModel is set');

  console.log('ROUTING_ENDPOINT_PASS: routingLlm honoured, fulfil stays on llm, model names default to each other');
})().catch((e) => { console.error('ROUTING_ENDPOINT_FAIL', e.message); process.exit(1); });
