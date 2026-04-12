# Obsidian Local STT

Desktop-only Obsidian plugin for local speech-to-text in Obsidian with a Rust sidecar.

Current working path:

- an Obsidian plugin at the repository root
- a native sidecar under `native/sidecar`
- versioned framed stdio IPC between them
- microphone capture in the plugin
- streaming `16 kHz` mono `PCM16` audio from the plugin to the sidecar
- session-based dictation with always-on, press-and-hold, and one-sentence modes
- local CPU Whisper transcription in the sidecar
- configurable transcript placement at the cursor or the end of the note

## Architecture

```text
Obsidian plugin (TypeScript)
  -> manages settings, commands, ribbon/state UX, microphone capture, and editor insertion
  -> streams framed JSON control messages and binary PCM audio over stdio

Rust sidecar
  -> validates framed protocol messages
  -> owns listening-session state, VAD, utterance segmentation, and queueing
  -> resolves managed catalog installs or explicit external files into a runtime model path
  -> transcribes finalized in-memory utterances with whisper-rs
  -> emits asynchronous session and transcript events back to the plugin
```

## Toolchain

Project baseline:

- Node.js `24.14.1`
- npm `11.12.1`
- TypeScript `6.0.2`
- Rust `1.94.1`

Pinning:

- `package.json` `engines` and `packageManager`
- `rust-toolchain.toml`
- lockfiles for JavaScript and Rust once dependencies are installed

## Repository Layout

```text
src/                  Obsidian plugin source
test/                 TypeScript unit tests
native/sidecar/       Rust sidecar crate
```

## Local Development

1. Install Node.js `24.14.1`.
2. Upgrade npm to `11.12.1` with `npm install --global npm@11.12.1`.
3. Install Rust `1.94.1`.
4. Run `npm install`.
5. Build the sidecar with `cargo build --manifest-path native/sidecar/Cargo.toml`.
6. Run `npm run dev` for the plugin bundle watcher.
7. Point an Obsidian dev vault plugin directory at this repository.

Recommended dev-vault workflow:

- create a dedicated vault for plugin development
- place this repository at `<vault>/.obsidian/plugins/obsidian-local-stt`, or symlink it there
- enable the plugin from Obsidian's community plugin screen
- use the settings tab to override the sidecar path if your debug binary is not at the default location
- reload or restart Obsidian after rebuilding the plugin bundle so it picks up the current `main.js`
- rebuild the sidecar executable with `cargo build --manifest-path native/sidecar/Cargo.toml` after Rust changes if you are only running `npm run dev`

Local note:

- `data.json` in the plugin directory is Obsidian runtime state, not checked-in source configuration

## Manual Verification

Managed models are now the primary path. The plugin ships a bundled model catalog, verifies downloads with `SHA-256`, and stores managed installs in a shared sidecar-owned model store. External `whisper.cpp`-compatible model files remain available as an explicit advanced fallback.

For the first end-to-end verification in this repository, use the bundled smaller English model first, then move up to the larger Turbo model after the full flow works. Bundled first-pass model:

- `Whisper Small English Q5_1`

Bundled follow-up model:

- `Whisper Large V3 Turbo Q8_0`

Managed-model verification flow:

1. Open a Markdown note in the dev vault.
2. Open `Settings -> Local STT`.
3. Confirm the `Current model` card shows `No model selected`.
4. Click `Browse models`.
5. Start an install for `Whisper Small English Q5_1`.
6. Wait for the install to complete, then select it.
7. Set `Listening mode` to `One sentence` for the simplest first pass.
8. Leave `Pause while processing` enabled for the first CPU verification pass.
9. Optionally set `Sidecar path override` if the debug sidecar is not at `native/sidecar/target/debug`.
10. Run `Local STT: Check Sidecar Health`.
11. Set `Transcript placement` to `Insert at cursor`.
12. Click the microphone ribbon button or run `Local STT: Start Dictation Session`.
13. Speak one short sentence.
14. Confirm the transcript replaces the current selection or inserts at the caret and the session returns to idle automatically.

External-file fallback verification:

1. Open `Settings -> Local STT`.
2. Click `Use external file`.
3. Enter an absolute `whisper.cpp`-compatible model file path.
4. Click `Validate and use`.
5. Confirm the `Current model` card shows `External file` as the source and resolves the configured path.

Append placement verification:

1. Set `Transcript placement` to `Append on a new line`.
2. Put the caret somewhere in the middle of an existing note and select some text.
3. Run another one-sentence dictation.
4. Confirm the transcript is appended at the note end, not at the selection, with exactly one newline before it.
5. Set `Transcript placement` to `Append as a new paragraph`.
6. Run another one-sentence dictation.
7. Confirm the transcript is appended at the note end with exactly one blank line before it.
8. Confirm placement changes do not add punctuation or capitalization beyond the raw transcript text.

For press-and-hold verification:

1. Set `Listening mode` to `Press and hold`.
2. Assign a hotkey to `Local STT: Press-And-Hold Gate` in Obsidian Hotkeys if you want keyboard gating. This hotkey target does not appear in the command palette.
3. Hold the ribbon button or the configured hotkey while speaking.
4. Release it and confirm the buffered utterance is transcribed and inserted.

## Commands

- `npm run build` builds the debug sidecar executable and bundles the plugin to `main.js`
- `npm run dev` watches and rebuilds the plugin
- `npm run test` runs TypeScript unit tests
- `npm run check` runs TypeScript and Rust quality gates
- `cargo run --manifest-path native/sidecar/Cargo.toml` runs the sidecar directly

Available command palette actions:

- `Local STT: Start Dictation Session`
- `Local STT: Stop Dictation Session`
- `Local STT: Cancel Dictation Session`
- `Local STT: Check Sidecar Health`
- `Local STT: Restart Sidecar`

Hotkey-only command target:

- `Local STT: Press-And-Hold Gate`

## GPU Acceleration

GPU acceleration is opt-in. The default sidecar is CPU-only and works everywhere. A GPU-enabled sidecar must be built separately and pointed to via the **Sidecar path override** setting.

### Platform support

| Platform | GPU support | Notes |
|---|---|---|
| Windows | CUDA | Native install; child processes inherit `CUDA_PATH` and DLL search path automatically |
| macOS | Metal | Metal is a standard system framework; no separate install required |
| Linux native (.AppImage / .deb / .rpm) | CUDA | Child process inherits host environment; RPATH in the CUDA binary resolves automatically |
| Linux Flatpak | Not supported by default | Sandbox blocks host CUDA libraries; see advanced setup below |

### Building a GPU sidecar (Linux CUDA)

Requires the CUDA toolkit (`nvcc`) and NVIDIA drivers installed on the host.

```sh
bash scripts/linux_cuda_build.sh --no-clean
```

Produces two binaries:

- `native/sidecar/target/debug/obsidian-local-stt-sidecar` — CPU build (default)
- `native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar` — CUDA build

Add `--release` for optimized binaries (longer build, significantly faster inference).

### Enabling GPU in the plugin

1. Open `Settings -> Local STT -> Advanced`.
2. Set **Sidecar path override** to the absolute path of the CUDA binary.
3. Enable the **GPU acceleration** toggle.
4. Restart the sidecar (`Local STT: Restart Sidecar` or restart Obsidian).

### Linux Flatpak: advanced override (power user)

Flatpak sandboxes child processes and hides host library paths. The CUDA sidecar links against `libcublas.so.13`, `libcudart.so.13`, `libcublasLt.so.13`, and `libcuda.so.1` — all invisible inside the sandbox by default.

**Why this is non-trivial:** Flatpak always replaces `/usr` with its own runtime — `--filesystem=host` does not expose host CUDA libraries. The `--filesystem=host-os` permission mounts the host OS tree at `/run/host/usr/` instead. Additionally, `/usr/local/cuda` is typically a symlink chain (e.g. `/usr/local/cuda` → `/etc/alternatives/cuda` → `/usr/local/cuda-13.2`) and these absolute symlinks break inside the sandbox because `/etc/alternatives/` resolves to the sandbox's `/etc`, not the host's. You must use the **resolved real path** (e.g. `cuda-13.2`) in all overrides.

#### Step 1: Find your CUDA paths

```sh
# Find the real CUDA toolkit path (not the symlink)
readlink -f /usr/local/cuda
# Example output: /usr/local/cuda-13.2

# Confirm the toolkit libraries
ls /usr/local/cuda-13.2/targets/x86_64-linux/lib/libcublas.so.*

# libcuda.so.1 comes from the NVIDIA driver, not the toolkit — find it separately
find /usr -name "libcuda.so.1" 2>/dev/null
# Common locations: /usr/lib64/libcuda.so.1 or /usr/lib/x86_64-linux-gnu/libcuda.so.1
```

#### Step 2: Apply Flatpak overrides

Replace `cuda-13.2` and `/usr/lib64` with the paths from step 1.

```sh
# Expose host OS tree at /run/host/usr/ inside the sandbox
flatpak override --user --filesystem=host-os md.obsidian.Obsidian

# Expose GPU device nodes (/dev/nvidia*, /dev/nvidiactl, /dev/nvidia-uvm)
flatpak override --user --device=all md.obsidian.Obsidian

# Point the dynamic linker at the real paths under /run/host/
# Three paths: toolkit libs, toolkit lib64, and driver lib (libcuda.so.1)
flatpak override --user \
  --env=LD_LIBRARY_PATH=/run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib:/run/host/usr/local/cuda-13.2/lib64:/run/host/usr/lib64 \
  md.obsidian.Obsidian
```

#### Step 3: Verify inside the sandbox (before launching Obsidian)

```sh
# Open a shell inside the Obsidian sandbox
flatpak run --command=sh md.obsidian.Obsidian

# Check libraries are visible
ls /run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib/libcublas.so.13
ls /run/host/usr/lib64/libcuda.so.1

# Run ldd on the CUDA sidecar to confirm all dependencies resolve
ldd /path/to/target-cuda/debug/obsidian-local-stt-sidecar | grep -E "cublas|cudart|cuda|not found"
# All four should show resolved paths under /run/host/. Zero "not found".
```

#### Step 4: Configure the plugin

1. Fully quit and reopen Obsidian (overrides only take effect on a fresh launch).
2. Open `Settings → Local STT → Advanced`.
3. Set **Sidecar path override** to the absolute path of the CUDA binary.
4. Set **GPU acceleration** to the appropriate backend.
5. Run `Local STT: Check Sidecar Health` from the command palette.

#### Why LD_LIBRARY_PATH works

The CUDA sidecar has a `RUNPATH` (not `RPATH`) baked into the ELF header at compile time, pointing to the host path (e.g. `/usr/local/cuda/targets/x86_64-linux/lib`). This path doesn't exist inside the sandbox. However, `LD_LIBRARY_PATH` is searched **before** `RUNPATH` in the dynamic linker search order, so the `/run/host/...` paths in the environment override win.

#### Reverting

```sh
flatpak override --user --reset md.obsidian.Obsidian
```

#### If it doesn't work

- Exit code 127 = the dynamic linker can't find a library. Recheck the `ldd` output from step 3.
- `cuInit` failure at runtime = driver version mismatch. Run `nvidia-smi` to check your driver version and confirm it matches the CUDA toolkit version you built against.
- If overrides are too fragile, switch to a native Obsidian install (.AppImage or distribution package). On a native install, the CUDA sidecar works without any overrides.

## License

MIT. See [LICENSE](LICENSE).
