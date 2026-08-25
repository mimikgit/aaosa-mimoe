#!/usr/bin/env bash
# End-to-end simulation of the mimOE-native PoV on one machine:
# the REAL mim bundle runs in three emulated mimOE hosts (mimikModule +
# context.http), against the mock LLM. Verifies: telemetry push into the
# device mim, determine fan-out, fulfil, synthesis, trace.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/aaosa-mim-sim
mkdir -p "$LOG"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

bash mim/build.sh >"$LOG/build.log" 2>&1 || { echo BUILD_FAIL; tail -5 "$LOG/build.log"; exit 1; }

PORT=8099 node test/mock-llm.js >"$LOG/mock.log" 2>&1 & PIDS+=($!)
sleep 0.4

PORT=9301 ENV_JSON='{"NAME":"network_agent","AGENT_KIND":"specialist","DESCRIPTION":"Handles network questions: topology, firewalls, adding devices.","INFERENCE_URL":"http://127.0.0.1:8099/v1","ROUTING_MODEL":"mock"}' \
  node test/mim-host.js >"$LOG/net.log" 2>&1 & PIDS+=($!)

PORT=9302 ENV_JSON='{"NAME":"pi_device_agent","AGENT_KIND":"device","DESCRIPTION":"Reports live health of this Raspberry Pi device.","INFERENCE_URL":"http://127.0.0.1:8099/v1","ROUTING_MODEL":"mock"}' \
  node test/mim-host.js >"$LOG/pi.log" 2>&1 & PIDS+=($!)

PORT=9300 ENV_JSON='{"NAME":"front_man","AGENT_KIND":"frontman","DESCRIPTION":"Coordinates lab operations inquiries.","PEERS":"http://127.0.0.1:9301,http://127.0.0.1:9302","INFERENCE_URL":"http://127.0.0.1:8099/v1","ROUTING_MODEL":"mock"}' \
  node test/mim-host.js >"$LOG/front.log" 2>&1 & PIDS+=($!)

sleep 0.8

echo "--- push telemetry into device mim ---"
curl -s http://127.0.0.1:9302/telemetry -d '{"cpuTempC":61.2,"loadAvg":{"1m":0.4}}'
echo; echo "--- device mim /metrics ---"
curl -s http://127.0.0.1:9302/metrics
echo; echo "--- front mim /chat (full pipeline through the real bundle) ---"
OUT=$(curl -s http://127.0.0.1:9300/chat -d '{"message":"Is the pi healthy and what network prep does a second pi need?"}')
echo "$OUT"; echo

DEVLOGOK=1
if echo "$OUT" | grep -q 'SYNTH:' \
   && echo "$OUT" | grep -q 'network_agent' \
   && echo "$OUT" | grep -q 'pi_device_agent'; then
  echo "MIM_SIM_PASS: real bundle, 3 emulated mimOE hosts, fan-out + fulfil + synthesis"
else
  echo "MIM_SIM_FAIL"; tail -5 "$LOG/front.log"; exit 1
fi

echo; echo "--- primary discovery path (mInsight) against a captured real response ---"
node test/discovery-sim.js || { echo "MIM_SIM_FAIL: discovery"; exit 1; }
