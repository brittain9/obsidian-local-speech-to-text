# Code Review

## Round 2: Runtime Capability Model + Build Infrastructure

Scope: 24 files, +896 / -416. CI matrix, Rust sidecar runtime capabilities, TS plugin acceleration preference model, settings migration, build script consolidation, docs refresh.

Verified: `npm run typecheck` clean, 46 TS tests pass, 62 Rust tests pass, `cargo fmt --check` clean. GitHub Actions versions (`checkout@v6`, `setup-node@v6`) confirmed current.

### New Findings

#### N-1. Correctness: Legacy migration inverts the intended default for most users

`src/settings/plugin-settings.ts:83`:
```ts
return legacyUseGpu === false ? 'cpu_only' : DEFAULT_PLUGIN_SETTINGS.accelerationPreference;
```

When `accelerationPreference` is absent and `useGpu` is also absent (fresh install, or settings with neither field), `legacyUseGpu` is `undefined`, which is not `=== false`, so this falls through to `'auto'`. That's correct for fresh installs.

But every existing user who never touched the old GPU toggle has `useGpu: false` in persisted settings (it was the default). This migrates them to `cpu_only`, which is a behavior change: the old `false` meant "GPU wasn't available yet" (not "I deliberately chose CPU"). These users now get locked to `cpu_only` instead of the new `auto` default.

Suggested fix: Only preserve `cpu_only` when the user had `useGpu: true` (a deliberate opt-in to GPU implies awareness of the setting). Treat `useGpu: false` and absent the same way: use the new default `'auto'`. If the current behavior is intentional, document the rationale in `tasks/decisions.md`.

Affected files:
- `src/settings/plugin-settings.ts`
- `test/plugin-settings.test.ts`

#### N-2. Correctness: CI release job references `build-cpu.sh --release` without verification

`ci.yml:85`:
```yaml
run: bash scripts/build-cpu.sh --release
```

`build-cpu.sh` exists but was not modified in this diff. Confirm it accepts `--release` and produces a binary at `native/sidecar/target/release/obsidian-local-stt-sidecar`. If it only supports debug builds, the release workflow silently produces a debug binary or fails.

Affected files:
- `.github/workflows/ci.yml`
- `scripts/build-cpu.sh`

#### N-3. Low: `upload-artifact@v4` is outdated

The CI uses `actions/upload-artifact@v4`. The current major is v7 (April 2026). v4 still works but is deprecated and will eventually stop running on newer runners. Since checkout and setup-node were already bumped to v6, upload-artifact should be bumped for consistency. v6 is the minimum to match the node24 runner requirement.

Affected files:
- `.github/workflows/ci.yml`

#### N-4. Low: Whisper CUDA probe is weaker than Cohere CUDA probe

`native/sidecar/src/capabilities.rs:51-53`: Whisper CUDA checks for `/dev/nvidiactl` and `/dev/nvidia0` device nodes. This confirms the driver is loaded but not that the userspace CUDA runtime libraries (`libcudart.so`, `libcublas.so`) are available. The Cohere probe actually tries to register the CUDA EP, so it catches library-level failures.

This means the settings UI could show `Whisper: CUDA` when Whisper will actually fail at runtime due to missing libraries. The asymmetry is acceptable as a fast heuristic, but worth a comment in the code or a backlog note.

Affected files:
- `native/sidecar/src/capabilities.rs`

#### N-5. High: launch-affecting sidecar settings do not take effect until a manual restart

`src/main.ts:198-200`:
```ts
private async updateSettings(nextSettings: PluginSettings): Promise<void> {
  this.settings = resolvePluginSettings(nextSettings);
  await this.saveData(this.settings);
}
```

The new `CUDA library path` and existing `Sidecar path override` settings both affect the sidecar launch spec, but changing them only persists settings. The already-running sidecar stays alive, and `Check Sidecar Health` only pings that existing process.

That creates a correctness gap in the documented GPU setup flow: a user can point settings at a CUDA sidecar or new library path, run the health check, and still be talking to the previously started CPU sidecar with its old cached runtime capabilities.

Suggested fix: restart the sidecar automatically when launch-affecting settings change while dictation is idle, or block the save with an explicit "restart required" notice and refresh path.

Affected files:
- `src/main.ts`
- `src/settings/settings-tab.ts`
- `src/sidecar/sidecar-connection.ts`
- `docs/linux-flatpak-gpu-setup.md`

#### N-6. Medium: multi-artifact install progress can report impossible totals

`native/sidecar/src/installer.rs:443-450`:
```rust
reporter.send(
    ModelInstallState::Downloading,
    Some(format!("Downloading {}.", artifact.filename)),
    None,
    downloaded_total + artifact_downloaded,
    stream.total_bytes.or(Some(reporter.total_bytes)),
)
```

`downloaded_total + artifact_downloaded` is cumulative across the whole install, but `total_bytes` falls back to the current artifact's content length when present. For single-file Whisper downloads this looks fine, but Cohere installs have multiple required artifacts, so later files can emit progress like "2.4 GiB / 324 MiB".

The UI renders this ratio directly in `src/shared/format-utils.ts:21-31`, so the modal/settings progress can shrink, jump, or exceed 100% for valid installs.

Suggested fix: keep `total_bytes` consistently scoped to the full install, or introduce separate per-artifact and aggregate progress fields instead of mixing scopes.

Affected files:
- `native/sidecar/src/installer.rs`
- `src/shared/format-utils.ts`
- `config/model-catalog.json`

#### N-7. Medium: `CUDA library path` replaces inherited `LD_LIBRARY_PATH` instead of extending it

`src/main.ts:230-235`:
```ts
const env =
  Platform.isLinux && this.settings.cudaLibraryPath.length > 0
    ? {
        LD_LIBRARY_PATH: this.settings.cudaLibraryPath,
      }
    : undefined;
```

The child process env merge in `src/sidecar/sidecar-process.ts:43-46` means this value overrides the parent's `LD_LIBRARY_PATH` wholesale. The deprecated wrapper script appended instead:

`scripts/flatpak-cuda-wrapper.sh:25`
```sh
export LD_LIBRARY_PATH="${CUDA_LD_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

On Linux systems that already rely on inherited library-path entries for parts of the CUDA/cuDNN/driver chain, entering one directory in plugin settings can remove the rest and make the sidecar less likely to start.

Suggested fix: append/prepend the configured path to the inherited `LD_LIBRARY_PATH` rather than replacing it, unless there is a deliberate reason to isolate the child completely.

Affected files:
- `src/main.ts`
- `src/sidecar/sidecar-process.ts`
- `scripts/flatpak-cuda-wrapper.sh`

### No Findings (reviewed, sound)

- Protocol wire format: `AccelerationPreference`, `RuntimeCapability`, `RefreshCapabilities` are clean additive extensions. Backward compatibility tested (`runtimeCapabilities` defaults to `[]` when absent).
- `resolve_use_gpu`: Logic correct across all 3 branches (`CpuOnly`, `Auto`, `None`/legacy). Unit tested.
- `build_system_info_event` extraction eliminates duplication between `GetSystemInfo` and `RefreshCapabilities`.
- `capabilities.rs` feature gating uses correct `cfg` attributes. Metal/CUDA/Cohere probes compile only with the right features.
- `cohere.rs` CUDA EP: `error_on_failure()` replaces silent fallback. Probe uses `is_available()` then tries registration.
- `SidecarProcess` env scoping: `{ ...process.env, ...launchSpec.env }` merges correctly, only set when field is present.
- Settings UI: `buildEffectiveBackendLines` handles null systemInfo, empty capabilities, cpu_only forcing, and unavailable GPU with reason strings. Dropdown re-renders on change.
- `build-cuda.sh` consolidation: properly subsumes `linux_cuda_build.sh`. Adds `--clean`, `--jobs`, disk check, `target-cuda/` isolation, toolchain validation.
- `build-metal.sh`: simple, correct, macOS-gated.
- `verify-build-output.mjs`: profile-aware via `--release` flag.
- Docs refresh: `linux-flatpak-gpu-setup.md` is significantly clearer. Wrapper script properly deprecated.
- Test quality: new tests cover protocol round-trips, acceleration preference migration, capability resolution, backward compatibility. High signal, no implementation coupling.

---

## Round 1: Cohere Feature Work

Scope: build, distribution, CI, and runtime contract issues from initial Cohere integration.

### Resolved Findings

#### 1. ~~High: the documented Linux CUDA flow builds the wrong sidecar variants~~ RESOLVED

Fixed in round 2. `build-cuda.sh` now uses `engine-cohere,gpu-cuda,gpu-ort-cuda`. `linux_cuda_build.sh` deleted. Docs updated to reference the new script.

#### 2. ~~High: the npm GPU build target has drifted from the actual Cargo feature model~~ RESOLVED

Fixed in round 2. `build:sidecar:gpu` now uses `engine-cohere,gpu-cuda,gpu-ort-cuda`.

#### 3. ~~High: the decoder prompt uses invalid hard-coded token IDs~~ RESOLVED

Token IDs reworked to match the actual tokenizer vocabulary (`tokenizer.json` `added_tokens`). `TOKEN_START_OF_CONTEXT` changed from `16384` to `7`, and all other prompt tokens now use verified IDs in the `0-254` special token range. The out-of-bounds crash on Q4 is fixed. The broader suggestion to use tokenizer-driven lookup instead of numeric constants remains valid as a hardening measure but is no longer a correctness blocker.

#### 7. ~~Medium: GitHub Actions is currently failing on a formatting regression~~ RESOLVED

`cargo fmt --check` passes clean.

### Resolved Findings (continued)

#### 4. ~~Medium: the mel feature extractor does not match the shipped Cohere preprocessing pipeline~~ SUBSTANTIALLY RESOLVED

The critical items from the original review are fixed:
- Mel filterbank now uses Slaney normalization (`norm="slaney"`) and the Slaney/O'Shaughnessy mel scale (`librosa htk=False`).
- Hann window is now symmetric (`periodic=False`), matching the official extractor.
- Per-feature normalization uses `n-1` denominator, matching official masked normalization.
- Parameters (`n_fft=512`, `win_length=400`, `hop_length=160`, `n_mels=128`) match `preprocessor_config.json`.

Remaining deltas (low risk): dither is xorshift-based rather than Gaussian, and the STFT is not centered (no zero-padding at signal edges). These are unlikely to be significant for typical audio lengths.

#### 5. ~~Medium: detokenization bypasses tokenizer semantics~~ SUBSTANTIALLY RESOLVED

Detokenization reworked. Special-token filtering now uses `SPECIAL_TOKEN_BOUNDARY = 255` matching the `added_tokens` range in the tokenizer vocabulary. BPE byte fallback (`<0xNN>` patterns) is properly decoded. `▁` (U+2581) word separator is handled. The threshold is numeric rather than tokenizer-metadata-driven, but it's now correct and documented.

#### 6. Medium: KV cache outputs are still matched by iterator position instead of output name

Still uses iterator position (`cohere.rs:510,526`). The code comments acknowledge the assumed output order (`present.{layer}.{decoder,encoder}.{key,value}`). Not addressed in this round.

Affected files:
- `native/sidecar/src/cohere.rs`
