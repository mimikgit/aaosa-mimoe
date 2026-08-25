#!/usr/bin/env bash
# The dynamism showcase: asks the same cross-node question in a loop while
# you pull nodes out and bring them back. Watch membership and routing adapt
# with zero redeploys and zero config edits.
#
#   MBP1_IP=192.168.1.101 bash pov/dynamic-demo.sh
#
# While it runs, in any order:
#   - stop mimOE on the Pi (sudo systemctl stop mimOE), or pull its power
#   - close MBP2's lid / kill its heartbeat
#   - bring either back (restart mimOE + heartbeat resumes announcing)
#   - deploy a brand-new agent mid-run and heartbeat it in: it joins the
#     consult set on the next question, no front-man change
set -uo pipefail
MBP1_IP="${MBP1_IP:-192.168.1.101}"
FRONT="http://${MBP1_IP}:8083/mimik-aaosa/agent/v1"
Q='{"message":"Given the pi'"'"'s current temperature and load, is it safe to add more agent workloads, and what network prep would a second pi need?"}'
N="${N:-30}"
SLEEP="${SLEEP:-12}"

compact() {
  if command -v jq >/dev/null; then jq -c "$1"; else cat; echo; fi
}

for i in $(seq 1 "$N"); do
  echo "===== round $i / $N  $(date +%H:%M:%S) ====="
  echo "-- mesh (front-man's live membership) --"
  curl -s --max-time 5 "${FRONT}/mesh" | compact '{peers: [.peers[] | {name, state, fresh}]}'
  echo "-- ask --"
  curl -s "${FRONT}/chat" -H "Content-Type: application/json" -d "$Q" | compact '{answer: (.answer | .[0:160]), consulted: [.trace[] | select(.mode=="determine") | .peers[] | {name, outcome}]}'
  echo
  sleep "$SLEEP"
done
