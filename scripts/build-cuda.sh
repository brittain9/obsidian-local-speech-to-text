#!/usr/bin/env bash
# Build sidecar: Whisper + Cohere + CUDA GPU. Linux only.
# Output goes to target-cuda/ to avoid overwriting the CPU binary.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/build-cuda.sh [OPTIONS]

Build the CUDA-enabled native sidecar (Whisper+CUDA, Cohere+CUDA).
Output: native/target-cuda/{debug|release}/obsidian-local-stt-sidecar

Options:
  --release   Build release binary instead of debug.
  --clean     Run cargo clean on the CUDA target directory before building.
  --jobs N    Parallel build job count (default: nproc or 4).
  --help      Show this help text.

Environment overrides:
  CC             Host C compiler       (default: /usr/bin/gcc)
  CXX            Host C++ compiler     (default: /usr/bin/g++)
  CUDAHOSTCXX    nvcc host compiler    (default: $CXX)
  CUDACXX        CUDA compiler         (default: /usr/local/cuda/bin/nvcc)
  CUDA_LIB_PATH  Library dir for RPATH (auto-detected from CUDACXX)
  CARGO_TIMINGS  Set to 1 to emit cargo timing HTML.
  CARGO_VERBOSE  Set to 1 for verbose cargo/rustc/CMake output.
  MIN_FREE_GB    Min free disk in GiB  (default: 10)
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  local cmd=$1
  if [[ "$cmd" == */* ]]; then
    [[ -x "$cmd" ]] || die "required executable not found: $cmd"
  else
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  fi
}

require_glob_match() {
  local pattern=$1
  compgen -G "$pattern" >/dev/null || die "required runtime artifact missing after build: $pattern"
}

stage_runtime_artifact() {
  local artifact_path=$1
  local resolved_path
  resolved_path=$(readlink -f "$artifact_path")
  [[ -f "$resolved_path" ]] || die "runtime artifact does not resolve to a file: $artifact_path"

  if [[ "$resolved_path" != "$artifact_path" ]]; then
    rm -f "$artifact_path"
    cp "$resolved_path" "$artifact_path"
  fi
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$REPO_ROOT/native/Cargo.toml"

[[ -f "$MANIFEST" ]] || die "sidecar manifest not found at $MANIFEST"
[[ "$(uname -s)" == "Linux" ]] || die "CUDA build is Linux-only"

profile=debug
do_clean=0
jobs=$(nproc 2>/dev/null || echo 4)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) profile=release; shift ;;
    --clean)   do_clean=1; shift ;;
    --jobs)    [[ $# -ge 2 ]] || die "--jobs requires a value"; jobs=$2; shift 2 ;;
    --help)    usage; exit 0 ;;
    *)         die "unknown argument: $1" ;;
  esac
done

[[ "$jobs" =~ ^[0-9]+$ && "$jobs" -gt 0 ]] || die "jobs must be a positive integer"

# ---------------------------------------------------------------------------
# Toolchain
# ---------------------------------------------------------------------------

export PATH="/usr/local/cuda/bin:$HOME/.cargo/bin:$PATH"
export CC=${CC:-/usr/bin/gcc}
export CXX=${CXX:-/usr/bin/g++}
export CUDAHOSTCXX=${CUDAHOSTCXX:-$CXX}
export CUDACXX=${CUDACXX:-/usr/local/cuda/bin/nvcc}
export WHISPER_DONT_GENERATE_BINDINGS=1
export WHISPER_CCACHE=OFF
export GGML_CCACHE=OFF
export CMAKE_ARGS="${CMAKE_ARGS:+$CMAKE_ARGS }-DWHISPER_CCACHE=OFF -DGGML_CCACHE=OFF"

require_cmd cargo
require_cmd rustc
require_cmd "$CC"
require_cmd "$CXX"
require_cmd "$CUDAHOSTCXX"
require_cmd "$CUDACXX"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

host_triple=$(rustc -vV | sed -n 's/^host: //p')
[[ -n "$host_triple" ]] || die "failed to detect Rust host triple"

cuda_root=$(dirname "$(dirname "$CUDACXX")")
cuda_lib="${CUDA_LIB_PATH:-${cuda_root}/targets/$(uname -m)-linux/lib}"
[[ -d "$cuda_lib" ]] || die "CUDA lib directory not found: $cuda_lib (override with CUDA_LIB_PATH)"

target_dir="$REPO_ROOT/native/target-cuda"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

min_free_gb=${MIN_FREE_GB:-10}
available_kb=$(df -Pk "$REPO_ROOT" | awk 'NR==2 { print $4 }')
required_kb=$((min_free_gb * 1024 * 1024))
(( available_kb >= required_kb )) || die "need at least ${min_free_gb} GiB free on the build volume"

printf 'CUDA sidecar build\n'
printf '  profile:  %s\n' "$profile"
printf '  jobs:     %s\n' "$jobs"
printf '  host:     %s\n' "$host_triple"
printf '  cc:       %s\n' "$CC"
printf '  nvcc:     %s\n' "$CUDACXX"
printf '  cuda lib: %s\n' "$cuda_lib"
printf '  target:   %s\n' "$target_dir"
printf '  arch:     %s\n' "${CMAKE_CUDA_ARCHITECTURES:-<default>}"
printf '  timings:  %s\n' "${CARGO_TIMINGS:-0}"
printf '  verbose:  %s\n' "${CARGO_VERBOSE:-0}"
printf '\n'

# ---------------------------------------------------------------------------
# Clean (opt-in)
# ---------------------------------------------------------------------------

if (( do_clean )); then
  printf 'Cleaning CUDA target directory...\n'
  cargo clean --manifest-path "$MANIFEST" --target-dir "$target_dir"
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

args=(
  build
  --locked
  --manifest-path "$MANIFEST"
  --target-dir "$target_dir"
  --features gpu-cuda,gpu-ort-cuda
  -j "$jobs"
  --config "host.linker=\"${CC}\""
  --config "host.rustflags=[\"-C\",\"link-arg=-fuse-ld=bfd\"]"
  --config "target.${host_triple}.linker=\"${CC}\""
  --config "target.${host_triple}.rustflags=[\"-C\",\"link-arg=-fuse-ld=bfd\",\"-C\",\"link-arg=-Wl,-rpath,\$ORIGIN\"]"
)
[[ "$profile" == "release" ]] && args+=(--release)
[[ "${CARGO_TIMINGS:-}" == "1" ]] && args+=(--timings)
[[ "${CARGO_VERBOSE:-}" == "1" ]] && args+=(-vv)

printf 'Building CUDA sidecar (%s)...\n' "$profile"
printf 'cargo %q ' "${args[@]}"
printf '\n'
cargo "${args[@]}"

binary="$target_dir/$profile/obsidian-local-stt-sidecar"
[[ -f "$binary" ]] || die "build completed but binary not found at $binary"

while IFS= read -r provider; do
  require_glob_match "$target_dir/$profile/${provider}*"
  stage_runtime_artifact "$target_dir/$profile/$provider"
done < <(node "$REPO_ROOT/scripts/list-cuda-artifacts.mjs" providers linux)
printf 'Done: %s\n' "$binary"
