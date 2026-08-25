#!/usr/bin/env bash
# Sensor feeder for the device agent.
#
# A serverless mim cannot read sysfs, so the host pushes its own readings in.
# This is mimik's mIoT sensor pattern: sensors POST into the mim, and the agent
# grounds its answers on the last sample through the gatherFacts hook.
#
#   INTERVAL=15 bash pov/pi-telemetry-push.sh    # loop forever, no external tools
#   bash pov/pi-telemetry-push.sh                # push once and exit
#
# This script does telemetry ONLY. Mesh membership is not its job: the agent is
# in the mesh because its node's mimOE advertises the aaosa service, which the
# coordinator reads from mimOE's mesh service (mInsight). Nothing to announce,
# nothing to keep alive. pov/heartbeat.sh still exists for the legacy /announce
# bootstrap path, but the normal PoV never calls it.
#
# Linux only: reads /sys/class/thermal, /proc/loadavg, /proc/meminfo, /proc/uptime.
set -euo pipefail

if [ -n "${INTERVAL:-}" ] && [ -z "${_AAOSA_LOOP:-}" ]; then
  export _AAOSA_LOOP=1
  while true; do bash "$0" || true; sleep "${INTERVAL}"; done
fi

AGENT_URL="${AGENT_URL:-http://127.0.0.1:8083/mimik-aaosa/agent/v1}"

TEMP_MILLI=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "")
TEMP_C=${TEMP_MILLI:+$(awk "BEGIN{printf \"%.1f\", ${TEMP_MILLI}/1000}")}
read -r L1 L5 L15 _ < /proc/loadavg
MEM_TOTAL_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
MEM_FREE_MB=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
UPTIME_H=$(awk '{printf "%.2f", $1/3600}' /proc/uptime)

curl -fsS -X POST "${AGENT_URL}/telemetry" -H 'content-type: application/json' -d "{
  \"host\": \"$(hostname)\",
  \"cpuTempC\": ${TEMP_C:-null},
  \"loadAvg\": {\"1m\": ${L1}, \"5m\": ${L5}, \"15m\": ${L15}},
  \"memory\": {\"totalMB\": ${MEM_TOTAL_MB}, \"freeMB\": ${MEM_FREE_MB}},
  \"uptimeHours\": ${UPTIME_H}
}" >/dev/null && echo "$(date +%H:%M:%S) telemetry pushed to ${AGENT_URL}"
