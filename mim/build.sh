#!/usr/bin/env bash
# Build the mim bundle for mimOE's serverless JS engine.
#
# The engine is ES5 (no arrow functions, no async/await, no native Promise);
# mimik's own mims ship Babel+core-js output, so we do the same:
#   1. esbuild: bundle sources into one CommonJS file (modern syntax)
#   2. Babel:   lower to ES5, auto-injecting core-js + regenerator imports
#   3. esbuild: resolve those imports into the final self-contained ES5 IIFE
#   4. acorn:   hard-verify the output parses as strict ES5
#
# First run downloads the toolchain into mim/build-tools/node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."

TOOLS=mim/build-tools
BUILD=mim/build
mkdir -p "$BUILD"

[ -d "$TOOLS/node_modules/@babel/core" ] || {
  echo "-- installing build toolchain (one time)"
  npm install --prefix "$TOOLS" --silent --no-audit --no-fund
}

# Runtime dependency bundled INTO the mim: @mimik/mcp-kit (the MCP server surface).
# esbuild resolves it from the project-root node_modules when bundling mim/src, so
# it must be installed at the root (not under build-tools).
[ -d node_modules/@mimik/mcp-kit ] || {
  echo "-- installing runtime deps (@mimik/mcp-kit)"
  npm install --silent --no-audit --no-fund
}

echo "-- 1/4 esbuild bundle (modern)"
# --main-fields=main: the neutral platform ignores package "main" fields unless
# told to; @mimik/mcp-kit resolves its entry via "main", so we set it explicitly.
npx -y esbuild mim/src/index.js \
  --bundle --format=cjs --platform=neutral --target=es2017 \
  --main-fields=main \
  --external:node:crypto \
  --outfile="$TOOLS/step1.cjs" --log-level=warning

echo "-- 2/4 babel -> ES5 (+ core-js/regenerator imports)"
(cd "$TOOLS" && ./node_modules/.bin/babel step1.cjs --config-file ./babel.config.json -o step2.cjs)

echo "-- 3/4 esbuild resolve -> final ES5 IIFE"
npx -y esbuild "$TOOLS/step2.cjs" \
  --bundle --format=iife --platform=neutral --target=es5 \
  --external:node:crypto \
  --outfile="$BUILD/index.js" --log-level=warning

echo "-- 4/4 verify strict ES5 parse"
node -e "
const acorn = require('./$TOOLS/node_modules/acorn');
const src = require('fs').readFileSync('$BUILD/index.js', 'utf8');
acorn.parse(src, { ecmaVersion: 5 });
console.log('   ES5 OK,', (src.length/1024).toFixed(0) + 'KB');
"
rm -f "$TOOLS/step1.cjs" "$TOOLS/step2.cjs"

# Plain ustar tar for the legacy mCM HTTP flow (mim/deploy.sh); the addon
# flow re-tars internally in mim/package-addon.sh.
COPYFILE_DISABLE=1 tar --format=ustar -C "$BUILD" -cf "$BUILD/aaosa-agent-v1.tar" index.js
echo "built $BUILD/index.js and $BUILD/aaosa-agent-v1.tar"
