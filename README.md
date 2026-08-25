# aaosa-mimoe

**A mesh-native rendition of AAOSA (Adaptive Agent Oriented Software Architecture) running as mimOE microservices at the edge, with a neuro-san integration.**

Agents run as serverless `mim` microservices on ordinary machines (laptops, a Raspberry Pi, a phone), find each other through mimOE's own mesh fabric, negotiate who owns an inquiry, and answer it together. One of them is grounded in real hardware telemetry rather than a simulation.

This repository is a **Proof of Value (PoV)**: a complete, runnable demonstration, not a library and not a product. Everything here is intended to be read, run, and taken apart.

---

## What this PoV actually demonstrates

Four claims, each verifiable by running the demo:

1. **Agent coordination can run on the edge, on CPU.** The AAOSA protocol (determine, adjudicate, fulfil, synthesize) executes across physically separate nodes, with inference served by a local model. No cloud agent platform is involved.
2. **Membership is discovered, not configured.** No agent holds a list of its peers. Each node asks its own mimOE mesh service who is nearby and what they run. Stop a node and it leaves the mesh; start it and it rejoins. There is no registry to update and no heartbeat to run.
3. **An agent can be grounded in real state.** Two agents in the demo reason from their model. The third answers from live CPU temperature, load, memory, and uptime pushed from the host it runs on. The difference is visible in the answers.
4. **This mesh composes with a cloud agent framework.** The same mesh appears inside [neuro-san](https://github.com/cognizant-ai-lab/neuro-san) either as a single MCP tool or as neuro-san external agents, so a large simulated agent network can have exactly one node that is telling the truth about real hardware.

### What a working round looks like

```console
$ curl -s "$FRONT_URL/chat" -H "Content-Type: application/json" \
    -d '{"message":"How hot is the raspberry pi right now, and is it under load?"}'
```

```json
{
  "answer": "The Raspberry Pi's current CPU temperature is 50.1°C. Regarding load, the device is not under load. The 1-minute load average is 0, the 5-minute average is 0.01, and the 15-minute average is 0, indicating negligible processing activity.",
  "trace": [
    { "mode": "discover", "found": 2, "consultable": 2 },
    { "mode": "determine", "ms": 3005, "peers": [
        { "name": "pi_device_agent", "outcome": "claimed" },
        { "name": "network_agent", "outcome": "declined",
          "reason": "Network agent specializes in network configuration, topology, connectivity, and security. Hardware monitoring falls outside..." } ] },
    { "mode": "fulfil", "ms": 833, "peers": [ { "name": "pi_device_agent", "outcome": "ok" } ] }
  ]
}
```

The `trace` is the point. It shows which agents were consulted, which claimed the inquiry and which declined and why, and what each tasked agent returned. Routing is an observable negotiation between independent processes on different machines, not a hidden prompt-chaining step.

---

## Architecture

![AAOSA agent mesh on mimOE: a neuro-san lab_assistant calls the mimOE coordinator over MCP, the coordinator negotiates with a network specialist and a device agent over the AAOSA mesh, and each agent reaches an inference engine](pov/topology.svg)

The outer panels are **machines**, not processes. Every node serves the **same** addon at the **same** path, `http://<node>:8083/mimik-aaosa/agent/v1`; a per-node `.ini` file decides which role it plays, so there is no separate coordinator build. The coordinator holds no peer list: `network_agent` and `pi_device_agent` are discovered from mimOE's mesh service, so a fourth node joins the fan-out on the next inquiry and a stopped one simply leaves.

Inference is placed per node rather than fixed by the protocol. Node A hosts a shared model through mimik ai. Node C has no local model and borrows Node A's. Node B keeps inference on its own machine, which is why its model is small and token-capped: a peer's entire reply must return inside mimOE's roughly 20 second outbound-read ceiling.

That fourth node is not hypothetical. The RUNBOOK's optional **Node D** is an Android phone running the mimOE app, serving a `netsim` simulation specialist on a model it hosts itself. It is installed by hand rather than over SSH, and the coordinator finds it the same way it finds everything else — nothing on Node A lists it. A phone in this mesh is a peer that gets tasked, not a client that calls in.

The same diagram animated, showing live traffic direction, is [`pov/topology.html`](pov/topology.html). One self-contained file with no dependencies: open it in a browser, no server and no build step.

### The protocol, in one paragraph

An inquiry arrives at any agent. That agent **discovers** its peers through mimOE's mesh service, then fans out a **determine** envelope to all of them in parallel. Each peer replies with a structured JSON claim: can it handle this, fully or partially, how confident is it, which parts does it own, and what values would it need. The originator **adjudicates** those claims with a small routing-grade model into a delegation plan, fans out **fulfil** envelopes to the winners in parallel, and **synthesizes** the returned contributions into one answer. A cycle guard (TTL plus a visited set plus envelope de-duplication) makes this safe when discovery produces loops, which it will. Context passed between agents is filtered through default-deny allowlists in both directions.

Full wire format: [`spec/aaosa-envelope-spec.md`](spec/aaosa-envelope-spec.md).

### Deliberate differences from the neuro-san rendition of AAOSA

This is a different rendition of the same architecture, not a port. The differences are choices, and they are what edge deployment buys:

| | neuro-san rendition | this rendition |
|---|---|---|
| Requirements gathering | separate round trip | folded into the determine claim, one round trip |
| Fan-out | LLM serializes the calls | parallel; the LLM only adjudicates structured claims |
| Down-chain set | declared in HOCON | discovered from the mesh at call time |
| Cycle safety | static graph, not needed | mandatory guard (TTL, visited set, dedup) |
| Model policy | one model | per role: small routing model, larger work model |
| Agent boundary | process-local | network, across physical machines |

---

## Repository layout

```
lib/aaosa.js               core protocol runtime: createAgent(), handleAaosa(), orchestrate()
lib/discovery.js           the only file that knows mimOE's mInsight response schema
lib/llm.js                 minimal OpenAI-compatible chat client
lib/compat-neurosan.js     neuro-san external-agent shim (/function, /streaming_chat)
agent.js                   runnable plain-Node agent, role set by env (no mimOE needed)

mim/src/index.js           the mim: HTTP surface, discovery, telemetry store, MCP server
mim/build.sh               bundle + transpile to the ES5 the serverless engine requires
mim/package-addon.sh       wrap the bundle as a mimOE .addon
mim/package-addon.js       the packager itself: ustar + docker-save layout, pure Node, deterministic
mim/deploy.sh              legacy mCM HTTP deploy (most runtimes use the addon path)

pov/RUNBOOK.md             ***the step-by-step install: start here for the real demo***
pov/README-pov.md          the PoV at a glance
pov/build-here.sh          build the bundle + package the addon ON THIS node (checks Node version)
pov/install-addon.sh       install the addon + a role .ini on THIS node, restart mimOE
pov/remote.sh              configure the OTHER nodes from this one over SSH (keys|push|setup|status|exec)
pov/pi-telemetry-push.sh   sensor feeder: host telemetry POSTed into the device mim
                           (installed as the aaosa-telemetry systemd service on the device node)
pov/heartbeat.sh           legacy /announce bootstrap; membership uses mInsight, so normally unused
pov/env.example.sh         one-time lab configuration, copy to pov/env.sh
pov/demo.sh, dynamic-demo.sh   the scripted demonstrations
pov/topology.svg           the topology diagram (static, rendered above)
pov/topology.html          the same diagram animated, self-contained, open in a browser

neuro-san/MCP.md           front-man as an MCP tool (preferred integration)
neuro-san/README.md        front-man as neuro-san external agents (adapter path)
neuro-san/adapter.js       the external-agent adapter
neuro-san/registries/      ready-to-serve agent networks (lab_ops, lab_ops_mcp)
neuro-san/registries/examples/   the telco example, grounded in one real device

spec/aaosa-envelope-spec.md   protocol specification v0.1
test/                      simulations and unit tests, no hardware required
```

---

## Prerequisites

Two sets: what the PoV itself needs, and what the optional neuro-san integration adds on top.

### To run the multi-node PoV

| Requirement | Notes |
|---|---|
| **Node.js 18 or newer, plus npm, on EVERY node** | `node -v`. Each node builds its own addon from the source it receives; nothing pre-built is transferred between machines |
| **Network access on each node's first build** | downloads the ES5 toolchain into `mim/build-tools/` (roughly 45 MB, cached afterwards; slow on a Raspberry Pi) |
| **2 or 3 machines on one LAN** | any mix of macOS and Linux hosts. Three is the intended shape (coordinator, specialist, device); two works if you drop the network specialist |
| **An Android phone** (optional fourth node) | the mimOE Android app plus a small local model, running the `netsim` simulation specialist. Installed by hand from a Termux shell, not over SSH. Worth adding because it shows a phone joining as a peer the coordinator tasks, reasoning on a model it hosts itself. RUNBOOK "Node D" |
| **mimOE runtime installed on each node** | mimik's edge runtime, serving on port `8083`. Get it from the [mimik developer portal](https://developer.mimik.com/) |
| **mimOE Studio** | mimik's development environment for mimOE. Required for the MCP step: the coordinator is published to mimOE's built-in **MCP gateway** through Studio, not by hand. Also how you inspect and manage what a node runs. Download it from the [mimOE Studio download page](https://developer.mimik.com/mimOE-studio-download) |
| **Port 8083 reachable between nodes** | the mesh will form but agents will show `unreachable` if a firewall blocks it |
| **An inference node** | one machine runs the model for the whole mesh. See the model row below |
| **mimik ai (`milm`) addon on the inference node** | provides the OpenAI-compatible endpoint at `/mimik-ai/openai/v1`, and its `API_KEY` becomes your `INFERENCE_API_KEY` |
| **A local model** | the reference lab uses `Qwen3.6-35B-A3B-Q4_K_M` (Q4_K_M GGUF, roughly 20 GB on disk, 32 GB RAM or more recommended). Any OpenAI-compatible chat model works; smaller models need the token and brevity caps described in the RUNBOOK |
| **An edge access token per node** (`INSIGHT_TOKEN`) | a JWT each mim uses to read its own node's mesh service. Minted with `@mimik/mimik-edge-cli` from a Developer ID Token issued by [console.mimik.com](https://console.mimik.com). RUNBOOK appendix has the exact commands |
| **A device with readable sensors** for the device role | the reference uses a Raspberry Pi 5 and reads `/sys/class/thermal/thermal_zone0/temp` and `/proc/loadavg`. Any Linux host works |


### To add the neuro-san integration (optional)

Everything above, plus:

| Requirement | Notes |
|---|---|
| **neuro-san / neuro-san-studio installed** | see [neuro-san-studio](https://github.com/cognizant-ai-lab/neuro-san-studio). Installed with `uv`: `uv init && uv venv && source .venv/bin/activate && uv add neuro-san-studio`, then `ns init` |
| **An LLM provider key for neuro-san** | neuro-san's own coordinator reasons with a cloud model by default (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), independent of your local mimOE model. Verify with `ns check-llm-keys` |
| **Network route from the neuro-san host to the front-man node** | neuro-san connects out to `http://<front-man>:8083/mimik-aaosa/agent/v1/mcp` |

Nothing in this repository requires a cloud API key unless you choose the neuro-san path. The mesh itself runs entirely on local inference.

---

## Quick start

Follow **[`pov/RUNBOOK.md`](pov/RUNBOOK.md)** from the top. It is written to be executed literally, node by node, and it ends with the mimik MCP registration and the neuro-san networks.

The shape of it, on each node:

```sh
git clone https://github.com/mimikgit/aaosa-mimoe.git
cd aaosa-mimoe
chmod +x mim/*.sh pov/*.sh test/*.sh

cp pov/env.example.sh pov/env.sh   # fill in node IPs, keys, tokens
source pov/env.sh
bash mim/build.sh                  # bundles and transpiles to ES5, ends with "ES5 OK"
bash mim/package-addon.sh          # -> mim/build/aaosa-agent-0.2.0.addon
bash pov/install-addon.sh frontman # then: network on node B, device on node C
```

From the coordinator, `bash pov/remote.sh setup all` does the copy, the build and the install on the other nodes for you (RUNBOOK step A7).

---

## The neuro-san integration, two paths

Both are implemented and tested. Pick one.

**MCP (preferred).** The front-man serves a Model Context Protocol endpoint at `…/mimik-aaosa/agent/v1/mcp`, built with `@mimik/mcp-kit` and bundled into the addon. It advertises one tool, `front_man`, taking an `inquiry` string; calling it runs the whole mesh. Any MCP client can consume it, and no adapter is needed because MCP clients connect to whatever URL they are given. Details in [`neuro-san/MCP.md`](neuro-san/MCP.md); the ready network is [`neuro-san/registries/lab_ops_mcp.hocon`](neuro-san/registries/lab_ops_mcp.hocon).

**External agents (adapter).** If you specifically want the mimOE agents to appear as neuro-san *external agents* rather than MCP tools, `neuro-san/adapter.js` serves neuro-san's `/api/v1/<name>/function` and `/streaming_chat` surface and translates each call into the mesh. This exists because neuro-san's external-agent surface expects agents at the server root, which a mim's base path cannot provide. Details in [`neuro-san/README.md`](neuro-san/README.md); the ready network is [`neuro-san/registries/lab_ops.hocon`](neuro-san/registries/lab_ops.hocon).

### Grounding one node of a large simulated network

The most compelling demonstration is not the standalone lab network. It is taking neuro-san's `telco_network_orchestration` example, a simulated Australian telco with three regions and a dozen node agents that all invent plausible numbers, and giving exactly one of them a real Raspberry Pi to report on. Ask the network about that node's temperature and one branch of the tree stops simulating.

The worked reference is [`neuro-san/registries/examples/telco_network_orchestration.hocon`](neuro-san/registries/examples/telco_network_orchestration.hocon), with the two required edits documented in its header and in RUNBOOK section E.2.

---

## Where mimOE plugs in

Two seams, both deliberate and both isolated:

1. **Discovery.** `discoverPeers()` in `mim/src/index.js` queries mimOE's mInsight service for nearby nodes and keeps the ones running the aaosa service. All schema knowledge lives in `lib/discovery.js` and nowhere else. `DISCOVERY_SCOPE` (`linkLocal`, `proximity`, `account`) is the mesh radius, and **the scope you query is the trust boundary**.
2. **Inference.** `INFERENCE_URL` points at a node-local OpenAI-compatible endpoint. `ROUTING_MODEL` handles determine, adjudicate, and synthesize; `WORK_MODEL` handles fulfil. Every node may point somewhere different, which is how a slow node can borrow a fast node's model.

## Constraints worth knowing before you read the code

- **The serverless engine is ES5.** No arrow functions, no `async`/`await`, no native `Promise` in the deployed artifact. `mim/build.sh` bundles with esbuild, lowers with Babel plus core-js, re-bundles, then hard-verifies the output parses as strict ES5 with acorn. Source stays modern; only the artifact is ES5.
- **A serverless mim cannot read `sysfs`.** That is why the device role does not read its own sensors. The host pushes telemetry into the mim (`pov/pi-telemetry-push.sh` POSTs to `/telemetry`), following mimik's own mIoT sensor pattern, and the agent grounds its answer in the last sample. This is a design constraint of the runtime, not a shortcut.
- **`lib/` is bundled into the mim at build time.** Editing protocol code changes nothing on a running node until you rebuild, repackage, and reinstall.
- **Peer replies must return inside mimOE's outbound-read ceiling (roughly 20 s).** A slow local model on a peer will blow through it and the coordinator will record `unreachable`. The `network` role ships with a brevity instruction and a token cap for exactly this reason.

## License and attribution

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

AAOSA originates in the work of Babak Hodjat and colleagues, "[An Adaptive Agent Oriented Software Architecture](https://arxiv.org/abs/cs/9812015)" (1998). [neuro-san](https://github.com/cognizant-ai-lab/neuro-san) and [neuro-san-studio](https://github.com/cognizant-ai-lab/neuro-san-studio) are Cognizant AI Lab projects, Apache-2.0; the example under `neuro-san/registries/examples/` is redistributed from neuro-san-studio with its copyright header intact and its modifications documented.
