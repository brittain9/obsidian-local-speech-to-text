# Platform Runtime Dependencies

This document describes the runtime dependency contract for each platform and sidecar build flavor. It covers what the plugin ships, what the host must provide, and how the two interact.

## Sidecar Build Flavors

The sidecar ships as a single native binary per platform. Three build flavors exist, each enabling different Cargo feature sets:

| Flavor | Command | Cargo features | Model families |
|---|---|---|---|
| CPU | `npm run build:sidecar` (Windows/Linux) | `engine-whisper,engine-cohere-transcribe` | Whisper (CPU), Cohere Transcribe (CPU) |
| Metal | `npm run build:sidecar` (macOS) | `engine-whisper,engine-cohere-transcribe,gpu-metal` | Whisper (Metal GPU), Cohere Transcribe (CPU) |
| CUDA | Linux: `npm run build:sidecar:cuda`<br>Windows: `npm run build:sidecar:cuda:windows` | `engine-whisper,engine-cohere-transcribe,gpu-cuda,gpu-ort-cuda` | Whisper (CUDA GPU), Cohere Transcribe (CUDA GPU) |

The CPU flavor is the default everywhere. GPU flavors are additive — they include all CPU capabilities plus GPU acceleration for the engines listed.

## What the Plugin Bundle Contains

The shipped plugin contains only:

- `main.js` — the Obsidian plugin bundle
- `manifest.json` — plugin metadata
- `styles.css` — plugin styles

The sidecar binary is **not** bundled. The plugin downloads it on demand from the matching GitHub Release at first activation (CPU flavor, ~150 MB). The CUDA variant is a separate opt-in download triggered from Settings.

On download, the CPU sidecar lands at `<vault>/.obsidian/plugins/local-transcript/bin/cpu/` and the CUDA variant at `<vault>/.obsidian/plugins/local-transcript/bin/cuda/`. The CUDA archive additionally contains ONNX Runtime provider libraries next to the sidecar binary:

| Platform | Provider libraries |
|---|---|
| Linux | `libonnxruntime_providers_shared.so`, `libonnxruntime_providers_cuda.so` |
| Windows | `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll` |

These are sidecar-owned artifacts that travel with the binary and do not need to be installed separately.

## Platform Matrix

### macOS

| Component | Requirement |
|---|---|
| **Downloaded sidecar** | Metal flavor (Whisper GPU + Cohere CPU) |
| **GPU driver** | None — Metal is a system framework |
| **GPU libraries** | None — linked at build time |
| **CUDA / cuDNN** | Not applicable — no CUDA on macOS |
| **User configuration** | None for GPU. Cohere runs CPU-only on macOS by design (D-004) |

macOS is the cleanest platform. Whisper uses Metal for GPU acceleration through `whisper-rs/metal`, which links against the system Metal framework at compile time. No runtime library discovery, no user path configuration, no sandbox issues.

Cohere is CPU-only on macOS. The ONNX Runtime CUDA execution provider is Linux/Windows only, and there is no Metal EP in use. Whisper+Metal remains the macOS GPU path.

### Windows

| Component | Requirement |
|---|---|
| **Downloaded sidecar** | CPU flavor (default); CUDA flavor available as opt-in download |
| **GPU driver** | NVIDIA display driver (Game Ready or Studio) |
| **CUDA userspace** | CUDA 12.x runtime libraries |
| **cuDNN** | cuDNN 9.x runtime libraries (for Cohere CUDA) |
| **User configuration** | None in the intended shipped flow |

Windows has no sandbox. The sidecar inherits the host environment directly, so CUDA and cuDNN libraries found on `PATH` or in standard install locations resolve without manual path configuration.

The CUDA archive includes the sidecar-owned ONNX provider DLLs alongside the executable. After the plugin downloads and extracts the CUDA variant, the DLLs land next to the binary and no manual path configuration is needed. See [Windows CUDA setup](../guides/windows-cuda-setup.md) for the supported Windows CUDA setup flow.

### Linux (native install)

| Component | Requirement |
|---|---|
| **Downloaded sidecar** | CPU flavor (default); CUDA flavor available as opt-in download |
| **GPU driver** | NVIDIA kernel driver + `libcuda.so.1` in the standard library path |
| **CUDA userspace** | CUDA 12.x toolkit (`libcudart.so`, `libcublas.so`, etc.) |
| **cuDNN** | cuDNN 9.x (`libcudnn.so.9`) for Cohere CUDA |
| **User configuration** | Usually none — host environment is inherited |

On a native Linux install, the sidecar child process inherits the host library paths. If the CUDA toolkit and cuDNN are installed in standard locations (`/usr/local/cuda/lib64`, `/usr/lib64`), the sidecar finds them without any plugin settings.

The `CUDA library path` plugin setting exists for non-standard installations but is not normally needed on native Linux.

### Linux (Flatpak)

| Component | Requirement |
|---|---|
| **Downloaded sidecar** | CPU flavor (default). CUDA requires manual override |
| **GPU driver** | NVIDIA kernel driver on the host |
| **CUDA userspace** | CUDA 12.x on the host, exposed via `--filesystem=host-os` |
| **cuDNN** | cuDNN 9.x on the host, exposed via `--filesystem=host-os` |
| **Flatpak overrides** | `--filesystem=host-os`, `--device=all` |
| **User configuration** | `Sidecar path override`, `CUDA library path` |

Flatpak is the hardest packaging case. Three things make it different:

1. **Host `/usr` is hidden.** The Flatpak runtime replaces the host OS tree. Host libraries are only visible under `/run/host/usr/` after adding `--filesystem=host-os`.
2. **CUDA symlinks break across the sandbox boundary.** The library path must use resolved real paths (e.g., `/run/host/usr/local/cuda-12.9/...`), not the `/usr/local/cuda` symlink.
3. **Global `LD_LIBRARY_PATH` breaks Electron audio.** Setting it on the whole Obsidian Flatpak causes Electron to load host PulseAudio/ALSA/PipeWire libraries instead of the Flatpak runtime versions. The plugin's `CUDA library path` setting scopes `LD_LIBRARY_PATH` to the sidecar child process only.

The full Flatpak GPU setup procedure is documented in `docs/guides/linux-flatpak-gpu-setup.md`.

## Engine Runtime Paths

The two compiled `Runtime` implementations (`whisper_cpp` and `onnx_runtime`) do not share GPU paths, even within the same sidecar binary.

### Whisper (whisper-rs / whisper.cpp)

| Platform | GPU backend | Runtime dependency |
|---|---|---|
| macOS | Metal | System framework — no runtime dependency |
| Linux/Windows | CUDA | CUDA 12.x userspace libraries (`libcudart`, `libcublas`, `libcublasLt`) |

Whisper's CUDA support is compiled into `whisper-rs` via `whisper.cpp`'s CUDA backend. The CUDA libraries must be loadable at runtime, but no additional provider libraries are needed.

### Cohere (ONNX Runtime)

| Platform | GPU backend | Runtime dependency |
|---|---|---|
| macOS | CPU only | None beyond the sidecar binary |
| Linux/Windows | CUDA | CUDA 12.x + cuDNN 9.x + sidecar-adjacent ONNX provider libraries |

Cohere uses the `ort` crate (ONNX Runtime) with the CUDA execution provider. At build time, `ort`'s `copy-dylibs` feature stages the provider shared libraries next to the sidecar binary. At runtime, those provider libraries load CUDA and cuDNN from the host.

This means Cohere CUDA has a strictly larger dependency set than Whisper CUDA: it needs everything Whisper needs, plus cuDNN 9.x, plus the sidecar-adjacent ONNX provider libraries.

Cohere CUDA is also encoder-only. The ONNX Runtime CUDA `GroupQueryAttention` kernel does not support the `attention_bias` input that the Cohere decoder graph requires, so the decoder runs on CPU even when CUDA is the selected accelerator. The constraint is enforced in `native/src/adapters/cohere_transcribe.rs` by building the decoder session with `GpuConfig { use_gpu: false }`.

## Runtime Capability Probing

Accelerator probing lives on the `Runtime` layer (D-008). Each compiled `Runtime` reports `RuntimeCapabilities { availableAccelerators, acceleratorDetails, supportedModelFormats }` at startup; results are cached and surfaced to the plugin through `system_info.compiledRuntimes[]`. Per-selection merges (`model_probe_result.mergedCapabilities`) combine runtime caps with the family adapter's `ModelFamilyCapabilities`.

| Runtime | Probe method |
|---|---|
| `whisper_cpp` (Metal) | Compile-time: reports available if built with `gpu-metal` on macOS |
| `whisper_cpp` (CUDA) | Fast heuristic: checks for `/dev/nvidiactl` and `/dev/nvidia0` device nodes |
| `onnx_runtime` (CUDA) | Full probe: attempts ONNX Runtime CUDA EP registration via `CUDAExecutionProvider::is_available()` + `.build().error_on_failure()` |

The `onnx_runtime` probe is stronger — it catches missing userspace libraries, driver mismatches, and cuDNN version issues. The `whisper_cpp` probe confirms the driver is loaded but does not verify the full library chain. If the Whisper probe reports CUDA available but inference fails, the root cause is usually a missing CUDA userspace library.

## Bundling Principles

1. **Bundle what the sidecar owns.** The sidecar binary and its ONNX provider libraries are build artifacts that travel together.
2. **Do not assume third-party host installs.** The host GPU stack (driver, CUDA toolkit, cuDNN) is a user-provided prerequisite, not something the plugin manages.
3. **Treat the host GPU stack as a runtime contract.** Document the required library sonames and versions. Let the sidecar's capability probing report what is actually available at runtime.
4. **Avoid manual user path configuration when possible.** macOS and Windows (native) should require none. Linux native usually requires none. Flatpak requires it due to sandbox constraints.
5. **Ship CPU-only by default.** GPU acceleration is opt-in and depends on the build flavor and host environment. The `accelerationPreference: auto` default lets the sidecar use GPU when available without requiring the user to know which engines support which backends.

## Current CI Release Artifacts

Release artifacts are published to GitHub Releases (triggered by version tag). The plugin fetches these at install time:

| Artifact | Runner | Build command |
|---|---|---|
| `sidecar-macos-arm64.tar.gz` | `macos-15` | `npm run build:sidecar:release` |
| `sidecar-linux-x86_64-cpu.tar.gz` | `ubuntu-latest` | `npm run build:sidecar:release` |
| `sidecar-linux-x86_64-cuda.tar.gz` | `ubuntu-latest` | `npm run build:sidecar:cuda:release` |
| `sidecar-windows-x86_64-cpu.zip` | `windows-latest` | `npm run build:sidecar:release` |
| `sidecar-windows-x86_64-cuda.zip` | `windows-latest` | `npm run build:sidecar:cuda:windows:release` |
| `checksums.txt` | — | generated at release time |

## Redistribution Considerations

Whether the plugin can legally and practically redistribute every NVIDIA/CUDA/cuDNN component should be treated as a separate packaging review:

- ONNX Runtime provider libraries (`libonnxruntime_providers_*.so`) are MIT-licensed and safe to bundle.
- CUDA toolkit and cuDNN libraries are NVIDIA-licensed. Redistribution terms vary by library and license version. Review the NVIDIA CUDA EULA and cuDNN Software License Agreement before bundling host-side libraries.
- The current model — bundle sidecar-owned artifacts, require host-provided GPU stack — avoids this question for now.
