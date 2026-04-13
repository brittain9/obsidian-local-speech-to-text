# macOS Build, Release, and GPU Notes

## Cohere on CoreML/Metal — Not Viable

The `ort` crate (2.0.0-rc.12) defines a `coreml` feature flag, but three independent blockers make it impractical for Cohere Transcribe on macOS.

### No prebuilt CoreML binaries

The `ort` crate's `download-binaries` feature only ships `none` (CPU) and `wgpu` variants for macOS aarch64. There is no CoreML prebuilt. Getting CoreML requires building ONNX Runtime from source with `--use_coreml` and setting `ORT_LIB_PATH` to the custom build. This adds Xcode, CMake 3.28+, and macOS 12+ as hard build requirements and breaks the current zero-config `download-binaries` workflow.

### Dynamic shapes kill CoreML performance

The Cohere decoder uses `past_key_values` with dynamic sequence lengths — the KV cache grows each autoregressive step. CoreML handles dynamic shapes poorly:

- Many nodes fall back to CPU (reported 201 unsupported nodes in similar transformer architectures).
- Excessive graph partitioning with as low as 25% CoreML coverage.
- Constant CPU-GPU data transfer overhead makes it slower than pure CPU.

Autoregressive decoding is the worst case for CoreML, which performs best with static, batched workloads.

### Operator coverage gaps

The Cohere decoder uses GroupQueryAttention with `attention_bias`. This operator is already forced to CPU on CUDA (`cohere.rs:195`) because ORT's CUDA kernel doesn't support it. CoreML has the same limitation. Only the encoder could theoretically benefit, but the build complexity is disproportionate to the gain for one model component.

### Conclusion

Whisper+Metal is the macOS GPU path. Cohere runs CPU-only on all platforms. If Cohere CPU performance becomes an issue, the first optimization target should be quantized models (int8/q4) rather than CoreML — those work with `download-binaries` and benefit all platforms. This confirms D-017.

### References

- [ort crate feature flags](https://lib.rs/crates/ort/features)
- [ONNX Runtime CoreML EP docs](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [CoreML dynamic shape issues (onnxruntime#14212)](https://github.com/microsoft/onnxruntime/issues/14212)
- [CoreML transformer coverage (onnxruntime#19887)](https://github.com/microsoft/onnxruntime/issues/19887)
- [ort linking strategies](https://ort.pyke.io/setup/linking)

---

## macOS Release Pipeline

### CI runner migration

The `macos-14` runner begins deprecation on July 6, 2025 and is fully unsupported by November 2, 2025. Migrate to `macos-15` — same ARM64 Apple Silicon, same Metal framework availability, Xcode 16.4 default. `macos-latest` will point to `macos-15` as of August 2025.

### Ship arm64-only

Apple Silicon accounts for ~85% of active Macs (late 2025). macOS 27 (2026) drops Intel entirely. Metal GPU acceleration only works on Apple Silicon — an x86_64 build would be CPU-only, a meaningfully worse product.

Building a universal binary with whisper.cpp + Metal is non-trivial: separate builds for each architecture, the x86_64 build must exclude `gpu-metal`, and `lipo -create` to merge. This doubles build time for a shrinking user base.

Intel users who need this plugin can use the `sidecarPathOverride` setting with a manually built CPU-only binary. If x86_64 demand materializes, add a separate CI job on `macos-15-intel` (available until August 2027) building with `engine-cohere` only (no Metal), uploading as `sidecar-darwin-x64`.

### Code signing and notarization

Starting with macOS Sequoia 15.1, Apple eliminated the easy Control-click bypass for unsigned downloaded software. Users must navigate to System Settings > Privacy & Security to manually approve unsigned binaries.

When Obsidian spawns the sidecar via `child_process.spawn()`, Gatekeeper evaluates the sidecar binary independently. If downloaded from the internet, macOS applies the `com.apple.quarantine` extended attribute and blocks execution of unsigned quarantined binaries.

**Signing tiers (in order of effort and UX quality):**

| Tier | Method | Cost | Gatekeeper behavior |
|------|--------|------|---------------------|
| 1 | Ad-hoc (`codesign --force --sign -`) | Free | Prevents "damaged binary" error for non-quarantined copies. Does NOT pass Gatekeeper for quarantined binaries. |
| 2 | Developer ID signing | $99/year | Passes Gatekeeper if also notarized. |
| 3 | Developer ID + notarization | $99/year | Silent Gatekeeper pass. Gold standard. |

**Short-term path:** Ad-hoc sign in CI. If the plugin downloads the sidecar at runtime, strip the quarantine attribute programmatically after download (`xattr -d com.apple.quarantine <path>`).

**Long-term path:** Apple Developer ID certificate ($99/year), sign with hardened runtime, notarize via `xcrun notarytool`. This is the only path to frictionless macOS UX on Sequoia+.

CI signing workflow sketch (for when the certificate is available):

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

### Sidecar distribution

The current `resolveSidecarExecutablePath()` (`main.ts:245-275`) only resolves against the dev path `native/sidecar/target/debug/`. For release distribution, the plugin needs a release-mode resolution path.

**Recommended binary layout:**

```
<plugin-dir>/
  main.js
  manifest.json
  styles.css
  bin/
    sidecar-darwin-arm64
    sidecar-linux-x64
    sidecar-win32-x64.exe
```

**Naming convention:** Align with Node.js `process.platform` + `process.arch` for direct runtime lookup:

| Platform | Binary name |
|----------|-------------|
| macOS ARM | `sidecar-darwin-arm64` |
| macOS Intel | `sidecar-darwin-x64` |
| Linux x86_64 | `sidecar-linux-x64` |
| Windows x86_64 | `sidecar-win32-x64.exe` |

Note: `uname -m` returns `arm64` on macOS (matches `process.arch`) but `x86_64` on Linux (maps to Node.js `x64`). CI artifact naming should use Node.js conventions for simpler runtime lookup.

**Resolution order:** sidecarPathOverride > `bin/sidecar-{platform}-{arch}` > dev-mode `native/sidecar/target/debug/`.

### References

- [macos-14 deprecation (actions/runner-images#12520)](https://github.com/actions/runner-images/issues/12520)
- [macos-15-intel availability (actions/runner-images#13045)](https://github.com/actions/runner-images/issues/13045)
- [Apple Sequoia signing enforcement](https://hackaday.com/2024/11/01/apple-forces-the-signing-of-applications-in-macos-sequoia-15-1/)
- [Gatekeeper quarantine issue (openai/codex#5787)](https://github.com/openai/codex/issues/5787)
- [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)
- [obsidian-mcp-tools native binary distribution](https://github.com/jacksteamdev/obsidian-mcp-tools)
