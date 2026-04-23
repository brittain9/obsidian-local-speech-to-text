# Code Review 1 — PR #53 (feat: download-on-demand sidecar + 2026.4.22)

Branch: `feat/sidecar-installer`
PR: https://github.com/brittain9/obsidian-local-speech-to-text/pull/53
Date: 2026-04-22
Scope asked: performance of sidecar, bundle-size reduction, no regression of prior lessons, "staff engineer approve?"

## Overview

Ships the three-file plugin bundle + on-demand sidecar installer, hardens the CPU baseline (AVX-512 crash), and bundles the full CUDA DLL import chain (cudart/cublas/cublasLt/cuFFT, `$ORIGIN` rpath on Linux). +1946 / −223 across 28 files, with a hefty uncommitted-but-on-branch set of refinements. The five-commit story is clean and the test coverage (vitest: installer, gpu-precheck, controller, paths) lands in roughly the right places.

## Would a staff engineer approve this?

**Conditional approve.** The intent is sound, the lessons from 2026-04-21/22 are largely encoded, and the framework is the right shape. But three items are below the bar; one is a true regression of a lesson that's already in `docs/lessons.md`.

---

## Blocking / must-fix

### 1. The 2026-04-22 Windows EBUSY lesson is only half-applied (correctness regression)

`src/sidecar/sidecar-installer.ts:196` does `await rm(destinationDirectory, …)` before `rename`. The 2026-04-22 lesson is explicit: *"This applies to both the uninstall path **and the upgrade `rm(destinationDirectory)` in `installSidecar`** — if the variant being overwritten is currently running, stop it before removing the old tree."*

The fix landed only on the CUDA uninstall path (`handleUninstallCuda`). The **CPU reinstall** path (settings → "Reinstall") never shuts down the live CPU sidecar before `installSidecar` runs — on Windows it will EBUSY on the `rm` the moment a user has actually used the plugin before clicking reinstall. Same risk for CUDA-over-live-CUDA reinstall. The `isDictationBusy()` guard only blocks while dictation is active; the sidecar process holds handles well outside of dictation windows (health check, system_info, model init).

Manual test plan in the PR body does not cover "reinstall while sidecar has been exercised." That's exactly the gap that produced the 2026-04-22 lesson.

**Fix:** have `installSidecar` accept a `shutdownRunningVariant: () => Promise<void>` and call it immediately before `rm(destinationDirectory)`. Or guarantee it at the caller — `openInstallModal` shuts down before opening the install flow and restarts on success/cancel. Add a Windows-reinstall case to the install test file and add the scenario to the PR test plan.

### 2. Archive extraction is fully buffered + synchronous (UX + memory)

`extractTarGz` (`src/sidecar/sidecar-installer.ts:381`) and `extractZip` do `readFile(wholeArchive)` followed by `gunzipSync` / `inflateRawSync`. For the CPU sidecar zip (~100–200 MB on Windows/Linux, CUDA larger) this:

- Peaks Obsidian's renderer-process JS heap at ~2× archive size (compressed buffer + decompressed buffer simultaneously).
- Blocks the event loop for the entire gunzip/inflate — the progress bar goes to 100% "Extracting…" and then Obsidian locks until it's done. That's seconds, not milliseconds, on a 150 MB CPU zip.

For a plugin that sells "stays local on your machine," a multi-second UI freeze on first run is poor product feel. Stream through `zlib.createGunzip()` and a stateful tar parser; for zip, stream each entry via `zlib.createInflateRaw()`. `tar-fs` / `yauzl` exist but add deps — staying dependency-free is fine, just don't slurp-and-block.

Related: `extractTarGz` does `decompressed.subarray(offset, offset + size)` without bounds-checking `offset + size <= decompressed.length`. A malformed archive silently writes a truncated file (a `subarray` past the end returns a shorter view, no throw). Add the bound check even if you keep the sync path for now.

### 3. `BUGS.md` is committed to the PR (added in commit 1, still on branch HEAD)

Single-line TODO as a repo-root `BUGS.md` is below the bar — it's state that belongs in a GitHub issue or the lessons file, not a root file. It's also already addressed in uncommitted work (`isDictationBusy()` guard). Roll the deletion into the PR, file the remaining edge case (install modal reactivity during an ongoing session) as an issue. The git index currently shows this as a local deletion; make it explicit.

---

## Bundle-size review (explicit ask)

The PR already does three of the big wins correctly; I'd push on two more.

**Good:**
- Windows packaging loops `d.providers.win32` rather than `*.dll` glob → drops the DirectML / TensorRT provider DLLs that `ort`'s `copy-dylibs` drops alongside. Solid call with an explanatory comment at `release.yml:282`.
- Uncommitted Linux packaging adds `strip --strip-unneeded` on both the ELF and the provider `.so`s (`release.yml:169,186`). Complements the Rust `strip = "symbols"` by reaching bundled C++/CUDA kernels Rust can't touch.
- `[profile.release]` with `lto = "thin"` + `codegen-units = 1` + `strip = "symbols"`, with a correct comment on *why* `panic` stays `unwind` (`catch_unwind` in worker/installer). Avoids the classic "abort = smaller binary" regression trap.

**Gaps I'd push back on:**

**a. `ndarray` is always compiled, but only `cohere_transcribe` uses it.** `native/Cargo.toml:20` lists `ndarray = "0.17"` unconditionally. It is referenced only in `src/adapters/cohere_transcribe.rs` and `src/runtimes/onnx.rs`, both gated by `engine-cohere-transcribe`. Move to `ndarray = { version = "0.17", optional = true }` and add it to the `engine-cohere-transcribe` feature list. Probably 1–2 MB off the stripped binary, and it lets `--no-default-features --features engine-whisper` actually produce a Whisper-only sidecar later.

**b. The CPU sidecar unconditionally pulls ORT via `download-binaries`.** `build-sidecar.mjs:8` always enables `engine-cohere-transcribe` (release and debug, CPU and Metal). That means the CPU zip bundles ORT's ~10-15 MB prebuilt runtime whether or not the user ever picks Cohere Transcribe. That's fine if Cohere Transcribe is core; call it out. If it's optional polish, either:
   - Ship two CPU archives (`cpu`, `cpu-cohere`) — more CI lanes, bigger aggregate matrix but smaller default download.
   - Make `engine-cohere-transcribe` off-by-default and lazy-install the Cohere model + ORT on demand (you already have the infra).

**c. Windows binary stripping is absent.** Linux gets `strip --strip-unneeded` in CI; Windows gets `strip = "symbols"` from the Rust profile only. Confirm the Windows zip contains no `.pdb`. The MSVC toolchain doesn't emit PDBs by default unless configured, but `ggml/whisper.cpp/ORT` could ship their own. `dumpbin /headers` on a release artifact to verify — and if there are any, either don't emit them in CMake or exclude from the zip.

**d. `lto = "thin"` → `fat` is a 2-5% size win** on a binary of this shape. Not a blocker. Ship "thin" now, re-evaluate once release builds are comfortably under 10 min.

---

## Performance review (explicit ask)

- Sidecar itself: profile untouched, no per-frame allocation change, not in scope of this PR. No regression.
- `detectNvidiaDriver` is correctly memoized per-tab (uncommitted settings-tab change at `settings-tab.ts:490`); the `nvidia-smi -L` spawn is a 3s-timeout child, not cheap if invoked per render.
- **Progress throttling** (uncommitted `PROGRESS_REPORT_BYTE_DELTA = 256 KB` / 100ms at `sidecar-installer.ts:314`) is a real win — prior version fired `onProgress` per chunk (~16 KB) and Obsidian's DOM updates were the hot path. Good.
- `downloadToFile` backpressure via `await fileStream.once('drain')` is correct.

---

## Lesson compliance audit

| Lesson (date) | Status |
|---|---|
| 2026-04-21 [build] AVX-512 / `GGML_NATIVE=OFF` at job scope | ✅ `release.yml:68-78, 194-198` |
| 2026-04-21 [build] `env-vars: … GGML WHISPER` on rust-cache | ✅ `release.yml:129-134, 240` |
| 2026-04-21 [build] Bundle cudart/cublas/cublasLt + `$ORIGIN` rpath | ✅ `cuda-artifacts.json`, `build-cuda.sh:158` |
| 2026-04-22 [build] cuFFT in provider import chain | ✅ `cuda-artifacts.json`, Jimver `cufft` subpackage |
| 2026-04-22 [process] `shutdown()` before `rm -rf` on Windows | ⚠️ **Partial** — only uninstall CUDA. Reinstall path regresses it. (Item 1 above.) |
| 2026-04-19 [process] Don't churn `PLANS.md` | ⚠️ PR does a 196-line rewrite of `PLANS.md`. Intentional plan distillation, fine if user-approved; confirm it matches the "distill completed outcomes back into AGENTS.md and docs/" rule. |

---

## Smaller notes

- `runPostLayoutStartup` at `main.ts:130-133` flips `firstRunCompleted` to `true` *before* opening the modal. If the download fails and the user closes Obsidian, next launch won't re-prompt — the only path left is clicking the ribbon. Intentional? Move the flag flip to the modal's `onInstalled` success callback, or flip back on dismiss/error.
- `openInstallModal` at `settings-tab.ts:562` gates on `isDictationBusy`. Good, but the **first-run modal** path (`main.ts:140-165`) doesn't — granted, the sidecar is by definition not running then, so there's nothing to be busy about. Fine.
- `detectPlatformAsset` hard-rejects `darwin` + `x64`; good. Consider a friendlier message routed into the first-run modal so Intel Mac users see "not supported" instead of a console error when they click.
- `gpu-precheck` test suite covers ENOENT/exit 0/non-zero/EACCES/sync-throw. One gap: the 3 s timeout branch is not tested (would need fake timers). Low priority.

---

## Summary for the author

Ship-blockers:
1. Apply the 2026-04-22 shutdown-before-`rm` rule to the install path (reinstall regression).
2. Stream archive extraction instead of `readFile + gunzipSync` — the current path is the UI freeze on first-run.
3. Commit the `BUGS.md` deletion.

Should address before the next CUDA cut:
4. Make `ndarray` optional under `engine-cohere-transcribe`.
5. Decide if Cohere Transcribe is core; if not, lazy-ORT.
6. Verify Windows zip has no `.pdb` leakage; add strip step if so.

Everything else reads as production-quality. The lessons log and decision trail makes the engineering history legible — nice.
