# Windows CUDA Setup

This guide shows how to run the CUDA sidecar on native Windows and, when needed, build it from source. For published release archives, normal users do not need the CUDA Toolkit.

The supported source-build path is:

1. install the Windows GPU prerequisites
2. build the CUDA sidecar
3. verify Windows can resolve the CUDA runtime
4. start the plugin and confirm the selected engines report CUDA

Windows is simpler than Linux Flatpak because there is no sandbox and no `LD_LIBRARY_PATH` scoping step. The published CUDA archive bundles the CUDA runtime DLLs used by Whisper CUDA. cuDNN still resolves from the normal Windows environment when Cohere CUDA is enabled.

## Requirements

- 64-bit Windows with desktop Obsidian
- NVIDIA Turing-or-newer GPU with a driver compatible with CUDA 12.x
- Published CUDA release archive, or CUDA Toolkit `12.9` with `nvcc` if building from source
- cuDNN 9.x runtime libraries if you want Cohere CUDA

### Cohere CUDA Runtime Requirements

Whisper CUDA and Cohere CUDA are not identical:

- Whisper uses the CUDA-enabled `whisper-rs` path from the sidecar build.
- Cohere uses ONNX Runtime CUDA execution providers at runtime.

Current ONNX Runtime CUDA binaries for this repo expect:

- CUDA 12.x userspace libraries bundled in the published CUDA archive
- cuDNN 9.x userspace libraries

If those libraries are missing or mismatched, the sidecar reports that explicitly in Settings and falls back to CPU for Cohere instead of silently pretending CUDA worked.

CUDA 13 is not a drop-in replacement for source builds. The release archive avoids this by shipping the CUDA 12 runtime DLLs (`cudart64_12.dll`, `cublas64_12.dll`, etc.) next to the sidecar. If you build from source, install CUDA 12.9 alongside any newer toolkit; the two versions coexist.

## Step 1: Verify Runtime Dependencies

For a published CUDA release archive, confirm the driver is available:

```powershell
nvidia-smi
```

If you want Cohere on CUDA as well, confirm cuDNN is resolvable:

```powershell
where.exe cudnn64_9.dll
```

## Step 2: Verify The Toolkit For Source Builds

Skip this step when using a published release archive. If you are building from source, open PowerShell and confirm CUDA Toolkit 12.9 is on the normal search path:

```powershell
nvcc --version
where.exe cudart64_12.dll
```

If `nvcc` or `cudart64_12.dll` cannot be found, fix the CUDA toolkit install before you build.

## Step 3: Build The CUDA Sidecar From Source

Skip this step when using a published release archive.

```powershell
npm run build:sidecar:cuda:windows
# or:
npm run build:sidecar:cuda:windows:release
```

Artifacts:

- CPU build: `native\target\{debug|release}\obsidian-local-stt-sidecar.exe`
- CUDA build: `native\target-cuda\{debug|release}\obsidian-local-stt-sidecar.exe`
- ONNX Runtime CUDA providers: `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll`

Keep the provider DLLs next to the CUDA executable. They are part of the sidecar build output.

## Step 4: Configure The Plugin

If you are testing from a repo checkout, the plugin auto-detects the CUDA debug build at `native\target-cuda\debug` when present and falls back to `native\target\debug` otherwise. No path override is required — use `Sidecar path override` only for custom layouts.

Under `Engine options`, leave `GPU acceleration` on `Use when available` unless you intentionally want CPU only.

## Step 5: Run And Verify

1. Run `Local STT: Check Sidecar Health`.
2. Open `Settings -> Local STT`.
3. Confirm the acceleration card reports:

- `Whisper: CUDA`
- `Cohere: CUDA`

The Cohere decoder still runs on CPU by design. That constraint comes from ONNX Runtime's `GroupQueryAttention` CUDA support and is not Windows-specific.

## Troubleshooting

### Settings show `Whisper: CPU`

The sidecar could not load the CUDA runtime or could not see a CUDA device. Check:

- the CUDA release archive's runtime DLLs are still next to `obsidian-local-stt-sidecar.exe`
- for source builds, `where.exe cudart64_12.dll`
- `nvidia-smi`
- that the plugin is pointed at the CUDA sidecar, not the default CPU dev build

### Settings show `Cohere: CPU (CUDA unavailable: ...)`

The sidecar started, but ONNX Runtime could not register the CUDA execution provider. Common causes:

- cuDNN 9.x is missing
- the bundled CUDA runtime files are missing from the sidecar directory, or the source-build toolkit install is incomplete
- the CUDA runtime and driver do not match closely enough for ONNX Runtime

Whisper may still report CUDA in this state because its runtime dependency set is smaller than Cohere's.

### Sidecar starts but complains about missing provider DLLs

The CUDA executable and the two ONNX Runtime provider DLLs must stay together in the same directory. Rebuild if either DLL is missing:

```powershell
npm run build:sidecar:cuda:windows
```
