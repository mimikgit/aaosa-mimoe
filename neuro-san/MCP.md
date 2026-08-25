# Exposing the agents over MCP (and publishing to mimOE's MCP gateway)

This is the MCP path to neuro-san: each agent now speaks **Model Context
Protocol** and can be published as a tool to **mimOE's built-in MCP gateway**,
which you do in **mimOE Studio** (RUNBOOK section D.2).
neuro-san then reaches the front agent as an MCP tool through that server — no
adapter, because MCP clients connect to whatever URL they're given (the base-path
problem that forced an adapter for neuro-san's *external-agent* surface simply
doesn't exist here).

```
   neuro-san  ──MCP──▶  mimOE MCP gateway  ──MCP──▶  front_man mim  /mcp
   (MCP client)         (tool registry/gateway)     tools/call { inquiry } → mesh
                              ▲
                              │  POST /mcp/register  (agent announces its tool)
                              └────────────────────  front_man / network_agent / pi_device_agent
```

## What the agent now serves

Under the mim's base path (`…/mimik-aaosa/agent/v1`):

- `POST /mcp` — a JSON-RPC 2.0 MCP endpoint: `initialize`, `tools/list`,
  `tools/call`, `ping`, and the `initialized` notification. It advertises **one
  tool** — this agent — taking a single `inquiry` string. `tools/call` runs the
  mesh (same path as `/chat`) and returns the answer as MCP text content.
- `POST /mcp/register` — scripted alternative to Studio: announces this tool to a
  registration endpoint (idempotent). See RUNBOOK D.3.
- `GET  /mcp/descriptor` — the tool descriptor (name, description, input schema).
- `GET  /mcp` — returns 405: no server→client SSE stream is offered, so MCP
  clients use plain POST request/response.

The MCP server is built with **`@mimik/mcp-kit`** — mimik's own MCP library for
the serverless mim runtime (zero-dep, bundled into the ES5 addon). The mim just
registers one tool and hands each request to `server.handleMcpRequest(body)`; the
kit does the JSON-RPC, schema validation (Zod-like), and result wrapping. It's
covered end-to-end against the shipped bundle by `test/mcp-sim.js`.

## Publishing to the gateway

The supported path is **mimOE Studio**: RUNBOOK section D.2 lists the exact values
the gateway needs. What follows is the scripted alternative (RUNBOOK D.3).

Set the registry endpoint (and, if the mesh is up, install auto-registers):

```sh
# on each node, before install:
export MCP_REGISTRY_URL="http://<mimik-mcp-host>:8083/<registration-path>"
export MCP_REGISTER_TOKEN="$INSIGHT_TOKEN"   # or a dedicated edge JWT
bash pov/install-addon.sh frontman           # network / device on the others
```

`install-addon.sh` bakes these into the node's ini and, if `MCP_REGISTRY_URL` is
set, POSTs `/mcp/register` after the restart. `MCP_SELF_URL` (the callback URL the
registry stores) defaults to this node's own `…/mimik-aaosa/agent/v1/mcp`. You can
re-register any time:

```sh
curl -s -X POST "$FRONT_URL/mcp/register"
# -> {"registered":true,"registryUrl":"…","record":{…},"result":{…}}
```

### The one thing to confirm — the registration envelope (the seam)

mimik's registry API is proprietary, so the agent POSTs a **neutral** record and
you align it to your server's expected shape in one place. What it sends today:

```json
{
  "name": "front_man",
  "description": "Coordinates lab operations inquiries across the mesh.",
  "inputSchema": { "type": "object",
    "properties": { "inquiry": { "type": "string", "description": "…" } },
    "required": ["inquiry"] },
  "transport": "streamable-http",
  "url": "http://192.168.1.101:8083/mimik-aaosa/agent/v1/mcp",
  "agent": "front_man",
  "type": "mcp-tool"
}
```

…with `Authorization: Bearer <MCP_REGISTER_TOKEN>`. The tool spec (`name`,
`description`, `inputSchema`) comes straight from the `@mimik/mcp-kit` server;
only the surrounding envelope is hand-built. If your registration endpoint wants a
different envelope (different keys, a wrapper object, a different auth), change the
one `record` in `registerWithMcp()` in `mim/src/index.js` — nothing else moves.
Tell me the exact shape your server expects and I'll pin it.

## Smoke-test the MCP surface directly (no MCP server needed)

```sh
# list tools
curl -s "$FRONT_URL/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# call the tool (runs the whole mesh)
curl -s "$FRONT_URL/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"front_man","arguments":{"inquiry":"how hot is the pi and can we add a second one?"}}}'
# -> {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"…mesh answer…"}],"isError":false}}
```

## Connecting neuro-san (your step)

neuro-san consumes MCP tools, so once the front agent is registered you point
neuro-san's MCP client at the mimOE MCP gateway and the `front_man` tool appears
alongside its native agents. If you'd rather skip the central registry for a first
test, neuro-san (or any MCP client) can connect **straight to the mim**:
`http://192.168.1.101:8083/mimik-aaosa/agent/v1/mcp`. Either way the agent side is
identical — that's the point of doing it over MCP.

## Which integration to use

- **MCP (this file)** — cleanest: no adapter, standard protocol, one tool per
  node, and it works with anything that speaks MCP (neuro-san, Claude, others),
  not just neuro-san.
- **neuro-san external agent + adapter** (`neuro-san/README.md`) — use if you
  specifically want the agents to appear as neuro-san *external agents* rather
  than MCP tools.
