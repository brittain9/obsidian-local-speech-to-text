# Replace WebRTC VAD with Silero VAD

## Objective

Remove `webrtc-vad` and replace it with Silero VAD, running via the `ort` crate (ONNX Runtime) in the Rust sidecar. Change the `VoiceActivityDetector` trait from returning a binary `bool` to returning an `f32` speech probability, and update the `ListeningSession` accumulation logic to make probability-aware boundary decisions with hysteresis and smoothing.

## Current State

- **VAD**: `webrtc-vad` 0.4.0 in Aggressive mode, returns binary voiced/unvoiced per 320-sample (20ms) frame.
- **Trait**: `VoiceActivityDetector::is_voice_segment(&mut self, &[i16]) -> Result<bool, VoiceActivityError>` at `native/src/session.rs:60-62`.
- **Session**: `ListeningSession<TVad>` is generic over VAD, uses frame-counting for speech start (10 consecutive voiced frames), silence end (75 frames base + adaptive bonus), and boundary-aware splitting at 30s cap.
- **ONNX Runtime**: `ort` 2.0.0-rc.12 is an optional dependency behind the `engine-cohere` feature flag.
- **Tests**: 9 session tests use `FakeVad` with `VecDeque<bool>` decisions.
- **App integration**: `app.rs:371` calls `ListeningSession::new(config)` which defaults to `WebRtcVadDetector`.

## Constraints

1. **Frame size mismatch**: Pipeline delivers 320-sample (20ms) frames. Silero VAD expects 512 samples (32ms at 16kHz). The detector must buffer internally.
2. **`ort` dependency**: Currently optional behind `engine-cohere`. Silero VAD needs `ort` unconditionally (or behind its own feature flag). Since Silero VAD is the only VAD going forward, making `ort` non-optional is cleaner.
3. **Model distribution**: ~2.2 MB ONNX model. Embed via `include_bytes!()` — trivial compared to transcription models (42 MB-3.8 GB).
4. **Silero is stateful**: RNN hidden state (`h`, `c` tensors) must be reset when `clear_activity()` is called or a new session starts.
5. **Cold start**: First ONNX inference ~50-200ms. Overlaps with pre-roll silence period, so not user-visible.
6. **Backward compatibility**: The IPC protocol between TS and Rust does not currently carry any VAD configuration. A `speechThreshold` setting needs to flow from plugin settings -> `StartSession` command -> `SessionConfig`.

## Approach

### Phase 1: Silero VAD detector (Rust-only, trait unchanged)

Ship a working `SileroVadDetector` that implements the *existing* `VoiceActivityDetector` trait (returning `bool` via internal thresholding). This validates the ONNX integration, model loading, frame buffering, and state management before touching the accumulation logic. Tests pass, binary builds, existing behavior preserved.

### Phase 2: Probability-based trait and accumulation

Change the trait to return `f32`, update `ListeningSession` to use probability-aware logic:
- **Hysteresis**: Start speech when rolling average probability > `speech_start_threshold` (default 0.5), end when probability < `speech_end_threshold` (default 0.15) for the silence duration. The asymmetric thresholds prevent oscillation at boundary probabilities.
- **Rolling average** (speech start only): Smooth per-frame probabilities over a `SPEECH_START_THRESHOLD_FRAMES`-sized window to dampen transient spikes before speech has started.
- **Silence tracking stays integer frame-counting**: `trailing_silence_frames` remains `usize`. A frame is silent when `probability < speech_end_threshold`, voiced otherwise. This preserves all existing arithmetic in `effective_end_threshold()`, `base_state()`, `maybe_finalize_utterance()`, and `split_at_boundary()`. The improvement over WebRTC VAD comes from the hysteresis gap and Silero's superior probability signal — not from changing the silence accumulation unit.

### Phase 3: Settings plumbing

Add `speechThreshold` to `PluginSettings`, propagate through `StartSession` command -> `SessionConfig`, expose in the settings UI.

### Why not two-stage (WebRTC gate -> Silero)?

Silero at ~1ms per 32ms chunk on native ONNX Runtime is fast enough for every frame. The WebRTC gate saves <0.1ms on silence frames -- negligible. More importantly, the two-stage approach loses Silero's opinion on ambiguous frames (probability 0.2-0.4), which is exactly where the value lies.

## Execution Steps

### Phase 1: SileroVadDetector

- [ ] **1.1** Make `ort` and `ndarray` non-optional dependencies in `Cargo.toml`. Remove `webrtc-vad`. Update `engine-cohere` feature flag to no longer gate `ort` or `ndarray` -- only gate Cohere-specific deps (`half`, `realfft`). **Important**: The current `ort` dependency carries features `["std", "download-binaries", "copy-dylibs", "half", "ndarray", "tls-rustls"]`. When making `ort` non-optional, remove `"half"` from its feature list — that feature should only be enabled when `engine-cohere` is active. Split into: base `ort` (non-optional, without `"half"`) and an additive `ort/half` under the `engine-cohere` feature flag.

- [ ] **1.2** Acquire the Silero VAD ONNX model file (`silero_vad.onnx`, ~2.2 MB). Place it in `native/models/silero_vad.onnx`. Embed in the binary with `include_bytes!()` in the detector module.

- [ ] **1.3** Create `native/src/vad.rs` with `SileroVadDetector`:
  - Struct holds: `ort::Session`, hidden state `h: Array2<f32>` `[2, 1, 64]`, cell state `c: Array2<f32>` `[2, 1, 64]`, sample buffer `Vec<f32>` for accumulating 512 samples across 320-sample frames, and a `threshold: f32`.
  - Constructor: build `Session` from `include_bytes!()` model data using `Session::builder().commit_from_memory()`. Initialize `h` and `c` to zeros.
  - `reset(&mut self)`: zero out `h`, `c`, and clear the sample buffer. Called on session start and `clear_activity()`.
  - Implement `VoiceActivityDetector` trait: convert i16 frame to f32, append to sample buffer. When buffer reaches 512 samples, run inference, update h/c, return `probability > threshold`. When buffer < 512, return the last known result (or `false` if no inference has run yet).

- [ ] **1.4** Update `native/src/lib.rs` to declare `pub mod vad;`.

- [ ] **1.5** Update `native/src/session.rs`:
  - Remove `WebRtcVadDetector` struct and its `impl` blocks (lines 64-66, `impl Default` at 273-279, `impl VoiceActivityDetector` at 281-287).
  - Remove `use webrtc_vad::{SampleRate, Vad, VadMode};` (line 4).
  - Update the default type parameter on `ListeningSession` (line 68): change `= WebRtcVadDetector` to `= SileroVadDetector`. Update `impl ListeningSession<WebRtcVadDetector>` (line 80) to `impl ListeningSession<SileroVadDetector>` and construct `SileroVadDetector` instead of `WebRtcVadDetector::default()`.
  - Add a `reset()` method to the `VoiceActivityDetector` trait.
  - Call `self.vad.reset()` in `clear_activity()`.
  - Remove the `"webrtc-vad rejected a frame"` error string in the `map_err` closure at line 149 (this is in `session.rs`, not `app.rs`).

- [ ] **1.6** Update tests in `session.rs`:
  - `FakeVad` implements `reset()` (no-op).
  - All 9 existing tests pass unchanged since they use `FakeVad`.

- [ ] **1.7** Add an integration test for `SileroVadDetector` in `native/src/vad.rs`: feed known speech/silence audio and assert plausible results (model loads, probabilities are in range, speech audio returns higher probability than silence).

- [ ] **1.8** `cargo test`, `cargo clippy`, verify sidecar binary builds and loads the embedded model.

### Phase 2: Probability-based trait and accumulation

- [ ] **2.1** Change `VoiceActivityDetector` trait:
  ```rust
  pub trait VoiceActivityDetector {
      fn speech_probability(&mut self, frame: &[i16]) -> Result<f32, VoiceActivityError>;
      fn reset(&mut self);
  }
  ```
  Update `SileroVadDetector` to return the raw probability.

- [ ] **2.2** Update `FakeVad` in tests to use `VecDeque<f32>` decisions instead of `VecDeque<bool>`. Update all test call sites -- `true` becomes `1.0`, `false` becomes `0.0`.

- [ ] **2.3** Add probability-related fields to `SessionConfig`:
  - `speech_start_threshold: f32` (default 0.5)
  - `speech_end_threshold: f32` (default 0.15)

- [ ] **2.4** Replace `voiced_run_frames: usize` with a rolling probability window:
  - Add field `recent_probabilities: VecDeque<f32>` (capacity `SPEECH_START_THRESHOLD_FRAMES`, i.e. 10).
  - Each frame: push `probability` to window, pop front if full.
  - **Cold-start rule**: require the window to be full (10 entries) before comparing the average. This prevents premature triggering from a few loud frames. Before the window is full, speech cannot start — matches the old "10 consecutive frames" minimum.
  - Start speech when `recent_probabilities.iter().sum::<f32>() / window.len() as f32 >= speech_start_threshold`.
  - **Behavioral note**: This is intentionally more sensitive than 10 consecutive binary-voiced frames. Under the old scheme, a single unvoiced frame reset the counter. Under rolling average, a single low frame only reduces the average. Tune `SPEECH_START_THRESHOLD_FRAMES` up if this proves too sensitive in practice.

- [ ] **2.5** Update silence classification in `ingest_audio_frame()`:
  - Replace the `is_voiced` boolean with `probability: f32` from `vad.speech_probability()`.
  - A frame is **silent** when `probability < speech_end_threshold`. A frame is **voiced** otherwise.
  - `trailing_silence_frames` remains `usize` — increment on silent, reset to 0 on voiced. No type change.
  - All downstream consumers of `trailing_silence_frames` are unchanged:
    - `base_state()`: `SPEECH_PAUSE_THRESHOLD_FRAMES` (25) comparison — still valid.
    - `maybe_finalize_utterance()`: trailing silence trim — still a frame count index.
    - `effective_end_threshold()`: base 75 + adaptive cap 25 — still frame counts.
    - `SILENCE_GAP_MIN_FRAMES` (5) for boundary tracking — still valid.
    - `BOUNDARY_STALENESS_CAP_FRAMES` (250) — still valid.

- [ ] **2.6** Update `clear_activity()` and `split_at_boundary()`:
  - `clear_activity()`: clear `recent_probabilities` window (in addition to `self.vad.reset()` from Phase 1).
  - `split_at_boundary()` (line 227): clear `recent_probabilities` window (replaces `voiced_run_frames = 0` reset). Since `speech_started` stays `true` after a split, the window isn't used for start decisions in carry-forward — but clearing prevents stale state.

- [ ] **2.7** Update all 9 session tests for the new probability values and verify behavior is equivalent. Specifically verify `speech_paused_state_during_brief_silence` still works (exercises `SPEECH_PAUSE_THRESHOLD_FRAMES` path in `base_state()`).

- [ ] **2.8** `cargo test`, `cargo clippy`.

### Phase 3: Settings plumbing

- [ ] **3.1** Add `speechThreshold` to `PluginSettings` in `src/settings/plugin-settings.ts` (default `0.5`). Add to `DEFAULT_PLUGIN_SETTINGS`, the interface, and the `resolvePluginSettings()` return object. Create a `readFloat(value: unknown, min: number, max: number, fallback: number): number` helper (does not exist yet — follow `readPositiveInteger` pattern, guard against `NaN`/`Infinity` with `isFinite`). Clamp to `[0.1, 0.95]`.
  - This single slider controls `speech_start_threshold` only. `speech_end_threshold` is derived as `speech_start_threshold * 0.3` (clamped to a floor of 0.1). This keeps a consistent hysteresis ratio without exposing two confusing sliders.

- [ ] **3.2** Add `speech_threshold` field to `StartSession` command in `native/src/protocol.rs`. Use `#[serde(rename = "speechThreshold", default = "default_speech_threshold")]` with a `fn default_speech_threshold() -> f32 { 0.5 }` function — bare `#[serde(default)]` on `f32` defaults to `0.0`, which would disable the VAD. Mirror in `src/sidecar/protocol.ts` as `speechThreshold?: number` (optional, so older sidecars handle absence via the Rust default). Add a protocol round-trip test for the new field.

- [ ] **3.3** Plumb `speechThreshold` through the full chain:
  - `DictationSessionController.startDictation()` (`src/dictation/dictation-session-controller.ts:104`): include `speechThreshold` in the `startSession` payload.
  - `app.rs`: destructure `speech_threshold` from `Command::StartSession` at line 317 and pass it into the `SessionConfig` construction at line 343.
  - `SessionConfig` → `ListeningSession`: use `speech_threshold` as `speech_start_threshold`, derive `speech_end_threshold` as `speech_start_threshold * 0.3` (floor 0.1).
  - `ListeningSession` passes the start threshold to `SileroVadDetector` (used as internal threshold in Phase 1 compat mode, unused after Phase 2 since thresholding moves to the session).

- [ ] **3.4** Add a "Speech detection threshold" slider in `src/settings/settings-tab.ts` under the "Transcription" heading (not the existing "Advanced: Sidecar" section, which is for sidecar internals). Use `Setting.addSlider()` with min=0.1, max=0.95, step=0.05 — matching the `readFloat` clamp range. Tooltip: "Higher values require more confident speech detection (fewer false triggers), lower values are more sensitive."

- [ ] **3.5** `cargo test`, `npm test`, manual verification: adjust slider, confirm behavior changes are perceptible.

## Verification

1. **Unit tests**: `cargo test` -- all session tests pass with `FakeVad` using probability values. New `SileroVadDetector` test validates model loads and returns plausible probabilities.
2. **Lint**: `cargo clippy` -- no warnings. `npm test` -- TS tests pass.
3. **Build**: Sidecar binary compiles for the target platform. Model is embedded and loads without error.
4. **Manual smoke test**: Record speech with pauses -> verify utterances finalize at natural boundaries, not mid-word. Silence -> no false triggers. Adjust threshold slider -> perceptible sensitivity change.
5. **Regression**: Existing dictation flows (OneSentence, AlwaysOn, pause-while-processing) work as before.

## Risks and Open Questions

1. **Model acquisition**: The Silero VAD ONNX model is sourced from [snakers4/silero-vad](https://github.com/snakers4/silero-vad) (`files/silero_vad.onnx`). License is MIT -- compatible with this project.

2. **`ort` as non-optional**: Makes the sidecar binary depend on ONNX Runtime shared libraries even when only using whisper.cpp for transcription. Binary size increase is ~15-20 MB for the ORT dylib. Acceptable given the sidecar is already large, but worth noting.

3. **512-sample buffering latency**: The detector must accumulate 512 samples before running inference. With 320-sample frames, this means inference runs on roughly every other frame (after 640 samples, using 512 and carrying forward 128). Worst-case latency before first VAD result: 2 frames x 20ms = 40ms. Negligible for speech detection.

4. **Probability threshold tuning**: The defaults (0.5 start, 0.15 end) are from the Silero VAD documentation but may need tuning based on real-world testing. The settings plumbing in Phase 3 enables user adjustment.

5. **`ndarray` version alignment**: Currently `ndarray = "0.17"` is optional behind `engine-cohere`. Silero VAD also needs it for tensor I/O. Making it non-optional is straightforward since the version is already pinned.

6. **Stale documentation**: `docs/architecture/system-architecture.md` references WebRTC VAD in multiple places (lines 192, 209, 356, 399, 412) — crate name, performance characteristics, glossary entry, timing tables. Update after implementation to reflect Silero VAD.
