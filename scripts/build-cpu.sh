#!/usr/bin/env bash
# Build sidecar: Whisper + Cohere, CPU only.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$REPO_ROOT/native/sidecar/Cargo.toml"

profile=debug
[[ "${1:-}" == "--release" ]] && profile=release

args=(build --manifest-path "$MANIFEST" --features engine-cohere)
[[ "$profile" == "release" ]] && args+=(--release)

printf 'Building CPU sidecar (%s)...\n' "$profile"
cargo "${args[@]}"

binary="$REPO_ROOT/native/sidecar/target/$profile/obsidian-local-stt-sidecar"
printf 'Done: %s\n' "$binary"
