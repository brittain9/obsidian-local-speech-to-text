#!/usr/bin/env bash
# Build everything: sidecar (CPU) + TypeScript plugin. Full production build.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

printf 'Building sidecar (CPU)...\n'
bash scripts/build-cpu.sh "$@"

printf '\nBuilding TypeScript plugin...\n'
node esbuild.config.mjs production

printf '\nVerifying build output...\n'
node scripts/verify-build-output.mjs "$@"

printf '\nFull build complete.\n'
