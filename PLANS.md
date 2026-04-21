# Release Strategy A: Bundle-Light Plugin + Download-on-Demand Sidecar

## Progress

Release-workflow foundation is now implemented on branch `feat/release-workflow-foundation` in commit `a46a32f`.

Included in this foundation slice:

- recorder worklet bundled into `main.js` instead of shipping as a separate runtime asset
- sidecar path resolution updated to prefer installed `bin/cpu` / `bin/cuda` binaries, then fall back to dev builds
- release version validation added so `manifest.json`, `package.json`, `native/Cargo.toml`, and the Git tag stay aligned
- dedicated `release.yml` added, and the old ad hoc release-artifact jobs removed from `ci.yml`
- targeted tests added for sidecar path selection

How this fits:

- this is the prerequisite layer for the rest of the plan
- it makes the shipped plugin bundle self-contained and gives the installer work a stable runtime layout to target
- it does not yet implement sidecar download/install, first-run setup UX, or CUDA install/uninstall UX

## Context

The plugin currently resolves its Rust sidecar from `native/target/debug` or `native/target-cuda/debug` — purely dev paths. There is no installer, no tagged release workflow, and no way for an end user who installs the plugin from GitHub releases or the Obsidian community directory to actually obtain the sidecar binary.

Obsidian's community-directory update mechanism only fetches `main.js`, `manifest.json`, and `styles.css` from a GitHub release — any binaries or extra runtime assets stuffed into the release zip are ignored by the directory installer path. That forces a download-on-demand architecture for anything native and means the shipped plugin bundle itself must be self-contained aside from sidecar downloads.

Goal: produce a shippable plugin where users install the canonical Obsidian release bundle, get walked through a one-time CPU sidecar download on first launch, and can opt into a CUDA sidecar later on Windows/Linux. The recorder worklet must be bundled into `main.js`, not left as a separate runtime file. Binary swap must not require restarting Obsidian — the existing `SidecarConnection.restart()` already gives us that for free if we rework path resolution.

Explicit non-goals for this PR:
- Single-binary consolidation across CPU/CUDA (whisper-rs 0.16.x doesn't support runtime CUDA loading; investigation deferred).
- Code signing / Apple Developer ID notarization.
- Dropping the `native/target/debug` dev-mode resolution (contributors still need it).
- Pre-release tag support. Stable `x.y.z` tags only for v1; dry runs use `workflow_dispatch`, not beta tags.

## Release artifact shape

Per GitHub tag `<plugin-version>` (exactly matches `manifest.json`, `package.json`, and `native/Cargo.toml`), upload:

- `manifest.json`, `main.js`, `styles.css` — Obsidian community-directory distribution path. `main.js` includes the recorder worklet; there is no extra `assets/` runtime payload.
- `sidecar-macos-arm64.tar.gz` — Apple Silicon only; Metal is compile-time linked, no sibling libs. (Intel Mac dropped — CPU-only on pre-Metal hardware would be materially worse than Apple Silicon.)
- `sidecar-linux-x86_64-cpu.tar.gz`, `sidecar-linux-x86_64-cuda.tar.gz` — CUDA archive carries sibling `libonnxruntime_providers_{shared,cuda}.so`.
- `sidecar-windows-x86_64-cpu.zip`, `sidecar-windows-x86_64-cuda.zip` — CUDA zip carries sibling `onnxruntime_providers_{shared,cuda}.dll`.
- `checksums.txt` — SHA256 for each sidecar archive.
- Build provenance via `actions/attest-build-provenance`.

## Installed layout on disk

Inside `<vault>/.obsidian/plugins/local-transcript/`:

```
main.js
manifest.json
styles.css
bin/
  cpu/
    obsidian-local-stt-sidecar(.exe)
    install.json           # {version, variant: "cpu", sha256, installedAt}
  cuda/                    # only present if user installed GPU pack
    obsidian-local-stt-sidecar(.exe)
    platform-specific ONNX Runtime provider libraries when required
    install.json           # {version, variant: "cuda", sha256, installedAt}
```

`install.json` is the source of truth for what variant is installed at what version — avoids fs heuristics and lets the plugin prompt for reinstall only when the installed sidecar actually changed.

Plugin version and sidecar version stay the same for v1. Reinstall triggers on `manifest.version !== install.json.version`. Bump `manifest.json`, `package.json`, and `native/Cargo.toml` together. Update `versions.json` only when `minAppVersion` changes.

## Code changes

### 1. Inline the recorder worklet into `main.js`

- Replace the separate `assets/pcm-recorder.worklet.js` build output with an inlined worklet source inside the main bundle.
- Update `src/audio/audio-capture-stream.ts` to install the recorder worklet from in-memory source instead of reading a file from disk.
- Update `scripts/verify-build-output.mjs` to stop expecting a separate worklet artifact.

This keeps the Obsidian-installed bundle truly self-contained: canonical release files arrive from Obsidian/BRAT/manual install, and the plugin only has to fetch sidecar binaries after that.

### 2. New module: `src/sidecar/sidecar-installer.ts`

Responsibilities:
- `detectPlatformAsset(variant: 'cpu' | 'cuda'): { assetName, archiveKind }` — maps `(os, arch, variant)` to GitHub release asset filename; rejects unsupported combos (CUDA on macOS).
- `resolveReleaseUrl(version, assetName)` — uses `https://github.com/<owner>/<repo>/releases/download/<version>/<assetName>` plus a `checksums.txt` sibling.
- `downloadAsset(url, destPath, onProgress)` — Node `https` stream to disk; reports bytes/total for the progress UI.
- `verifyChecksum(filePath, expectedSha256)` — `node:crypto` SHA256 over the archive; fails loudly on mismatch.
- `extractArchive(archivePath, destDir, kind)` — tar.gz via `zlib` + custom USTAR reader on POSIX; zip via a small extractor on Windows. Keep archive handling minimal and test it hard.
- `markExecutable(path)` — `chmod 0o755` on POSIX; no-op on Windows.
- `installSidecar({ variant, version, pluginDir, onProgress }): Promise<InstallResult>` — orchestrates the above, writes `install.json` last so partial installs don't register as complete.
- `readInstallManifest(dir): InstallManifest | null`.

Reuse: `src/filesystem/path-validation.ts` for path hygiene; `src/shared/plugin-logger.ts` for structured logs.

### 3. Rework `src/main.ts` path resolution

Replace `resolveSidecarExecutablePath()` logic (`src/main.ts:223-259`) with ordered lookup:

1. `settings.sidecarPathOverride` — unchanged.
2. Installed binary under `<plugin-dir>/bin/{variant}/` — variant determined by `pickRuntimeVariant(settings, installedVariants)`:
   - If `accelerationPreference === 'cpu_only'` → `cpu`.
   - Else if CUDA variant is installed and platform supports it → `cuda`.
   - Else → `cpu`.
3. Dev fallback: `native/target-cuda/debug/` (if present and not mac), then `native/target/debug/`.

The current CUDA auto-preference at `src/main.ts:235-242` moves into `pickRuntimeVariant()`. Keep `assertSidecarExecutableIsFresh` only for the dev fallback path — installed binaries don't have a `Cargo.toml` mtime to compare against.

### 4. First-launch UX

New module `src/setup/first-run-setup-modal.ts`:
- Registered during `src/main.ts:onload`, but actually triggered from `workspace.onLayoutReady()` when `readInstallManifest(bin/cpu)` returns null AND no override is set AND no dev-build binary is present.
- Obsidian-native `Modal` (D-005) with: description of what will happen, byte count, target URL, "Download CPU sidecar" primary button, "Later" secondary.
- Drives `installSidecar({ variant: 'cpu', version: manifest.version })` with a progress bar and error surface.
- On success, kicks `SidecarConnection.start()`.

Non-goal: automatic/silent first-run downloads — user must click through, consistent with the privacy model and with Obsidian's startup guidance to keep heavy work out of `onload()`.

### 5. Hardware acceleration toggle (Windows/Linux)

In `src/settings/settings-tab.ts`, extend the acceleration section (currently around `settings-tab.ts:367-388`):

- Show installed variants + current runtime variant.
- On Windows/Linux only: "Install CUDA acceleration" button. Confirms via dialog (includes archive size), runs `installSidecar({ variant: 'cuda', version: manifest.version })`, then flips `accelerationPreference` to `auto` and calls `restartSidecar()`. No Obsidian restart.
- Before offering the download, run a cheap compatibility precheck: look for `nvidia-smi` on `PATH` (Windows: `where nvidia-smi`; Linux: `which nvidia-smi`). If absent, disable the button and show "No NVIDIA driver detected — CUDA download not offered." Prevents a wasted large download for users without NVIDIA hardware. A manual-override link ("Install anyway") remains for edge cases.
- On macOS: Metal is compile-time linked in the single Mac binary; no install step, toggle auto-enables when the binary is present. Describe this explicitly in the UI copy.
- Add an "Uninstall GPU acceleration" action that deletes `bin/cuda/` and restarts the sidecar onto CPU.

Reuse: `describeAcceleration()` in `src/settings/acceleration-info.ts` for the current status string.

New module `src/sidecar/gpu-precheck.ts`: `detectNvidiaDriver(): Promise<'present' | 'absent' | 'unknown'>` — spawns `nvidia-smi -L` with a short timeout; returns `present` on exit 0, `absent` on ENOENT, `unknown` on other errors.

### 6. Durable docs update

Update whichever durable docs remain in use (`docs/decisions.md`, `docs/architecture/platform-runtime-dependencies.md`, README install notes) so they match the final release model:

- Obsidian/BRAT/manual install provides only the canonical release files.
- The plugin fetches the sidecar on demand from GitHub releases.
- The recorder worklet is bundled into `main.js`.
- Plugin version and sidecar version are the same for v1.

### 7. Release workflow

New `.github/workflows/release.yml` supports two modes:

- `workflow_dispatch` dry run — builds and packages the full release set, uploads workflow artifacts, but does not publish a GitHub release.
- tag push for exact version tags (`1.2.3` style, no `v` prefix) — builds and packages the same artifacts, then publishes the GitHub release.

- Job matrix: `macos-arm64`, `linux-x86_64-cpu`, `linux-x86_64-cuda`, `windows-x86_64-cpu`, `windows-x86_64-cuda`.
- Each job builds the sidecar, packages the tar.gz/zip, emits a per-artifact SHA256.
- Final aggregator job downloads all artifacts, writes `checksums.txt`, bundles the plugin, runs the updated release verification path, and then:
  - in dry-run mode, uploads canonical plugin files + sidecar archives + `checksums.txt` as workflow artifacts only
  - in tag mode, calls `softprops/action-gh-release@v2` to create the GitHub release with all assets attached
- `actions/attest-build-provenance@v2` on each native artifact.

Repurpose the existing `build-release-*` jobs in `.github/workflows/ci.yml` — lift their steps into the new workflow. Add the missing `linux-x86_64-cuda` lane. Keep at least one manual release-style verification path in CI before deleting the old release lanes.

### 8. README + submission checklist

- Document the first-run download flow and the GitHub release URL.
- Document BRAT as the install path pre-directory-approval: users install the BRAT community plugin, then add `<owner>/<repo>` to BRAT's beta list. BRAT fetches `main.js` + `manifest.json` + `styles.css` from the latest tagged release into `<vault>/.obsidian/plugins/local-transcript/`; our plugin's own download-on-demand code then handles the sidecar exactly as it would post-approval.
- Document manual install as a fallback: download the 3 files from the GitHub release page, drop them in `<vault>/.obsidian/plugins/local-transcript/`, enable the plugin. Same download-on-demand flow takes over from there.
- Update `versions.json` if and only if `minAppVersion` changes.
- Prepare the PR to `obsidianmd/obsidian-releases` in parallel — review is slow.

## Critical files

- `src/audio/audio-capture-stream.ts` (switch worklet installation from disk file to inlined source)
- `esbuild.config.mjs` (remove separate worklet output; bundle it into `main.js`)
- `scripts/verify-build-output.mjs` (update release verification expectations)
- `src/main.ts` (path resolver at 204-259)
- `src/sidecar/sidecar-connection.ts` (`restart()` at 255; already wired to `src/main.ts:167`)
- `src/sidecar/sidecar-process.ts` (no changes expected; launch spec is already re-resolved per start)
- `src/settings/settings-tab.ts` (acceleration section at 367-388)
- `src/settings/plugin-settings.ts` (existing `accelerationPreference`, `sidecarPathOverride`, `cudaLibraryPath`)
- `src/settings/acceleration-info.ts` (`describeAcceleration` for status strings)
- `.github/workflows/ci.yml` (lift `build-release-*` jobs → delete here, recreate in release.yml)
- `docs/decisions.md`, `docs/architecture/platform-runtime-dependencies.md` (only if retained as durable release-model docs)
- `manifest.json`, `package.json`, `native/Cargo.toml` (single shared version)
- `versions.json`

## New files

- `src/sidecar/sidecar-installer.ts`
- `src/sidecar/gpu-precheck.ts`
- `src/setup/first-run-setup-modal.ts`
- `.github/workflows/release.yml`

## Verification

Dev-loop:
1. `npm run check` — full type/lint/test/build passes.
2. Trigger `release.yml` via `workflow_dispatch` in a fork/branch, confirm it produces the canonical plugin files, all six platform archives, and `checksums.txt` without publishing a release.
3. Wipe `<vault>/.obsidian/plugins/local-transcript/bin/` locally, delete dev-build output, launch Obsidian → confirm first-run modal appears after layout is ready, CPU download succeeds, sidecar starts, health probe returns ok.
4. On Windows and Linux native: click "Install CUDA acceleration" → confirm CUDA archive downloads to `bin/cuda/`, sidecar hot-swaps to the GPU variant without restarting Obsidian, and `system_info` reports CUDA as available.
5. On Linux Flatpak: confirm the first-run CPU download flow works; confirm the documented GPU path still works with Flatpak overrides and sidecar-scoped `CUDA library path`.
6. On Windows/Linux: flip `accelerationPreference` to `cpu_only` → confirm sidecar hot-swaps back to `bin/cpu/` without Obsidian restart.
7. Corrupt a `checksums.txt` entry in the dry-run artifacts → confirm installer fails verification and does not write `install.json`.
8. `npm run test` — add unit/integration tests for `detectPlatformAsset`, `pickRuntimeVariant`, `readInstallManifest`, archive extraction, checksum mismatch, partial-install rollback, and path-traversal rejection.
9. Install via BRAT into a clean vault and confirm the real user path works end to end: canonical files land first, then the plugin fetches the sidecar on first launch.
