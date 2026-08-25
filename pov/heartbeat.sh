#!/usr/bin/env bash
# LEGACY / OPTIONAL. Membership no longer works this way: an agent is in the
# mesh because its node's mimOE advertises the aaosa service, which the
# coordinator reads from mimOE's mesh service (mInsight). Nothing in the PoV
# calls this script. It survives for two narrow cases: bootstrapping against a
# build whose mInsight is unavailable, and offline single-host testing, both of
# which use the mim's `/announce` fallback route.
#
# Peer heartbeat: announce this agent to the coordinator so it joins (or
# rejoins) the consult set. Set INTERVAL to loop forever (no external tools,
# works on macOS which has no `watch`):
#   INTERVAL=15 FRONT_URL=... SELF_URL=... SELF_NAME=... bash pov/heartbeat.sh
# Without INTERVAL it announces once and exits.
# Stop the loop -> after STALE_MS the agent silently leaves the mesh.
set -euo pipefail

FRONT_URL="${FRONT_URL:?front-man base url}"
SELF_URL="${SELF_URL:?this agent base url (LAN address, never 127.0.0.1)}"
SELF_NAME="${SELF_NAME:?agent name, e.g. network_agent}"
SELF_DESC="${SELF_DESC:-}"

announce_once() {
  payload=$(printf '{"name":"%s","url":"%s","description":"%s"}' "$SELF_NAME" "$SELF_URL" "$SELF_DESC")
  if curl -fsS -X POST "$FRONT_URL/announce" -H 'content-type: application/json' -d "$payload" >/dev/null; then
    echo "$(date +%H:%M:%S) announced $SELF_NAME -> $FRONT_URL"
  else
    echo "$(date +%H:%M:%S) announce failed (front-man unreachable)"
  fi
}

if [ -n "${INTERVAL:-}" ]; then
  while true; do announce_once; sleep "$INTERVAL"; done
else
  announce_once
fi
