#!/usr/bin/env bash
# Build sidecar: Whisper + Cohere + CUDA GPU. Linux only.
# For full control (clean, jobs, compiler overrides), use linux_cuda_build.sh instead.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$REPO_ROOT/native/sidecar/Cargo.toml"

[[ "$(uname -s)" == "Linux" ]] || { printf 'error: CUDA build is Linux-only\n' >&2; exit 1; }

export PATH="/usr/local/cuda/bin:$PATH"
export CC=${CC:-/usr/bin/gcc}
export CXX=${CXX:-/usr/bin/g++}
export CUDAHOSTCXX=${CUDAHOSTCXX:-$CXX}
export CUDACXX=${CUDACXX:-/usr/local/cuda/bin/nvcc}
export WHISPER_DONT_GENERATE_BINDINGS=1
export WHISPER_CCACHE=OFF
export GGML_CCACHE=OFF

profile=debug
[[ "${1:-}" == "--release" ]] && profile=release

host_triple=$(rustc -vV | sed -n 's/^host: //p')
cuda_root=$(dirname "$(dirname "$CUDACXX")")
cuda_lib="${CUDA_LIB_PATH:-${cuda_root}/targets/$(uname -m)-linux/lib}"

args=(
  build
  --manifest-path "$MANIFEST"
  --features engine-cohere,gpu-cuda,gpu-ort-cuda
  --config "target.${host_triple}.linker=\"${CC}\""
  --config "target.${host_triple}.rustflags=[\"-C\",\"link-arg=-fuse-ld=bfd\",\"-C\",\"link-arg=-Wl,-rpath,${cuda_lib}\"]"
)
[[ "$profile" == "release" ]] && args+=(--release)

printf 'Building CUDA sidecar (%s)...\n' "$profile"
cargo "${args[@]}"

binary="$REPO_ROOT/native/sidecar/target/$profile/obsidian-local-stt-sidecar"
printf 'Done: %s\n' "$binary"
