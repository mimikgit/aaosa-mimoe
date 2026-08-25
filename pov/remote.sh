#!/usr/bin/env bash
# Configure the OTHER nodes of the mesh from this one, over SSH.
#
#   bash pov/remote.sh keys                install this machine's SSH key on the other nodes
#   bash pov/remote.sh setup all           copy source + BUILD THERE + install
#   bash pov/remote.sh setup network       just that one role
#   bash pov/remote.sh push all            copy the source only, do not build or install
#   bash pov/remote.sh status              reach every node's agent from here
#   bash pov/remote.sh exec all 'uptime'   run a command on each remote node
#
# RUN THIS FROM THE COORDINATOR. "all" therefore means "the other nodes" and
# never includes frontman: you do not SSH to yourself, install a key on
# yourself, or reinstall the role you already installed with
#   bash pov/install-addon.sh frontman
# To drive a coordinator from some other machine, name it: `setup frontman`.
#
# "all" also never includes netsim. That role is the phone: no sshd, no scp,
# no remote sudo. You copy the folder to it and run build-here.sh +
# install-addon.sh in Termux yourself (RUNBOOK section "Node D"). `status`
# still reports it, because it answers HTTP on the LAN like any other node.
#
# Which machine plays which role comes from pov/env.sh:
#   NODE_FRONTMAN_HOST / NODE_NETWORK_HOST / NODE_DEVICE_HOST / NODE_NETSIM_HOST
#   (+ _USER, _PASS)
# A role whose host is empty is skipped, as is any role pointing at this
# machine; install that one locally with `bash pov/install-addon.sh <role>`.
#
# Auth: SSH keys if they work, password (via sshpass) otherwise. `remote.sh keys`
# uses the password once so that everything afterwards is key-based.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f pov/env.sh ] || { echo "no pov/env.sh — copy pov/env.example.sh to pov/env.sh and fill it in"; exit 1; }
# shellcheck disable=SC1091
source pov/env.sh

ROLES="frontman network device netsim"
# Roles this script never provisions over SSH. frontman is this machine;
# netsim is the phone, which has no sshd. Both are reported by `status` and by
# the node map — they are part of the mesh, just not of the SSH fan-out.
MANUAL_ROLES="netsim"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o BatchMode=no"
REMOTE_PATH="${NODE_REMOTE_PATH:-aaosa-mimoe}"

have() { command -v "$1" >/dev/null 2>&1; }
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
is_manual() { case " $MANUAL_ROLES " in *" $1 "*) return 0;; *) return 1;; esac; }

# macOS bsdtar writes LIBARCHIVE.xattr.* extended headers, and anything you
# unzipped from a download carries com.apple.quarantine. GNU tar on a Linux node
# does not know those keywords and prints
#     tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr...'
# once per file. It is only a warning (extraction succeeds, exit 0), but it
# reads like a failure, so strip the metadata at the source instead. Probed
# rather than assumed: GNU tar accepts --no-xattrs but not --no-mac-metadata.
# A plain string, not an array, so an empty value is safe under `set -u` on
# macOS's bash 3.2.
TAR_OPTS=""
for _o in --no-xattrs --no-mac-metadata; do
  if tar "$_o" -cf /dev/null -T /dev/null >/dev/null 2>&1; then TAR_OPTS="$TAR_OPTS $_o"; fi
done

# Read NODE_<ROLE>_<FIELD> without letting the caller's shell expand anything
# eagerly: an inline "${VAR:-$USER}" inside eval expands $USER in THIS shell,
# which aborts under `set -u` on a login without USER set.
role_var() { local v=""; eval "v=\${NODE_$(upper "$1")_$2:-}"; printf '%s' "$v"; }
role_host() { role_var "$1" HOST; }
role_pass() { role_var "$1" PASS; }
role_user() { local u; u="$(role_var "$1" USER)"; printf '%s' "${u:-${USER:-$(id -un)}}"; }
# The sudo password is NOT the SSH password: once `remote.sh keys` is done the
# _PASS lines get blanked, but a Linux node still needs a password to restart
# mimOE. Falls back to the SSH password when they happen to be the same.
role_sudo() { local p; p="$(role_var "$1" SUDO_PASS)"; if [ -z "$p" ]; then p="$(role_var "$1" PASS)"; fi; printf '%s' "$p"; }

# Resolve a node's sudo password: env.sh first, otherwise ASK. Over SSH the
# remote side has no terminal for a sudo prompt, but the machine you are
# running this from almost always does, so prompt here and pipe the answer
# through. That keeps the password out of env.sh entirely. Non-interactive
# runs (CI, cron) get an empty value and install-addon.sh explains what to do.
sudo_pass_for() {
  local role="$1" p pw=""
  p="$(role_sudo "$role")"
  if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '   sudo password for %s@%s (to restart mimOE; empty to skip): ' \
      "$(role_user "$role")" "$(role_host "$role")" > /dev/tty
    read -rs pw < /dev/tty || true
    printf '\n' > /dev/tty
  fi
  printf '%s' "$pw"
}

# Names and addresses belonging to this machine, so we never SSH to ourselves.
# Hostnames are included because a role host may be written as a name rather
# than an address, which an interface scan alone would never match.
local_names() {
  { ip -o addr show 2>/dev/null || ifconfig 2>/dev/null || true; } \
    | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | sort -u
  hostname 2>/dev/null || true
  hostname -s 2>/dev/null || true
  echo "127.0.0.1"; echo "localhost"
}
is_local() { local_names | grep -qxF "$1"; }

# Print the resolved role -> user@host mapping once, before doing anything.
# Logins differ per machine, so showing the guess is the difference between a
# clear "wrong user" and a confusing permission denied.
MAP_SHOWN=0
show_map() {
  if [ "$MAP_SHOWN" = 1 ]; then return 0; fi
  MAP_SHOWN=1
  local r host user set_user
  echo "-- node map (pov/env.sh)"
  for r in $ROLES; do
    host="$(role_host "$r")"
    if [ -z "$host" ]; then
      printf '   %-9s %s\n' "$r" "no host set, skipped"
      continue
    fi
    user="$(role_user "$r")"; set_user="$(role_var "$r" USER)"
    if [ "$r" = "frontman" ]; then
      printf '   %-9s %-28s %s\n' "$r" "$host" "this machine, not touched by 'all'"
    elif is_manual "$r"; then
      printf '   %-9s %-28s %s\n' "$r" "$host" "installed by hand, not touched by 'all'"
    elif [ -z "$set_user" ]; then
      printf '   %-9s %-28s %s\n' "$r" "${user}@${host}" \
        "<- NODE_$(upper "$r")_USER not set, guessed from this machine"
    elif is_local "$host"; then
      printf '   %-9s %-28s %s\n' "$r" "${user}@${host}" "(this machine)"
    else
      printf '   %-9s %s\n' "$r" "${user}@${host}"
    fi
    # The inference topology this node will be installed with, straight from
    # env.sh. Wrong model or a 127.0.0.1 that should be the coordinator's LAN
    # address is far easier to catch here than in a trace afterwards.
    local iurl rmod wmod
    iurl="$(role_var "$r" INFERENCE_URL)"
    rmod="$(role_var "$r" ROUTING_MODEL)"
    wmod="$(role_var "$r" WORK_MODEL)"
    # Since 0.2.0 the agent defaults each model to the other, so a node that
    # sets only one is using it for both. Print what will actually run, not a
    # "routing ?" that suggests something is missing.
    [ -n "$rmod" ] || rmod="$wmod"
    [ -n "$wmod" ] || wmod="$rmod"
    if [ -n "$iurl" ] || [ -n "$rmod" ]; then
      if [ -n "$wmod" ] && [ "$wmod" != "$rmod" ]; then
        printf '   %-9s   routing %s / work %s\n' "" "${rmod:-?}" "$wmod"
      else
        printf '   %-9s   model %s\n' "" "${rmod:-?}"
      fi
      printf '   %-9s   via   %s\n' "" "${iurl:-<role default>}"
      local rinfer; rinfer="$(role_var "$r" ROUTING_INFERENCE_URL)"
      if [ -n "$rinfer" ] && [ "$rinfer" != "$iurl" ]; then
        printf '   %-9s   routing phases run on %s\n' "" "$rinfer"
      fi
    else
      printf '   %-9s   inference: no NODE_%s_* block in env.sh, role default applies\n' "" "$(upper "$r")"
    fi
  done
  echo
}

# Wrap ssh/scp so password auth is used only when a password is set AND keys
# are not already working. sshpass is not on macOS by default.
need_sshpass() {
  have sshpass && return 0
  cat >&2 <<'EOS'
   sshpass is required for password auth and is not installed.
     macOS : brew install hudochenkov/sshpass/sshpass
     Debian: sudo apt install sshpass
   Or use keys instead: ssh-copy-id <user>@<host>, then blank the _PASS lines.
EOS
  return 1
}

key_works() { # $1 user@host
  # </dev/null is load-bearing. ssh forwards stdin to the remote command, so
  # this probe would otherwise EAT the sudo password that cmd_setup pipes in
  # and the remote `head -n1` would read EOF, producing "no way to
  # authenticate" on a node whose password was supplied correctly. -n does the
  # same thing; both are given so the intent survives an edit.
  ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 \
    "$1" true </dev/null 2>/dev/null
}

RSH=()          # populated per role by transport_for
transport_for() {
  local role="$1" host user pass target
  host="$(role_host "$role")"; user="$(role_user "$role")"; pass="$(role_pass "$role")"
  target="${user}@${host}"
  if key_works "$target"; then
    RSH=(ssh)
  elif [ -n "$pass" ]; then
    need_sshpass || return 1
    RSH=(sshpass -p "$pass" ssh)
  else
    echo "   no key access to ${target} and no NODE_$(upper "$role")_PASS set" >&2
    return 1
  fi
  return 0
}

rsh() { # role, command...
  local role="$1"; shift
  local target="$(role_user "$role")@$(role_host "$role")"
  transport_for "$role" || return 1
  "${RSH[@]}" $SSH_OPTS "$target" "$@"
}

# --- which roles to act on -------------------------------------------------
selected_roles() {
  local want="${1:-all}" r host
  for r in $ROLES; do
    [ "$want" = "all" ] || [ "$want" = "$r" ] || continue
    # You run this FROM the coordinator, so 'all' means "the other nodes" and
    # never includes frontman: no key to install on yourself, and nothing to
    # push to yourself. Name the role explicitly to override, for the unusual
    # case of driving a coordinator from some other machine.
    if [ "$want" = "all" ] && [ "$r" = "frontman" ]; then continue; fi
    # The phone has no sshd and no remote sudo: it is installed by hand. Silent
    # under 'all' (it is not a failure), explicit when you name it, so nobody
    # sits waiting for an SSH connection that was never going to happen.
    if is_manual "$r"; then
      if [ "$want" != "all" ]; then
        echo "   role '$r' is installed by hand, not over SSH." >&2
        echo "       Copy this folder to the device, then run there:" >&2
        echo "         bash pov/build-here.sh && bash pov/install-addon.sh $r" >&2
        echo "       See the 'Node D' section of pov/RUNBOOK.md." >&2
      fi
      continue
    fi
    host="$(role_host "$r")"
    if [ -z "$host" ]; then
      if [ "$want" != "all" ]; then
        echo "   role '$r' has no NODE_$(upper "$r")_HOST set in pov/env.sh" >&2
      fi
      continue
    fi
    if is_local "$host"; then
      echo "   skipping '$r' ($host): that is this machine. Install it locally:" >&2
      echo "       bash pov/install-addon.sh $r" >&2
      continue
    fi
    echo "$r"
  done
}

# --- subcommands -----------------------------------------------------------
cmd_keys() {
  show_map
  have ssh-keygen || { echo "ssh-keygen not found"; exit 1; }
  [ -f "$HOME/.ssh/id_ed25519.pub" ] || [ -f "$HOME/.ssh/id_rsa.pub" ] || {
    echo "-- no SSH key on this machine, generating one"
    ssh-keygen -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519"
  }
  local r host user pass target
  for r in $(selected_roles "${1:-all}"); do
    host="$(role_host "$r")"; user="$(role_user "$r")"; pass="$(role_pass "$r")"
    target="${user}@${host}"
    if key_works "$target"; then echo "-- ${r} (${target}): key already works"; continue; fi
    [ -n "$pass" ] || { echo "-- ${r} (${target}): no key and no NODE_$(upper "$r")_PASS, skipping"; continue; }
    need_sshpass || exit 1
    echo "-- ${r} (${target}): installing key"
    sshpass -p "$pass" ssh-copy-id -o StrictHostKeyChecking=accept-new "$target" >/dev/null 2>&1 \
      && echo "   ok" || echo "   FAILED (check user/password)"
  done
  echo
  echo "Keys done. You can now blank the NODE_*_PASS lines in pov/env.sh."
}

# Copy the working tree to a node. Excludes node_modules, the ES5 toolchain,
# and env.sh; a SANITISED env.sh (every *_PASS value blanked) is sent after.
cmd_push() {
  show_map
  local r host user target
  for r in $(selected_roles "${1:-all}"); do
    host="$(role_host "$r")"; user="$(role_user "$r")"; target="${user}@${host}"
    echo "-- ${r} (${target}): copying to ~/${REMOTE_PATH}"
    transport_for "$r" || { echo "   SKIPPED"; continue; }
    # shellcheck disable=SC2086
    COPYFILE_DISABLE=1 tar $TAR_OPTS -czf - \
      --exclude='./node_modules' \
      --exclude='./mim/build-tools/node_modules' \
      --exclude='./package-lock.json' \
      --exclude='./mim/build' \
      --exclude='./.git' \
      --exclude='./pov/env.sh' \
      --exclude='./pov/env.tmp' \
      --exclude='.DS_Store' \
      . | "${RSH[@]}" $SSH_OPTS "$target" \
        "mkdir -p ~/${REMOTE_PATH} && tar -xzf - -C ~/${REMOTE_PATH} && chmod +x ~/${REMOTE_PATH}/mim/*.sh ~/${REMOTE_PATH}/pov/*.sh ~/${REMOTE_PATH}/test/*.sh"
    # env.sh with every password blanked
    sed -E 's/^([[:space:]]*export[[:space:]]+[A-Za-z_]*(PASS|PASSWORD)[A-Za-z_]*=).*/\1/' pov/env.sh \
      | "${RSH[@]}" $SSH_OPTS "$target" "cat > ~/${REMOTE_PATH}/pov/env.sh && chmod 600 ~/${REMOTE_PATH}/pov/env.sh"
    echo "   ok (passwords stripped from the copied env.sh)"
  done
}

cmd_setup() {
  local want="${1:-all}" r host user target pass extra
  cmd_push "$want"
  for r in $(selected_roles "$want"); do
    host="$(role_host "$r")"; user="$(role_user "$r")"; pass="$(sudo_pass_for "$r")"
    target="${user}@${host}"
    echo "-- ${r} (${target}): building on that node, then installing the '${r}' role"
    echo "   (first build there downloads the ES5 toolchain; slow on a Pi, cached afterwards)"
    # install-addon.sh restarts mimOE, which needs root on Linux. Over SSH there
    # is no terminal for a sudo prompt, so hand the login password to the remote
    # side ON STDIN rather than interpolating it into the command line: a
    # password containing a quote would otherwise break out of the quoting.
    # Harmless where sudo is already passwordless.
    if [ -n "$pass" ]; then
      printf '%s\n' "$pass" | rsh "$r" \
        "bash -lc 'cd ~/${REMOTE_PATH} && source pov/env.sh && export NODE_SUDO_PASS=\$(head -n1) && bash pov/build-here.sh && bash pov/install-addon.sh ${r}'" \
        && echo "   ok" || echo "   FAILED on ${target}"
    else
      rsh "$r" "bash -lc 'cd ~/${REMOTE_PATH} && source pov/env.sh && bash pov/build-here.sh && bash pov/install-addon.sh ${r}'" \
        && echo "   ok" || echo "   FAILED on ${target}"
    fi
  done
  echo
  echo "Now verify from here:  bash pov/remote.sh status"
}

cmd_status() {
  show_map
  local r host url out label
  for r in $ROLES; do
    host="$(role_host "$r")"
    [ -n "$host" ] || continue
    url="http://${host}:8083/mimik-aaosa/agent/v1"
    # No login to show for a hand-installed node — printing a guessed username
    # for a phone would only invite someone to try sshing to it.
    if is_manual "$r"; then label="$host"; else label="$(role_user "$r")@$host"; fi
    printf '%-9s %-22s ' "$r" "$label"
    out=$(curl -s --max-time 6 "${url}/descriptor" 2>/dev/null || true)
    if [ -z "$out" ]; then
      echo "UNREACHABLE (mimOE down, addon not installed, or :8083 firewalled)"
    else
      printf '%s\n' "$out" | tr -d '\n' | cut -c1-110; echo
    fi
  done
  # The device node's feed: a healthy agent with a dead feed answers "I have no
  # data", and nothing else in this output would reveal it.
  local dh; dh="$(role_host device)"
  if [ -n "$dh" ]; then
    local m
    m=$(curl -s --max-time 6 "http://${dh}:8083/mimik-aaosa/agent/v1/metrics" 2>/dev/null || true)
    printf '%-9s %-22s ' "telemetry" "$dh"
    case "$m" in
      "")                     echo "no answer (agent unreachable)";;
      *"no telemetry pushed"*) echo "NOT RUNNING — the device agent has no data to answer from";;
      *)                      printf '%s\n' "$m" | tr -d '\n' | cut -c1-110; echo;;
    esac
  fi

  local fh; fh="$(role_host frontman)"
  if [ -n "$fh" ]; then
    echo
    echo "-- coordinator's view of the mesh (who it would actually consult)"
    curl -s --max-time 8 "http://${fh}:8083/mimik-aaosa/agent/v1/mesh" || echo "   (no answer)"
    echo
  fi
}

cmd_exec() {
  show_map
  local want="${1:-all}" cmdline="${2:?usage: remote.sh exec <role|all> '<command>'}" r
  for r in $(selected_roles "$want"); do
    echo "== ${r} ($(role_host "$r")) =="
    rsh "$r" "$cmdline" || echo "   FAILED"
  done
}

case "${1:-}" in
  keys)   shift; cmd_keys   "${1:-all}" ;;
  push)   shift; cmd_push   "${1:-all}" ;;
  setup)  shift; cmd_setup  "${1:-all}" ;;
  status) shift; cmd_status ;;
  exec)   shift; cmd_exec   "${1:-all}" "${2:-}" ;;
  *) sed -n '2,26p' "$0"; exit 1 ;;
esac
