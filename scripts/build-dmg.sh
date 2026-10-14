#!/usr/bin/env bash
# Build a universal (Apple Silicon + Intel) Lattice.dmg. Output: target/universal-apple-darwin/release/bundle/dmg/
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-darwin x86_64-apple-darwin
(cd ui && npm install)
# CI=true makes the bundler skip the Finder-scripting step, which fails without a GUI session.
CI=true ./ui/node_modules/.bin/tauri build --target universal-apple-darwin --bundles dmg
