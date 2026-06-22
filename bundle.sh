#!/usr/bin/env bash
# Build the plugin and produce a clean dist/ ready to ship.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "?? Cleaning previous build..."
rm -rf dist .parcel-cache

echo "?? Installing dependencies..."
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

echo "?? Bundling entry files with Parcel..."
npx parcel build src/index.js src/global.js \
  --dist-dir dist \
  --no-cache \
  --no-source-maps

echo "?? Copying pref.html into dist/..."
cp pref.html dist/pref.html

echo "?? Done. dist/ contents:"
ls -1 dist/
