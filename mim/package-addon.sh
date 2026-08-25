#!/usr/bin/env bash
# Package the aaosa mim as a mimOE .addon (file-based install, the format used
# by current mimOE-SE runtimes). Structure cloned field-for-field from the
# genuine ai-foundation addon: outer tar (./-prefixed entries) = manifest.json
# + one docker-save-format image tar per mim; the single layer contains
# exactly index.js; indexFileChecksum = sha256(index.js); the image config
# carries the mimik.* labels (incl. mimik.type=sandbox) the serverless
# loader expects.
#
#   bash mim/package-addon.sh   ->  mim/build/aaosa-agent-0.2.0.addon
#
# Install: pov/install-addon.sh (copies addon + role ini, restarts mimoe).
#
# The archive is assembled by mim/package-addon.js: pure Node, no dependencies,
# so a node needs only the runtime it already uses to build the bundle. It
# replaced a Python implementation and was verified byte-for-byte identical to
# it. Output is deterministic (fixed entry mtimes; override with
# SOURCE_DATE_EPOCH), so the same source always produces the same .addon.
set -euo pipefail
cd "$(dirname "$0")/.."

ADDON_NAME="aaosa-agent"
ADDON_VERSION="0.2.0"
ADDON_ID="mimik.aaosa"           # must be company.package; gateway prefix: dots -> dashes
MIM_NAME="aaosa-agent-v1"
MIM_VERSION="0.2.0"
BASE_API_PATH="/agent/v1"        # external URL: http://<node>:8083/mimik-aaosa/agent/v1

bash mim/build.sh >/dev/null
echo "-- bundling addon ${ADDON_NAME}-${ADDON_VERSION}.addon"

node mim/package-addon.js "$ADDON_NAME" "$ADDON_VERSION" "$ADDON_ID" "$MIM_NAME" "$MIM_VERSION" "$BASE_API_PATH"
