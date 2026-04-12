# Linux Flatpak GPU Acceleration Setup

This guide documents how to enable CUDA GPU acceleration for the Local STT sidecar when running Obsidian as a Flatpak. This is a power-user workflow — it requires the CUDA toolkit, NVIDIA drivers, and manual Flatpak permission overrides.

## Why This Is Non-Trivial

Flatpak sandboxes replace `/usr` with the runtime's own copy. The CUDA sidecar binary links against `libcublas.so.13`, `libcudart.so.13`, `libcublasLt.so.13`, and `libcuda.so.1` — all of which live under the host's `/usr` and are invisible inside the sandbox by default.

Three specific issues must be solved:

1. **`/usr` is the runtime's, not the host's.** `--filesystem=host` does not expose host `/usr`. The `--filesystem=host-os` permission mounts the host OS tree at `/run/host/usr/` inside the sandbox.

2. **Symlinks break across the sandbox boundary.** On most systems, `/usr/local/cuda` is a symlink chain (e.g. `/usr/local/cuda` → `/etc/alternatives/cuda` → `/usr/local/cuda-13.2`). Inside the sandbox, these absolute symlink targets resolve against the *sandbox's* filesystem, not the host's. The symlink chain breaks silently. You must use the resolved real path (e.g. `cuda-13.2`).

3. **Global `LD_LIBRARY_PATH` poisons Electron's audio.** Setting `LD_LIBRARY_PATH` globally on the Obsidian Flatpak to include `/run/host/usr/lib64` makes Electron load host versions of PulseAudio, ALSA, and PipeWire libraries instead of the Flatpak runtime's versions. This breaks microphone capture (`getUserMedia()` fails with `NotReadableError: Could not start audio source`). The fix is a wrapper script that scopes `LD_LIBRARY_PATH` to only the sidecar child process.

## Prerequisites

- NVIDIA GPU with drivers installed
- CUDA toolkit installed on the host (e.g. via the NVIDIA CUDA repo or distribution packages)
- The CUDA sidecar binary, built with `bash scripts/linux_cuda_build.sh`
- Obsidian installed via Flatpak (`md.obsidian.Obsidian`)

## Version Compatibility

CUDA has two halves that must be version-compatible:

| Component | Location | What It Does |
|---|---|---|
| Kernel driver (`nvidia.ko`) | Loaded into the Linux kernel | Talks to GPU hardware |
| Userspace runtime (`libcuda.so`, `libcublas.so`) | `/usr/local/cuda-*/lib64/` | What your application links against |

The CUDA sidecar binary is compiled against a specific CUDA toolkit version (e.g. CUDA 13.2). The soname version in the binary (e.g. `libcublas.so.13`) must match what's installed on the host. Run `nvidia-smi` to check your driver version and `nvcc --version` to check your toolkit version.

Mismatches between the kernel driver and userspace runtime fail at `cuInit()` — not at link time. The binary loads, the library resolves, but CUDA initialization returns an error.

## Step-by-Step Setup

### Step 1: Find your CUDA paths

Run these on the host (outside the sandbox):

```sh
# Find the real CUDA toolkit path (resolves through symlinks)
readlink -f /usr/local/cuda
# Example output: /usr/local/cuda-13.2

# Confirm the toolkit libraries exist
ls $(readlink -f /usr/local/cuda)/targets/x86_64-linux/lib/libcublas.so.*

# Find libcuda.so.1 — this comes from the NVIDIA driver package, NOT the toolkit
find /usr -name "libcuda.so.1" 2>/dev/null
# Common locations: /usr/lib64/libcuda.so.1 (Fedora/RHEL) or /usr/lib/x86_64-linux-gnu/libcuda.so.1 (Debian/Ubuntu)
```

Record these values:
- **Real CUDA toolkit path**: e.g. `/usr/local/cuda-13.2`
- **Driver library path**: e.g. `/usr/lib64`

### Step 2: Build the CUDA sidecar

```sh
bash scripts/linux_cuda_build.sh --no-clean
```

This produces two binaries:
- `native/sidecar/target/debug/obsidian-local-stt-sidecar` — CPU build
- `native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar` — CUDA build

Add `--release` for optimized builds (significantly faster inference).

### Step 3: Apply Flatpak overrides

Only two overrides are needed. **Do not set `LD_LIBRARY_PATH` globally** — see the audio issue in the Troubleshooting section.

```sh
# Expose the host OS tree at /run/host/usr/ inside the sandbox
flatpak override --user --filesystem=host-os md.obsidian.Obsidian

# Expose GPU device nodes (/dev/nvidia*, /dev/nvidiactl, /dev/nvidia-uvm)
flatpak override --user --device=all md.obsidian.Obsidian
```

Verify the overrides are saved:

```sh
flatpak override --user --show md.obsidian.Obsidian
```

Expected output:

```
[Context]
filesystems=host-os;
devices=all;
```

### Step 4: Configure the wrapper script

The repository includes `scripts/flatpak-cuda-wrapper.sh`. Edit the two variables at the top to match your system:

```sh
# The absolute path to the CUDA sidecar binary
SIDECAR_BINARY="/home/youruser/path/to/native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar"

# CUDA library paths prefixed with /run/host/ (real path, not symlink)
# Three entries: toolkit targets lib, toolkit lib64, driver lib directory
CUDA_LD_PATH="/run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib:/run/host/usr/local/cuda-13.2/lib64:/run/host/usr/lib64"
```

The wrapper sets `LD_LIBRARY_PATH` only for the sidecar child process and then `exec`s the binary.

### Step 5: Verify inside the sandbox (optional but recommended)

Before launching Obsidian, open a shell inside the sandbox and confirm the libraries resolve:

```sh
flatpak run --command=sh md.obsidian.Obsidian -c '
  echo "=== CUDA toolkit libs ==="
  ls /run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib/libcublas.so.13 2>&1
  ls /run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib/libcudart.so.13 2>&1
  echo "=== Driver lib ==="
  ls /run/host/usr/lib64/libcuda.so.1 2>&1
'
```

All three should print the file path (no "No such file or directory").

For a definitive check, run `ldd` on the sidecar binary inside the sandbox:

```sh
flatpak run --command=sh md.obsidian.Obsidian -c '
  export LD_LIBRARY_PATH=/run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib:/run/host/usr/local/cuda-13.2/lib64:/run/host/usr/lib64
  ldd /path/to/target-cuda/debug/obsidian-local-stt-sidecar | grep -E "cublas|cudart|cuda|not found"
'
```

All CUDA libraries should show resolved paths under `/run/host/`. Zero "not found".

### Step 6: Configure the plugin

1. **Fully quit and reopen Obsidian** (Flatpak overrides only take effect on a fresh launch).
2. Open `Settings → Local STT → Advanced: Sidecar`.
3. Set **Sidecar path override** to the absolute path of the wrapper script: `/path/to/scripts/flatpak-cuda-wrapper.sh`
4. Set **Hardware acceleration** to CUDA under Engine options.
5. Run `Local STT: Check Sidecar Health` from the command palette.
6. If health check passes, start a dictation session to verify audio capture and CUDA inference both work.

## Troubleshooting

### Exit code 127: `libcublas.so.13: cannot open shared object file`

The dynamic linker can't find a CUDA library inside the sandbox.

- **Check the path is real, not a symlink**: Run `readlink -f /usr/local/cuda` on the host. Use the resolved path (e.g. `cuda-13.2`) in the wrapper script, never the `cuda` symlink.
- **Check `--filesystem=host-os` is applied**: Run `flatpak override --user --show md.obsidian.Obsidian`. If `host-os` is missing, the host's `/usr` is not mounted.
- **Check `libcuda.so.1` path**: This comes from the NVIDIA driver package, not the CUDA toolkit. On Fedora it's at `/usr/lib64/`, on Debian/Ubuntu it's at `/usr/lib/x86_64-linux-gnu/`. Run `find /usr -name libcuda.so.1` on the host.

### `NotReadableError: Could not start audio source`

**Do not set `LD_LIBRARY_PATH` as a global Flatpak environment override.** This is the most common mistake.

Setting `--env=LD_LIBRARY_PATH=...:/run/host/usr/lib64` on the Obsidian Flatpak makes Electron load the host's PulseAudio, ALSA, and PipeWire shared libraries instead of the Flatpak runtime's versions. These are ABI-incompatible across runtime boundaries, causing `getUserMedia()` to fail with `NotReadableError`.

The wrapper script (`scripts/flatpak-cuda-wrapper.sh`) solves this by setting `LD_LIBRARY_PATH` only for the sidecar child process. Electron keeps the Flatpak runtime's audio libraries, and the sidecar gets the CUDA libraries.

If you previously set a global `LD_LIBRARY_PATH` override, remove it:

```sh
flatpak override --user --reset md.obsidian.Obsidian
# Then re-apply only the two needed overrides:
flatpak override --user --filesystem=host-os md.obsidian.Obsidian
flatpak override --user --device=all md.obsidian.Obsidian
```

### `cuInit` failure at runtime

The CUDA userspace runtime version does not match the kernel driver version. Run `nvidia-smi` to check the driver version and compare against the CUDA toolkit version you built the sidecar with (`nvcc --version`). If they don't match, update one or the other.

### RUNPATH vs LD_LIBRARY_PATH

The CUDA sidecar binary has a `RUNPATH` baked into its ELF header at compile time (inspect with `readelf -d <binary> | grep RUNPATH`). This points to the host path where CUDA was found during the build (e.g. `/usr/local/cuda/targets/x86_64-linux/lib`). Inside the Flatpak sandbox, this path doesn't exist — it's the runtime's `/usr`, not the host's.

`LD_LIBRARY_PATH` is searched **before** `RUNPATH` in the dynamic linker search order, so setting it in the wrapper script to point at `/run/host/...` paths overrides the baked-in `RUNPATH`. This is why the wrapper works even though the binary was compiled with host-relative paths.

## Reverting All Overrides

```sh
flatpak override --user --reset md.obsidian.Obsidian
```

This removes all user overrides and returns Obsidian to its default Flatpak permissions. The plugin will fall back to the CPU sidecar (or fail to start if `sidecarPathOverride` still points at the CUDA binary).

## Alternative: Native Obsidian Install

If the Flatpak override is too fragile, switch to a native Obsidian install (.AppImage or distribution package from obsidian.md). On a native install, child processes inherit the full host environment — CUDA libraries resolve automatically via `RUNPATH` without any overrides, wrapper scripts, or Flatpak permissions.
