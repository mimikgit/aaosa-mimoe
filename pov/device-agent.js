#!/usr/bin/env node
// Raspberry Pi device agent for the 3-node PoV. Zero dependencies, Node 18+.
//
// Same AAOSA protocol as agent.js, plus a coded capability: live system
// metrics (CPU temperature, load, memory, uptime) gathered at fulfil time
// and injected into the work prompt, so answers quote real numbers.
// Also serves GET /metrics for the raw data.
//
//   NAME=pi_device_agent PORT=9102 \
//   INFERENCE_URL=http://<MBP1_IP>:8083/v1 ROUTING_MODEL=Qwen3.6-35B-A3B-Q4_K_M \
//   node pov/device-agent.js

'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const { createAgent } = require('../lib/aaosa');
const { makeLlm } = require('../lib/llm');

const NAME = process.env.NAME ?? 'pi_device_agent';
const PORT = Number(process.env.PORT ?? 9102);

function readCpuTempC() {
  // Raspberry Pi (incl. Ubuntu): millidegrees in sysfs. Absent elsewhere.
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return Math.round(Number(raw.trim()) / 100) / 10;
  } catch {
    return null;
  }
}

async function gatherFacts() {
  const [l1, l5, l15] = os.loadavg();
  return {
    host: os.hostname(),
    arch: os.arch(),
    cpuTempC: readCpuTempC(),
    loadAvg: { '1m': round2(l1), '5m': round2(l5), '15m': round2(l15) },
    cores: os.cpus().length,
    memory: {
      totalMB: Math.round(os.totalmem() / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    uptimeHours: round2(os.uptime() / 3600),
    sampledAt: new Date().toISOString(),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

const llm = makeLlm({
  baseUrl: process.env.INFERENCE_URL ?? 'http://127.0.0.1:8083/v1',
  apiKey: process.env.INFERENCE_API_KEY,
  maxTokens: Number(process.env.INFERENCE_MAX_TOKENS) || undefined,
  enableThinking: process.env.INFERENCE_ENABLE_THINKING === '1',
  timeoutMs: Number(process.env.INFERENCE_TIMEOUT_MS) || undefined,
});

const agent = createAgent({
  name: NAME,
  description:
    process.env.DESCRIPTION ??
    'Reports the live health of this Raspberry Pi device: CPU temperature, load, memory, uptime. Owns any question about this device\'s current state or capacity.',
  instructions:
    process.env.INSTRUCTIONS ??
    'You report on this device\'s live state. Use the provided live device data only; never invent numbers. Flag CPU temperature above 80C as throttling risk.',
  llm,
  // Either name alone configures both phases.
  routingModel: process.env.ROUTING_MODEL ?? process.env.WORK_MODEL ?? 'Qwen3.6-35B-A3B-Q4_K_M',
  workModel: process.env.WORK_MODEL ?? process.env.ROUTING_MODEL ?? 'Qwen3.6-35B-A3B-Q4_K_M',
  gatherFacts,
  // Leaf agent: no down-chain peers by default.
  async discoverPeers() {
    const urls = (process.env.PEERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const peers = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(`${url}/descriptor`, { signal: AbortSignal.timeout(1500) });
          const d = await res.json();
          return { name: d.name, url, description: d.description };
        } catch { return null; }
      })
    );
    return peers.filter(Boolean);
  },
  tuning: { deadlineMs: Number(process.env.DEADLINE_MS ?? 15000) },
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/descriptor') return sendJson(res, 200, agent.descriptor);
    if (req.method === 'GET' && url.pathname === '/metrics') return sendJson(res, 200, await gatherFacts());
    if (req.method === 'POST' && url.pathname === '/aaosa') return sendJson(res, 200, await agent.handleAaosa(await readJson(req)));
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`[aaosa] ${NAME} (device agent) listening on :${PORT}`));

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
