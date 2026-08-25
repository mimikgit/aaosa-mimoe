// Turn a mimOE mInsight `/nodes` response into aaosa-agent peer base URLs.
//
// Pinned to the real mInsight link-local schema:
//   { "type":"linkLocal", "data":[ {
//       "url":"http://192.168.1.11:8083",
//       "addresses":[ { "type":"local", "url":{ "href":"http://192.168.1.11:8083" } } ],
//       "services":[ { "id":"mimik-aaosa-aaosa-agent-v1",
//                      "self":"/mimik-aaosa/agent/v1",
//                      "serviceType":"mimik-aaosa-aaosa-agent-v1",
//                      "tenant":{ "id":"mimik-aaosa" } }, ... ]
//   }, ... ] }
//
// This is the ONLY place the schema is read. The peer URL is node.url + the
// aaosa service's own `self` path, so we never hard-code the base path. Pure
// (no I/O) so it's unit-tested against a captured real response.

'use strict';

// Base URL ("http://host:port") of a node from its mInsight record.
function nodeBaseUrl(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.url === 'string' && node.url) return node.url.replace(/\/+$/, '');
  if (Array.isArray(node.addresses)) {
    for (const a of node.addresses) {
      const href = a && a.url && (a.url.href || a.url);
      if (typeof href === 'string' && href) return href.replace(/\/+$/, '');
      if (typeof a === 'string' && a) return a.replace(/\/+$/, '');
    }
  }
  const ni = node.localLinkNetworkInfo || node.networkInfo || {};
  const host = node.address || node.ip || ni.address || '';
  return host ? `http://${host}:8083` : '';
}

function servicesOf(node) {
  const s = node && (node.services || node.microservices || node.mimServices);
  return Array.isArray(s) ? s : [];
}

// The aaosa service running on a node, or null. Identified by `match` (default
// "aaosa") appearing in the service's serviceType / id / self / tenant.id.
// mInsight only lists running services, so absence of a status means running.
function aaosaService(node, match) {
  const needle = String(match || 'aaosa').toLowerCase();
  return servicesOf(node).find((s) => {
    if (!s || typeof s !== 'object') return false;
    const status = String(s.status || 'running').toLowerCase();
    if (status !== 'running' && status !== 'active' && status !== 'online') return false;
    const hay = `${s.serviceType || ''} ${s.id || ''} ${s.self || ''} ${(s.tenant && s.tenant.id) || ''}`.toLowerCase();
    return hay.indexOf(needle) >= 0;
  }) || null;
}

// mInsight response -> deduped list of aaosa peer base URLs (node.url + self).
// `opts.basePath` overrides the service's `self` path if ever needed.
function extractAaosaPeerUrls(body, opts) {
  opts = opts || {};
  const match = opts.match || 'aaosa';
  const nodes = Array.isArray(body) ? body : (body && (body.data || body.nodes || body.results)) || [];
  const urls = [];
  const seen = {};
  for (const node of nodes) {
    const svc = aaosaService(node, match);
    if (!svc) continue;
    const base = nodeBaseUrl(node);
    if (!base) continue;
    let path = opts.basePath || svc.self || '/mimik-aaosa/agent/v1';
    if (path.charAt(0) !== '/') path = `/${path}`;
    const url = `${base}${path}`.replace(/\/+$/, '');
    if (!seen[url]) { seen[url] = true; urls.push(url); }
  }
  return urls;
}

module.exports = { extractAaosaPeerUrls, nodeBaseUrl, servicesOf, aaosaService };
