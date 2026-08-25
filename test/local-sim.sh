#!/usr/bin/env bash
# Full-system simulation on one machine, zero real inference:
# mock LLM + front_man + network_agent + pi_device_agent, then one /chat
# that must fan out to both specialists and synthesize.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/aaosa-sim
mkdir -p "$LOG"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

PORT=8099 node test/mock-llm.js >"$LOG/mock.log" 2>&1 & PIDS+=($!)
sleep 0.4

NAME=network_agent PORT=9201 \
DESCRIPTION="Handles network questions: topology, firewalls, adding devices." \
INFERENCE_URL=http://127.0.0.1:8099/v1 ROUTING_MODEL=mock WORK_MODEL=mock \
node agent.js >"$LOG/network.log" 2>&1 & PIDS+=($!)

NAME=pi_device_agent PORT=9202 \
INFERENCE_URL=http://127.0.0.1:8099/v1 ROUTING_MODEL=mock WORK_MODEL=mock \
node pov/device-agent.js >"$LOG/device.log" 2>&1 & PIDS+=($!)

NAME=front_man PORT=9200 \
DESCRIPTION="Coordinates lab operations inquiries." \
PEERS="http://127.0.0.1:9201,http://127.0.0.1:9202" \
INFERENCE_URL=http://127.0.0.1:8099/v1 ROUTING_MODEL=mock WORK_MODEL=mock \
node agent.js >"$LOG/front.log" 2>&1 & PIDS+=($!)

sleep 0.8

echo "--- /metrics (device agent, raw) ---"
curl -s http://127.0.0.1:9202/metrics
echo; echo "--- /chat (front-man, full pipeline) ---"
OUT=$(curl -s http://127.0.0.1:9200/chat -d '{"message":"Is the pi healthy and what network prep does a second pi need?"}')
echo "$OUT"
echo

if echo "$OUT" | grep -q 'SYNTH:' \
   && echo "$OUT" | grep -q 'network_agent' \
   && echo "$OUT" | grep -q 'pi_device_agent'; then
  echo "SIM_PASS: fan-out to both agents, fulfil, synthesis all worked"
else
  echo "SIM_FAIL"; echo "front log:"; tail -5 "$LOG/front.log"; exit 1
fi
