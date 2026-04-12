#!/usr/bin/env bash
# Run all Rust checks: build, fmt, clippy, tests.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$REPO_ROOT/native/sidecar/Cargo.toml"
FEATURES=engine-cohere

export DOCS_RS=1
export WHISPER_DONT_GENERATE_BINDINGS=1

printf '=== build ===\n'
cargo build --manifest-path "$MANIFEST" --features "$FEATURES"

printf '\n=== fmt check ===\n'
cargo fmt --manifest-path "$MANIFEST" --check

printf '\n=== clippy ===\n'
cargo clippy --manifest-path "$MANIFEST" --all-targets --features "$FEATURES" -- -D warnings

printf '\n=== tests ===\n'
cargo test --manifest-path "$MANIFEST" --features "$FEATURES"

printf '\nAll Rust checks passed.\n'
