#!/usr/bin/env bash
# Build sidecar: Whisper (Metal GPU) + Cohere (CPU). macOS only.
# Cohere runs CPU-only on macOS — Whisper+Metal is the macOS GPU path.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$REPO_ROOT/native/sidecar/Cargo.toml"

[[ "$(uname -s)" == "Darwin" ]] || { printf 'error: Metal build is macOS-only\n' >&2; exit 1; }

profile=debug
[[ "${1:-}" == "--release" ]] && profile=release

args=(build --manifest-path "$MANIFEST" --features engine-cohere,gpu-metal)
[[ "$profile" == "release" ]] && args+=(--release)

printf 'Building Metal sidecar (%s)...\n' "$profile"
cargo "${args[@]}"

binary="$REPO_ROOT/native/sidecar/target/$profile/obsidian-local-stt-sidecar"
printf 'Done: %s\n' "$binary"
