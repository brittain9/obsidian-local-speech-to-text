# Linux Flatpak GPU Acceleration Setup

This guide shows how to run the CUDA sidecar under Flatpak Obsidian on Linux. The supported path is now:

1. build the CUDA sidecar
2. expose the host CUDA libraries to the Flatpak sandbox
3. point `Sidecar path override` at the CUDA binary
4. set `CUDA library path` so the plugin scopes `LD_LIBRARY_PATH` on the sidecar child process only

The old wrapper script still exists as a deprecated fallback, but it should not be your first choice anymore.

## Why Flatpak Needs Extra Setup

Three things are different under Flatpak:

1. Host `/usr` is not visible by default. The host OS tree is mounted under `/run/host/usr/` only if you add `--filesystem=host-os`.
2. CUDA symlinks often break across the sandbox boundary. Use the resolved real path from `readlink -f /usr/local/cuda`, not the `cuda` symlink.
3. Global `LD_LIBRARY_PATH` breaks Electron audio. If you set it on the whole Obsidian Flatpak, Electron can load host PulseAudio / ALSA / PipeWire libraries instead of the Flatpak runtime versions, which breaks microphone capture. The plugin’s `CUDA library path` setting avoids that by scoping the variable to the sidecar child process only.

## Requirements

- NVIDIA GPU and driver installed on the host
- CUDA toolkit installed on the host
- Obsidian installed via Flatpak (`md.obsidian.Obsidian`)
- CUDA sidecar built with `bash scripts/build-cuda.sh`

### Cohere CUDA Runtime Requirements

Whisper CUDA and Cohere CUDA are not identical:

- Whisper uses the CUDA-enabled `whisper-rs` path from the sidecar build.
- Cohere uses ONNX Runtime CUDA execution providers at runtime.

Current ONNX Runtime CUDA binaries for this repo expect:

- CUDA 12.x userspace libraries
- cuDNN 9.x userspace libraries

If those libraries are missing or mismatched, the sidecar now reports that explicitly in Settings and falls back to CPU for Cohere instead of silently pretending CUDA worked.

## Step 1: Find the Host Library Paths

Run these commands on the host, outside the sandbox:

```sh
readlink -f /usr/local/cuda
find /usr -name "libcuda.so.1" 2>/dev/null
```

Typical results:

- CUDA toolkit root: `/usr/local/cuda-12.9`
- driver library directory: `/usr/lib64` or `/usr/lib/x86_64-linux-gnu`

Build the colon-separated library path you will paste into plugin settings. It usually needs:

- toolkit target libs
- toolkit `lib64`
- driver library directory

Example:

```text
/run/host/usr/local/cuda-12.9/targets/x86_64-linux/lib:/run/host/usr/local/cuda-12.9/lib64:/run/host/usr/lib64
```

## Step 2: Build the CUDA Sidecar

```sh
bash scripts/build-cuda.sh
# or:
bash scripts/build-cuda.sh --release
```

Artifacts:

- CPU build: `native/sidecar/target/{debug|release}/obsidian-local-stt-sidecar`
- CUDA build: `native/sidecar/target-cuda/{debug|release}/obsidian-local-stt-sidecar`

## Step 3: Apply Flatpak Overrides

```sh
flatpak override --user --filesystem=host-os md.obsidian.Obsidian
flatpak override --user --device=all md.obsidian.Obsidian
```

Verify:

```sh
flatpak override --user --show md.obsidian.Obsidian
```

Expected:

```text
[Context]
filesystems=host-os;
devices=all;
```

## Step 4: Optional Sandbox Verification

Before launching Obsidian, confirm the paths resolve inside the sandbox:

```sh
flatpak run --command=sh md.obsidian.Obsidian -c '
  ls /run/host/usr/local/cuda-12.9/targets/x86_64-linux/lib/libcudart.so* 2>&1
  ls /run/host/usr/lib64/libcuda.so.1 2>&1
'
```

For a stricter check, run `ldd` with the same library path you plan to paste into the plugin:

```sh
flatpak run --command=sh md.obsidian.Obsidian -c '
  export LD_LIBRARY_PATH=/run/host/usr/local/cuda-12.9/targets/x86_64-linux/lib:/run/host/usr/local/cuda-12.9/lib64:/run/host/usr/lib64
  ldd /absolute/path/to/native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar | grep -E "cuda|cudnn|cublas|not found"
'
```

## Step 5: Configure the Plugin

1. Fully quit and reopen Obsidian after applying Flatpak overrides.
2. Open `Settings -> Local STT -> Advanced: Sidecar`.
3. Set `Sidecar path override` to the CUDA binary:
   `/absolute/path/to/native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar`
4. Set `CUDA library path` to the colon-separated `/run/host/...` value you built earlier.
5. Under `Engine options`, leave `GPU acceleration` on `Use when available` unless you intentionally want CPU only.
6. Run `Local STT: Check Sidecar Health`.

The settings page now shows the effective backend per engine:

- `Whisper: CUDA`
- `Cohere: CUDA`
- or CPU with an explicit reason if the GPU runtime is unavailable

`Disabled` forces both engines onto CPU even if a GPU backend is available.

## Troubleshooting

### Sidecar fails to start with missing CUDA libraries

Check:

- the Flatpak has `--filesystem=host-os`
- the paths use the resolved toolkit directory (`cuda-12.x`), not `/usr/local/cuda`
- the driver library directory is included in `CUDA library path`

### `NotReadableError: Could not start audio source`

Do not set `LD_LIBRARY_PATH` as a global Flatpak override.

Remove it if you did:

```sh
flatpak override --user --reset md.obsidian.Obsidian
flatpak override --user --filesystem=host-os md.obsidian.Obsidian
flatpak override --user --device=all md.obsidian.Obsidian
```

Then use only the plugin’s `CUDA library path` setting.

### Settings show `Cohere: CPU (CUDA unavailable: ...)`

The sidecar successfully started, but ONNX Runtime could not register the CUDA execution provider. Common causes:

- CUDA 12.x userspace libraries are not available in the sandbox
- cuDNN 9.x is missing
- the library path points at the wrong host directory
- the host driver and userspace runtime do not match

Check `nvidia-smi`, `nvcc --version`, and the sandbox-visible library paths.

### Settings show `Whisper: CPU`

On Linux, the sidecar checks for exposed NVIDIA device nodes. Confirm:

```sh
flatpak run --command=sh md.obsidian.Obsidian -c 'ls /dev/nvidia* 2>&1'
```

If those nodes are missing, re-apply `--device=all`.

## Removed Fallback: Wrapper Script

The old wrapper-script escape hatch has been removed. The supported approach is to point `Sidecar path override` directly at the CUDA sidecar binary and use the plugin's `CUDA library path` setting for the host library directories.

## Alternative: Native Obsidian Install

If Flatpak GPU setup is too fragile, use native Obsidian. On a native install, the sidecar inherits the host environment directly and usually does not need the extra Flatpak-specific path handling.
