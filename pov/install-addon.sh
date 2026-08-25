#!/usr/bin/env bash
# Install the aaosa addon on THIS node (file-based, no mCM HTTP).
#
#   source pov/env.sh
#   bash pov/install-addon.sh frontman|network|device|netsim
#
# Copies the built mim/build/aaosa-agent-<version>.addon into ~/.mimoe/addon/,
# writes the per-role env override ini ([aaosa-agent-v1] section), restarts mimoe.
# The agent is then served at http://<this-node>:8083/mimik-aaosa/agent/v1
set -euo pipefail
cd "$(dirname "$0")/.."

ROLE="${1:?role: frontman | network | device | netsim}"
MIMOE_HOME="${MIMOE_HOME:-$HOME/.mimoe}"
ADDON_DIR="$MIMOE_HOME/addon"
# Derived from whatever mim/package-addon.sh actually produced, so a version
# bump never has to be echoed here (this used to be hardcoded in two places).
ADDON="$(ls -1 mim/build/aaosa-agent-*.addon 2>/dev/null | sort -V | tail -1 || true)"
INI="$ADDON_DIR/$(basename "${ADDON:-aaosa-agent-unknown.addon}" .addon).ini"

# The coordinator's address, which is also the default inference host. Prefer
# the role-based name; MBP1_IP is the older alias and is still honoured.
FRONTMAN_HOST="${NODE_FRONTMAN_HOST:-${MBP1_IP:-}}"
: "${FRONTMAN_HOST:?set NODE_FRONTMAN_HOST in pov/env.sh, then: source pov/env.sh}"

# Read THIS node's block out of env.sh. The whole mesh topology lives in that
# one file, so every node installs with the same two commands and no inline
# overrides: source pov/env.sh, then bash pov/install-addon.sh <role>.
#
# Precedence for every setting below:
#   1. NODE_<ROLE>_<SETTING>   this node's entry in env.sh
#   2. <SETTING>               a bare variable, as a mesh-wide default
#   3. the role's built-in default, further down
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
node_cfg() { local v=""; eval "v=\${NODE_$(upper "$ROLE")_$1:-}"; printf '%s' "$v"; }

CFG_INFER="$(node_cfg INFERENCE_URL)"
CFG_ROUTING="$(node_cfg ROUTING_MODEL)"
CFG_WORK="$(node_cfg WORK_MODEL)"
CFG_MAXTOK="$(node_cfg INFERENCE_MAX_TOKENS)"
CFG_APIKEY="$(node_cfg INFERENCE_API_KEY)"
CFG_INSIGHT="$(node_cfg INSIGHT_TOKEN)"
CFG_INSTR="$(node_cfg INSTRUCTIONS)"
# Optional: run the routing phases on ANOTHER node's model (see env.example.sh).
CFG_RINFER="$(node_cfg ROUTING_INFERENCE_URL)"
CFG_RKEY="$(node_cfg ROUTING_INFERENCE_API_KEY)"
CFG_RMAXTOK="$(node_cfg ROUTING_INFERENCE_MAX_TOKENS)"
[ -n "$ADDON" ] && [ -f "$ADDON" ] || { echo "no addon in mim/build/ — run: bash mim/build.sh && bash mim/package-addon.sh"; exit 1; }
[ -d "$ADDON_DIR" ] || { echo "no $ADDON_DIR here; is mimOE installed on this node?"; exit 1; }

# Per role: NAME/KIND/DESC, plus two latency controls that matter on nodes whose
# local model is slow. INSTR (-> INSTRUCTIONS) steers the work model's answer
# length so it finishes on its own; IMAXTOK (-> INFERENCE_MAX_TOKENS default) is
# the hard backstop. Both are overridable from the environment. The network role
# defaults are tuned for MBP2's local 4B (~26 tok/s): a peer's whole /aaosa reply
# must return inside mimOE's ~20s outbound-read ceiling, and ~120 words (~160
# tokens) clears that with margin; 256 is the backstop. Frontman/device default
# to the fast 35B, so they keep the full budget.
case "$ROLE" in
  frontman)
    NAME=front_man; KIND=frontman
    DESC="Coordinates lab operations inquiries across the mesh."
    INFER_DEFAULT="http://127.0.0.1:8083/mimik-ai/openai/v1"
    INSTR=""            # front-man synthesizes; no brevity clamp
    IMAXTOK=2048
    SC=1                # fast 35B: a confident one-shot answer may short-circuit
    EXTRA="STALE_MS=45000"
    ;;
  network)
    NAME=network_agent; KIND=specialist
    DESC="Handles questions about the REAL lab network as it is configured right now: topology, LAN and WiFi setup, firewalls, adding a device to the mesh, and connectivity troubleshooting. Does not run simulations or what-if analysis."
    INFER_DEFAULT="http://${FRONTMAN_HOST}:8083/mimik-ai/openai/v1"
    INSTR="Answer lab network questions concisely, in under 120 words, with no preamble and without restating the question."
    IMAXTOK=256
    SC=0                # slow, 256-token 4B: skip the speculative answer (it comes
                        # back truncated, e.g. "Full") and always run real fulfil
    EXTRA=""
    ;;
  device)
    NAME=pi_device_agent; KIND=device
    DESC="Reports the live health of this Raspberry Pi: CPU temperature, load, memory, uptime. Owns questions about this device's state or capacity."
    INFER_DEFAULT="http://${FRONTMAN_HOST}:8083/mimik-ai/openai/v1"
    INSTR=""            # grounded in telemetry; the work prompt already quotes numbers
    IMAXTOK=2048
    SC=0                # telemetry-grounded: determine has NO facts yet (gatherFacts
                        # runs at fulfil), so never let it emit a speculative one-shot
                        # answer; always run the real fulfil pass. Also enforced in
                        # lib/aaosa.js determine() for any gatherFacts agent.
    EXTRA=""
    ;;
  netsim)
    NAME=netsim_agent; KIND=specialist
    # Deliberately disjoint from network_agent: that one owns the network as it
    # IS, this one owns the network as it MIGHT BE. Routing is decided purely
    # from these strings, so the two must not overlap or both will claim.
    DESC="Runs network simulations and what-if analysis: capacity and load modelling, failure and outage scenarios, protocol behaviour under stress, and estimating the effect of a proposed change before it is made. Reasons about hypothetical networks, not the current state of the real lab network."
    INFER_DEFAULT="http://127.0.0.1:8083/mimik-ai/openai/v1"
    # A phone's model is small and slow, and a peer's WHOLE reply must return
    # inside mimOE's ~20s outbound-read ceiling, so this role is capped harder
    # than any other and told to be brief.
    INSTR="Answer with a concise simulation result or estimate, under 100 words, no preamble. State the assumptions you used in one short clause."
    IMAXTOK=200
    SC=0                # small model: a one-shot speculative answer comes back
                        # truncated, so always run the real fulfil pass
    EXTRA=""
    ;;
  *) echo "unknown role: $ROLE"; exit 1;;
esac

# Resolve: this node's env.sh entry, then a bare mesh-wide default, then the
# role default. (${VAR-default} without the colon so INSTRUCTIONS="" can clear.)
FINAL_INSTR="${CFG_INSTR:-${INSTRUCTIONS-$INSTR}}"
FINAL_MAXTOK="${CFG_MAXTOK:-${INFERENCE_MAX_TOKENS-$IMAXTOK}}"
FINAL_SC="${SHORT_CIRCUIT-$SC}"
FINAL_APIKEY="${CFG_APIKEY:-${INFERENCE_API_KEY:-}}"
FINAL_INSIGHT="${CFG_INSIGHT:-${INSIGHT_TOKEN:-}}"
INFER="${CFG_INFER:-${INFERENCE_URL:-$INFER_DEFAULT}}"
ROUTING_INFER="${CFG_RINFER:-${ROUTING_INFERENCE_URL:-}}"
ROUTING_KEY="${CFG_RKEY:-${ROUTING_INFERENCE_API_KEY:-}}"
ROUTING_MAXTOK="${CFG_RMAXTOK:-${ROUTING_INFERENCE_MAX_TOKENS:-}}"

# Inference is PER NODE: each role may point at its own endpoint and model via
# INFERENCE_URL / ROUTING_MODEL / WORK_MODEL (loopback is valid for a node that
# runs its own inference). The defaults here suit MBP1 + the Pi (MBP1's 35B);
# override the env when a node runs a different model, e.g. MBP2's local one.
# The two model names default to EACH OTHER: declaring one per node is enough,
# and only a node that deliberately splits routing from work needs both.
_R="${CFG_ROUTING:-${ROUTING_MODEL:-}}"
_W="${CFG_WORK:-${WORK_MODEL:-}}"
MODEL="${_R:-${_W:-Qwen3.6-35B-A3B-Q4_K_M}}"
WMODEL="${_W:-$MODEL}"

# MCP: this agent can register itself as a tool with the mimik MCP server. The
# node's OWN externally-reachable /mcp endpoint (what the MCP server/neuro-san
# calls back) is this role's agent URL + /mcp. MCP_REGISTRY_URL is your mimik MCP
# server's tool-registration endpoint (empty -> registration is a no-op; the /mcp
# tool surface still works for anything that connects directly).
case "$ROLE" in
  frontman) SELF_BASE="${FRONT_URL:-http://127.0.0.1:8083/mimik-aaosa/agent/v1}";;
  network)  SELF_BASE="${NET_URL:-http://127.0.0.1:8083/mimik-aaosa/agent/v1}";;
  device)   SELF_BASE="${PI_URL:-http://127.0.0.1:8083/mimik-aaosa/agent/v1}";;
  netsim)   SELF_BASE="${NETSIM_URL:-http://127.0.0.1:8083/mimik-aaosa/agent/v1}";;
esac
MCP_SELF="${MCP_SELF_URL:-${SELF_BASE%/}/mcp}"

echo "-- installing addon + ${ROLE} ini into ${ADDON_DIR}"
echo "   NAME=${NAME}  AGENT_KIND=${KIND}"
echo "   INFERENCE_URL=${INFER}"
echo "   ROUTING_MODEL=${MODEL}  WORK_MODEL=${WMODEL}"
echo "   INFERENCE_MAX_TOKENS=${FINAL_MAXTOK}"
if [ -n "$ROUTING_INFER" ] && [ "$ROUTING_INFER" != "$INFER" ]; then
  echo "   ROUTING_INFERENCE_URL=${ROUTING_INFER}  (determine/adjudicate/synthesize run there)"
fi
if [ -n "$CFG_INFER" ]; then
  echo "   source: NODE_$(upper "$ROLE")_* in pov/env.sh"
else
  echo "   source: role default (no NODE_$(upper "$ROLE")_INFERENCE_URL in pov/env.sh)"
fi
[ -n "$FINAL_INSTR" ] && echo "   INSTRUCTIONS=${FINAL_INSTR}"
# Drop any previously-installed aaosa addon/ini (including older versions) so
# mimOE cannot keep serving a stale cached image alongside the freshly built one.
rm -f "$ADDON_DIR"/aaosa-agent-*.addon "$ADDON_DIR"/aaosa-agent-*.ini 2>/dev/null || true
cp "$ADDON" "$ADDON_DIR/"
{
  echo "# aaosa agent role config for this node (overrides addon manifest env)"
  echo "[aaosa-agent-v1]"
  echo "NAME=${NAME}"
  echo "AGENT_KIND=${KIND}"
  echo "DESCRIPTION=${DESC}"
  [ -n "$FINAL_INSTR" ] && echo "INSTRUCTIONS=${FINAL_INSTR}"
  echo "INFERENCE_URL=${INFER}"
  [ -n "$ROUTING_INFER" ] && echo "ROUTING_INFERENCE_URL=${ROUTING_INFER}"
  [ -n "$ROUTING_KEY" ] && echo "ROUTING_INFERENCE_API_KEY=${ROUTING_KEY}"
  [ -n "$ROUTING_MAXTOK" ] && echo "ROUTING_INFERENCE_MAX_TOKENS=${ROUTING_MAXTOK}"
  echo "INFERENCE_API_KEY=${FINAL_APIKEY}"
  echo "INFERENCE_MAX_TOKENS=${FINAL_MAXTOK}"
  echo "INFERENCE_ENABLE_THINKING=${INFERENCE_ENABLE_THINKING:-0}"
  echo "INFERENCE_TIMEOUT_MS=${INFERENCE_TIMEOUT_MS:-60000}"
  echo "INSIGHT_TOKEN=${FINAL_INSIGHT}"
  echo "DISCOVERY_SCOPE=${DISCOVERY_SCOPE:-linkLocal}"
  echo "MCP_REGISTRY_URL=${MCP_REGISTRY_URL:-}"
  echo "MCP_SELF_URL=${MCP_SELF}"
  echo "MCP_REGISTER_TOKEN=${MCP_REGISTER_TOKEN:-${FINAL_INSIGHT}}"
  [ -n "${MCP_TOOL_NAME:-}" ] && echo "MCP_TOOL_NAME=${MCP_TOOL_NAME}"
  echo "ROUTING_MODEL=${MODEL}"
  echo "WORK_MODEL=${WMODEL}"
  echo "DEADLINE_MS=${DEADLINE_MS:-25000}"
  echo "SHORT_CIRCUIT=${FINAL_SC}"
  echo "MCM.MAX_EXECUTION_TIME_SEC=180"
  echo "MCM.OTEL_SUPPORT=true"
  [ -n "$EXTRA" ] && echo "$EXTRA"
} > "$INI"

echo "-- restarting mimoe"
# Restarting the service needs root on Linux. Over SSH there is no terminal to
# type a sudo password into, so pov/remote.sh passes the node's login password
# as NODE_SUDO_PASS and we feed it to `sudo -S`. Interactively (the normal
# case) NODE_SUDO_PASS is unset and this is a plain sudo.
RESTART_OK=1
MANUAL_RESTART=0
# Some hosts run mimOE as an APP, not a service: an Android phone is restarted
# from the mimOE app's own UI, and there is no command to do it. Detect that
# and give instructions instead of failing; MIMOE_RESTART=manual|auto forces it.
IS_ANDROID=0
case "$(uname -o 2>/dev/null || true)" in Android) IS_ANDROID=1;; esac
case "${PREFIX:-}" in *com.termux*) IS_ANDROID=1;; esac
if [ "$IS_ANDROID" = 1 ]; then RESTART_MODE="${MIMOE_RESTART:-manual}"; else RESTART_MODE="${MIMOE_RESTART:-auto}"; fi

as_root() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"                                   # passwordless sudo already available
  elif [ -n "${NODE_SUDO_PASS:-}" ]; then
    printf '%s\n' "$NODE_SUDO_PASS" | sudo -S -p '' "$@"
  elif [ -t 0 ]; then
    sudo "$@"                                   # interactive: let sudo prompt
  else
    cat >&2 <<'EOS'
   ERROR: restarting mimOE needs root, and this session has no way to authenticate.
   Over SSH there is no terminal for a sudo prompt, so supply the password or
   remove the need for one:
     - run `bash pov/remote.sh setup <role>` from a terminal: it asks for the
       password and pipes it through, so nothing is stored, or
     - set NODE_<ROLE>_SUDO_PASS (or NODE_<ROLE>_PASS) in pov/env.sh, or
     - give this login passwordless sudo for the restart only:
         echo "$(id -un) ALL=(root) NOPASSWD: $(command -v systemctl) restart mimOE" \
           | sudo tee /etc/sudoers.d/mimoe-restart
EOS
    return 1
  fi
}
if [ "$RESTART_MODE" = "manual" ]; then
  MANUAL_RESTART=1
  echo "   this host runs mimOE as an app, so there is nothing to restart from here."
elif systemctl list-units --type=service 2>/dev/null | grep -qi mimoe; then
  SVC=$(systemctl list-units --type=service | grep -i mimoe | awk '{print $1}' | head -1)
  as_root systemctl restart "$SVC" || RESTART_OK=0
elif [ -x "$MIMOE_HOME/bin/mimoe" ]; then
  "$MIMOE_HOME/bin/mimoe" stop >/dev/null 2>&1 || true
  sleep 1
  (cd "$MIMOE_HOME" && "$MIMOE_HOME/bin/mimoe" start < /dev/null > /dev/null 2>&1 &)
else
  RESTART_OK=0
  echo "   WARNING: no way to restart mimOE found on this host (no systemctl unit," >&2
  echo "   no ${MIMOE_HOME}/bin/mimoe). The role ini was written but is NOT in effect" >&2
  echo "   until mimOE reloads. Restart it by hand, then re-check /descriptor." >&2
fi

sleep 3
echo "-- verify:"
curl -s "http://127.0.0.1:8083/mimik-aaosa/agent/v1/healthcheck" || echo " (not up yet; give it a few seconds and re-curl)"
echo

# Register this agent's MCP tool with the mimik MCP server (idempotent; safe to
# re-run). No-op if MCP_REGISTRY_URL is unset. The /mcp tool surface is served
# regardless — this step only advertises it to the central registry.
if [ -n "${MCP_REGISTRY_URL:-}" ]; then
  echo "-- registering MCP tool with ${MCP_REGISTRY_URL}"
  curl -s -X POST "http://127.0.0.1:8083/mimik-aaosa/agent/v1/mcp/register" \
    || echo " (register failed; re-run: curl -s -X POST \$THIS_NODE/mcp/register)"
  echo
fi

# ---- device role: keep the sensor feed running --------------------------------
# A serverless mim cannot read sysfs, so the host pushes its own readings in. A
# device agent whose feed is not running answers "I have no data", which is the
# one thing this role exists not to do — and the install otherwise looks
# perfectly healthy, so it is an easy thing to miss.
#
# The feed is a loop, so it belongs under systemd rather than a backgrounded
# SSH command: it survives reboot, restarts on failure, and re-running this
# installer updates it in place instead of stacking a second loop pushing twice
# per interval. TELEMETRY_SERVICE=0 skips it; TELEMETRY_INTERVAL sets the period.
if [ "$ROLE" = "device" ] && [ "${TELEMETRY_SERVICE:-1}" != "0" ]; then
  TELE_URL="http://127.0.0.1:8083/mimik-aaosa/agent/v1"
  if [ ! -r /proc/loadavg ]; then
    echo "-- telemetry feed skipped: no /proc/loadavg, so this host has nothing to read"
  elif ! command -v systemctl >/dev/null 2>&1; then
    echo "-- telemetry feed skipped: no systemd on this host. Run it yourself:"
    echo "     INTERVAL=15 bash pov/pi-telemetry-push.sh"
  else
    UNIT_PATH=/etc/systemd/system/aaosa-telemetry.service
    UNIT_TMP="$(mktemp)"
    cat > "$UNIT_TMP" <<UNITEOF
[Unit]
Description=AAOSA device telemetry feed (host sensors into the local mim)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${PWD}
Environment=INTERVAL=${TELEMETRY_INTERVAL:-15}
Environment=AGENT_URL=${TELE_URL}
ExecStart=/bin/bash ${PWD}/pov/pi-telemetry-push.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF
    echo "-- installing the telemetry feed as a service (${UNIT_PATH})"
    if as_root cp "$UNIT_TMP" "$UNIT_PATH" \
       && as_root systemctl daemon-reload \
       && as_root systemctl enable aaosa-telemetry >/dev/null 2>&1 \
       && as_root systemctl restart aaosa-telemetry; then
      sleep 3
      echo "   state: $(systemctl is-active aaosa-telemetry 2>/dev/null || echo unknown)"
      echo "   feed : $(curl -s --max-time 5 "${TELE_URL}/metrics" | head -c 140)"
    else
      echo "   WARNING: could not install the telemetry service. The agent will have" >&2
      echo "   no data to answer from until you run the feed yourself:" >&2
      echo "     INTERVAL=15 bash pov/pi-telemetry-push.sh" >&2
    fi
    rm -f "$UNIT_TMP"
  fi
fi

# Exit non-zero when the config was written but mimOE never reloaded it. Without
# this, pov/remote.sh reports "ok" for a node that is still running the previous
# configuration, which is a slow and confusing way to find out.
if [ "$MANUAL_RESTART" = "1" ]; then
  echo
  echo "== ACTION REQUIRED ON THIS DEVICE =="
  echo "   The addon and the ${ROLE} ini are installed, but mimOE has not reloaded"
  echo "   them. Open the mimOE app, stop it, and start it again."
  echo "   Then confirm from the coordinator:"
  echo "       curl -s http://<this-device>:8083/mimik-aaosa/agent/v1/descriptor"
  echo "   Until you do, this node is not in the mesh."
  exit 0
fi
if [ "$RESTART_OK" != "1" ]; then
  echo "-- FAILED: role ini written to ${INI}, but mimOE was NOT restarted." >&2
  echo "   Nothing above is in effect until it reloads." >&2
  exit 1
fi
