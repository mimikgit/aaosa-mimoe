#!/usr/bin/env node
// Drives the SHIPPED bundle's /mcp surface exactly as an MCP client (neuro-san,
// the mimik MCP gateway, Claude) would: initialize -> tools/list -> tools/call,
// plus the initialized notification, GET (SSE-not-offered), and /mcp/register.
// A mock context.http supplies inference + swallows the registry POST, so no
// real mesh or network is needed.
'use strict';

const assert = require('node:assert');
const path = require('node:path');

global.mimikModule = { exports: null };

const registryHits = [];
const env = {
  NAME: 'front_man', AGENT_KIND: 'frontman',
  DESCRIPTION: 'Coordinates lab operations inquiries across the mesh.',
  INFERENCE_URL: 'http://mock/openai/v1', INFERENCE_API_KEY: 'k',
  ROUTING_MODEL: 'mock', WORK_MODEL: 'mock',
  INSIGHT_TOKEN: 't', DISCOVERY_SCOPE: 'linkLocal',
  MCP_REGISTRY_URL: 'http://mock-registry/mcp/tools',
  MCP_SELF_URL: 'http://192.168.1.214:8083/mimik-aaosa/agent/v1/mcp',
};
const storeMap = {};
const context = {
  env,
  edge: {},
  storage: { getItem: (k) => (k in storeMap ? storeMap[k] : null), setItem: (k, v) => { storeMap[k] = String(v); } },
  http: {
    request(opts) {
      const url = opts.url;
      if (url.indexOf('/chat/completions') >= 0) {
        return opts.success({ data: JSON.stringify({ choices: [{ message: { content: 'MOCK_ANSWER', reasoning_content: '' }, finish_reason: 'stop' }] }) });
      }
      if (url.indexOf('/mimik-mesh/insight') >= 0) {
        return opts.success({ data: JSON.stringify({ data: [] }) }); // no peers -> self-answer
      }
      if (url === env.MCP_REGISTRY_URL) {
        registryHits.push({ auth: opts.authorization || '', body: JSON.parse(opts.data) });
        return opts.success({ data: JSON.stringify({ ok: true, id: 'reg-1' }) });
      }
      return opts.error({ message: 'unexpected url ' + url });
    },
  },
};

require(path.join(__dirname, '..', 'mim', 'build', 'index.js'));
const entry = global.mimikModule.exports;
assert.strictEqual(typeof entry, 'function', 'bundle set mimikModule.exports');

function call(method, url, bodyObj) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, _b: '',
      end(b) { this._b = b || ''; let j = null; try { j = this._b ? JSON.parse(this._b) : null; } catch {} resolve({ status: this.statusCode, text: this._b, json: j }); },
    };
    entry(context, { method, url, body: bodyObj != null ? JSON.stringify(bodyObj) : undefined }, res);
  });
}

(async () => {
  // 1) initialize
  const init = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.strictEqual(init.status, 200);
  assert.strictEqual(init.json.jsonrpc, '2.0');
  assert.strictEqual(init.json.result.protocolVersion, '2025-06-18', 'echoes client protocol version');
  assert.ok(init.json.result.capabilities.tools, 'advertises tools capability');
  assert.ok(init.json.result.serverInfo.name, 'has serverInfo');
  console.log('1. initialize: PASS');

  // 2) initialized notification -> no body, 202
  const note = await call('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(note.status, 202, 'notification -> 202');
  assert.strictEqual(note.text, '', 'notification -> empty body');
  console.log('2. notifications/initialized: PASS (202, no body)');

  // 3) tools/list -> exactly one tool, our agent, requiring `inquiry`
  const list = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = list.json.result.tools;
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'front_man');
  assert.ok(tools[0].description, 'tool has a description');
  assert.deepStrictEqual(tools[0].inputSchema.required, ['inquiry']);
  console.log('3. tools/list: PASS (front_man, inquiry required)');

  // 4) tools/call -> runs the mesh, returns text content (kit wraps the string)
  const res4 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'front_man', arguments: { inquiry: 'how hot is the pi?' } } });
  assert.ok(!res4.json.error, 'no protocol error');
  assert.notStrictEqual(res4.json.result.isError, true, 'not an error result');
  assert.strictEqual(res4.json.result.content[0].type, 'text');
  assert.strictEqual(res4.json.result.content[0].text, 'MOCK_ANSWER', 'tool answer came from the mesh');
  console.log('4. tools/call: PASS (mesh answer as text content)');

  // 5) tools/call unknown tool -> JSON-RPC error
  const res5 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: { inquiry: 'x' } } });
  assert.strictEqual(res5.json.error.code, -32602, 'unknown tool -> invalid params');
  console.log('5. tools/call unknown tool: PASS (-32602)');

  // 6) missing inquiry -> the kit validates the schema -> -32602 invalid params
  const res6 = await call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'front_man', arguments: {} } });
  assert.strictEqual(res6.json.error.code, -32602, 'missing required inquiry -> invalid params');
  assert.match(res6.json.error.message, /inquiry/i, 'error names the missing param');
  console.log('6. tools/call missing inquiry: PASS (-32602 schema validation by the kit)');

  // 7) GET /mcp -> 405 (no SSE offered)
  const g = await call('GET', '/mcp');
  assert.strictEqual(g.status, 405, 'GET /mcp -> 405');
  console.log('7. GET /mcp: PASS (405, SSE not offered)');

  // 8) /mcp/register -> announces the tool to the mimik MCP server
  const reg = await call('POST', '/mcp/register', {});
  assert.strictEqual(reg.json.registered, true, 'registration reported success');
  assert.strictEqual(registryHits.length, 1, 'exactly one registry POST');
  assert.strictEqual(registryHits[0].body.name, 'front_man', 'registered under the agent name');
  assert.strictEqual(registryHits[0].body.url, env.MCP_SELF_URL, 'registered this mim\'s /mcp url');
  assert.deepStrictEqual(registryHits[0].body.inputSchema.required, ['inquiry'], 'registered the input schema');
  assert.match(registryHits[0].auth, /^Bearer /, 'sent a bearer token');
  console.log('8. /mcp/register: PASS (announced name+url+schema with bearer)');

  console.log('\nMCP_SIM_PASS');
  process.exit(0);
})().catch((e) => { console.error('MCP_SIM_FAIL:', e.message); process.exit(1); });
