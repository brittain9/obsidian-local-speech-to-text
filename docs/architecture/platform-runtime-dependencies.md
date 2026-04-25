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

## What the Plugin And Sidecar Archives Contain

The shipped plugin always includes:

- `main.js` — the Obsidian plugin bundle
- `config/model-catalog.json` — model metadata
- `assets/pcm-recorder.worklet.js` — audio capture worklet

The CUDA release archive additionally stages ONNX Runtime provider libraries and the CUDA runtime libraries that the sidecar ships:

| Platform | Provider libraries | Bundled CUDA runtime libraries |
|---|---|
| Linux | `libonnxruntime_providers_shared.so`, `libonnxruntime_providers_cuda.so` | `libcudart.so.12`, `libcublas.so.12`, `libcublasLt.so.12`, `libcufft.so.11` |
| Windows | `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll` | `cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, `cufft64_11.dll` |

These are sidecar-owned release artifacts produced or collected during the build. They travel with the binary and do not need to be installed separately by release users. cuDNN is not bundled in this pass.

## Platform Matrix

### macOS

| Component | Requirement |
|---|---|
| **Shipped sidecar** | Metal flavor (Whisper GPU + Cohere CPU) |
| **GPU driver** | None — Metal is a system framework |
| **GPU libraries** | None — linked at build time |
| **CUDA / cuDNN** | Not applicable — no CUDA on macOS |
| **User configuration** | None for GPU. Cohere runs CPU-only on macOS by design (D-004) |

macOS is the cleanest platform. Whisper uses Metal for GPU acceleration through `whisper-rs/metal`, which links against the system Metal framework at compile time. No runtime library discovery, no user path configuration, no sandbox issues.

Cohere is CPU-only on macOS. The ONNX Runtime CUDA execution provider is Linux/Windows only, and there is no Metal EP in use. Whisper+Metal remains the macOS GPU path.

### Windows

| Component | Requirement |
|---|---|
| **Shipped sidecar** | CUDA flavor (when GPU is desired) or CPU flavor |
| **GPU driver** | NVIDIA Turing-or-newer GPU with a CUDA 12.x-compatible display driver (Game Ready or Studio) |
| **CUDA userspace** | Bundled in the CUDA release archive for Whisper CUDA |
| **cuDNN** | cuDNN 9.x runtime libraries (for Cohere CUDA) |
| **User configuration** | None in the intended shipped flow |

Windows has no sandbox. CUDA release users do not need the CUDA Toolkit or `nvcc`; the archive ships the CUDA runtime DLLs the sidecar depends on. Cohere CUDA still requires cuDNN 9.x runtime DLLs to be resolvable from the normal Windows DLL search path. If cuDNN is missing, Cohere reports a CUDA fallback reason and runs on CPU.

The intended packaging model bundles the sidecar-owned ONNX provider DLLs next to the executable. Users should not need to hand-edit paths. See [Windows CUDA setup](../guides/windows-cuda-setup.md) for the supported Windows CUDA setup flow.

### Linux (native install)

| Component | Requirement |
|---|---|
| **Shipped sidecar** | CPU flavor (default) or CUDA flavor (opt-in) |
| **GPU driver** | NVIDIA Turing-or-newer GPU with kernel driver + `libcuda.so.1` in the standard library path |
| **CUDA userspace** | Bundled in the CUDA release archive for Whisper CUDA |
| **cuDNN** | cuDNN 9.x (`libcudnn.so.9`) for Cohere CUDA |
| **User configuration** | Usually none — host environment is inherited |

On a native Linux install, the sidecar child process inherits the host library paths and the CUDA release binary uses `$ORIGIN` rpath so bundled CUDA runtime libraries next to the executable are found before host toolkit paths. Release users do not need the CUDA Toolkit. Cohere CUDA still requires cuDNN 9.x to be installed in a standard library path or supplied through the plugin's scoped `CUDA library path`.

The `CUDA library path` plugin setting exists for non-standard installations but is not normally needed on native Linux.

### Linux (Flatpak)

| Component | Requirement |
|---|---|
| **Shipped sidecar** | CPU flavor (default). CUDA requires manual override |
| **GPU driver** | NVIDIA Turing-or-newer GPU with kernel driver on the host |
| **CUDA userspace** | Bundled in the CUDA release archive; host toolkit only needed when building from source |
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
| Linux/Windows | CUDA | Turing-or-newer NVIDIA GPU, compatible driver, and bundled CUDA runtime libraries (`cudart`, `cublas`, `cublasLt`) |

Whisper's CUDA support is compiled into `whisper-rs` via `whisper.cpp`'s CUDA backend. The bundled CUDA libraries must be loadable at runtime, but no additional provider libraries are needed.

### Cohere (ONNX Runtime)

| Platform | GPU backend | Runtime dependency |
|---|---|---|
| macOS | CPU only | None beyond the sidecar binary |
| Linux/Windows | CUDA | Turing-or-newer NVIDIA GPU, compatible driver, bundled CUDA runtime libraries, cuDNN 9.x, and sidecar-adjacent ONNX provider libraries |

Cohere uses the `ort` crate (ONNX Runtime) with the CUDA execution provider. At build time, `ort`'s `copy-dylibs` feature stages the provider shared libraries next to the sidecar binary. At release-package time, the workflow also copies the CUDA runtime libraries declared in `native/cuda-artifacts.json`. At runtime, those provider libraries still need cuDNN from the host.

This means Cohere CUDA has a strictly larger dependency set than Whisper CUDA: it needs everything Whisper needs, plus cuDNN 9.x, plus the sidecar-adjacent ONNX provider libraries. If cuDNN is not resolvable, Cohere reports an explicit CPU fallback reason.

Cohere CUDA is also encoder-only. The ONNX Runtime CUDA `GroupQueryAttention` kernel does not support the `attention_bias` input that the Cohere decoder graph requires, so the decoder runs on CPU even when CUDA is the selected accelerator. The constraint is enforced in `native/src/adapters/cohere_transcribe.rs` by building the decoder session with `GpuConfig { use_gpu: false }`.

## Runtime Capability Probing

Accelerator probing lives on the `Runtime` layer (D-008). Each compiled `Runtime` reports `RuntimeCapabilities { availableAccelerators, acceleratorDetails, supportedModelFormats }` at startup; results are cached and surfaced to the plugin through `system_info.compiledRuntimes[]`. Per-selection merges (`model_probe_result.mergedCapabilities`) combine runtime caps with the family adapter's `ModelFamilyCapabilities`.

| Runtime | Probe method |
|---|---|
| `whisper_cpp` (Metal) | Compile-time: reports available if built with `gpu-metal` on macOS |
| `whisper_cpp` (CUDA) | Fast heuristic: checks for `/dev/nvidiactl` and `/dev/nvidia0` device nodes |
| `onnx_runtime` (CUDA) | Full probe: attempts ONNX Runtime CUDA EP registration via `CUDAExecutionProvider::is_available()` + `.build().error_on_failure()` |

The `onnx_runtime` probe is stronger — it catches missing userspace libraries, driver mismatches, and cuDNN version issues. The `whisper_cpp` probe confirms the driver is loaded but does not verify the full library chain.

## Bundling Principles

1. **Bundle what the sidecar owns.** The sidecar binary and its ONNX provider libraries are build artifacts that travel together.
2. **Bundle reviewed CUDA runtime libraries.** CUDA release archives include the CUDA runtime libraries declared in `native/cuda-artifacts.json`; release users should not need the CUDA Toolkit.
3. **Keep cuDNN host-provided until redistribution is reviewed.** Cohere CUDA depends on cuDNN 9.x, but cuDNN is not bundled in this pass.
4. **Treat the host GPU stack as a runtime contract.** Document the required driver, GPU baseline, library sonames, and versions. Let the sidecar's capability probing report what is actually available at runtime.
5. **Avoid manual user path configuration when possible.** macOS and Windows (native) should require none. Linux native usually requires none. Flatpak requires it due to sandbox constraints.
6. **Ship CPU-only by default.** GPU acceleration is opt-in and depends on the build flavor and host environment. The `accelerationPreference: auto` default lets the sidecar use GPU when available without requiring the user to know which engines support which backends.

## Current CI Release Artifacts

Automated release artifacts (via `workflow_dispatch`) currently cover:

| Artifact | Runner | Build command |
|---|---|---|
| `sidecar-linux-x86_64-cpu` | `ubuntu-latest` | `npm run build:sidecar:release` |
| `sidecar-linux-x86_64-cuda` | `ubuntu-latest` | `npm run build:sidecar:cuda:release` |
| `sidecar-windows-x86_64-cpu` | `windows-latest` | `npm run build:sidecar:release` |
| `sidecar-windows-x86_64-cuda` | `windows-latest` | `npm run build:sidecar:cuda:windows:release` |
| `sidecar-macos-arm64` | `macos-15` | `npm run build:sidecar:release` |

CUDA release jobs set `GGML_NATIVE=OFF` to avoid inheriting runner CPU SIMD and `CMAKE_CUDA_ARCHITECTURES=75-virtual` to ship one forward-compatible Turing PTX target. The CUDA archives remain one GPU archive per OS and include both Whisper CUDA and Cohere CUDA capability.

## Redistribution Considerations

Whether the plugin can legally and practically redistribute every NVIDIA/CUDA/cuDNN component should be treated as a separate packaging review:

- ONNX Runtime provider libraries (`libonnxruntime_providers_*.so`) are MIT-licensed and safe to bundle.
- CUDA runtime libraries listed in `native/cuda-artifacts.json` are bundled in CUDA release archives after CUDA EULA review.
- cuDNN libraries are NVIDIA-licensed and are not bundled in this pass. Review the cuDNN Software License Agreement before redistributing them.
