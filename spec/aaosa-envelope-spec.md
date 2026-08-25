# AAOSA-over-mimOE Envelope Specification

Version 0.1 (draft), 2026-07-30. Defines a mesh-native rendition of AAOSA (Adaptive Agent Oriented Software Architecture) for agents implemented as mimOE microservices. Differs deliberately from the neuro-san rendition: phases are collapsed, fan-out is parallel, claims are structured JSON, and the down-chain set is dynamic (mesh discovery) rather than static config. A thin compatibility shim exposes each agent to genuine neuro-san networks as an external agent.

## 1. Transport and endpoint

Every agent exposes one uniform endpoint:

    POST /aaosa
    Content-Type: application/json

All protocol interactions use this endpoint. Peers are addressed by URL; on mimOE the URL comes from mesh discovery (node, proximity, or account scope). Discovery scope IS the consult set and therefore the trust boundary: an agent only consults peers it can discover.

## 2. Modes

Two modes, not three. The neuro-san rendition separates determine / requirements / respond; here the requirements exchange is folded into the determine claim, and a confident peer may answer speculatively in the same round trip.

- `determine`: "Is any part of this inquiry yours? What would you need? Answer now if you are confident."
- `fulfil`: "Handle your part, with these requirement values."

## 3. Request envelope

```json
{
  "v": "0.1",
  "id": "uuid, unique per protocol interaction",
  "corr": "uuid, stable across one user inquiry end to end",
  "mode": "determine | fulfil",
  "inquiry": "the user inquiry, or the delegated part of it",
  "parts": ["optional, fulfil only: which claimed parts are being tasked"],
  "requirements": { "key": "value, fulfil only: fulfilled requirement values" },
  "context": { "allowlisted cross-agent state, see section 7" },
  "origin": { "agent": "caller agent name", "node": "caller node id" },
  "hops": 0,
  "ttl": 4,
  "visited": ["agent names already in this delegation chain"],
  "deadlineMs": 8000
}
```

## 4. Claim (response to determine)

```json
{
  "v": "0.1",
  "agent": "responder name",
  "canHandle": true,
  "coverage": "full | partial | none",
  "strength": 0.85,
  "parts": ["which aspects of the inquiry it claims"],
  "requirements": [
    { "key": "marriage_date", "description": "date of the status change" }
  ],
  "speculative": "optional: a complete answer, present only when confident and no requirements are missing",
  "reason": "optional short rationale, for audit"
}
```

Timeout, transport error, TTL exceeded, or a visited-set hit are all equivalent to `{"canHandle": false, "coverage": "none"}`. This is the graceful-degradation property: an unreachable peer is simply a peer that cannot contribute.

## 5. Fulfil response

```json
{
  "v": "0.1",
  "agent": "responder name",
  "status": "ok | cannot_contribute | timeout",
  "answer": "natural-language answer for the claimed parts",
  "contextOut": { "allowlisted keys only" },
  "trace": [{ "agent": "...", "mode": "...", "ms": 123 }]
}
```

## 6. Orchestration rules (up-chain behavior)

1. Discover candidate peers (scope-limited). Filter out any peer already in `visited`.
2. Fan out `determine` to all candidates in parallel with a per-peer timeout derived from `deadlineMs`. Never serialize this.
3. Short-circuit: if exactly one claim has `coverage: full`, strength above threshold, and a `speculative` answer, accept it and skip fulfil.
4. Otherwise adjudicate: a routing-grade LLM call over the structured claims decides which claimants to task with which parts, and resolves requirement values from the inquiry and context.
5. Fan out `fulfil` to the selected claimants in parallel. Each claimant may recurse this entire protocol against its own discoverable peers with `hops + 1` and itself appended to `visited`.
6. Synthesize: single contributor passes through; multiple contributors are merged by one LLM call.

## 7. Context policy (sly_data equivalent)

Each agent declares two allowlists in its descriptor: `contextToDownstream` and `contextFromDownstream`, arrays of key names. Default deny both directions. Keys not allowlisted are stripped at the boundary, silently. Long-lived secrets never enter `context`; per-request credentials are injected from node-held credentials at the node boundary.

## 8. Cycle guard

Required, because dynamic discovery permits cycles that neuro-san's static hierarchy cannot express. Drop (respond cannot-contribute) when: `hops >= ttl`, own name appears in `visited`, or an envelope `id` repeats within a short dedup window.

## 9. Discovery descriptor

Each agent publishes to mesh discovery:

```json
{
  "name": "networking_agent",
  "description": "Handles network-related tasks: setup, maintenance, troubleshooting.",
  "tags": ["it", "networking"],
  "aaosa": { "v": "0.1", "endpoint": "/aaosa" },
  "compat": { "neuroSan": "/api/v1/networking_agent" },
  "models": { "routing": "small local model id", "work": "domain model id" }
}
```

The `description` field is the routing signal, exactly as in neuro-san: description quality is routing quality.

## 10. neuro-san compatibility shim

To be callable from a genuine neuro-san network as an external agent (`http://host:port/agent_name` in its tools list), the agent additionally serves:

- `GET /api/v1/<name>/function` returning the agent's callable signature (name, description, single `inquiry` parameter).
- `POST /api/v1/<name>/streaming_chat` accepting a chat request, running the native pipeline, and streaming the result.

Note: the skeleton implements a working approximation of these two routes. Before claiming wire compatibility, align request/response bodies to the neuro-san OpenAPI specification (see neuro-san docs/clients.md and their gRPC/HTTP protos), including `chat_context` echo semantics.

## 11. Model policy

`determine`, adjudication, and synthesis are routing-grade work: bind them to a small node-local model. `fulfil` binds to the domain model. Both via the node's OpenAI-compatible endpoint, so the policy is per-agent configuration, not code.

## 12. Membership and liveness (dynamic mesh)

Nodes may appear or disappear at any moment. Membership is runtime state, never configuration:

- **Announce.** `POST /announce {name, url, description}` upserts a peer with `lastSeen = now`. A repeated announce is a heartbeat. One announce suffices to join (or rejoin); the peer is consulted from the next inquiry on, with no redeploy or config change anywhere.
- **Freshness.** Peers with `now - lastSeen < STALE_MS` (default 90000) form the consult set. An optional static `PEERS` list acts as bootstrap only (probed via `/descriptor`) and is superseded by announcements for the same name.
- **Disappearance semantics, two stages.** A peer that dies mid-window shows up as an `unreachable` consult outcome, which AAOSA already treats as cannot-contribute: the answer degrades gracefully in the same round. Once past `STALE_MS` without a heartbeat, the peer silently leaves the consult set and costs nothing further.
- **Observability.** Every determine/fulfil records per-peer outcomes (`claimed | declined | unreachable | ok | timeout`) in the response `trace`, and `GET /mesh` exposes the live table (name, state, lastSeenAgoMs, fresh).
- **Position.** Announce/heartbeat is the PoV stand-in for mDS mesh discovery; the swap point is `discoverPeers()` and nothing else. The cycle guard (section 8) is what makes dynamic membership safe.
