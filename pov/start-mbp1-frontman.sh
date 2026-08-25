#!/usr/bin/env bash
# MacBook Pro 1: front-man (entry point). Inference also lives on this machine.
# Edit the three IPs/URLs, then: bash pov/start-mbp1-frontman.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export MBP2_IP="${MBP2_IP:-192.168.1.102}"
export PI_IP="${PI_IP:-192.168.1.103}"

NAME=front_man \
PORT=9100 \
DESCRIPTION="Coordinates lab operations inquiries across the mesh." \
PEERS="http://${MBP2_IP}:9101,http://${PI_IP}:9102" \
INFERENCE_URL="${INFERENCE_URL:-http://127.0.0.1:8083/mimik-ai/openai/v1}" \
ROUTING_MODEL="${ROUTING_MODEL:-Qwen3.6-35B-A3B-Q4_K_M}" \
WORK_MODEL="${WORK_MODEL:-${ROUTING_MODEL:-Qwen3.6-35B-A3B-Q4_K_M}}" \
INFERENCE_API_KEY="${INFERENCE_API_KEY:-}" \
DEADLINE_MS="${DEADLINE_MS:-25000}" \
node agent.js
