#!/usr/bin/env bash
# One-time lab configuration. Copy to env.sh, fill in the blanks, then run
#     source pov/env.sh
# in EVERY terminal you open, on every machine (the folder you scp to the other
# nodes carries env.sh along).
#
# env.sh HOLDS CREDENTIALS. It is gitignored. Never commit it.
#
# ===========================================================================
# 1. WHICH MACHINE PLAYS WHICH ROLE
# ===========================================================================
# One line per role. The role is what matters, not the hardware: any machines
# on one LAN work, as long as :8083 is reachable between them.
#
#   frontman  the coordinator, and normally the inference host for the mesh
#   network   a specialist with no special hardware requirement
#   device    needs readable host sensors (Linux /sys + /proc)
#
# Addresses: macOS `ipconfig getifaddr en0`, Linux `hostname -I`.
# Leave a role's host EMPTY to run without it (a two-node mesh is valid;
# drop `network` rather than `device`, which is what makes the demo worth
# watching). One of these is the machine you are sitting at.

export NODE_FRONTMAN_HOST=192.168.1.101
export NODE_NETWORK_HOST=192.168.1.102
export NODE_DEVICE_HOST=192.168.1.103

# --- SSH, for configuring the other nodes from this one (pov/remote.sh) -----
# The login on EACH machine. These are usually different per machine, so set
# them literally: run `whoami` on a node to read its login. Do NOT write
# "$USER" here. This file gets copied to every node, and "$USER" would be
# re-evaluated by whichever machine sources it, so one file would silently mean
# a different login on each node.
#
# Leave one blank only if that node's login happens to match the login on the
# machine you run remote.sh from; remote.sh then falls back to it and says so.
export NODE_FRONTMAN_USER=          # e.g. alice  (login on the coordinator machine)
export NODE_NETWORK_USER=           # e.g. bob    (login on the specialist machine)
export NODE_DEVICE_USER=pi          # Raspberry Pi OS default

# Password auth is supported so you can start from nothing, but it needs
# `sshpass` and puts a password in this file. Run
#     bash pov/remote.sh keys
# once and every later command uses key auth; then blank the _PASS lines.
# remote.sh strips every *_PASS value out of env.sh before copying it to a
# node, so passwords never leave this machine.

export NODE_FRONTMAN_PASS=
export NODE_NETWORK_PASS=
export NODE_DEVICE_PASS=

# The SUDO password, which is a DIFFERENT thing. Restarting mimOE needs root on
# a Linux node, and over SSH the remote side has no terminal for a sudo prompt.
# Running `remote.sh keys` removes the SSH password but not this one.
#
# LEAVING THESE BLANK IS FINE AND IS THE RECOMMENDED DEFAULT: remote.sh asks
# for the password on YOUR terminal when it needs one, and pipes it through, so
# it is never written to a file. Fill one in only for unattended runs (cron,
# CI), where there is no terminal to ask. Blank also falls back to that node's
# _PASS above, for the case where they are the same.
#
# To remove the need entirely, give that login passwordless sudo for the
# restart only, on that node:
#     echo "$(whoami) ALL=(root) NOPASSWD: $(command -v systemctl) restart mimOE" \
#       | sudo tee /etc/sudoers.d/mimoe-restart
# install-addon.sh tries passwordless sudo first, so it will never ask again.
export NODE_FRONTMAN_SUDO_PASS=
export NODE_NETWORK_SUDO_PASS=
export NODE_DEVICE_SUDO_PASS=

# Where the repo lands on a remote node (must be writable by the SSH user).
export NODE_REMOTE_PATH="aaosa-mimoe"

# --- Compatibility aliases -------------------------------------------------
# The older scripts and some runbook curls still use these names, which came
# from the reference lab (RUNBOOK.md appendix B). Derived, do not edit.
export MBP1_IP="${NODE_FRONTMAN_HOST}"
export MBP2_IP="${NODE_NETWORK_HOST}"
export PI_IP="${NODE_DEVICE_HOST}"

# --- mCM credential, one per node (OPTIONAL: legacy HTTP deploy only) ---
# The file-based addon install (pov/install-addon.sh) needs NO mCM credential.
# The bearer mim/deploy.sh sends to that node's mCM (as MCM_TOKEN; legacy
# alias MCM_API_KEY). Paste the credential you have for each node.
# WHERE TO FIND IT: on each node, mimOE writes its own key to
#     ~/.mimoe/mimoe-api-key.env
# so read it there, on that machine, rather than guessing.
# If mCM rejects it with 403 "A JWT Token is required", your build wants a
# minted edge access token instead: see the RUNBOOK appendix.
export MBP1_KEY=
export MBP2_KEY=
export PI_KEY=

# --- Derived agent URLs (no edits needed) ---
export FRONT_URL="http://${NODE_FRONTMAN_HOST}:8083/mimik-aaosa/agent/v1"
export NET_URL="http://${NODE_NETWORK_HOST}:8083/mimik-aaosa/agent/v1"
export PI_URL="http://${NODE_DEVICE_HOST}:8083/mimik-aaosa/agent/v1"

# ===========================================================================
# 2. INFERENCE TOPOLOGY: which model each node reasons with, and where
# ===========================================================================
# This is the whole point of declaring the mesh in one file. Each node reads
# ITS OWN block, so installing is the same two steps everywhere:
#
#     source pov/env.sh
#     bash pov/install-addon.sh <role>
#
# No per-node edits, no inline overrides on the install command.
#
# install-addon.sh resolves each setting in this order:
#     1. NODE_<ROLE>_<SETTING>   this file (the normal path)
#     2. <SETTING>               a bare variable, as a mesh-wide default
#     3. the role's built-in default
# so a one-off override is the per-role name set inline, e.g.
#     NODE_NETWORK_WORK_MODEL=some-model bash pov/install-addon.sh network
#
# Two URL conventions, and the difference matters:
#   127.0.0.1  the node's OWN mimik ai. Correct only in that node's own block,
#              because each node evaluates its own line.
#   ${NODE_FRONTMAN_HOST}  another node's mimik ai, over the LAN. Never write
#              127.0.0.1 to mean "the coordinator" from a different node.

# --- Node A, coordinator: hosts the shared model, uses it locally ----------
export NODE_FRONTMAN_INFERENCE_URL="http://127.0.0.1:8083/mimik-ai/openai/v1"
export NODE_FRONTMAN_ROUTING_MODEL="Qwen3.6-35B-A3B-Q4_K_M"
export NODE_FRONTMAN_WORK_MODEL="Qwen3.6-35B-A3B-Q4_K_M"
export NODE_FRONTMAN_INFERENCE_MAX_TOKENS=2048

# --- Node B, network specialist: its own smaller model, on its own machine --
# A peer's WHOLE reply must return inside mimOE's ~20s outbound-read ceiling.
# A 4B at ~26 tok/s overruns that unless the answer is short, which is why this
# node caps tokens; install-addon.sh also applies a "be concise" instruction to
# the network role. To give it full-length answers instead, point it at the
# coordinator's fast model below and raise the cap to 2048.
export NODE_NETWORK_INFERENCE_URL="http://127.0.0.1:8083/mimik-ai/openai/v1"
export NODE_NETWORK_ROUTING_MODEL="Qwen3.5-4B-Q3_K_M"
export NODE_NETWORK_WORK_MODEL="Qwen3.5-4B-Q3_K_M"
export NODE_NETWORK_INFERENCE_MAX_TOKENS=256
# Alternative: borrow the coordinator's model instead of running one here.
#   export NODE_NETWORK_INFERENCE_URL="http://${NODE_FRONTMAN_HOST}:8083/mimik-ai/openai/v1"
#   export NODE_NETWORK_ROUTING_MODEL="Qwen3.6-35B-A3B-Q4_K_M"
#   export NODE_NETWORK_WORK_MODEL="Qwen3.6-35B-A3B-Q4_K_M"
#   export NODE_NETWORK_INFERENCE_MAX_TOKENS=2048

# --- Node C, device: no local model, borrows the coordinator's -------------
export NODE_DEVICE_INFERENCE_URL="http://${NODE_FRONTMAN_HOST}:8083/mimik-ai/openai/v1"
export NODE_DEVICE_ROUTING_MODEL="Qwen3.6-35B-A3B-Q4_K_M"
export NODE_DEVICE_WORK_MODEL="Qwen3.6-35B-A3B-Q4_K_M"
export NODE_DEVICE_INFERENCE_MAX_TOKENS=2048

# --- Inference API key, per node ------------------------------------------
# The [milm-v1] API_KEY in that node's ~/.mimoe/addon/ai-foundation.ini
# (installer default: 1234). Wrong or empty -> inference returns 401/403.
# Set MESH_INFERENCE_API_KEY once when every node's mimik ai uses the same key.
MESH_INFERENCE_API_KEY=1234
export NODE_FRONTMAN_INFERENCE_API_KEY="${MESH_INFERENCE_API_KEY}"
export NODE_NETWORK_INFERENCE_API_KEY="${MESH_INFERENCE_API_KEY}"
export NODE_DEVICE_INFERENCE_API_KEY="${MESH_INFERENCE_API_KEY}"
# Bare names, used by the runbook curls and as the last-resort default for a
# role with no block above. Deliberately the coordinator's LAN address, not
# 127.0.0.1: this value has to be correct when read from ANY node.
export INFERENCE_API_KEY="${NODE_FRONTMAN_INFERENCE_API_KEY}"
export INFERENCE_URL="http://${NODE_FRONTMAN_HOST}:8083/mimik-ai/openai/v1"
# Chain-of-thought is DISABLED by default: this Qwen build otherwise reasons for
# 20-40s per call and returns empty output when the reasoning overruns the token
# budget (verified: top-level enable_thinking:false is the switch milm honors).
# Set to 1 only if you want the model's reasoning back (and expect slow calls).
# export INFERENCE_ENABLE_THINKING=1
# How long a node waits for one inference call before giving up (ms). With
# thinking off, calls are ~1-2s so this rarely bites; raise it if you turn
# thinking back on or the model is slow. If PEERS time out as 'unreachable',
# raise DEADLINE_MS too (front-man's per-consult budget includes the peer's call).
export INFERENCE_TIMEOUT_MS=60000
# Front-man's budget for one peer consult (ms; doubled for the fulfil step).
export DEADLINE_MS=25000

# ===========================================================================
# 3. MESH DISCOVERY
# ===========================================================================
# Agents find each other by interrogating mimOE's mesh service (mInsight), not
# by announcing, so there is no heartbeat to keep running. INSIGHT_TOKEN is the
# edge access token (JWT) a mim uses to query ITS OWN node's mesh.
#
# These are MINTED PER NODE (RUNBOOK Appendix A), so each node normally has a
# different one. Set MESH_INSIGHT_TOKEN only if your build accepts one value
# everywhere; otherwise paste each node's own token.
MESH_INSIGHT_TOKEN=
export NODE_FRONTMAN_INSIGHT_TOKEN="${MESH_INSIGHT_TOKEN}"
export NODE_NETWORK_INSIGHT_TOKEN="${MESH_INSIGHT_TOKEN}"
export NODE_DEVICE_INSIGHT_TOKEN="${MESH_INSIGHT_TOKEN}"

# The mesh radius: linkLocal (same LAN) | proximity | account.
export DISCOVERY_SCOPE=linkLocal

# Bare name, for runbook curls run on the coordinator.
export INSIGHT_TOKEN="${NODE_FRONTMAN_INSIGHT_TOKEN}"

# --- OPTIONAL: route on one node's model, answer on another -----------------
# The routing phases (determine, adjudicate, synthesize) and the work phase
# (fulfil) normally share one endpoint. Set a routing URL for a node to split
# them. Typical use: a node whose local model is small enough to truncate
# routing JSON ("Full", or determine error: expected JSON) borrows the
# coordinator's larger model for routing only, and still answers locally.
#
#   export NODE_NETWORK_ROUTING_INFERENCE_URL="http://${NODE_FRONTMAN_HOST}:8083/mimik-ai/openai/v1"
#   export NODE_NETWORK_ROUTING_MODEL="Qwen3.6-35B-A3B-Q4_K_M"   # lives at that URL
#   export NODE_NETWORK_ROUTING_INFERENCE_API_KEY="${MESH_INFERENCE_API_KEY}"
#   export NODE_NETWORK_ROUTING_INFERENCE_MAX_TOKENS=512          # JSON needs few
#
# The reverse also works: keep routing local and cheap, send only fulfil to a
# bigger model, by pointing NODE_<ROLE>_INFERENCE_URL at the other node and
# NODE_<ROLE>_ROUTING_INFERENCE_URL at 127.0.0.1.
#
# COST: determine runs on EVERY inquiry, and the up-chain's DEADLINE_MS covers a
# peer's whole reply INCLUDING that peer's inference call. Splitting routing
# off-node adds a LAN round trip inside that budget, and concentrates routing
# traffic on one machine. Leave it unset unless a node's routing is failing.
