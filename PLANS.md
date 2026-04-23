# Active work

Working-plan file. Completed large-change plans are distilled into `docs/decisions.md` and `AGENTS.md`; this file tracks only in-flight work.

## Lazy install prompt

### Context

The download-on-demand installer (first-run modal + CUDA CTA + settings CPU install row) ships and works end-to-end. The remaining UX concern is _when_ the install modal appears.

Before: the plugin checked for a resolvable sidecar on `workspace.onLayoutReady()` and popped the install modal unconditionally when none was found. Too intrusive — a user who enables the plugin to poke around gets a download prompt before they've decided they want the feature.

After: the plugin stays silent on enable. The user clicks the dictation ribbon (or runs the command), the sidecar spawn fails with a specific "not downloaded" signal, and only then does the install modal appear.

Scoping requirement: the signal must fire _only_ for "no binary in any default location." If `sidecarPathOverride` points at a broken path, or the spawn itself dies, the user gets a generic error — not a misdirected "download a sidecar" CTA.

### Mechanism

- `SidecarNotInstalledError` class thrown from exactly one line — the final throw in `resolveSidecarExecutablePath` (`src/sidecar/sidecar-paths.ts`), which only runs when override is empty AND no installed binary exists AND no dev binary exists.
- `DictationSessionController` takes an `onSidecarMissing?: () => void` dep. Its `startDictation` catch branches on `instanceof SidecarNotInstalledError`, calls the callback, and returns without a notice (the modal itself is the feedback).
- `src/main.ts` wires the callback to `openFirstRunSetup()`. `runPostLayoutStartup` no longer opens the modal proactively and treats a startup-path `SidecarNotInstalledError` as a debug-level "deferred" log. `ModelInstallManager.init()` also swallows the sentinel at debug.
- Ribbon code stays state-unaware — it just reflects controller state.

### Status

- [x] Sentinel class + scoped throw in `sidecar-paths.ts`
- [x] `onSidecarMissing` callback in `DictationSessionController` + branch in catch
- [x] Delete `isSidecarAvailable()` + proactive modal trigger in `main.ts`; wire callback; demote startup/model-init sentinel logs to debug
- [x] Tests: two new controller tests + tightened sidecar-paths tests
- [ ] `npm run check` green
- [ ] Real-Obsidian manual verification (fresh install, override-broken, already-installed, command-palette paths — see the plan file for the exact steps)

### Pending non-blocking items

- Task #12: update `docs/decisions.md` + README for the download-on-demand flow. Separate docs commit, does not gate PR.
- Publish release `2026.4.20` for true end-to-end download testing.
- Open PR against `main` once manual verification passes.

## Release 2026.4.21 — what shipped + what's still wrong

Commit `c7f7190` tag `2026.4.21` (CI run `24759006262`, currently in progress as of 2026-04-21). Single commit covering the two-part fix as originally planned:

- **Part A — AVX-512 cache bust (CPU).** Moved `GGML_NATIVE: 'OFF'` from step-level to **job-level** `env:` on both `build-sidecar-posix` and `build-sidecar-windows`, and widened `Swatinem/rust-cache@v2`'s `env-vars:` to `CARGO CC CFLAGS CXX CMAKE RUST GGML WHISPER` so any `GGML_*` / `WHISPER_*` flip busts the key automatically. The two stale CPU keys were also `gh cache delete`'d belt-and-braces. Directionally sound — no known defect.
- **Part B — CUDA runtime DLLs.** Added `runtime.{linux,win32}` to `native/cuda-artifacts.json` (cudart/cublas/cublasLt only), extended both packaging steps to copy those, swapped `scripts/build-cuda.sh`'s `-Wl,-rpath,${cuda_lib}` to `-Wl,-rpath,$ORIGIN`.

### Problems with what shipped

1. **High — the CUDA archive is still broken.** Re-inspection of the shipped Windows CUDA artifact shows `onnxruntime_providers_cuda.dll` *also* directly imports **`cufft64_11.dll`** and **`cudnn64_9.dll`**. Neither is in `runtime.win32`, and the workflow's Jimver sub-packages (`nvcc, cudart, cublas, cublas_dev, visual_studio_integration`) don't install either. So the in-flight rebuild will still fail with `STATUS_DLL_NOT_FOUND` a moment after load — cudart/cublas resolve, cuFFT/cuDNN don't.
2. **Medium — Linux lib path is duplicated.** `.github/workflows/release.yml` hard-codes `/usr/local/cuda/lib64/`, but `scripts/build-cuda.sh:111-112` derives it canonically as `${cuda_root}/targets/$(uname -m)-linux/lib`. Same place via symlink today, two sources of truth regardless.
3. **Medium — re-tagging `2026.4.21` made broken-vs-fixed indistinguishable.** `src/sidecar/sidecar-installer.ts:184` records `options.version` verbatim into the install manifest; `src/settings/settings-tab.ts:605-608` surfaces it as the installed-status string. Users with either the original or re-tagged 2026.4.21 artifact see the same "2026.4.21" — impossible to tell which DLL set they have.

## Release 2026.4.22 — full CUDA dep chain + distinct version

Goal: ship the full direct-import chain of `onnxruntime_providers_cuda.dll`, standardize on the build script's CUDA lib derivation, and cut under a distinct version string so broken 2026.4.21 installs stay identifiable.

### Decision still open — cuDNN sourcing (A vs B)

**Option A — Bundle cuDNN with the CUDA archive.** Download NVIDIA's cuDNN redistributable (`cudnn-{windows,linux}-x86_64-9.5.1.17_cuda12-archive.{zip,tar.xz}`) from `developer.download.nvidia.com/compute/cudnn/redist/` in CI and stage the stub + 7 backend DLLs.
- **+** One-click install for end users, archive is fully self-contained.
- **−** ~600-900 MB added per CUDA archive (Windows zip → ~1.3 GB).
- **−** cuDNN SLA redistribution clause needs a legal sanity-check; the redistributables are on a public CDN (consistent with SLA terms) but not as clear-cut as CUDA EULA Attachment A for cudart/cublas.

**Option B — Require user-installed cuDNN 9.** Ship only cudart/cublas/cublasLt + **cuFFT**. Document cuDNN 9.x as a hard CUDA-sidecar prerequisite; have the sidecar fail fast with a specific "install cuDNN" notice when the load fails, routed through the existing `openFirstRunSetup()` path.
- **+** No SLA question, no size blowup, mirrors much ML tooling.
- **−** CUDA sidecar is no longer one-click; user must grab cuDNN 9 from NVIDIA (dev-portal login).
- **−** Extra plugin-side plumbing: new `CudnnMissingError` sentinel paralleling `SidecarNotInstalledError` (`src/sidecar/sidecar-paths.ts`), new `onCudnnMissing` callback in `DictationSessionController`, updated first-run modal copy.

### Shared plan (applies to both A and B)

1. **Cancel the in-flight `2026.4.21` rebuild** (`gh run cancel 24759006262`) and `gh release delete 2026.4.21` + `git push --delete origin 2026.4.21` + `git tag -d 2026.4.21`. Do NOT re-tag `2026.4.21` — leave the broken artifact visibly attached to its version so user support is clean.
2. **`package.json`**: bump `"version": "2026.4.21"` → `"version": "2026.4.22"`.
3. **`native/cuda-artifacts.json`**: extend `runtime` with `libcufft.so.11` / `cufft64_11.dll`. *(Option A adds a sibling `cudnn` block with the 8-file backend set per platform; Option B does not.)*
4. **`.github/workflows/release.yml`**:
   - Add `cufft` (and on Windows also `libcufft`) to Jimver `sub-packages`.
   - Replace the Linux packaging's `/usr/local/cuda/lib64/$file` with `cuda_lib="$(dirname "$(dirname "$(which nvcc)")")/targets/$(uname -m)-linux/lib"` — exactly matching `scripts/build-cuda.sh:111-112`.
   - Packaging loops already iterate `d.runtime.*` from JSON — cuFFT just slips in.
   - *(Option A only)* Add a "Install cuDNN" step after Jimver (guarded by `if: matrix.cuda`). Linux: wget + extract + `sudo cp -P` into `${cuda_lib}`. Windows: Invoke-WebRequest + Expand-Archive + copy into `$env:CUDA_PATH\bin\`. Add a second packaging loop for `d.cudnn.*`.
5. **`docs/lessons.md`**: expand the 2026-04-21 CUDA-bundling lesson — the ORT CUDA provider's import chain must be audited with `dumpbin /dependents` on the provider DLL, not just the sidecar exe.
6. **Commit / tag / push**: single commit staging only the files above (leave lazy-install plugin-side edits uncommitted, same as before). Annotated tag `git tag -a 2026.4.22 -m "Release 2026.4.22"`. Push branch, then tag.

### Verification

- **Windows CPU zip** (~15 min after trigger): `unzip -l` must NOT contain any `cudnn* / cufft* / cudart* / cublas*`. Disassembled exe: ~zero `zmm` refs. This validates Part A independent of CUDA work.
- **Windows CUDA zip**:
  - Option A: contains `cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, `cufft64_11.dll`, `cudnn64_9.dll` + the 7 cuDNN backends.
  - Option B: contains the first four; README/platform-deps updated to call out cuDNN.
  - `dumpbin /dependents obsidian-local-stt-sidecar.exe` against a fresh download: no `STATUS_DLL_NOT_FOUND` on ORT provider load (Option A) or a clean cuDNN-missing notice instead of a generic crash (Option B).
- **Linux CUDA tar.gz**: `tar tzf … | grep -E 'libcud(art|nn|fft)|libcublas'` mirrors the Windows coverage.
- **Post-publish manual**: fresh install on a Windows box with CUDA 13.x driver only (no CUDA 12 toolkit). Dictation must initialize (Option A) or emit the cuDNN-missing notice, then succeed after user installs cuDNN 9 (Option B). Same on a Linux host without `/usr/local/cuda`.

### Out of scope for 2026.4.22

- Splitting CUDA into a separate workflow job. Still recommended as follow-up; not blocking.
- Making ORT's CUDA provider truly optional at runtime so we never need cuDNN at all. Larger code-level change; file separately.
- Linux cuDNN install via `apt libcudnn9-cuda-12` — equivalent outcome to the redistributable tarball; tarball wins for symmetry with Windows.
