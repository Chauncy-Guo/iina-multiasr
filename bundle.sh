#!/usr/bin/env bash
# Build the plugin and produce a clean dist/ ready to ship.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo ">> Cleaning previous build..."
rm -rf dist .parcel-cache

echo ">> Installing dependencies..."
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

echo ">> Bundling entry files with Parcel..."
npx parcel build src/index.js src/global.js \
  --dist-dir dist \
  --no-cache \
  --no-source-maps

echo ">> Copying sidebar HTML into dist/ui/sidebar/..."
mkdir -p dist/ui/sidebar
cp ui/sidebar/index.html dist/ui/sidebar/index.html

echo ">> Done. dist/ contents:"
find dist -type f | sort
