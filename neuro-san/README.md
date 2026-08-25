# Running the three mimOE agents on top of neuro-san

This wires your mimOE AAOSA mesh into a neuro-san agent network. neuro-san sits
on top as the orchestrator; all three mimOE agents are exposed as **external
agents**, so the neuro-san coordinator can hand a whole inquiry to the mesh
(`front_man`) or reach a single specialist directly (`network_agent`,
`pi_device_agent`).

```
          ┌─────────────────────────── neuro-san server (:8080) ───────────────────────────┐
  user ──▶│  lab_coordinator (LLM)                                                          │
          │     tools: http://adapter:4747/{front_man,network_agent,pi_device_agent}        │
          └───────────────┬─────────────────────────────────────────────────────────────────┘
                          │  neuro-san external-agent protocol
                          │  GET /api/v1/<name>/function , POST /api/v1/<name>/streaming_chat
                          ▼
             ┌──────────────────────────── adapter.js (:4747) ───────────────────────────┐
             │  front_man     → POST {FRONT_URL}/chat      (whole mesh: determine →        │
             │  network_agent → POST {NET_URL}/aaosa fulfil (one specialist, no fan-out)   │
             │  pi_device_agent→ POST {PI_URL}/aaosa fulfil                                 │
             └───────────────┬───────────────┬───────────────┬─────────────────────────────┘
                             ▼               ▼               ▼
                    front_man (.214)   network_agent (.11)  pi_device_agent (.103)
                       mimOE :8083  /mimik-aaosa/agent/v1   (your existing mesh)
```

## Why the adapter exists

neuro-san references an external agent by URL (`http://host:port/<name>`) and
then calls that host at `…/api/v1/<name>/streaming_chat`. Your mimOE mim serves a
different vocabulary (`/chat`, `/aaosa`) under its MCM base path
(`/mimik-aaosa/agent/v1`), not at the host root. `adapter.js` is the thin bridge:
it serves the exact neuro-san surface at the root and translates each call into
the mesh. It also closes the two gaps the in-repo shim flagged — it nests
`chat_context` and `sly_data` inside `response` (neuro-san's real chunk shape,
per `docs/clients.md`) rather than at the top level.

## Step 1 — run the adapter

Point it at your three mim nodes (defaults match the lab: .214 / .11 / .103) and
give it a port neuro-san can reach. It has **zero dependencies**.

```sh
FRONT_URL=http://192.168.1.101:8083/mimik-aaosa/agent/v1 \
NET_URL=http://192.168.1.11:8083/mimik-aaosa/agent/v1 \
PI_URL=http://192.168.1.103:8083/mimik-aaosa/agent/v1 \
PORT=4747 node neuro-san/adapter.js
```

Smoke-test it directly (no neuro-san needed) — this is exactly what neuro-san will do:

```sh
curl -s localhost:4747/api/v1/network_agent/function        # callable signature
curl -s localhost:4747/api/v1/front_man/streaming_chat \
  -H 'content-type: application/json' \
  -d '{"user_message":{"text":"is the pi hot and can we add a second pi?"}}'
# -> {"response":{"type":"AI","text":"…mesh answer…","chat_context":{},"sly_data":{}}}
```

## Step 2 — register the network with neuro-san

```sh
pip install neuro-san-studio
ns init                       # scaffolds ./registries + ./config in the current dir
export OPENAI_API_KEY=…       # or your provider key / a .env file
```

Copy this folder's network in, and enable it in the manifest `ns init` created:

```sh
cp neuro-san/registries/lab_ops.hocon ./registries/
# add  "lab_ops.hocon": true  to ./registries/manifest.hocon
```

`registries/lab_ops.hocon` is a one-agent network: a `lab_coordinator` whose
`tools` are the three adapter URLs. If neuro-san and the adapter are on different
hosts, change `127.0.0.1:4747` in that file to the adapter's address. The
`llm_config.model_name` there is the LLM the coordinator itself reasons with —
set it to whatever your neuro-san install is configured for (to run it on your
local milm, register a custom llm in neuro-san's `config/llm_config.hocon` and
reference it by name).

## Step 3 — run it

```sh
ns run        # server on localhost:8080, nsflow UI on http://localhost:4173
```

Open the UI, pick the **lab_ops** network, and ask. A device question resolves
through `pi_device_agent`, a network question through `network_agent`, and a
compound one ("given the pi's load, is it safe to add another pi, and what
network prep?") through `front_man`, where your mesh does its own parallel
determine → adjudicate → fulfil and returns one synthesized answer.

## Verify against your neuro-san version

The adapter targets the surface documented in neuro-san `docs/clients.md`
(request `{user_message:{text}, chat_context, sly_data}`; response chunks
`{response:{type,text,chat_context,sly_data}}`). Two things worth confirming on
your build:

- **`/connectivity`** — the adapter returns a minimal `{connectivity:[{origin,
  tools:[]}]}` for a leaf external agent. If your neuro-san version relies on a
  richer connectivity probe, adjust that handler.
- **Response `type`** — the answer is emitted as `"AI"`. neuro-san's own
  meta-messages use `"AGENT_FRAMEWORK"`; if your client filters types, confirm it
  surfaces `AI` content.

`test/neurosan-adapter-sim.js` drives the adapter end-to-end against a fake mim
(function signature, mesh-vs-direct routing, nested `response` shape,
`chat_context`/`sly_data` echo) with no neuro-san server required:

```sh
node test/neurosan-adapter-sim.js     # -> NEUROSAN_ADAPTER_SIM_PASS
```
