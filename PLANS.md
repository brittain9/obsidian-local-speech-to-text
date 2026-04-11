# GPU Acceleration for whisper.cpp

## Objective

Enable GPU-accelerated transcription via Metal (macOS Apple Silicon) and CUDA (Linux/Windows NVIDIA). Ship three platform-specific sidecar binaries. CPU remains the development default and the runtime fallback when no GPU is detected.

## Current State

- `whisper-rs = "0.16.0"` in Cargo.toml with no features enabled — CPU only
- `transcription.rs:176` uses `WhisperContextParameters::default()` — no GPU settings
- `worker.rs` `SessionMetadata` carries `language`, `model_file_path`, `session_id` — no GPU config
- `protocol.rs` `StartSession` has no GPU fields, no system info command
- `plugin-settings.ts` has no `useGpu` setting
- `settings-tab.ts` has no GPU UI
- `main.ts:295` `getSidecarExecutableName()` returns basename only — no platform-specific binary selection
- `npm run build:sidecar` runs bare `cargo build` with no features

### whisper-rs GPU API Surface

`WhisperContextParameters` has three GPU-relevant fields (set at model load time):
- `use_gpu: bool` — default `cfg!(feature = "_gpu")`, i.e., auto-true when any GPU feature is compiled in
- `flash_attn: bool` — default false, improves GPU performance, incompatible with DTW (we don't use DTW)
- `gpu_device: c_int` — default 0

Available whisper-rs compile-time features: `metal` (→ `_gpu`), `cuda` (→ `_gpu`), `vulkan` (→ `_gpu`), `hipblas`, `coreml`, `openblas`.

`whisper-rs-sys` build script handles CMake flags, library linking, and Metal shader embedding automatically based on features.

`whisper_rs::print_system_info()` returns a string like `"AVX = 1 | AVX2 = 1 | ... | METAL = 1"` — useful for capability reporting.

## Constraints

- D-001: Plugin owns UX/settings, sidecar owns inference and native concerns
- D-003: CPU-first is the development default. GPU is an acceleration layer, not a requirement.
- D-008: GPU config is per-session (carried in `StartSession`), not a sidecar-global setting
- D-013: Sidecar owns inference capability detection; plugin displays what the sidecar reports
- Metal embeds shaders via `GGML_METAL_EMBED_LIBRARY=ON` — single binary, no external `.metallib`
- CUDA requires CUDA toolkit at compile time. At runtime, whisper.cpp falls back to CPU automatically if no NVIDIA driver/GPU is present.
- Protocol stays at v3. All changes are additive with serde defaults. No shipped versions exist.
- Lesson: run clippy with `WHISPER_DONT_GENERATE_BINDINGS=1` to avoid extra bindgen/CMake pass

## Approach

Thread a single `useGpu: bool` from plugin settings through the protocol to `WhisperContextParameters`. The sidecar derives `flash_attn = use_gpu` internally (safe without DTW) and uses `gpu_device = 0`. This keeps the protocol and settings surface minimal while enabling the full GPU path.

Add `GetSystemInfo` command so the plugin can discover what the sidecar was compiled with. The sidecar reports `compiled_backends` (compile-time cfg) and `system_info` (whisper.cpp's runtime string).

Gate GPU features in Cargo.toml behind opt-in features (`gpu-metal`, `gpu-cuda`). The build matrix selects features per target platform. Local dev builds remain CPU-only by default.

## Execution Steps

### Phase 1: Sidecar Rust — GPU Plumbing

#### Step 1.1: Cargo.toml Features
- [ ] Add `gpu-metal` and `gpu-cuda` features that forward to `whisper-rs/metal` and `whisper-rs/cuda`
- [ ] Keep `default = []` so bare `cargo build` remains CPU-only

```toml
[features]
default = []
gpu-metal = ["whisper-rs/metal"]
gpu-cuda = ["whisper-rs/cuda"]
```

#### Step 1.2: GpuConfig in transcription.rs
- [ ] Add `GpuConfig { use_gpu: bool }` struct
- [ ] Add `gpu_config` field to `TranscriptionRequest`
- [ ] Add `gpu_config` field to `LoadedModel` (tracks config used at load time)
- [ ] `load_or_reuse_model` accepts `GpuConfig`, reloads if config changed (not just path)
- [ ] `load_model_context` accepts `GpuConfig`, sets `use_gpu` and `flash_attn` on `WhisperContextParameters`
- [ ] `probe_model_path` stays with default params (validation doesn't need specific GPU settings)

Key change in `load_model_context`:
```rust
fn load_model_context(path: &Path, gpu: &GpuConfig) -> Result<WhisperContext, TranscriptionError> {
    let mut params = WhisperContextParameters::default();
    params.use_gpu(gpu.use_gpu);
    params.flash_attn(gpu.use_gpu); // safe: we don't use DTW
    WhisperContext::new_with_params(model_path, params)...
}
```

Reload check in `load_or_reuse_model`:
```rust
let should_reload = self.loaded_model.as_ref()
    .map(|m| m.model_path != model_file_path || m.gpu_config != gpu_config)
    .unwrap_or(true);
```

#### Step 1.3: GpuConfig in worker.rs
- [ ] Add `gpu_config: GpuConfig` to `SessionMetadata`
- [ ] Track `loaded_gpu_config: Option<GpuConfig>` alongside `loaded_model_path` in `worker_main`
- [ ] Extend the reload check in `BeginSession` to compare both path and GPU config
- [ ] Pass `gpu_config` from active session metadata into `TranscriptionRequest`

#### Step 1.4: Protocol Changes
- [ ] Add `use_gpu: bool` to `Command::StartSession` with `#[serde(rename = "useGpu", default = "default_use_gpu")]` where `default_use_gpu` returns `true`
- [ ] Add `Command::GetSystemInfo` variant (no fields)
- [ ] Add `Event::SystemInfo { compiled_backends: Vec<String>, system_info: String }`
- [ ] Add `compiled_backends()` helper using `cfg!(feature = "...")` to report compiled GPU backends

```rust
pub fn compiled_backends() -> Vec<String> {
    let mut backends = vec!["cpu".to_string()];
    #[cfg(feature = "gpu-metal")]
    backends.push("metal".to_string());
    #[cfg(feature = "gpu-cuda")]
    backends.push("cuda".to_string());
    backends
}
```

#### Step 1.5: app.rs Wiring
- [ ] `handle_command` for `GetSystemInfo`: emit `Event::SystemInfo` with `compiled_backends()` and `whisper_rs::print_system_info()`
- [ ] `handle_command` for `StartSession`: read `use_gpu` field, pass `GpuConfig { use_gpu }` into `SessionMetadata`

### Phase 2: Plugin TypeScript — Settings and Protocol

#### Step 2.1: Plugin Settings
- [ ] Add `useGpu: boolean` to `PluginSettings` (default `true`)
- [ ] Add `readBoolean` call in `resolvePluginSettings`
- [ ] Update `plugin-settings.test.ts` if it has coverage for settings resolution

#### Step 2.2: TypeScript Protocol Types
- [ ] Add `useGpu?: boolean` to `StartSessionCommand` interface
- [ ] Add `GetSystemInfoCommand` interface
- [ ] Add `SystemInfoEvent` interface with `compiledBackends: string[]`, `systemInfo: string`
- [ ] Add `GetSystemInfoCommand` to `SidecarCommand` union
- [ ] Add `SystemInfoEvent` to `SidecarEvent` union
- [ ] Add `createGetSystemInfoCommand()` factory
- [ ] Add `system_info` case to `parseEventFrame` switch
- [ ] Update `createStartSessionCommand` to pass through `useGpu`

#### Step 2.3: SidecarConnection
- [ ] Add `getSystemInfo()` method — sends `GetSystemInfoCommand`, waits for `SystemInfoEvent`
- [ ] `startSession` already passes through the full payload; `useGpu` flows automatically once it's in the command type

#### Step 2.4: Dictation Session Controller
- [ ] Pass `useGpu` from settings when building the `startSession` payload

#### Step 2.5: Settings Tab — GPU Display
- [ ] Add GPU toggle (`useGpu`) in settings under a new "Acceleration" heading or within the existing "Transcription" section
- [ ] On settings display, call `getSystemInfo()` and show compiled backends (e.g., "GPU: Metal" or "GPU: CUDA" or "CPU only")
- [ ] Toggle description explains that GPU is used automatically when available and this setting disables it

### Phase 3: Build System

#### Step 3.1: Build Matrix Design
- [ ] Document the three initial targets:

| Target         | `--target`                  | `--features`  | Notes                          |
|----------------|-----------------------------|---------------|--------------------------------|
| darwin-arm64   | `aarch64-apple-darwin`      | `gpu-metal`   | Metal always available on AS   |
| linux-x64      | `x86_64-unknown-linux-gnu`  | `gpu-cuda`    | Requires CUDA toolkit in CI    |
| win32-x64      | `x86_64-pc-windows-msvc`    | `gpu-cuda`    | Requires CUDA toolkit in CI    |

- [ ] Add `build:sidecar:release` npm script: `cargo build --manifest-path native/sidecar/Cargo.toml --release`
- [ ] Local dev continues to use `npm run build:sidecar` (CPU-only debug, no features)
- [ ] Document CUDA toolkit requirement for CI Linux/Windows builds
- [ ] The CI build command pattern is: `cargo build --manifest-path native/sidecar/Cargo.toml --release --target <TARGET> --features <FEATURES>`

#### Step 3.2: Binary Naming and Distribution
- [ ] Binary name stays `obsidian-local-stt-sidecar` (+ `.exe` on Windows) — unchanged
- [ ] Platform distinction is in the release artifact directory structure, not the binary name
- [ ] Plugin binary selection at runtime uses `process.platform` + `process.arch` to locate the correct binary (deferred to the distribution plan in backlog)

### Phase 4: Verification

- [ ] `cargo build --features gpu-metal` compiles on macOS (or cross-compile check)
- [ ] `cargo build --features gpu-cuda` compiles on Linux with CUDA toolkit (or document CI requirement)
- [ ] `cargo build` (no features) still compiles and works — CPU-only path unchanged
- [ ] `cargo test` passes with no features (existing tests, no GPU hardware needed)
- [ ] `npm run check:rust` passes (build, fmt, clippy, test)
- [ ] `npm run check:js` passes (typecheck, lint, test, build)
- [ ] Protocol round-trip test for `StartSession` with `useGpu` field
- [ ] Protocol round-trip test for `GetSystemInfo` → `SystemInfo`
- [ ] Settings persistence test for `useGpu`
- [ ] Manual verification: start a dictation session with `useGpu: true` on a CPU-only build — confirm it works (CPU fallback)

## Risks and Open Questions

1. **CUDA toolkit in CI**: Linux and Windows CUDA builds require the CUDA toolkit installed in the CI environment. This is a CI infrastructure requirement, not a code change. Document the version requirement (CUDA 12.x).

2. **CUDA binary size**: CUDA-linked binaries are significantly larger than CPU-only. This affects download size for the plugin. Acceptable tradeoff for GPU acceleration.

3. **Model reload on GPU toggle**: Changing `useGpu` between sessions triggers a full model reload (WhisperContext recreation). This is the correct behavior but adds ~1-3s latency on the first transcription of the new session. The alternative (keeping two contexts) is wasteful.

4. **No runtime GPU detection API**: whisper.cpp does not expose "which backend was actually used for this inference." The sidecar reports what was compiled in and what was requested. The plugin displays reality based on compiled backends, not assumptions about runtime behavior.

5. **Deferred**: darwin-x64 (Intel Mac) binary, Vulkan backend (AMD/Intel GPUs), per-session `gpuDevice` selection, `flash_attn` as a user-visible setting.
