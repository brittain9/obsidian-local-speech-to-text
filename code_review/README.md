# Code Review Cycle — PR #53

Multi-pass review loop until PR 53 (`feat/sidecar-installer`) meets the staff-engineer bar. This directory is the scratch space for that process.

## Goals for this cycle (ordered)

1. **Correctness** — no regression of any lesson in `docs/lessons.md`. This is the floor.
2. **Download size** — every pass must either cut bytes off the shipped sidecar archives or explain why the next cut isn't worth it. Track both compressed (archive) and on-disk (extracted) size per pass.
3. **Performance** — hot code paths and hardware acceleration (whisper.cpp CUDA/Metal, ORT CUDA EP). Not the installer — installer perf only matters when it affects first-run UX (UI freezes, memory spikes).

Simplicity is a means to all three. If a later pass can delete code, that usually wins.

## The loop

1. **Review** — produce `code-review-N.md`. Audit the current branch state (committed + uncommitted) against the goals above and the lessons log. Flag what would stop a staff engineer from approving.
2. **Extract actions** — each review ends with a ship-blocker list and a "should address" list. Those are the actions. Don't maintain a separate `actions.md`; the review file is the action file.
3. **Fix** — apply edits on the branch. Keep changes surgical per `AGENTS.md`. Run `npm run check` after each blocker clears.
4. **Re-review** — next pass starts fresh, reads the prior review, and calls out which actions landed, which didn't, and what new surface the fixes exposed. Reviews accumulate; do not rewrite history.
5. **Manual test** — once the blocker list empties across all passes, run the Linux+CUDA test below. Record sizes and timings in the review that triggered the test.
6. **Land** — merge when the test passes and size/perf budget has no cheap wins left.

## Linux + CUDA manual test

Run on a Linux x86_64 host with an NVIDIA driver and a CUDA-capable GPU. User-installed cuDNN 9.x is required (per Option B in `PLANS.md`).

**Preflight**
- `nvidia-smi -L` lists the GPU.
- cuDNN 9 is on the loader path (`/usr/lib/x86_64-linux-gnu/libcudnn.so.9` or equivalent).
- Host has **no** `/usr/local/cuda` (or move it aside). This is the check that `$ORIGIN` rpath works — if the binary still resolves because the host happens to have the toolkit, the test is meaningless.

**Steps**
1. Wipe `<vault>/.obsidian/plugins/local-transcript/bin/` and delete `native/target*/debug` dev builds.
2. Launch Obsidian. Enable the plugin. Confirm **no** modal opens on startup (lazy-install).
3. Click the dictation ribbon. First-run modal opens.
4. Download CPU sidecar. Record: archive bytes, wall-clock download time, wall-clock extract time, peak Obsidian RSS.
5. Transcribe a 30-second clip on CPU. Record: transcription wall-clock.
6. Settings → Install CUDA acceleration. Driver precheck shows "present". Download CUDA sidecar. Record same metrics as step 4.
7. Audit the CUDA archive **before** extract: `tar tzf` must contain `libcudart.so.12`, `libcublas.so.12`, `libcublasLt.so.12`, `libcufft.so.11`, `libonnxruntime_providers_cuda.so`, `libonnxruntime_providers_shared.so` — and nothing else from ORT's copy-dylibs drop.
8. `ldd bin/cuda/obsidian-local-stt-sidecar` must not reference `/usr/local/cuda`. Every `libcu*` / `libcublas*` / `libcufft*` should resolve to `bin/cuda/`.
9. Transcribe the same clip on CUDA. Record transcription time. Verify in developer console that both Whisper CUDA and Cohere Transcribe CUDA initialise (no silent fallback to CPU).
10. Uninstall CUDA sidecar. Sidecar restarts on CPU. No errors.
11. **Reinstall CPU sidecar while the current CPU sidecar is live** (this is the 2026-04-22 lesson-check). Completes without EBUSY / EPERM / file-locking errors.
12. Corrupt one checksum entry and retry — install must fail at verify, not at extract.

Record every measurement in the review file that gated the test. Compare against the prior pass.

## Size-reduction backlog

Rolling list; prune as items land. Ordered by expected bytes-saved-per-effort.

- [ ] `ndarray` → optional under `engine-cohere-transcribe` (`native/Cargo.toml:20`).
- [ ] Verify Windows archive has no `.pdb` / ORT `.lib` leakage. If present, exclude in packaging.
- [ ] Decide ORT strategy for CPU sidecar: bundled (current) vs lazy-on-Cohere-Transcribe-selection. Bundles ~10–15 MB today.
- [ ] `lto = "fat"` once CI release budget tolerates it. Re-measure.
- [ ] Evaluate split archives (`cpu` vs `cpu-cohere`) if ORT stays bundled.
- [ ] Audit whisper.cpp CUDA archive for ggml CPU SIMD kernels that are dead when GPU is active — may be none left to strip, worth a `readelf -s` scan.

## Performance backlog

- [ ] Stream archive extraction (current `readFile + gunzipSync` blocks the event loop for seconds on ~150 MB archives).
- [x] Progress-report throttling (landed uncommitted in pass 1; re-verify in pass 2).
- [x] Memoize `nvidia-smi -L` per settings-tab lifetime (landed uncommitted).
- [ ] Confirm whisper.cpp `GGML_AVX2` baseline doesn't regress on Zen-2 / older Intel without AVX-512 after `GGML_NATIVE=OFF`. One clip each, at minimum.

## Exit criteria

- Every blocker across `code-review-*.md` resolved or consciously deferred with a note.
- Linux + CUDA manual test passes end-to-end on the current build.
- CPU archive and CUDA archive sizes have been recorded for at least two consecutive passes and the trend is flat or down.
- Any lessons learned during the cycle added to `docs/lessons.md`.
