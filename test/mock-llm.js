#!/usr/bin/env node
// Offline mock of an OpenAI-compatible /chat/completions endpoint.
// Lets the whole multi-node agent system run with zero real inference,
// for wiring tests and demos on airplanes. PORT env, default 8099.

'use strict';
const http = require('node:http');

const PORT = Number(process.env.PORT ?? 8099);

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    let out = 'mock';
    try {
      const body = JSON.parse(data || '{}');
      const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';

      if (system.includes('Decide whether any part')) {
        // determine: claim a part, never speculative, so the full path runs
        out = JSON.stringify({
          canHandle: true, coverage: 'partial', strength: 0.7,
          parts: ['my specialty'], requirements: [], speculative: null, reason: 'mock claim',
        });
      } else if (system.includes('orchestrator')) {
        // adjudicate: task every claimant
        const claims = JSON.parse(user.slice(user.indexOf('Claims: ') + 8));
        out = JSON.stringify({ tasks: claims.map((c) => ({ agent: c.agent, parts: c.parts ?? [], requirements: {} })) });
      } else if (system.includes('Merge the agent contributions')) {
        out = 'SYNTH: ' + user.split('\n').filter((l) => l.startsWith('[')).join(' + ');
      } else {
        out = 'WORK' + (user.includes('Live device data') ? '-WITH-FACTS' : '') + ' by mock';
      }
    } catch (e) {
      out = `mock error: ${e.message}`;
    }
    const payload = JSON.stringify({ choices: [{ message: { role: 'assistant', content: out } }] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
});

server.listen(PORT, () => console.log(`[mock-llm] listening on :${PORT}`));
