#!/usr/bin/env bash
# Deploy the AAOSA mim to a mimOE node via mCM.
#
#   MCM_API_KEY=... bash mim/deploy.sh <node-ip> <container-name> '<env-json>'
#
# Example (front-man on MBP1):
#   MCM_API_KEY=$KEY bash mim/deploy.sh 192.168.1.101 aaosa-front '{
#     "MCM.BASE_API_PATH": "/aaosa-front/v1",
#     "NAME": "front_man", "AGENT_KIND": "frontman",
#     "DESCRIPTION": "Coordinates lab operations inquiries across the mesh.",
#     "PEERS": "http://192.168.1.102:8083/aaosa-net/v1,http://192.168.1.103:8083/aaosa-pi/v1",
#     "INFERENCE_URL": "http://192.168.1.101:8083/mimik-ai/openai/v1",
#     "ROUTING_MODEL": "Qwen3.6-35B-A3B-Q4_K_M", "DEADLINE_MS": "25000"
#   }'
#
# Auth: MCM API key as bearer (current portal docs). Container creation is
# attempted on POST /mcm/v1/mims (current portal) and falls back to
# POST /mcm/v1/containers (shipped examples, e.g. mIoT) for older builds.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_IP="${1:?node ip}"
NAME="${2:?container name}"
ENVJSON="${3:?env json}"
# MCM_TOKEN is the node's EDGE ACCESS TOKEN (a JWT minted per RUNBOOK step A1),
# NOT the node's static mimOE api key; that key is only a minting input.
# MCM_API_KEY is accepted as a legacy alias for the same JWT.
MCM_TOKEN="${MCM_TOKEN:-${MCM_API_KEY:-}}"
[ -n "$MCM_TOKEN" ] || { echo "set MCM_TOKEN to this node's edge access token JWT (RUNBOOK step A1)"; exit 1; }
IMAGE=aaosa-agent-v1
MCM="http://${NODE_IP}:8083/mcm/v1"
AUTH="Authorization: Bearer ${MCM_TOKEN}"

[ -f mim/build/${IMAGE}.tar ] || { echo "run mim/build.sh first"; exit 1; }

echo "-- uploading image to ${MCM}/images"
# -H "Expect:" is required: curl adds "Expect: 100-continue" to multipart
# uploads, which mCM's embedded HTTP server does not handle; it then reads an
# empty body and answers 400 "no image received". mimik's own CLI uploads via
# axios, which never sends Expect, hence the same request works there.
UP=$(curl -sS -X POST "${MCM}/images" -H "$AUTH" -H "Expect:" -F "image=@mim/build/${IMAGE}.tar" -w $'\n%{http_code}')
UP_CODE=${UP##*$'\n'}
UP_BODY=${UP%$'\n'*}
if [ "$UP_CODE" -ge 300 ] 2>/dev/null; then
  echo "   image upload failed (HTTP ${UP_CODE}): ${UP_BODY}"
  echo "   hints: 403 'JWT Token is required' -> MCM_TOKEN must be an edge access token"
  echo "          (mimik-edge-cli account get-edge-access-token); tar complaints -> re-run mim/build.sh"
  exit 1
fi

PAYLOAD=$(printf '{"name":"%s","image":"%s","env":%s}' "$NAME" "$IMAGE" "$ENVJSON")

echo "-- creating container ${NAME}"
C1=$(curl -sS -X POST "${MCM}/mims" -H "$AUTH" -H 'content-type: application/json' -d "$PAYLOAD" -w $'\n%{http_code}')
C1_CODE=${C1##*$'\n'}
if [ "$C1_CODE" -ge 300 ] 2>/dev/null; then
  echo "   /mims returned ${C1_CODE} (${C1%$'\n'*}), trying legacy /containers"
  C2=$(curl -sS -X POST "${MCM}/containers" -H "$AUTH" -H 'content-type: application/json' -d "$PAYLOAD" -w $'\n%{http_code}')
  C2_CODE=${C2##*$'\n'}
  if [ "$C2_CODE" -ge 300 ] 2>/dev/null; then
    echo "   container creation failed (HTTP ${C2_CODE}): ${C2%$'\n'*}"
    exit 1
  fi
fi

BASE=$(printf '%s' "$ENVJSON" | tr -d ' \n' | sed -n 's/.*"MCM.BASE_API_PATH":"\([^"]*\)".*/\1/p')
echo "-- deployed: http://${NODE_IP}:8083${BASE}/healthcheck"
