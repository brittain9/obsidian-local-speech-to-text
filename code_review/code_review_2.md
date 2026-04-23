# Code Review 2 — PR #53: feat(installer): download-on-demand sidecar + release 2026.4.22 CUDA fix

## Overview

Bundles five commits spanning three concerns: the download-on-demand sidecar installer (modal + GitHub-releases fetch + verification/extraction), a release packaging fix (portable SIMD baseline, CUDA runtime DLLs, `$ORIGIN` rpath, basename-only checksums), and a lifecycle hardening pass (shutdown before delete on Windows, stop-audio-on-reject, re-init model manager after restart). 2680-line diff, +1946/-223 across 28 files, with ~580 lines of new tests.

**Verdict:** ship it. The design is sound, separation between plugin and installer concerns is clean, and test coverage is thorough for the unit-testable surface. A handful of non-blocking concerns below.

---

## Correctness

### Blocking: none
No correctness issue is severe enough to block the release.

### Non-blocking — worth addressing

**1. `downloadToFile` doesn't listen for write-stream errors** — `src/sidecar/sidecar-installer.ts:330`
`createWriteStream(destPath)` returns a stream with no `error` handler. If the disk errors mid-download (ENOSPC, EACCES, quota), Node will emit an unhandled `error` on the stream and can crash the renderer. Also: `fileStream.once('drain', resolve)` on line 353 will never fire if the stream has errored, so the await deadlocks if we happen to be back-pressured when the error hits. Fix: `fileStream.on('error', reject)` via a Promise race, or use `pipeline()`.

**2. `modelInstallManager.init()` now races with `runPostLayoutStartup()`** — `src/main.ts:113` vs `:109`
The restructure fires `init()` from `onload()` (synchronously scheduled microtask) in parallel with the layout-ready-triggered `runPostLayoutStartup()`. Both call into the sidecar; with a missing sidecar, both independently throw `SidecarNotInstalledError` and both handle it — fine. With an installed sidecar, both will kick `ensureStarted()` concurrently. This relies on `SidecarProcess.start()` being idempotent (deduping concurrent starts). Worth confirming explicitly in `SidecarProcess`; if it spawns twice, you get duplicate processes.

**3. Silent CUDA-install half-failure** — `src/settings/settings-tab.ts:568-583`
On CUDA install success, `onInstalled` writes the new binary to disk, flips `accelerationPreference` to `'auto'`, then calls `restartSidecar()`. If the restart fails (CUDA binary can't load on this hardware after all), the user is left with a broken-but-picked-by-auto CUDA install, no rollback, and a "Failed to start" notice on every subsequent dictation. Suggest: on restart failure, either flip the preference back to `cpu_only` or prompt the user. At minimum, document the failure mode.

**4. `firstRunCompleted` semantic mismatch** — `src/main.ts:130-133`
The flag is set to `true` *before* the modal is opened, not after install completes. Misleading name — it's really "firstRunModalShown." Consider renaming, or move the flip into the modal's `onInstalled`/`onClose` so it reflects actual completion. Current behavior is fine; naming just invites future bugs.

**5. `handleUninstallCuda` still deletes after failed shutdown** — `src/settings/settings-tab.ts:586-616`
The hardening comment at 592-596 acknowledges the tradeoff: if shutdown fails because the process is alive-but-unresponsive on Windows, the subsequent `rm -rf` will hit EBUSY, which falls through to the outer catch. That's the best available option given the constraints, but note that between the failed shutdown and the failed rm, the sidecar is in an undefined state — it may or may not be alive. The user gets a toast and has to manually intervene. Acceptable; the comment is honest about the limitation.

---

## Code quality

- **`sidecar-installer.ts`** is clean and self-contained. Hand-rolled tar/zip is appropriately narrow: rejects symlinks/hardlinks/PAX/ZIP64/data-descriptor explicitly with loud errors (not silent drops), and `resolveArchiveMemberPath` correctly guards zip-slip including the `normalizedDest`-equals-`resolved` edge case. Progress throttling (256KB / 100ms) in the new `downloadToFile` version is a nice detail the diff didn't show.
- **`openHttpsStream`** redirect handling is correct: `res.resume()` on 3xx drains the body, then recurses with `hops + 1`, capped at `MAX_REDIRECTS`. Abort signal wiring handles both pre-abort and mid-request cases.
- **`SidecarNotInstalledError`** is thrown from exactly one line (`sidecar-paths.ts:78`) — the test at `test/sidecar-paths.test.ts:57` explicitly verifies that the override-missing path does NOT throw the sentinel, which is the critical invariant for the "don't show install modal on a misconfigured path" contract. Well-tested.
- **`detectPlatformAsset`** correctly rejects CUDA-on-macOS and Intel-Mac combinations at the type boundary. `detectPlatformAssetForCurrentEnv` just widens `process.platform` / `process.arch` — if Obsidian ever lands on an unsupported platform the cast fails open into the error path. Fine.
- **Workflow changes**: `env:` hoisted to job scope is the right fix; extending `env-vars:` with `GGML WHISPER` correctly busts cache on future toggles. The `find -printf '%P\n'` is GNU-only but runs on the Linux aggregator, so fine. `test -s dist/release/checksums.txt` catches an empty-result silent failure even without `pipefail`.
- **Comments**: the `env:` and `env-vars:` block in `release.yml:68-78,129-134` and the shutdown-before-delete rationale in `settings-tab.ts:592-596` are exactly the right places to leave paragraph-sized explanations. Good discipline.

---

## Test coverage

440 lines of installer tests + 72 gpu-precheck + controller additions + tightened sidecar-paths tests. Covers: platform asset dispatch, checksum parsing, manifest round-trip, happy-path install, checksum mismatch rollback, zip-slip rejection, Windows zip flow, uninstall idempotency, nvidia-smi present/absent/unknown/sync-throw, sidecar-missing sentinel vs generic errors.

Uncovered (manual-test only, per PR description): redirect-following, abort-during-download, post-install restart-failure rollback, large-file progress throttling. The checked boxes in the PR test plan match what CI can verify; unchecked items (CI-green, Windows/Linux GPU positive + negative) are the remaining manual gates before tag-push.

---

## Security

- Archive entries validated for path traversal on both tar.gz and zip paths, with both `resolved !== normalizedDest` and `startsWith(boundary)` checks covering the "`/dest/foo`/`/dest-evil`" sibling-prefix trap.
- Absolute path rejection in `resolveArchiveMemberPath` catches both POSIX absolute and Windows drive-letter forms.
- SHA256 verification is computed from bytes-as-read-from-network and compared against a published `checksums.txt`. HTTPS-to-github.com provides the trust anchor; no signing, but this matches the stated scope.
- `spawn('nvidia-smi', ['-L'], { stdio: 'ignore', windowsHide: true })` — arguments are fixed literals, no injection surface.

No new security concerns.

---

## Recommendation

**Approve.** Address (1) and (2) in this PR or a quick follow-up; (3)/(4)/(5) are good-to-have, not gating. Manual verification items from the PR test plan are the remaining risk — especially Windows CUDA positive + cuDNN-missing negative, since the 2026.4.21 regression was specifically a cuDNN-chain blindspot.
