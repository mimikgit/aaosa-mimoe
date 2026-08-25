#!/usr/bin/env bash
# Verifies the dynamic-membership story end to end with the REAL mim bundle.
# Membership is normally sourced from mimOE's mInsight; this local host does not
# emulate mInsight, so the discovery call fails fast and the mim falls back to
# the announce/static table. This test therefore exercises that FALLBACK path
# (still shipped for bootstrap + offline single-host use). The primary mInsight
# path is covered by test/discovery-sim.js against a captured real response.
#   round 1: both peers announced -> consulted -> synthesis
#   round 2: pi host killed       -> unreachable outcome, degraded answer
#   round 3: past STALE_MS        -> pi gone from the consult set AND from /mesh
#   round 4: pi restarted+announce-> back in the mesh, synthesis again
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/aaosa-dyn-sim
mkdir -p "$LOG"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
fail() { echo "DYN_SIM_FAIL: $1"; tail -5 "$LOG/front.log" 2>/dev/null; exit 1; }

bash mim/build.sh >"$LOG/build.log" 2>&1 || fail "build"

PORT=8099 node test/mock-llm.js >"$LOG/mock.log" 2>&1 & PIDS+=($!)
sleep 0.4

start_net() {
  PORT=9301 ENV_JSON='{"NAME":"network_agent","AGENT_KIND":"specialist","DESCRIPTION":"Handles network questions.","INFERENCE_URL":"http://127.0.0.1:8099/v1","ROUTING_MODEL":"mock"}' \
    node test/mim-host.js >"$LOG/net.log" 2>&1 & PIDS+=($!)
}
start_pi() {
  PORT=9302 ENV_JSON='{"NAME":"pi_device_agent","AGENT_KIND":"device","DESCRIPTION":"Reports live health of this Raspberry Pi device.","INFERENCE_URL":"http://127.0.0.1:8099/v1","ROUTING_MODEL":"mock"}' \
    node test/mim-host.js >"$LOG/pi.log" 2>&1 & PI_PID=$!; PIDS+=($PI_PID)
}
announce() { # name url
  curl -s http://127.0.0.1:9300/announce -d "{\"name\":\"$1\",\"url\":\"$2\",\"description\":\"$3\"}" >/dev/null
}
ask() { curl -s http://127.0.0.1:9300/chat -d '{"message":"Is the pi healthy and what network prep does a second pi need?"}'; }

start_net
start_pi
# Front-man starts with NO static peers: membership is pure announcement.
PORT=9300 ENV_JSON='{"NAME":"front_man","AGENT_KIND":"frontman","DESCRIPTION":"Coordinates lab inquiries.","INFERENCE_URL":"http://127.0.0.1:8099/v1","ROUTING_MODEL":"mock","STALE_MS":"3000"}' \
  node test/mim-host.js >"$LOG/front.log" 2>&1 & PIDS+=($!)
sleep 0.8

announce network_agent   http://127.0.0.1:9301 "Handles network questions."
announce pi_device_agent http://127.0.0.1:9302 "Reports live health of this Raspberry Pi device."

echo "== round 1: both nodes present =="
R1=$(ask); echo "$R1"
echo "$R1" | grep -q 'SYNTH:' || fail "round1 synthesis"
echo "$R1" | grep -q '"name":"pi_device_agent","outcome":"claimed"' || fail "round1 pi claimed"

echo "== round 2: pi node disappears (killed) =="
kill "$PI_PID" 2>/dev/null; sleep 0.3
R2=$(ask); echo "$R2"
echo "$R2" | grep -q '"name":"pi_device_agent","outcome":"unreachable"' || fail "round2 pi unreachable"
echo "$R2" | grep -q 'WORK' || fail "round2 degraded answer still served"

echo "== round 3: past STALE_MS, pi silently leaves the consult set =="
sleep 3.2
# network_agent's heartbeat keeps running (pov/heartbeat.sh in real life);
# the pi's does not, so only the pi expires.
announce network_agent http://127.0.0.1:9301 "Handles network questions."
R3=$(ask); echo "$R3"
echo "$R3" | grep -q '"name":"pi_device_agent"' && fail "round3 pi should not be consulted"
echo "$R3" | grep -q '"name":"network_agent"' || fail "round3 network still consulted"
# mInsight model: a peer that is no longer live is ABSENT from /mesh entirely
# (not lingering as fresh:false). The front-man states a peer is here only while
# discovery reports it. So /mesh shows network_agent and no pi.
MESH3=$(curl -s http://127.0.0.1:9300/mesh); echo "$MESH3"
echo "$MESH3" | grep -q '"name":"pi_device_agent"' && fail "round3 /mesh should drop the gone pi (mInsight: absent, not stale)"
echo "$MESH3" | grep -q '"name":"network_agent"' || fail "round3 /mesh should still list network_agent"

echo "== round 4: pi node reappears (restart + announce) =="
start_pi; sleep 0.5
announce pi_device_agent http://127.0.0.1:9302 "Reports live health of this Raspberry Pi device."
R4=$(ask); echo "$R4"
echo "$R4" | grep -q '"name":"pi_device_agent","outcome":"claimed"' || fail "round4 pi rejoined"
echo "$R4" | grep -q 'SYNTH:' || fail "round4 synthesis restored"

echo "DYN_SIM_PASS: disappear -> degrade -> silent removal -> reappear -> full service"
