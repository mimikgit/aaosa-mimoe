#!/usr/bin/env node
// Local emulation host for the bundled mim: provides the mimikModule global
// and a context shaped like mimOE's (env, http.request with success/error
// callbacks), bridges a real HTTP port to the serverless handler. Lets the
// exact bundle that ships to mCM run on any machine for wiring tests.
//
//   PORT=9300 ENV_JSON='{"NAME":"front_man",...}' node test/mim-host.js

'use strict';

const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT ?? 9300);
const env = JSON.parse(process.env.ENV_JSON ?? '{}');

// ---- mimOE-shaped outbound http (callback style over fetch) ----
const contextHttp = {
  request(opts) {
    const { type = 'GET', url, data, success, error } = opts;
    fetch(url, {
      method: type,
      headers: { 'content-type': 'application/json' },
      ...(data != null ? { body: data } : {}),
    })
      .then(async (r) => success({ data: await r.text(), status: r.status }))
      .catch((e) => error({ message: e.message }));
  },
};

// localStorage-like persistent storage, as mimOE provides (getItem/setItem/eachItem)
const storeMap = {};
const storage = {
  getItem: (k) => (k in storeMap ? storeMap[k] : null),
  setItem: (k, v) => { storeMap[k] = String(v); },
  removeItem: (k) => { delete storeMap[k]; },
  eachItem: (fn) => { for (const k of Object.keys(storeMap)) fn(k, storeMap[k]); },
};

const context = { env, http: contextHttp, edge: {}, storage };

// ---- load the bundle exactly as mimOE would ----
global.mimikModule = { exports: null };
require(path.join(__dirname, '..', 'mim', 'build', 'index.js'));
const handler = global.mimikModule.exports;
if (typeof handler !== 'function') {
  console.error('bundle did not set mimikModule.exports');
  process.exit(1);
}

// ---- bridge real HTTP to the serverless handler ----
const server = http.createServer((nodeReq, nodeRes) => {
  let body = '';
  nodeReq.on('data', (c) => (body += c));
  nodeReq.on('end', () => {
    const req = { url: nodeReq.url, method: nodeReq.method, body: body || undefined };
    const res = {
      statusCode: 200,
      end: (payload) => {
        nodeRes.writeHead(res.statusCode, { 'content-type': 'application/json' });
        nodeRes.end(payload);
      },
    };
    try {
      handler(context, req, res);
    } catch (e) {
      nodeRes.writeHead(500);
      nodeRes.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log(`[mim-host] ${env.NAME ?? 'mim'} on :${PORT}`));
