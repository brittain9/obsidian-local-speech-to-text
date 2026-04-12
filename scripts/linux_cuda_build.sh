#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/linux_cuda_build.sh [--release] [--no-clean] [--jobs N]

Build both the CPU and CUDA-enabled native sidecars. The CPU binary is written
to the default target/ directory. The CUDA binary is written to target-cuda/ so
it never overwrites the CPU binary.

Options:
  --release   Build release binaries instead of debug.
  --no-clean  Skip the initial cargo clean of both target directories.
  --jobs N    Override the parallel build job count (default: 4).
  --help      Show this help text.

Environment overrides:
  CC             Host C compiler (default: /usr/bin/gcc)
  CXX            Host C++ compiler (default: /usr/bin/g++)
  CUDAHOSTCXX    Host C++ compiler used by nvcc (default: $CXX)
  CUDACXX        CUDA compiler path (default: /usr/local/cuda/bin/nvcc)
  JOBS           Same as --jobs.
  MIN_FREE_GB    Minimum free disk space required before build starts (default: 15)
  CMAKE_ARGS     Extra CMake flags preserved before the required ccache disables.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_path=$1

  if [[ "$command_path" == */* ]]; then
    [[ -x "$command_path" ]] || die "required executable not found: $command_path"
    return
  fi

  command -v "$command_path" >/dev/null 2>&1 || die "required command not found on PATH: $command_path"
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SIDECAR_MANIFEST="$REPO_ROOT/native/sidecar/Cargo.toml"

[[ -f "$SIDECAR_MANIFEST" ]] || die "sidecar manifest not found at $SIDECAR_MANIFEST"
[[ "$(uname -s)" == "Linux" ]] || die "this script only supports Linux builds"

build_profile=debug
skip_clean=0
jobs=${JOBS:-4}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      build_profile=release
      shift
      ;;
    --no-clean)
      skip_clean=1
      shift
      ;;
    --jobs)
      [[ $# -ge 2 ]] || die "--jobs requires a value"
      jobs=$2
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$jobs" =~ ^[0-9]+$ ]] || die "jobs must be a positive integer"
(( jobs > 0 )) || die "jobs must be greater than zero"

export PATH="/usr/local/cuda/bin:$HOME/.cargo/bin:$PATH"
export CC=${CC:-/usr/bin/gcc}
export CXX=${CXX:-/usr/bin/g++}
export CUDAHOSTCXX=${CUDAHOSTCXX:-$CXX}
export CUDACXX=${CUDACXX:-/usr/local/cuda/bin/nvcc}
export WHISPER_DONT_GENERATE_BINDINGS=1
export WHISPER_CCACHE=OFF
export GGML_CCACHE=OFF
export CMAKE_ARGS="${CMAKE_ARGS:+$CMAKE_ARGS }-DWHISPER_CCACHE=OFF -DGGML_CCACHE=OFF"

require_command cargo
require_command rustc
require_command "$CC"
require_command "$CXX"
require_command "$CUDAHOSTCXX"
require_command "$CUDACXX"

min_free_gb=${MIN_FREE_GB:-15}
[[ "$min_free_gb" =~ ^[0-9]+$ ]] || die "MIN_FREE_GB must be a positive integer"
available_kb=$(df -Pk "$REPO_ROOT" | awk 'NR==2 { print $4 }')
required_kb=$((min_free_gb * 1024 * 1024))
(( available_kb >= required_kb )) || die "need at least ${min_free_gb} GiB free on the build volume before starting"

host_triple=$(rustc -vV | sed -n 's/^host: //p')
[[ -n "$host_triple" ]] || die "failed to detect Rust host triple"

cuda_root=$(dirname "$(dirname "$CUDACXX")")
cuda_arch="$(uname -m)-linux"
cuda_lib_path="${CUDA_LIB_PATH:-${cuda_root}/targets/${cuda_arch}/lib}"
[[ -d "$cuda_lib_path" ]] || die "CUDA lib directory not found: $cuda_lib_path (override with CUDA_LIB_PATH)"

host_linker_config="host.linker=\"${CC}\""
host_rustflags_config='host.rustflags=["-C","link-arg=-fuse-ld=bfd"]'
target_linker_config="target.${host_triple}.linker=\"${CC}\""
target_rustflags_config="target.${host_triple}.rustflags=[\"-C\",\"link-arg=-fuse-ld=bfd\",\"-C\",\"link-arg=-Wl,-rpath,${cuda_lib_path}\"]"

printf 'Linux CUDA sidecar build\n'
printf '  repo: %s\n' "$REPO_ROOT"
printf '  profile: %s\n' "$build_profile"
printf '  jobs: %s\n' "$jobs"
printf '  rust host: %s\n' "$host_triple"
printf '  cc: %s\n' "$CC"
printf '  cxx: %s\n' "$CXX"
printf '  cuda host cxx: %s\n' "$CUDAHOSTCXX"
printf '  nvcc: %s\n' "$CUDACXX"
printf '  cuda lib rpath: %s\n' "$cuda_lib_path"
printf '  free space: %s\n' "$(df -h "$REPO_ROOT" | awk 'NR==2 { print $4 " free on " $1 }')"
printf '\n'

"$CC" --version | sed -n '1p'
"$CUDACXX" --version | sed -n '1,4p'
printf '\n'

cpu_target_dir="$REPO_ROOT/native/sidecar/target"
cuda_target_dir="$REPO_ROOT/native/sidecar/target-cuda"

if (( skip_clean == 0 )); then
  printf 'Cleaning CPU target directory...\n'
  cargo clean --manifest-path "$SIDECAR_MANIFEST"
  printf 'Cleaning CUDA target directory...\n'
  cargo clean --manifest-path "$SIDECAR_MANIFEST" --target-dir "$cuda_target_dir"
  printf '\n'
fi

run_build() {
  local label=$1
  shift

  printf 'Building %s sidecar:\n  cargo' "$label"
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n\n'

  (
    cd "$REPO_ROOT"
    cargo "$@"
  )
}

cpu_args=(
  build
  --manifest-path "$SIDECAR_MANIFEST"
  --features engine-cohere
  -j "$jobs"
)

cuda_args=(
  build
  --manifest-path "$SIDECAR_MANIFEST"
  --target-dir "$cuda_target_dir"
  --features engine-cohere,gpu-cuda,gpu-ort-cuda
  -j "$jobs"
  --config "$host_linker_config"
  --config "$host_rustflags_config"
  --config "$target_linker_config"
  --config "$target_rustflags_config"
)

if [[ "$build_profile" == "release" ]]; then
  cpu_args+=(--release)
  cuda_args+=(--release)
fi

run_build CPU "${cpu_args[@]}"
cpu_artifact="$cpu_target_dir/$build_profile/obsidian-local-stt-sidecar"
[[ -f "$cpu_artifact" ]] || die "CPU build completed but expected sidecar binary was not found at $cpu_artifact"
printf 'CPU build complete:\n  %s\n\n' "$cpu_artifact"

run_build CUDA "${cuda_args[@]}"
cuda_artifact="$cuda_target_dir/$build_profile/obsidian-local-stt-sidecar"
[[ -f "$cuda_artifact" ]] || die "CUDA build completed but expected sidecar binary was not found at $cuda_artifact"
printf 'CUDA build complete:\n  %s\n' "$cuda_artifact"
