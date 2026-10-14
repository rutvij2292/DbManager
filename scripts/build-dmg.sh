#!/usr/bin/env bash
# Build an Apple Silicon (arm64) Tabnix.dmg. Intel Macs are intentionally not supported. Output: dist/. The cargo target/ directory (several GB) is removed afterwards; set KEEP_TARGET=1 to keep it for faster rebuilds.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-darwin
(cd ui && npm install)
# CI=true makes the bundler skip the Finder-scripting step, which fails without a GUI session.
CI=true ./ui/node_modules/.bin/tauri build --target aarch64-apple-darwin --bundles dmg

mkdir -p dist
cp target/aarch64-apple-darwin/release/bundle/dmg/*.dmg dist/
if [ -z "${KEEP_TARGET:-}" ]; then rm -rf target; fi
echo "DMG: $(ls -1t dist/*.dmg | head -1)"
