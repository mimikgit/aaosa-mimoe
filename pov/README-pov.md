# The PoV at a glance

Three AAOSA agents run **on top of mimOE**, deployed as edge microservices (mims) and served from each node's mimOE gateway on `:8083`, with an optional fourth on a phone. Inference is mimik ai's OpenAI-compatible endpoint on one node. There are no standalone Node processes on any node. Every node builds its own addon from source, so Node.js 18+ and npm are needed on each of them; Node is the only runtime involved.

**To actually install it, follow [`RUNBOOK.md`](RUNBOOK.md).** This file explains what you are installing and why.

## Topology

    Node A (mimOE :8083)              Node B (mimOE :8083)          Node C (mimOE :8083)
    ------------------------          ----------------------        ----------------------
    mimik ai inference                aaosa mim                     aaosa mim
      /mimik-ai/openai/v1               role: network                 role: device
    aaosa mim                                                       telemetry pushed in by
      role: frontman  (entry)                                       pov/pi-telemetry-push.sh

    Node D (mimOE :8083, optional)    a phone
    ------------------------------
    mimik ai inference (small local model)
    aaosa mim
      role: netsim   what-if analysis, disjoint from Node B's "as configured now"

    Every node serves the SAME addon at the SAME path:
        http://<node>:8083/mimik-aaosa/agent/v1
    A per-node .ini file decides the role. Agent-to-agent calls go gateway to
    gateway:  POST http://<peer>:8083/mimik-aaosa/agent/v1/aaosa

Node A normally hosts inference for the whole mesh, but inference is per node: any node can point `INFERENCE_URL` at its own local model instead. Node D does exactly that, on a phone: it is a peer the coordinator tasks, not a client that calls in, and it is installed by hand rather than over SSH (RUNBOOK, "Node D").

## How the mim works

`mim/src/index.js` is the single agent implementation, built to mimik's published serverless model (verified against the mimikgit mIoT example): the runtime invokes `mimikModule.exports = (context, req, res)`, environment comes from `context.env`, and all outbound calls (peer mims, inference) go through `context.http.request`, wrapped into the protocol library in `lib/`.

One image serves every role. The node's `.ini` decides `NAME`, `AGENT_KIND` (`frontman` | `specialist` | `device`), `DESCRIPTION`, and `INFERENCE_URL`. Routing quality is description quality: the `DESCRIPTION` string is the only thing peers see when deciding whether an inquiry belongs to that agent.

**Device note.** A serverless mim cannot read `sysfs`, so the device agent does not read its own sensors. It follows mimik's own mIoT sensor pattern: `pov/pi-telemetry-push.sh` reads temperature, load, and memory on the host and POSTs them into the mim's `/telemetry` route, and the agent grounds its answers in the last pushed sample through the `gatherFacts` hook. That hook runs at **fulfil** time only, which is why a telemetry-backed agent must never emit a speculative determine answer: at determine time it has no telemetry yet and could only describe its own capabilities. The invariant is enforced in `determine()` in `lib/aaosa.js`, where an agent configured with `gatherFacts` is neither asked for a speculative answer nor allowed to return one.

## Membership is mesh state, not configuration

No agent holds a peer list. The coordinator queries its own node's mimOE mesh service (mInsight) for nearby nodes, keeps the ones advertising the aaosa service, and probes each one's `/descriptor` for its name and specialty. A node joins the mesh simply by having the addon installed; there is no announce and no heartbeat. Each mim needs an `INSIGHT_TOKEN` (an edge access JWT) to read mInsight, and `DISCOVERY_SCOPE` (`linkLocal` | `proximity` | `account`) sets the radius.

`lib/discovery.js` isolates all knowledge of the mInsight response schema, so drift there is one file to adjust. The legacy announce and static `PEERS` paths remain as a bootstrap fallback for offline single-host testing.

## The dynamism showcase

This is the demonstration that does not work in a statically configured agent framework. Nodes appear and disappear at any moment and nothing anywhere is redeployed or reconfigured.

    bash pov/dynamic-demo.sh

The script asks the same cross-node question every 12 seconds and prints live membership (`GET /mesh`) plus who was consulted and with what outcome. While it runs:

1. **Kill Node C** (`sudo systemctl stop mimOE`, or pull power). Next round the trace shows `pi_device_agent: unreachable` and the answer degrades gracefully in that same round, because AAOSA treats an unreachable peer as one that cannot contribute. Within a mesh cycle mInsight stops advertising the node and it drops out of `/mesh` entirely, costing nothing.
2. **Close Node B's lid.** Same two-stage story for `network_agent`.
3. **Bring either back.** mimOE restarts, re-advertises the aaosa service, and the agent is discovered and consulted again on the very next question. Nothing to restart.
4. **The punchline: add a brand-new agent mid-run.** Install the addon on a further node with a new `NAME` and `DESCRIPTION` — the `netsim` role on a phone is the ready-made one, or invent a storage agent. Its mimOE advertises the service and it joins the consult set on the next inquiry. Compare with the static-configuration world, where new membership is a config change and a redeploy: here membership is runtime mesh state. With a phone you can do the reverse in the same run: walk out of Wi-Fi range and watch it leave.

## Inference sizing, and why it matters here

The reference lab runs `Qwen3.6-35B-A3B` (Q4_K_M GGUF, roughly 20 GB; unsloth and bartowski both publish quants). A 35B MoE with roughly 3B active parameters is a good single-model fit: fast enough per token to serve routing (determine, adjudicate, synthesize) and strong enough for fulfil, so `ROUTING_MODEL` and `WORK_MODEL` can be the same id. That node wants 32 GB of RAM or more.

The protocol runs several inference calls per inquiry and they all queue on one server, so inference is the expected bottleneck. Two consequences worth internalizing before you tune anything:

- A cross-node `determine` round costs roughly 3 to 5 s on the reference lab, and `fulfil` roughly 0.8 s. That is the baseline protocol cost.
- A peer's entire `/aaosa` reply, including its own inference call, must return inside mimOE's outbound-read ceiling of roughly 20 s. A slow local model on a peer blows through it and the coordinator records `unreachable`. This is why the `network` role ships with a brevity instruction and a 256-token cap by default, and why the phone-hosted `netsim` role is capped harder still, at 200.

## What is verified, and what to confirm on your runtime

Verified in this repository, with no hardware required:

- `bash test/mim-sim.sh` runs the **exact shipped bundle** in three emulated mimOE hosts (same `mimikModule` entry, same `context.http` callback shape) through telemetry push, parallel determine, adjudication, fulfil, and synthesis.
- `node test/discovery-sim.js` drives the primary mInsight path: the shipped bundle answers `GET /mesh` from a mocked mimOE fed a **captured real** `/nodes?type=linkLocal` response, and the aaosa peers fall out of it while the node's own record and inference-only nodes are dropped.
- `bash test/dynamic-sim.sh` covers the dynamic story: both peers present and synthesized, one killed mid-run (unreachable, degraded answer in the same round), then gone from `/mesh`, then restored.
- `node test/mcp-sim.js` covers the MCP tool surface end to end, and `node test/neurosan-adapter-sim.js` the neuro-san external-agent adapter.
- `bash test/local-sim.sh` runs the plain-Node flavor, which remains useful for development.

Confirm against your own runtime, all marked in the code:

1. **Router path shape.** The mim assumes the gateway strips `MCM.BASE_API_PATH` before it sees `req.url`, consistent with the mIoT example.
2. **`context.http.request` content-type defaults** for JSON POST bodies. `GET /debug/inference` probes four header strategies and reports which ones your engine accepts.
3. **Addon install mechanism.** `pov/install-addon.sh` copies the `.addon` and a role `.ini` into `~/.mimoe/addon/` and restarts mimOE. If your build instead accepts mCM HTTP image uploads, `mim/deploy.sh` implements that legacy flow.
4. **mInsight specifics.** The exact path, the `type` scope values, and which token your build wants. `lib/discovery.js` is the only file to adjust.
5. **The MCP registration envelope.** mimik's registry API is proprietary; `registerWithMcp()` in `mim/src/index.js` posts a neutral record you align to your server in one place. See `neuro-san/MCP.md`.
