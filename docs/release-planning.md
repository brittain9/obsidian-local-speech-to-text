# Release Planning

Status: Shelved — reference material for future distribution work.

Tracked follow-up: see `Sidecar distribution strategy for community-plugin releases (CPU/CUDA packaging, binary selection, updates, CUDA licensing)` in [tasks/backlog.md](../tasks/backlog.md).

## CI runner migration

The macOS release pipeline migration to `macos-15` is complete. Keep `macos-15` as the Apple Silicon release target for Metal builds; these notes are retained only as rationale for future distribution work.

## Ship arm64-only on macOS

Apple Silicon is the dominant active Mac base, and Metal GPU acceleration is only meaningful there. An x86_64 build would be CPU-only and materially worse for the product.

Building a universal binary with whisper.cpp + Metal is also costly: separate builds per architecture, no `gpu-metal` in the x86_64 build, then `lipo -create` to merge. That doubles build complexity for a shrinking target.

Intel users who need the plugin can use `sidecarPathOverride` with a manually built CPU-only binary. If x86_64 demand becomes real, add a separate `macos-15-intel` CI job that builds `engine-cohere` without Metal and uploads `sidecar-darwin-x64`.

## Code signing and notarization

Starting with macOS Sequoia 15.1, unsigned downloaded binaries face stricter Gatekeeper friction. When Obsidian spawns the sidecar via `child_process.spawn()`, Gatekeeper evaluates the sidecar binary independently.

| Tier | Method | Cost | Gatekeeper behavior |
|---|---|---|---|
| 1 | Ad-hoc (`codesign --force --sign -`) | Free | Prevents "damaged binary" errors for non-quarantined copies. Does not pass Gatekeeper for quarantined binaries. |
| 2 | Developer ID signing | $99/year | Passes Gatekeeper if also notarized. |
| 3 | Developer ID + notarization | $99/year | Silent Gatekeeper pass. Preferred end state. |

Short-term path: ad-hoc sign in CI. If the plugin ever downloads the sidecar at runtime, it must also strip the quarantine attribute after download.

Long-term path: use an Apple Developer ID certificate, sign with hardened runtime, and notarize with `xcrun notarytool`.

CI signing workflow sketch:

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

## Sidecar distribution

The current `resolveSidecarExecutablePath()` implementation only resolves the dev path `native/sidecar/target/debug/`. Release distribution needs a packaged lookup path.

Recommended binary layout:

```text
<plugin-dir>/
  main.js
  manifest.json
  styles.css
  bin/
    sidecar-darwin-arm64
    sidecar-linux-x64
    sidecar-win32-x64.exe
```

Naming convention: align with Node.js `process.platform` + `process.arch` for direct runtime lookup.

| Platform | Binary name |
|---|---|
| macOS ARM | `sidecar-darwin-arm64` |
| macOS Intel | `sidecar-darwin-x64` |
| Linux x86_64 | `sidecar-linux-x64` |
| Windows x86_64 | `sidecar-win32-x64.exe` |

Resolution order: `sidecarPathOverride` > `bin/sidecar-{platform}-{arch}` > dev-mode `native/sidecar/target/debug/`.

## References

- [macos-15-intel availability (actions/runner-images#13045)](https://github.com/actions/runner-images/issues/13045)
- [Apple Sequoia signing enforcement](https://hackaday.com/2024/11/01/apple-forces-the-signing-of-applications-in-macos-sequoia-15-1/)
- [Gatekeeper quarantine issue (openai/codex#5787)](https://github.com/openai/codex/issues/5787)
- [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)
- [obsidian-mcp-tools native binary distribution](https://github.com/jacksteamdev/obsidian-mcp-tools)
