#!/usr/bin/env bash
# Build the mim bundle and package the addon ON THIS NODE.
#
#   bash pov/build-here.sh
#
# Every node builds its own addon from the source it received. Nothing
# pre-built and nothing host-specific is transferred between machines:
# pov/remote.sh excludes node_modules, package-lock.json and mim/build/ from
# the copy, so a node cannot silently install a binary produced elsewhere.
#
# Node is the only runtime needed: bundling, transpiling and packaging the
# addon are all JavaScript (mim/package-addon.js).
#
# Requires Node 18+, npm, and network access for the first build, which
# downloads the ES5 toolchain into mim/build-tools/node_modules (~45 MB) and
# the runtime dependency @mimik/mcp-kit into node_modules. Later builds reuse
# both and take seconds. On a Raspberry Pi the first build is slow; that is
# the one-time cost of building per node.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || {
  echo "node not found. This node builds its own addon, so it needs Node 18+ and npm."
  echo "  Debian/Raspberry Pi OS: sudo apt install nodejs npm   (check: node -v)"
  exit 1
}
command -v npm >/dev/null 2>&1 || { echo "npm not found (needed to fetch the build toolchain)"; exit 1; }

MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
[ "$MAJOR" -ge 18 ] || {
  echo "node $(node -v) is too old: the build needs Node 18 or newer."
  exit 1
}

echo "-- building on $(hostname) ($(uname -m), node $(node -v))"
bash mim/build.sh
bash mim/package-addon.sh
echo "-- built here, nothing was copied in:"
ls -1 mim/build/aaosa-agent-*.addon | sed 's/^/   /'
