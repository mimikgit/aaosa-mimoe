#!/usr/bin/env bash
# The scripted demo. Run from any machine that can reach the coordinator:
#
#   source pov/env.sh && bash pov/demo.sh
#
# Everything goes through the coordinator's /chat; the routing is what you are
# watching, so read each answer's `trace` (who was consulted, who claimed, who
# was tasked) rather than only the prose.
set -euo pipefail

# Prefer the derived URLs from env.sh; fall back to the role hosts, then to the
# old MBP1_IP alias, so this works whether or not env.sh has been sourced.
HOST="${NODE_FRONTMAN_HOST:-${MBP1_IP:-192.168.1.101}}"
FRONT="${FRONT_URL:-http://${HOST}:8083/mimik-aaosa/agent/v1}"
DEV_HOST="${NODE_DEVICE_HOST:-${PI_IP:-}}"
PI="${PI_URL:-${DEV_HOST:+http://${DEV_HOST}:8083/mimik-aaosa/agent/v1}}"

J() { if command -v jq >/dev/null; then jq .; else cat; echo; fi; }
ask() { curl -s "${FRONT}/chat" -H "Content-Type: application/json" -d "{\"message\":$1}" | J; }

echo "=== who is in the mesh right now (discovered, not configured) ==="
curl -s "${FRONT}/mesh" | J

echo "=== 1. Routes to the device agent (live telemetry crosses the mesh) ==="
ask '"How hot is the raspberry pi right now, and is it under load?"'

echo "=== 2. Routes to the network agent (the lab as it is wired today) ==="
ask '"What network setup do we need to add a second raspberry pi to this lab?"'

echo "=== 3. Needs both: fan-out, two fulfils, one synthesis ==="
ask '"Given the pi'"'"'s current temperature and load, is it safe to add more agent workloads to it, and what network prep would a second pi need?"'

if [ -n "$PI" ]; then
  echo "=== Raw device metrics, no LLM in the path ==="
  curl -s "${PI}/metrics" | J
fi
