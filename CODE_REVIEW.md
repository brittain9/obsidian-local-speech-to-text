# Code Review

Scope: recent Cohere feature work, limited to confirmed build and distribution issues.

## Findings

### 1. High: the documented Linux CUDA flow builds the wrong sidecar variants

Evidence:
- `docs/linux-flatpak-gpu-setup.md` tells users to run `bash scripts/linux_cuda_build.sh --no-clean`.
- `scripts/linux_cuda_build.sh` builds the CPU sidecar with no explicit features.
- The same script builds the CUDA sidecar with `--features gpu-cuda` only.

Impact:
- The CPU artifact produced by the script does not include the Cohere engine.
- The CUDA artifact produced by the script enables Whisper CUDA, but not Cohere ONNX CUDA.
- Users following the repo's own Linux GPU guide do not get the intended shipped engine set.

Suggested fix:
- Change the script's CPU build to include `--features engine-cohere`.
- Change the script's CUDA build to include the full intended feature set for a shipped CUDA sidecar, not just `gpu-cuda`. If the intent is "Whisper + Cohere with CUDA where available", that likely means `engine-cohere,gpu-cuda,gpu-ort-cuda`.
- Prefer a single Cargo feature alias for each supported build profile so scripts and docs stop hard-coding overlapping feature lists. Example direction:
  - `sidecar-default = ["engine-cohere"]`
  - `sidecar-cuda = ["sidecar-default", "gpu-cuda", "gpu-ort-cuda"]`
- After fixing the script, keep `docs/linux-flatpak-gpu-setup.md` explicit about which engines and GPU paths the generated binaries actually contain.

Affected files:
- `docs/linux-flatpak-gpu-setup.md`
- `scripts/linux_cuda_build.sh`
- `native/sidecar/Cargo.toml`

### 2. High: the npm GPU build target has drifted from the actual Cargo feature model

Evidence:
- `package.json` defines `build:sidecar:gpu` as `cargo build ... --features engine-cohere,gpu-cuda`.
- `native/sidecar/Cargo.toml` splits Whisper CUDA and Cohere CUDA into separate flags: `gpu-cuda` and `gpu-ort-cuda`.
- `native/sidecar/src/cohere.rs` only registers the ONNX CUDA execution provider behind `gpu-ort-cuda`.
- `native/sidecar/src/protocol.rs` only reports `ort-cuda` in `compiled_backends()` when `gpu-ort-cuda` is enabled.

Impact:
- `npm run build:sidecar:gpu` does not produce a fully GPU-enabled Cohere build.
- The command name implies "GPU sidecar", but the resulting binary only covers the Whisper CUDA path.
- This is the kind of feature-flag drift that will keep resurfacing anywhere the build profile is re-expressed manually.

Suggested fix:
- Update `build:sidecar:gpu` to use the full intended GPU feature set, not just `engine-cohere,gpu-cuda`.
- Use the same Cargo feature alias strategy as above so `package.json`, shell scripts, and any future release automation all target one source of truth.
- Add one high-signal verification step for shipped build profiles. The simplest option is a small Rust assertion around `compiled_backends()` under the supported feature combinations, so feature drift is caught before docs and helper scripts diverge again.

Affected files:
- `package.json`
- `native/sidecar/Cargo.toml`
- `native/sidecar/src/cohere.rs`
- `native/sidecar/src/protocol.rs`
