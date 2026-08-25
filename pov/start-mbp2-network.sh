#!/usr/bin/env bash
# MacBook Pro 2: network specialist agent. Inference goes to MBP1 over LAN.
# Edit MBP1_IP, then: bash pov/start-mbp2-network.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export MBP1_IP="${MBP1_IP:-192.168.1.101}"

NAME=network_agent \
PORT=9101 \
DESCRIPTION="Handles network questions for the lab: topology, LAN/WiFi setup, firewalls, adding devices to the mesh, connectivity troubleshooting." \
INSTRUCTIONS="You are the lab's network specialist. Give concrete, actionable network guidance." \
INFERENCE_URL="${INFERENCE_URL:-http://${MBP1_IP}:8083/mimik-ai/openai/v1}" \
ROUTING_MODEL="${ROUTING_MODEL:-Qwen3.6-35B-A3B-Q4_K_M}" \
WORK_MODEL="${WORK_MODEL:-${ROUTING_MODEL:-Qwen3.6-35B-A3B-Q4_K_M}}" \
INFERENCE_API_KEY="${INFERENCE_API_KEY:-}" \
DEADLINE_MS="${DEADLINE_MS:-25000}" \
node agent.js
