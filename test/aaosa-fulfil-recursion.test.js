// Verifies the fulfil-recursion gate: a leaf specialist (delegatesInFulfil:false)
// must NOT re-orchestrate/consult peers inside fulfil (the cause of the
// network_agent 20s timeout), while a delegating agent still recurses.
const assert = require('assert');
const { createAgent } = require('../lib/aaosa.js');

let peerConsulted = false;
function llm() {
  return { async chat({ json }) {
    if (json) return { canHandle: true, coverage: 'partial', strength: 0.5, parts: ['x'], requirements: [] };
    return 'specialist direct answer';
  } };
}
function makeSpecialist(delegates) {
  return createAgent({
    name: 'network_agent', description: 'net', instructions: 'net',
    llm: llm(), routingModel: 'mock', workModel: 'mock',
    delegatesInFulfil: delegates,
    discoverPeers: async () => [{ name: 'front_man', url: 'mem://front', description: 'front' }],
    postJson: async (url) => {
      if (url.indexOf('mem://front') === 0) { peerConsulted = true; return { v: '0.1', agent: 'front_man', canHandle: false, coverage: 'none' }; }
      throw new Error('no route');
    },
  });
}
const env = (id) => ({ v: '0.1', id, corr: 'c', mode: 'fulfil', inquiry: 'q', context: {}, hops: 0, ttl: 4, visited: [], deadlineMs: 5000 });

(async () => {
  // leaf: must NOT recurse -> peer never consulted, answers directly
  peerConsulted = false;
  let r = await makeSpecialist(false).handleAaosa(env('1'));
  assert.strictEqual(peerConsulted, false, 'leaf specialist must NOT recurse/consult peers in fulfil');
  assert.strictEqual(r.answer, 'specialist direct answer', 'leaf answers directly');

  // coordinator: recurses -> peer consulted in the nested determine
  peerConsulted = false;
  await makeSpecialist(true).handleAaosa(env('2'));
  assert.strictEqual(peerConsulted, true, 'delegating agent recurses and consults peers');

  console.log('aaosa.js fulfil-recursion gate test: PASS (leaf skips recursion; coordinator recurses)');
})().catch((e) => { console.error('TEST FAIL:', e.stack || e.message); process.exit(1); });
