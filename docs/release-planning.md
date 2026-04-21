# Release Planning

Status: Active. This document plans the first public release and the path to Obsidian community-plugin submission. Supersedes `docs/archive/release-planning.md`.

## Scope

- Ship a working public v1 to users who don't have Rust, CMake, or CUDA SDKs.
- Support three OSes (macOS arm64, Linux x64, Windows x64) with optional CUDA variants on Linux/Windows.
- Submit to `obsidianmd/obsidian-releases` once the end-to-end install flow works on all three OSes.
- Support ongoing sidecar updates independently of the Obsidian plugin auto-update cadence.

## The Distribution Constraint

The Obsidian community-plugin store only ever delivers `main.js`, `manifest.json`, and `styles.css` to users. Any other file in a release zip is invisible to the installer. This is the single fact that shapes everything below.

Implication: the sidecar binary and its provider DLLs **cannot** be distributed through the community-plugin pipe. They must be fetched from our own GitHub Releases by the plugin on first activation. This is a hard constraint, not a design choice.

Canonical precedent: [`jacksteamdev/obsidian-mcp-tools`](https://github.com/jacksteamdev/obsidian-mcp-tools) — TS plugin + Rust sidecar, version-locked runtime download, progress UI, decoupled sidecar-update button. Mirror this pattern.

## Release Artifacts

Single source of truth: a GitHub Release per `manifest.version`, tagged `v<version>`, with these assets:

| Asset | Host | Contents |
|---|---|---|
| `sidecar-darwin-arm64` | macOS arm64 | Metal-enabled binary (Whisper Metal + Cohere CPU) |
| `sidecar-linux-x64` | Linux x64 | CPU binary (Whisper CPU + Cohere CPU) |
| `sidecar-linux-x64-cuda.tar.gz` | Linux x64 | CUDA binary + `libonnxruntime_providers_shared.so` + `libonnxruntime_providers_cuda.so` |
| `sidecar-win32-x64.exe` | Windows x64 | CPU binary |
| `sidecar-win32-x64-cuda.zip` | Windows x64 | CUDA exe + `onnxruntime_providers_shared.dll` + `onnxruntime_providers_cuda.dll` |
| `checksums.txt` | — | SHA-256 of every artifact |
| `main.js`, `manifest.json`, `styles.css` | — | Plugin bundle (what Obsidian actually downloads) |

Naming convention: Node.js `process.platform`-`process.arch`. The plugin does `` `sidecar-${process.platform}-${process.arch}` `` and fetches directly — no mapping table. Current CI uses `macos`/`windows`/`linux` and `uname -m` (`x86_64`); this must change to `darwin`/`win32`/`linux` and `x64` for lookup to work without a translation layer.

Deferred: `darwin-x64`, `linux-arm64`, `win32-arm64`. Add a runner only if a real user asks.

## Versioning

Lockstep: the sidecar git tag equals `manifest.version`. The sidecar reports its own version via the `system_info` protocol message. On startup, the plugin compares `system_info.sidecarVersion` against `manifest.version`. Mismatch surfaces an "Update sidecar" button in settings.

No protocol-version field yet (consistent with D-013 — no versioning/migration dead weight until a real installed user base exists). Revisit once we ship a plugin update that must work with an older sidecar.

Checksums: CI generates `checksums.txt` at release time. The expected hash for each platform is embedded into `main.js` at build time via `esbuild` `define` injection, keyed by the git tag being built. Download flow verifies SHA-256 before executing.

## Update Mechanism

Two tracks, decoupled:

1. **Plugin updates** flow through Obsidian's community-plugin auto-update. Only `main.js`/`manifest.json`/`styles.css` are replaced.
2. **Sidecar updates** are plugin-driven. On startup or on a manual "Check for update" button, the plugin compares installed sidecar version to `manifest.version` and prompts the user to download the matching release asset.

When the user updates the plugin to a new version with a pinned sidecar hash, the next launch detects the mismatch and offers the download. This means a plugin update without a matching sidecar download leaves a functional but outdated sidecar — acceptable.

## Binary Storage Location

**Decision:** Store the sidecar and its provider libraries under `app.getPath('userData')/local-transcript/bin/<version>/`, not inside the plugin folder.

Rationale:
- Survives plugin uninstall/reinstall. A multi-hundred-MB CUDA download should not be wasted on a UI disable/re-enable.
- Shared across vaults on the same user account.
- Keeps the vault clean and backup-friendly.

Trade-off: `process.platform === 'darwin'` uses `~/Library/Application Support/obsidian/local-transcript/`, Linux uses `~/.config/obsidian/local-transcript/`, Windows uses `%APPDATA%\obsidian\local-transcript\`. Document these in the README for users who need to clean up.

Resolution order in `resolveSidecarExecutablePath()`:
1. `sidecarPathOverride` (advanced setting, unchanged)
2. `userData/local-transcript/bin/<manifest.version>/<binary-name>`
3. Dev-mode `native/target/{debug,release}/` (unchanged)

If (2) is missing, the plugin shows a blocking setup modal that triggers the download flow.

## GPU Variant UX

CPU is the default on every platform. CUDA is a second, opt-in download.

1. On first activation, download CPU flavor automatically (small, ~30 MB).
2. On Linux/Windows, run an NVIDIA probe (`nvidia-smi` or registry check). If positive, show a non-blocking card in settings: "GPU acceleration available. Download CUDA sidecar (~450 MB)."
3. User opts in explicitly. Download into `userData/local-transcript/bin/<version>-cuda/`.
4. Settings acceleration preference (`auto`/`cpu`/`cuda`) selects which binary to spawn.

Never auto-download the CUDA variant. Never force-prompt — use the acceleration card that already exists in settings.

macOS ships one binary (Metal + CPU combined). No second download.

## macOS Signing

Starting with macOS Sequoia 15.1, unsigned downloaded binaries face stricter Gatekeeper friction. Obsidian spawns the sidecar via `child_process.spawn()`, which changes the threat model somewhat — Gatekeeper evaluates the sidecar independently, but subprocess spawns get less aggressive prompting than user-launched apps.

| Tier | Method | Cost | Gatekeeper behavior |
|---|---|---|---|
| 1 | Ad-hoc (`codesign --force --sign -`) | Free | Prevents "damaged binary" errors for non-quarantined copies. Does not pass Gatekeeper for quarantined binaries. |
| 2 | Developer ID signing | $99/year | Passes Gatekeeper if also notarized. |
| 3 | Developer ID + notarization | $99/year | Silent Gatekeeper pass. Preferred end state. |

**V1 plan:** ship ad-hoc signed (tier 1). After the plugin downloads the binary, strip the quarantine attribute with `xattr -d com.apple.quarantine` before the first spawn. Revisit tier 3 if user reports show consistent Gatekeeper blocks.

Long-term (tier 3) CI signing sketch, kept for when we're ready:

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
      --sign "Developer ID Application: Name (TEAMID)" dist/sidecar-darwin-arm64

- name: Notarize macOS binary
  run: |
    xcrun notarytool submit dist/sidecar-darwin-arm64 \
      --apple-id "$APPLE_ID" --team-id "$TEAM_ID" \
      --password "$APP_PASSWORD" --wait
```

## CI & Release Workflow

Current state (`.github/workflows/ci.yml`):
- Quality gate runs on every push/PR across Linux/Windows/macOS.
- Release artifacts run only on `workflow_dispatch` and upload to GitHub Actions artifacts (not GitHub Releases).
- Linux CUDA release is still manual.

Gaps to close before v1:

1. **`release.yml` triggered by `v*` tag push.** Builds all 5 variants, generates `checksums.txt`, creates a GitHub Release with all assets attached. This replaces the `workflow_dispatch` lanes for actual releases; keep `workflow_dispatch` for manual dry-runs.
2. **Linux CUDA build lane in CI.** Already exists for Windows; add the Linux equivalent using the same `build-cuda.sh` path.
3. **Rename artifacts to Node.js conventions.** `sidecar-darwin-arm64`, `sidecar-linux-x64`, `sidecar-win32-x64.exe`. See Release Artifacts table above.
4. **Checksum manifest generation and build-time injection.** CI writes `checksums.txt`; `esbuild` reads and injects them into `main.js` via `define`.
5. **Attach `main.js`/`manifest.json`/`styles.css` to the release.** Community plugin installer fetches these three files by release tag.

The existing quality-gate workflow stays as-is.

## Submission to obsidian-releases

Prerequisites before opening the submission PR:

- End-to-end install flow works on all three OSes (fresh user activates plugin → sees download prompt → sidecar downloads → transcription works).
- Release disclosure in README: what gets downloaded, from where, how much, where it's stored, how to remove it.
- User-visible confirmation before first download.
- SHA-256 verification of the downloaded asset.
- Graceful offline/proxy behavior.
- Manual "install binary from local file" fallback in settings (covers air-gapped and corporate-proxy users — this is our answer to the "installer script" question).
- BRAT beta run with a handful of real users, at minimum one per OS.

Timeline: reviewer queue is 1–6 weeks in 2026. No SLA. Bot feedback is instant; rescan on push within ~6 hours. Iterate in parallel once the PR is open.

Common rejection reasons to pre-empt: `id`/`name` containing "obsidian" or "plugin", missing LICENSE, tag format (`1.0.0`, not `v1.0.0`) — wait, this conflicts with lockstep `v<version>` sidecar tags. Reconcile: plugin release tag is `<version>` (e.g., `2026.4.20`) per obsidian-releases policy; the sidecar binaries ship on the same release. Don't use a leading `v`.

## Order of Work

1. **Land the Windows CI PR.** Already in flight.
2. **Write `release.yml`** triggered by tag push, covering all 5 variants + checksum manifest + GitHub Release creation. Rename artifacts to Node.js conventions.
3. **Sidecar download module in the plugin.** Platform-triple detection, fetch from Release by `manifest.version` tag, SHA-256 check, progress UI, unpack to `userData/local-transcript/bin/<version>/`. Add the "install from local file" fallback at the same time.
4. **CUDA opt-in flow.** Wire the existing acceleration-card UI to the download module; add the NVIDIA probe.
5. **Update README.** Replace the "clone into vault" dev instruction as the only path with a user-facing "enable and follow prompts" section; keep the dev setup for contributors.
6. **BRAT beta.** Tag an early version, announce for BRAT. Gather feedback on the install flow specifically.
7. **Submit to obsidian-releases.** In parallel with continued BRAT iteration.

## Open Decisions

- **Compression for CUDA bundles.** `tar.gz` on Linux, `zip` on Windows — simplest. Alternative: single `zstd` everywhere. Lean simplest for v1.
- **Architecture support.** arm64 Linux and arm64 Windows are deferred. Apple Silicon only on macOS (archive rationale preserved: x86_64 Mac would be CPU-only and materially worse). Revisit per real demand.
- **Model download vs sidecar download consolidation.** Models already download on demand. Sidecar download becomes a similar flow. Whether they share infra (progress UI, cancel/resume, checksums) or stay separate is a design question for the download module step.
- **Where to store the checksums pin.** In `main.js` at build time (simpler, requires plugin rebuild on checksum change) vs fetched from a signed manifest at runtime (more flexible, adds an extra network call and a trust anchor). V1: pin at build time.
- **CUDA variant lockstep vs lag.** If a CUDA toolkit bump breaks the build, does the CPU release ship alone with CUDA disabled for that version? Lean "ship together or not at all" for v1 — simpler update logic, fewer edge cases.

## References

- [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
- [Submit your plugin — Obsidian Developer Docs](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools) — canonical precedent
- [rust-analyzer bootstrap.ts](https://github.com/rust-lang/rust-analyzer/blob/master/editors/code/src/bootstrap.ts)
- [TfTHacker/obsidian42-brat](https://github.com/TfTHacker/obsidian42-brat) — beta distribution
- [macos-15-intel availability (actions/runner-images#13045)](https://github.com/actions/runner-images/issues/13045)
- [Apple Sequoia signing enforcement](https://hackaday.com/2024/11/01/apple-forces-the-signing-of-applications-in-macos-sequoia-15-1/)
- [Gatekeeper quarantine issue (openai/codex#5787)](https://github.com/openai/codex/issues/5787)
- [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)
- [`docs/architecture/platform-runtime-dependencies.md`](architecture/platform-runtime-dependencies.md) — per-platform runtime contract
- [`docs/decisions.md`](decisions.md) — D-001, D-003, D-011, D-012, D-013
