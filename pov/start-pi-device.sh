#!/usr/bin/env bash
# Raspberry Pi 5: device agent with live metrics. Inference goes to MBP1 over LAN.
# Edit MBP1_IP, then: bash pov/start-pi-device.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export MBP1_IP="${MBP1_IP:-192.168.1.101}"

NAME=pi_device_agent \
PORT=9102 \
INFERENCE_URL="${INFERENCE_URL:-http://${MBP1_IP}:8083/mimik-ai/openai/v1}" \
ROUTING_MODEL="${ROUTING_MODEL:-Qwen3.6-35B-A3B-Q4_K_M}" \
WORK_MODEL="${WORK_MODEL:-${ROUTING_MODEL:-Qwen3.6-35B-A3B-Q4_K_M}}" \
INFERENCE_API_KEY="${INFERENCE_API_KEY:-}" \
DEADLINE_MS="${DEADLINE_MS:-25000}" \
node pov/device-agent.js
