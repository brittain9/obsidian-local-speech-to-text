# Problem: CUDA Sidecar Overwrite + Flatpak Runtime Failure

- Status: open
- Date observed: 2026-04-11
- Scope: Linux development runtime, native sidecar startup, GPU packaging, and release planning
- Primary evidence: `build_output.txt` (local untracked build log captured on 2026-04-11)

## Observed Symptoms

- Obsidian console reported `Uncaught Error: write EPIPE` from `SidecarProcess.write`.
- Plugin stderr logging reported:
  `error while loading shared libraries: libcublas.so.13: cannot open shared object file: No such file or directory`
- The initial sidecar health check failed with:
  `Sidecar exited unexpectedly (code: 127, signal: null).`

## What Happened

The Linux CUDA build wrote a CUDA-linked sidecar into the same default debug path that the plugin automatically launches when no sidecar override is configured. Obsidian was running as a Flatpak app, so the sidecar process did not reliably have access to host CUDA libraries under `/usr/local/cuda`. The sidecar failed in the dynamic loader before the framed protocol started, then the plugin wrote to dead stdin and surfaced `EPIPE` as follow-on noise.

This was not a transcription-engine logic failure. It was a build-artifact collision plus a runtime sandbox mismatch plus weak dead-process write handling.

## Evidence

### Local build log

`build_output.txt` is an untracked local artifact, so the critical facts are repeated here instead of relying on the file remaining present.

The captured log shows:

- the build was a `Linux CUDA sidecar build`
- profile was `debug`
- the cargo command used `--features gpu-cuda`
- the produced artifact path was `native/sidecar/target/debug/obsidian-local-stt-sidecar`
- the build injected a CUDA runtime path:
  `/usr/local/cuda/targets/x86_64-linux/lib`

Relevant excerpt from the log:

```text
Linux CUDA sidecar build
  profile: debug
  cuda lib rpath: /usr/local/cuda/targets/x86_64-linux/lib

Running cargo command:
  cargo build --manifest-path /home/Alex/Projects/new/native/sidecar/Cargo.toml --features gpu-cuda ...

Build complete:
  /home/Alex/Projects/new/native/sidecar/target/debug/obsidian-local-stt-sidecar
```

### Runtime validation performed during diagnosis

- The repo sidecar binary and the deployed vault binary had identical size and mtime, so this was not a bad copy problem.
- `readelf -d` on the runtime binary showed:
  - `NEEDED libcublas.so.13`
  - `NEEDED libcudart.so.13`
  - `NEEDED libcuda.so.1`
  - `RUNPATH /usr/local/cuda/targets/x86_64-linux/lib`
- `ldd` from the host shell resolved those libraries successfully, which means the binary itself was valid in the host environment.
- `flatpak ps` showed Obsidian running as `md.obsidian.Obsidian`, confirming the actual runtime context was Flatpak rather than a native host install.

### Relevant code and config paths

- `scripts/linux_cuda_build.sh`
- `src/main.ts`
- `src/sidecar/sidecar-process.ts`
- `src/sidecar/sidecar-connection.ts`
- `src/settings/plugin-settings.ts`
- `native/sidecar/src/protocol.rs`
- `scripts/verify-build-output.mjs`

## Root Cause Chain

```text
CUDA build ran
  -> overwrote the default debug sidecar path
  -> Obsidian Flatpak launched that CUDA-linked binary
  -> Flatpak runtime could not resolve host CUDA libraries
  -> sidecar exited with code 127 before protocol startup
  -> plugin kept writing to dead stdin
  -> Obsidian console showed write EPIPE
```

Primary failure:

- the default runtime sidecar path stopped being CPU-safe
- the launched binary required CUDA libraries that were not available inside the actual Obsidian runtime environment

Secondary symptom:

- `EPIPE` was noise caused by writing to a sidecar process that had already exited

## Fixes in Priority Order

### 1. High: GPU builds must never overwrite the default CPU sidecar path

The default plugin runtime path should always contain a CPU binary. Any GPU build, including `scripts/linux_cuda_build.sh`, must write to a separate output path or separate target directory.

Target shape:

- CPU default stays at `native/sidecar/target/debug/obsidian-local-stt-sidecar`
- CUDA build writes to a dedicated artifact such as:
  - `native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar`, or
  - `native/sidecar/target/debug/obsidian-local-stt-sidecar-cuda`

Important constraint:

- a post-build rename inside the same default target directory is not enough if the normal runtime binary was already overwritten during the build; isolation must happen before or during the build output step

### 2. High: Flatpak + CUDA is a separate distribution problem

The plugin currently has no complete support story for Obsidian Flatpak plus CUDA sidecars. This must be treated as an explicit product and release decision rather than as a transparent runtime mode.

Two realistic paths:

- Support GPU mode only on non-Flatpak Linux Obsidian installs such as native packages or AppImage
- Document an advanced manual Flatpak override workflow for users who want to try host CUDA access

If Flatpak overrides are documented, the observed CUDA path on this machine was:

- `/usr/local/cuda/targets/x86_64-linux/lib`

That matters because generic instructions using `/usr/local/cuda/lib64` would not match the path that was actually linked into this binary.

This still would not be a silent or reliable default. It would require explicit user action and a documented support boundary.

### 3. Medium: Harden dead-sidecar write handling and suppress `EPIPE` noise

`SidecarProcess.write()` currently assumes `stdin.write()` is enough as long as the child handle exists and `stdin.writable` is true. That is not sufficient once the process has already died and the stream emits an asynchronous broken-pipe error.

Expected fix direction:

- register `stdin` error handling when the child starts, not inside each write
- treat `EPIPE` as a dead-sidecar condition rather than an uncaught exception path
- convert command failures after child death into a clean "sidecar unavailable" or "sidecar exited" error

Goal:

- one clear launch/runtime failure
- no extra Obsidian console noise from follow-on writes

### 4. Medium: Flip GPU defaults from opt-out to opt-in

Current defaults still bias toward GPU:

- `src/settings/plugin-settings.ts` defaults `useGpu` to `true`
- `native/sidecar/src/protocol.rs` defaults `use_gpu` to `true` when omitted

That is inconsistent with the repo's CPU-first decisions and makes accidental GPU coupling easier during development. GPU should default to `false` and become an explicit user opt-in.

Tests that currently assert the `true` default will need to be updated accordingly.

### 5. Medium: Strengthen build verification beyond file existence

`scripts/verify-build-output.mjs` currently checks only that the sidecar file exists. That is too weak for dynamically linked GPU binaries.

Minimum improvement options:

- run `ldd` on the produced binary and fail if any dependency is unresolved
- or run a tiny startup smoke check with the required `--catalog-path` argument and treat exit `127` as a missing shared-library failure

Important note:

- the sidecar does not support a standalone `--version` flag, so build verification should not assume that interface exists

## Immediate Workaround

- Rebuild the default sidecar as CPU-only so the default runtime path is safe again.
- Reload or restart Obsidian after replacing the sidecar binary.
- Do not rely on the settings-level GPU toggle as a fix for this specific issue; once the launched binary itself is CUDA-linked, the loader failure happens before the plugin can negotiate runtime behavior.

## Release Impact, Especially for Linux Flatpak

This issue increases release complexity on Linux in several ways:

- community-plugin releases cannot assume users run a native Obsidian package rather than Flatpak
- Flatpak sandboxing breaks the assumption that host CUDA libraries are reachable from the plugin sidecar
- GPU support cannot be treated as a transparent checkbox if the runtime environment may block shared-library access before startup
- Linux packaging may need CPU and GPU artifacts to be distinct, with explicit runtime selection instead of one default path
- release notes and setup docs will need a Linux install-method support matrix, not just a generic "GPU supported" statement
- support burden rises because the user's Obsidian distribution method becomes relevant to whether the plugin can launch a GPU sidecar at all

This directly complicates the backlog item about native sidecar distribution and community-plugin release strategy.

## Open Questions

- Will GPU mode be officially unsupported on Obsidian Flatpak?
- Will Linux community-plugin releases ship CPU-only sidecars, optional GPU sidecars, or both?
- Should plugin-side binary selection become explicit instead of assuming one default executable path?
- Should build verification include dependency inspection such as `ldd` for non-CPU artifacts?
- If Flatpak overrides are documented, what level of support or troubleshooting commitment is acceptable?
