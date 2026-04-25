# Release Readiness

Status: Active. This document tracks remaining release work for the first public release and Obsidian community-plugin submission.

## Distribution Contract

The Obsidian community-plugin store delivers only:

- `main.js`
- `manifest.json`
- `styles.css`

The native sidecar, provider libraries, CUDA runtime libraries, and bundled model catalog are installed by the plugin from the GitHub Release matching `manifest.version`. Sidecar archives are version-locked to the plugin version and verified with the release's `checksums.txt`.

## Release Artifacts

Single source of truth: a GitHub Release per `manifest.version`, tagged exactly `<manifest.version>` with no leading `v` (for example, `2026.4.25`).

| Asset | Host | Contents |
|---|---|---|
| `sidecar-macos-arm64.tar.gz` | macOS arm64 | `local-transcript-sidecar` with Whisper Metal + Cohere CPU |
| `sidecar-linux-x86_64-cpu.tar.gz` | Linux x86_64 | `local-transcript-sidecar` CPU binary |
| `sidecar-linux-x86_64-cuda.tar.gz` | Linux x86_64 | `local-transcript-sidecar` CUDA binary + ONNX Runtime CUDA provider libraries + bundled CUDA runtime libraries |
| `sidecar-windows-x86_64-cpu.zip` | Windows x86_64 | `local-transcript-sidecar.exe` CPU binary |
| `sidecar-windows-x86_64-cuda.zip` | Windows x86_64 | `local-transcript-sidecar.exe` CUDA binary + ONNX Runtime CUDA provider libraries + bundled CUDA runtime libraries |
| `checksums.txt` | - | SHA-256 of every sidecar archive, exactly five lines, sorted |
| `main.js`, `manifest.json`, `styles.css` | - | Plugin files for manual release install and Obsidian community-plugin ingestion |

Release archive names stay `sidecar-<platform>-<arch>-<flavor>.<ext>` even though the executable inside them is named `local-transcript-sidecar`.

Deferred: macOS x86_64, Linux arm64, Windows arm64. Add a runner only if real user demand appears.

## Versioning And Install Layout

The sidecar git tag equals `manifest.version`. The sidecar reports its own version via `system_info`; the plugin compares `system_info.sidecarVersion` against `manifest.version` and offers to install the matching sidecar when they differ.

The installer fetches `checksums.txt` at runtime alongside the selected sidecar archive and verifies the downloaded archive's SHA-256 before unpacking. Checksums are not embedded into `main.js`; the release manifest remains authoritative.

Installed sidecars live under the plugin directory:

- CPU: `<vault>/.obsidian/plugins/local-transcript/bin/cpu/`
- CUDA: `<vault>/.obsidian/plugins/local-transcript/bin/cuda/`

Resolution order in `resolveSidecarExecutablePath()`:

1. `sidecarPathOverride`
2. plugin-local `bin/cpu` or `bin/cuda`, selected by acceleration preference and host support
3. dev-mode `native/target/debug` or `native/target-cuda/debug`

CPU is the default sidecar. CUDA is a second, opt-in install on Linux and Windows. macOS ships one Metal-capable sidecar.

## Runtime Constraints

- Linux/Windows CUDA release builds target Turing-or-newer NVIDIA GPUs with `CMAKE_CUDA_ARCHITECTURES=75-virtual`.
- Release jobs set `GGML_NATIVE=OFF` at workflow scope so sidecars do not inherit runner-only SIMD such as AVX-512.
- CUDA build logs are bounded with `CMAKE_CUDA_FLAGS=-t0`; `CARGO_TIMINGS=1` keeps timing diagnostics available without full verbose logs.
- CUDA archives bundle reviewed CUDA runtime libraries declared in `native/cuda-artifacts.json`.
- cuDNN 9.x remains host-provided for Cohere CUDA until redistribution is reviewed.

## macOS Signing

Current release path: ad-hoc sign the macOS sidecar before packaging.

Long-term Developer ID signing and notarization sketch, kept for when the project is ready:

```yaml
- name: Sign macOS binary
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE_P12_BASE64 }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
  run: |
    echo "$APPLE_CERTIFICATE" | base64 --decode > certificate.p12
    security create-keychain -p "" build.keychain
    security import certificate.p12 -k build.keychain \
      -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -s -k "" build.keychain
    codesign --force --options runtime \
      --sign "Developer ID Application: Name (TEAMID)" native/target/release/local-transcript-sidecar

- name: Notarize macOS binary
  run: |
    xcrun notarytool submit dist/sidecar-macos-arm64.tar.gz \
      --apple-id "$APPLE_ID" --team-id "$TEAM_ID" \
      --password "$APP_PASSWORD" --wait
```

## Current CI And Release Workflow

- `.github/workflows/ci.yml`: split into `frontend-quality` (Linux only, runs `npm run check:frontend`) and `sidecar-quality` (Linux/Windows/macOS-15, runs `npm run build:sidecar` then `npm run check:rust`). Shared setup lives in composite actions under `.github/actions/setup-node-npm` and `.github/actions/setup-sidecar-rust`.
- `.github/workflows/release.yml`: triggered by a date-version tag push matching `manifest.version` exactly and by `workflow_dispatch` for dry-runs. Tag-triggered runs publish a GitHub Release with the five sidecar archives, the three plugin files, and `checksums.txt`. Dry-runs upload an Actions artifact `release-<version>`.

Release gating:

1. `metadata` resolves and validates the version with `scripts/read-release-version.mjs`.
2. `plugin-bundle` runs `npm run check:frontend` and uploads `main.js`, `manifest.json`, and `styles.css`.
3. `native-quality` runs `npm run check:rust` against a fresh sidecar build.
4. `build-sidecar-posix` and `build-sidecar-windows` produce signed-and-attested sidecar archives.
5. `publish` runs `node scripts/assemble-release-files.mjs`, rejecting missing, empty, duplicated, or unexpected sidecar archives and generating deterministic `checksums.txt`.

Top-level `release.yml` permissions are `contents: read`; only `publish` carries `contents: write`. CI workflow permissions remain `contents: read`.

## Remaining Work

- End-to-end install verification on macOS, Linux native, Linux Flatpak, and Windows.
- User-visible disclosure in README for what gets downloaded, from where, how large it is, where it is stored, and how to remove it.
- Graceful offline/proxy failure behavior review.
- Manual "install sidecar from local file" fallback in settings for air-gapped and corporate-proxy users.
- BRAT beta with real users, at minimum one per OS.
- Submit to `obsidianmd/obsidian-releases` after the install flow is verified.

Common rejection reasons to pre-empt: `id`/`name` containing "obsidian" or "plugin", missing LICENSE, and leading-`v` tag names. This project uses date-version tags matching `<manifest.version>` exactly and the sidecar binaries ship on the same release.

## References

- [Platform Runtime Dependencies](platform-runtime-dependencies.md)
- [System Architecture](../system-architecture.md)
- [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
- [Submit your plugin - Obsidian Developer Docs](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools)
- [TfTHacker/obsidian42-brat](https://github.com/TfTHacker/obsidian42-brat)
