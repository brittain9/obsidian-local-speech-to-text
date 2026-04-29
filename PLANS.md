# Timeline PR 2 Plan: Carry VAD Evidence Through The Pipeline

This is the plan for `timeline.md` PR 2 (VAD trace through the pipeline). GitHub PR #67 carries this work. Do not confuse with GitHub PR #62, which is unrelated.

> **Status:** Complete. The aggregate ships on the wire; the per-frame trace and `voiced_fraction` helper land in-process for the PR 3 hallucination filter to consume. `voiced_seconds` redefinition and the per-segment adapter wiring deferred to PR 3 (no consumer in PR 2). After this lands, distill any durable shape into `docs/system-architecture.md` and delete this file.

## Branching

Branch from the merged Timeline PR 1 (stage pipeline scaffolding) tip on `main`.

Suggested command:

```bash
git switch main
git pull --ff-only
git switch -c feat/vad-evidence-pipeline
```

Do not branch directly from a stale `main`; this work depends on Timeline PR 1's canonical transcript/stage-runner work.

## Goal

VAD currently decides utterance boundaries and then most of its evidence is discarded. This PR should preserve the useful audio-domain facts so later pipeline stages can use them for timestamp quality, hallucination detection, and other segment-preserving text stages.

The implementation should keep one authoritative VAD evidence object and pass that object through the existing sidecar pipeline. Avoid adding settings, feature toggles, placeholder processors, or UI behavior in this PR.

## Current Shape

Relevant existing flow:

1. `ListeningSession` ingests 20 ms PCM frames and calls `VoiceActivityDetector::speech_probability`.
2. The session uses thresholds and padding to create a `FinalizedUtterance`.
3. `AppState` queues that utterance while it requests plugin context.
4. `TranscriptionWorker` sends audio to the selected engine adapter.
5. The worker wraps engine output into a canonical `Transcript`, writes an engine `StageOutcome`, and runs post-engine stages.
6. The plugin receives `transcript_ready` with `segments`, `text`, and `stageResults`.

The loss happens at step 2: `FinalizedUtterance` only carries `duration_ms` and `samples`. The VAD probabilities, speech window, padding window, and session-relative timing are gone before the worker and stage context can inspect them.

## Design

Introduce a small audio-domain metadata type for the facts VAD already knows. Keep it independent of any specific future processor.

Proposed Rust shape:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceActivityEvidence {
    pub audio_start_ms: u64,
    pub audio_end_ms: u64,
    pub speech_start_ms: u64,
    pub speech_end_ms: u64,
    pub voiced_ms: u64,
    pub unvoiced_ms: u64,
    pub mean_probability: f32,
    pub max_probability: f32,
}
```

Semantics:

- `audio_start_ms` / `audio_end_ms` are session-relative bounds of the exact sample buffer sent to inference, including retained pre/post padding.
- `speech_start_ms` / `speech_end_ms` are session-relative bounds of retained frames whose probabilities met the session's speech threshold. They describe the retained inference buffer, not any earlier candidate frames discarded by the min-speech gate.
- `voiced_ms` and `unvoiced_ms` summarize retained VAD frames using the session's existing speech threshold.
- `mean_probability` and `max_probability` summarize retained VAD probabilities for future quality stages without serializing a large per-frame trace.

Keep raw per-frame probabilities internal to `ListeningSession` while an utterance is being assembled. Do not put the full trace on the wire in this PR.

## Data Flow Changes

1. Add an internal buffered-frame struct in `native/src/session.rs`:

   ```rust
   struct BufferedAudioFrame {
       samples: Vec<i16>,
       start_ms: u64,
       speech_probability: f32,
   }
   ```

2. Add a monotonic session clock to `ListeningSession`.

   `elapsed_frames` can continue to serve one-sentence timeout behavior. Add a separate counter or millisecond field that is not reset by `clear_activity`, so each finalized utterance has stable session-relative timing.

3. Change `pre_speech_frames` and `utterance_frames` from raw sample buffers to buffered frames.

   This is the source of truth for both flattened samples and VAD evidence.

4. Replace `FinalizedUtterance { duration_ms, samples }` with:

   ```rust
   pub struct FinalizedUtterance {
       pub samples: Vec<i16>,
       pub voice_activity: VoiceActivityEvidence,
   }
   ```

   Add a small `duration_ms()` method if call sites need the audio duration. Do not store `duration_ms` separately from `voice_activity.audio_*`.

5. Store the whole `FinalizedUtterance` in `PendingContextRequest`.

   This prevents `samples`, duration, and VAD metadata from drifting across the context-request delay.

6. Pass `voice_activity` through `WorkerCommand::TranscribeUtterance` and `TranscriptAssembly`.

7. Add `voice_activity` to `StageContext`.

   Future processors should read typed data from `StageContext`, not deserialize their own copy from JSON.

8. Add `voiceActivity` to `EngineStagePayload`.

   This is the reporting path. It lets the plugin journal preserve the evidence through the existing `stageResults[0].payload` record without adding a new top-level `transcript_ready` field.

9. Keep TypeScript changes minimal.

   The current sidecar parser already preserves `StageOutcome.payload` as a generic record. Add or adjust only the tests needed to prove the engine payload survives parsing. Do not add a plugin UI consumer in this PR.

## Placement

Prefer a small new Rust module if importing the metadata type from both session and protocol gets awkward:

- `native/src/audio.rs` or `native/src/audio_metadata.rs`

The type should not live in a future hallucination or timestamp module. VAD evidence is an audio-pipeline fact, not ownership of any one post-engine stage.

## Non-Goals

- Do not implement hallucination filtering in this PR.
- Do not implement timestamp rendering or correction in this PR.
- Do not add stage toggles, settings, or feature flags.
- Do not expose raw VAD traces to the plugin.
- Do not change transcript segment timestamp semantics in this PR.
- Do not add compatibility shims for old internal payloads.

## Implementation Steps

1. Introduce `VoiceActivityEvidence`.

   Add serialization derives because the engine stage payload will carry it. Keep helper methods small and domain-specific, for example `duration_ms()`.

2. Update `ListeningSession` buffering.

   Attach start time and probability to every retained frame. Preserve existing boundary behavior and padding tests exactly unless a test is proving new metadata.

3. Build evidence at finalization boundaries.

   `flatten_frames` should flatten samples and derive `VoiceActivityEvidence` from the same frame slice. Handle three boundary paths: normal silence finalization, max-duration split at a silence boundary, and hard max-duration split.

4. Pipe the metadata through `AppState`.

   `enqueue_utterance`, `PendingContextRequest`, timeout dispatch, and context-response dispatch should carry `FinalizedUtterance` as one unit.

5. Pipe the metadata through `TranscriptionWorker`.

   `WorkerCommand::TranscribeUtterance`, `TranscriptAssembly`, and `StageContext` should receive the same `VoiceActivityEvidence`.

6. Extend `EngineStagePayload`.

   Serialize `voiceActivity` alongside `isFinal`. Update `Transcript::is_final` tests and any engine-stage payload fixtures.

7. Update the TypeScript protocol tests.

   Add a fixture with `stageResults[0].payload.voiceActivity` and assert it is preserved. Avoid strict TS modeling unless a real consumer needs it.

8. Update docs.

   `docs/system-architecture.md` should state that VAD evidence becomes part of the engine stage payload and typed stage context, while raw traces remain internal.

## Tests

Rust:

- `ListeningSession` finalization includes audio bounds matching retained sample duration.
- speech bounds follow the first and last retained voiced frames, including the case where retained pre-pad frames are already voiced.
- two finalized utterances in one session have monotonically increasing `audio_start_ms`.
- max-duration split carries correct audio bounds and evidence.
- `AppState` pending context entries retain the full finalized utterance metadata.
- `TranscriptionWorker` engine payload includes `voiceActivity`.
- a fake stage can read `ctx.voice_activity` without touching JSON payload.

TypeScript:

- `parseEventFrame` preserves `stageResults[0].payload.voiceActivity`.

High-signal checks before finishing:

```bash
cargo test -p local-transcript-sidecar --lib
node scripts/check-rust.mjs
npm run typecheck && npm run lint && npm run test && npm run build:frontend
git diff --check
```

## Risks And Trade-Offs

- Session-relative VAD timestamps should not silently replace engine segment timestamps. This PR preserves both; any correction/rendering policy belongs in a later PR.
- Mean/max probability is intentionally compact. If a future real processor needs full traces, add that as a targeted change with measured payload and memory impact.
- `clear_activity` currently resets session activity state. The new session clock must not reset there, or later utterances will appear to start at zero.
- `EngineStagePayload` becomes a stricter internal contract. That is acceptable for this greenfield sidecar/plugin boundary; update all fixtures instead of adding fallback parsing.

## Success Criteria

This PR is complete when:

- VAD evidence is produced once by `ListeningSession`.
- The evidence stays attached to the utterance through context request, worker dispatch, transcript assembly, stage context, and engine stage payload.
- Existing transcription behavior and session state behavior are unchanged.
- The plugin receives the evidence inside `stageResults[0].payload.voiceActivity`.
- Tests prove the metadata survives the paths that could otherwise drop it.
