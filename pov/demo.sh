#!/usr/bin/env bash
# Run from any machine that can reach MBP1. Edit MBP1_IP first.
set -euo pipefail
MBP1_IP="${MBP1_IP:-192.168.1.101}"
J() { if command -v jq >/dev/null; then jq .; else cat; echo; fi; }

echo "=== 1. Routes to the Pi device agent (live metrics cross the mesh) ==="
curl -s "http://${MBP1_IP}:9100/chat" -d '{"message":"How hot is the raspberry pi right now, and is it under load?"}' | J

echo "=== 2. Routes to the network agent on MBP2 ==="
curl -s "http://${MBP1_IP}:9100/chat" -d '{"message":"What network setup do we need to add a second raspberry pi to this lab?"}' | J

echo "=== 3. Needs both agents: fan-out, two fulfils, one synthesis ==="
curl -s "http://${MBP1_IP}:9100/chat" -d '{"message":"Given the pi'"'"'s current temperature and load, is it safe to add more agent workloads to it, and what network prep would a second pi need?"}' | J

echo "=== Raw Pi metrics, no LLM ==="
PI_IP="${PI_IP:-192.168.1.103}"
curl -s "http://${PI_IP}:9102/metrics" | J
