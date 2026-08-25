#!/usr/bin/env node
// Primary discovery path (mimik-native mInsight), verified two ways:
//
//   A. UNIT: lib/discovery.js parses a CAPTURED real mInsight
//      /nodes?type=linkLocal response into aaosa peer base URLs.
//   B. END-TO-END: the SHIPPED bundle (mim/build/index.js) answers GET /mesh
//      by interrogating a mocked mimOE mInsight (same context.http shape mimOE
//      uses) and probing each candidate's /descriptor — proving /mesh is
//      sourced entirely from mInsight and keeps the v49 output shape.
//
// Run: node test/discovery-sim.js   (also invoked by test/mim-sim.sh)
'use strict';

const path = require('node:path');
const assert = require('node:assert');

// A captured mInsight link-local response: 5 nodes, 3 run the aaosa service
// (.11 network, .103 pi, .214 self/front), 2 run inference only (.101, .102).
const INSIGHT_NODES = {
  type: 'linkLocal',
  data: [
    { url: 'http://192.168.1.11:8083', nodeName: 'Misterwolf-Mac',
      addresses: [{ type: 'local', url: { href: 'http://192.168.1.11:8083' } }],
      services: [
        { id: 'mimik-ai-openai-v1', self: '/mimik-ai/openai/v1', serviceType: 'mimik-ai-openai-v1', tenant: { id: 'mimik-ai' } },
        { id: 'mimik-aaosa-aaosa-agent-v1', self: '/mimik-aaosa/agent/v1', serviceType: 'mimik-aaosa-aaosa-agent-v1', tenant: { id: 'mimik-aaosa' } },
      ] },
    { url: 'http://192.168.1.103:8083', nodeName: 'raspberrypi3',
      addresses: [{ type: 'local', url: { href: 'http://192.168.1.103:8083' } }],
      services: [
        { id: 'mimik-aaosa-aaosa-agent-v1', self: '/mimik-aaosa/agent/v1', serviceType: 'mimik-aaosa-aaosa-agent-v1', tenant: { id: 'mimik-aaosa' } },
      ] },
    { url: 'http://192.168.1.102:8083', nodeName: 'raspberrypi2',
      services: [{ id: 'mimik-ai-openai-v1', self: '/mimik-ai/openai/v1', serviceType: 'mimik-ai-openai-v1', tenant: { id: 'mimik-ai' } }] },
    { url: 'http://192.168.1.101:8083', nodeName: 'raspberrypi1',
      services: [{ id: 'mimik-ai-openai-v1', self: '/mimik-ai/openai/v1', serviceType: 'mimik-ai-openai-v1', tenant: { id: 'mimik-ai' } }] },
    { url: 'http://192.168.1.214:8083', nodeName: 'Michels-MacBook-Pro',
      addresses: [{ type: 'local', url: { href: 'http://192.168.1.214:8083' } }],
      services: [
        { id: 'mimik-ai-openai-v1', self: '/mimik-ai/openai/v1', serviceType: 'mimik-ai-openai-v1', tenant: { id: 'mimik-ai' } },
        { id: 'mimik-aaosa-aaosa-agent-v1', self: '/mimik-aaosa/agent/v1', serviceType: 'mimik-aaosa-aaosa-agent-v1', tenant: { id: 'mimik-aaosa' } },
      ] },
  ],
};

// ---------- A. parser unit test ----------
const { extractAaosaPeerUrls, aaosaService } = require(path.join(__dirname, '..', 'lib', 'discovery'));
const urls = extractAaosaPeerUrls(INSIGHT_NODES, { match: 'aaosa', basePath: '' });
assert.deepStrictEqual(urls, [
  'http://192.168.1.11:8083/mimik-aaosa/agent/v1',
  'http://192.168.1.103:8083/mimik-aaosa/agent/v1',
  'http://192.168.1.214:8083/mimik-aaosa/agent/v1',
], 'parser must return exactly the 3 aaosa node URLs (node.url + service self)');
assert.strictEqual(aaosaService(INSIGHT_NODES.data[2], 'aaosa'), null, 'inference-only node has no aaosa service');
console.log('A. parser: PASS (3 aaosa URLs; inference-only .101/.102 excluded)');

// ---------- B. end-to-end /mesh through the shipped bundle ----------
const DESCRIPTORS = {
  'http://192.168.1.11:8083/mimik-aaosa/agent/v1/descriptor':  { name: 'network_agent', description: 'network', kind: 'specialist' },
  'http://192.168.1.103:8083/mimik-aaosa/agent/v1/descriptor': { name: 'pi_device_agent', description: 'pi', kind: 'device' },
  'http://192.168.1.214:8083/mimik-aaosa/agent/v1/descriptor': { name: 'front_man', description: 'self', kind: 'frontman' },
};
const storeMap = {};
const context = {
  env: { NAME: 'front_man', AGENT_KIND: 'frontman', INSIGHT_TOKEN: 'edge-jwt', DISCOVERY_SCOPE: 'linkLocal',
    INFERENCE_URL: 'http://192.168.1.11:8083/mimik-ai/openai/v1', ROUTING_MODEL: 'mock' },
  edge: {},
  storage: { getItem: (k) => (k in storeMap ? storeMap[k] : null), setItem: (k, v) => { storeMap[k] = String(v); } },
  http: {
    request(opts) {
      const url = opts.url;
      if (url.indexOf('/mimik-mesh/insight/v1/nodes') >= 0) {
        if (!opts.authorization || opts.authorization.indexOf('Bearer edge-jwt') < 0) return opts.error({ message: 'missing bearer' });
        return opts.success({ data: JSON.stringify(INSIGHT_NODES) });
      }
      if (url in DESCRIPTORS) return opts.success({ data: JSON.stringify(DESCRIPTORS[url]) });
      return opts.error({ message: 'unexpected url ' + url });
    },
  },
};

global.mimikModule = { exports: null };
require(path.join(__dirname, '..', 'mim', 'build', 'index.js'));
const entry = global.mimikModule.exports;
assert.strictEqual(typeof entry, 'function', 'bundle must set mimikModule.exports');

function call(method, url) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, end(b) { resolve({ status: this.statusCode, json: JSON.parse(b || '{}') }); } };
    entry(context, { method, url }, res);
  });
}

(async () => {
  const { status, json } = await call('GET', '/mesh');
  assert.strictEqual(status, 200, '/mesh returns 200');
  const names = json.peers.map((p) => p.name).sort();
  assert.strictEqual(json.self, 'front_man');
  assert.deepStrictEqual(names, ['network_agent', 'pi_device_agent'], 'self excluded; inference-only excluded; 2 peers left');
  const byName = Object.fromEntries(json.peers.map((p) => [p.name, p]));
  assert.strictEqual(byName.network_agent.url, 'http://192.168.1.11:8083/mimik-aaosa/agent/v1');
  assert.strictEqual(byName.pi_device_agent.url, 'http://192.168.1.103:8083/mimik-aaosa/agent/v1');
  // v49 output shape preserved.
  assert.deepStrictEqual(Object.keys(json).sort(), ['peers', 'self', 'staleMs', 'staticPeers']);
  for (const p of json.peers) {
    assert.deepStrictEqual(Object.keys(p).sort(), ['fresh', 'lastSeenAgoMs', 'name', 'state', 'url']);
    assert.strictEqual(p.fresh, true, 'mInsight-discovered peers are live -> fresh');
  }
  assert.deepStrictEqual(json.staticPeers, [], 'no static PEERS env');
  console.log('B. /mesh e2e: PASS (2 peers from mInsight, self+inference-only dropped, v49 shape)');
  console.log('DISCOVERY_SIM_PASS');
})().catch((e) => { console.error('DISCOVERY_SIM_FAIL:', e.message); process.exit(1); });
