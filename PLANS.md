# PR 61 Contract Baseline and VAD Trace Plan

## Summary

Refactor PR 61 from "stage pipeline scaffolding with no-op future stages" into
the contract baseline for the intelligent STT timeline. PR 61 should lock
revision/finality behavior, session-scoped feature settings, context handling,
and timing metadata without shipping placeholder processors or user-visible
future features.

Then add a new stacked PR 2 that carries Silero VAD evidence through the
pipeline as an internal utterance signal. PR 2 makes VAD usable by the
hallucination filter, future timestamp fallback, and later pause-aware UX
without serializing raw VAD probabilities to the plugin.

## Branch Sequence

1. Keep this plan on `main`.
2. Rebase `feat/stage-pipeline-scaffolding` on `main` and rewrite it as PR 61:
   contract baseline only.
3. Create `feat/vad-trace-pipeline` from the updated PR 61 branch. This is the
   new timeline PR 2.
4. Rebase `feat/stage-hallucination-filter` on the VAD trace branch and rewrite
   it as hallucination filter v2. That work is intentionally not part of this
   plan except for the contract it depends on.

## Non-Goals

- No hallucination filter behavior in PR 61 or PR 2.
- No timestamp rendering UI.
- No speculative transcription loop.
- No LLM cleanup or session polish.
- No punctuation stage, punctuation setting, or punctuation no-op.
- No schema versions, migrations, compatibility shims, or legacy branches.
- No raw VAD probability stream in the TypeScript protocol.

## Shared Contract

- A dictated utterance has stable `utterance_id`, `utterance_index`, and
  session-relative timing.
- Revisions are monotonic per utterance. Partial revisions are `is_final=false`;
  final engine and final post-engine revisions are `is_final=true`.
- A partial revision may be replaced by a later partial or final revision. Once
  any final revision is accepted for an utterance, later partial revisions for
  that utterance are stale and must not project into the note.
- Post-engine stages run only for final engine revisions unless a real stage
  explicitly declares `runs_on_partials=true` and documents its narrower partial
  contract.
- Segment text is canonical. Joined text is a projection.
- Segment timing is canonical metadata, never rendered timestamp text.
- Post-engine text stages may drop segments or rewrite text inside existing
  segment timing boundaries. They must not move boundaries, synthesize new
  timing, or reflow timestamps in PR 61.
- Empty final text can be a valid transcript revision after filtering. It must
  be journaled with stage history and diagnostics. It should not append a blank
  span into the note.

## PR 61 - Contract Baseline

### 1. Remove Placeholder Stage Behavior

Current PR 61 adds `NoopProcessor`s and emits planned stages as
`stage_not_implemented` history. Replace that with a real runner contract:

- Keep a stage runner module, but register only real processors.
- Delete `native/src/stages/noop.rs`.
- Do not emit history for stages that do not exist yet.
- Do not add or keep a punctuation setting.
- Keep the existing `StageId::Punctuation` and `StageId::UserRules` enum values
  as inert protocol vocabulary. They must not imply registered processors.
- In PR 61, make `StageEnablement` empty/default-only. PR 3 adds the first real
  stage toggle when hallucination filtering lands.

Acceptance:

- A transcript with no registered post-engine processors has engine history
  only.
- There is no public `stage_not_implemented` outcome.
- Plugin settings do not contain a punctuation stage toggle.

### 2. Finality and Stage Runner Contract

Add the finality gate that speculative transcription and final-only stages will
depend on.

- Change `assemble_transcript` to take `is_final: bool`; production calls pass
  `true` until speculative transcription exists.
- Store `is_final` in `EngineStagePayload`.
- Add `runs_on_partials() -> bool` to `StageProcessor`, defaulting to `false`.
- In `run_post_engine`, skip registered processors with
  `runs_on_partials=false` when the engine revision is partial.
- The skip reason for a registered final-only stage on a partial revision is
  exactly `partial`.
- Validate stage output before accepting it:
  - segment ranges must be ordered and non-overlapping;
  - each returned segment must stay within the utterance duration;
  - a text stage must preserve existing segment timing boundaries unless a
    later PR introduces an explicit resegmentation contract.
- Stage panics remain isolated as failed outcomes.

Acceptance:

- Unit tests cover final revision runs, partial revision skips, partial-safe
  stage execution, panic isolation, disabled registered stages, and invalid
  stage output becoming `Failed` without mutating the transcript.
- Partial revisions stay engine-only when no registered partial-safe stages
  exist.

### 3. Context Window Contract

Context must be a typed artifact that engines and future stages can consume
without asking the plugin twice.

- Add `ContextWindowSource::NoteGlossary` for note-derived glossary context.
- Keep `SessionUtterance` for future journal-derived context.
- Pass `context: Option<&ContextWindow>` into `StageContext`.
- Keep `TranscriptionRequest.context` for engine prompt conditioning.
- Capability-gate context requests in the sidecar:
  - request note context when the selected family supports initial prompts;
  - also request it when a registered stage declares it needs context;
  - otherwise dispatch transcription immediately with `context=None`.
- `ContextWindow.text` must fit `budget_chars`; truncate at the plugin source
  before sending, and add sidecar validation that drops over-budget context
  rather than passing it to an engine or stage.
- Plugin context responses use the session settings snapshot, not live settings.

Acceptance:

- Whisper still receives glossary context when `useNoteAsContext` was enabled at
  session start.
- Cohere does not trigger a context request unless a registered stage requires
  context.
- The plugin sends `sources: [{ kind: "note_glossary", ... }]` instead of an
  empty source list for note context.
- Toggling `useNoteAsContext` during active dictation affects the next session,
  not the current one.

### 4. Session-Scoped Settings Snapshot

Advanced feature behavior must not change under an active utterance.

- Create a plugin-side dictation session snapshot at `startDictation`.
- The snapshot drives:
  - start-session payload;
  - note placement options;
  - context-response policy;
  - future render/projection settings;
  - future feature-gating decisions.
- Do not reread live settings for active-session behavior except for developer
  logging or UI display that does not affect output.
- Native session metadata stores the session feature snapshot it receives.

Acceptance:

- Tests flip `useNoteAsContext`, phrase separator, and future-stage-like
  settings after dictation starts and verify active behavior does not change.
- Starting a new session uses the new settings.

### 5. Timing and Capability Baseline

Move timing provenance into the contract before VAD and timestamps build on it.

- Add these fields to `FinalizedUtterance` and through worker/app events:
  - `utterance_index: u64`;
  - `utterance_start_ms_in_session: u64`;
  - `utterance_end_ms_in_session: u64`.
- Add these fields to `TranscriptReadyEvent` and `TranscriptRevision`.
- Add `session_start_unix_ms` to native `SessionConfig` and the start-session
  command path.
- Track retained audio frame positions so pre-speech padding is included in
  `utterance_start_ms_in_session`.
- Add segment timing provenance now:
  - `TimestampSource = engine | vad | interpolated | none`;
  - `TimestampGranularity = utterance | segment | word`;
  - `TranscriptSegment.timestamp_source`;
  - `TranscriptSegment.timestamp_granularity`.
- Replace `supportsTimedSegments` with:
  - `supportsSegmentTimestamps`;
  - `supportsWordTimestamps`.
- Set current capabilities:
  - Whisper: segment timestamps true, word timestamps false;
  - Cohere Transcribe: both false.
- Populate current segments:
  - Whisper segments: `source=engine`, `granularity=segment`;
  - Cohere single utterance segment: `source=vad`, `granularity=utterance`.
- Do not add timestamp rendering settings or marker insertion in PR 61.

Acceptance:

- Rust and TypeScript protocol parsers round-trip the new timing fields.
- Existing model-management UI gates from the split capabilities.
- No TypeScript code infers engine-specific timestamp support by family name.
- Segment objects never contain rendered timestamp strings.

### 6. Plugin Journal and Projection Rules

Make the plugin side safe for empty finals and future speculative revisions.

- `SessionJournal` rejects or ignores `isFinal=false` revisions that arrive
  after an accepted final revision for the same utterance.
- Later `isFinal=true` revisions may replace earlier final revisions when the
  revision number is newer.
- Empty final revisions are accepted into the journal.
- Projection behavior:
  - empty final with no projected partial: journal only, no note append;
  - empty final after an unlatched projected partial: replace anchor with empty
    text so the partial disappears;
  - empty final after user latch: leave user text untouched and keep the journal
    revision.
- User-wins latch remains absolute.

Acceptance:

- Tests cover partial `r0` append, partial `r1` replace, final `r2` replace,
  and partial `r3` ignored after final.
- Tests cover empty final journal persistence and the three projection cases
  above.

### PR 61 Verification

Run:

- `npm test -- --run test/protocol.test.ts test/plugin-settings.test.ts test/dictation-session-controller.test.ts test/session.test.ts test/session-journal.test.ts test/capability-view.test.ts`
- `cargo test --manifest-path native/Cargo.toml protocol`
- `cargo test --manifest-path native/Cargo.toml transcription`
- `cargo test --manifest-path native/Cargo.toml session`
- `cargo test --manifest-path native/Cargo.toml worker`
- `cargo test --manifest-path native/Cargo.toml stages`
- `cargo test --manifest-path native/Cargo.toml`

If full Rust tests hit the known clippy/bindings issue, use the build/test path
from `docs/lessons.md` and report the exact skipped command.

## PR 2 - VAD Trace Through the Pipeline

### 1. Internal VAD Trace Type

Add `native/src/vad_trace.rs` and export it from `native/src/lib.rs`.

Types:

- `VadTrace`
  - `frame_duration_ms: u32`
  - `speech_threshold: f32`
  - `negative_threshold: f32`
  - `probabilities: Vec<f32>`
- `VadSegmentEvidence`
  - `frame_count: u32`
  - `voiced_frame_count: u32`
  - `voiced_fraction: f32`
  - `mean_probability: f32`
  - `max_probability: f32`
  - `voiced_seconds: f32`

Behavior:

- `summarize_ms(start_ms, end_ms, threshold)` floors the start frame, ceils the
  end frame, clamps to trace duration, and returns `None` when there is no frame
  overlap.
- Use `0.35` as the default VAD evidence threshold for `voiced_seconds` and
  `voiced_fraction`. This is below the normal Silero speech threshold and is
  deliberately conservative on the side of treating audio as voiced.
- Raw probabilities stay internal.

Acceptance:

- Tests cover exact-frame ranges, partial-frame rounding, out-of-range clamps,
  zero-length ranges, empty traces, and no-overlap behavior.

### 2. Capture Frames With VAD Evidence

Update `ListeningSession` so audio and probability cannot drift apart.

- Introduce an internal captured-frame struct containing:
  - PCM samples for one 20 ms frame;
  - `start_ms_in_session`;
  - VAD probability.
- Replace `pre_speech_frames` and `utterance_frames` element types with that
  struct.
- Extend `FinalizedUtterance` with:
  - `vad_trace: VadTrace`;
  - the timing fields added by PR 61.
- Build samples and probabilities from the same retained frame slice.
- Natural finalization, graceful stop, boundary split, and hard-cap split must
  slice audio and VAD trace identically.

Acceptance:

- Session tests verify trace length matches retained audio frame count for
  pre-speech padding, post-speech padding, graceful stop, boundary split, and
  max-utterance split.
- Session-relative start/end timings include retained pre-speech padding.

### 3. Move VAD Trace Through App and Worker

Carry the trace by ownership until the worker borrows it for adapters/stages.

- Add `vad_trace` to `PendingContextRequest`.
- Forward it in `WorkerCommand::TranscribeUtterance`.
- Add `vad_trace` to `TranscriptionRequest`.
- Add `vad_trace: &VadTrace` to `StageContext`.
- Pass the same trace into `assemble_transcript`.
- Queue overload continues to drop the entire utterance, including trace.

Acceptance:

- App tests verify pending context requests preserve trace and timing fields.
- Worker tests verify a processor can read `ctx.vad_trace`.
- Worker tests verify engine stage diagnostics remain aligned with engine
  segments.

### 4. Compact Segment Diagnostics

Expose compact VAD evidence where downstream consumers already look for segment
quality data. Do not expose the raw trace on `transcript_ready`.

- Introduce or extend `SegmentDiagnostics` in `native/src/protocol.rs`:
  - `avg_logprob: Option<f32>`;
  - `compression_ratio: f32`;
  - `no_speech_prob: Option<f32>`;
  - `voiced_seconds: f32`;
  - `vad: Option<VadSegmentDiagnostics>`.
- `VadSegmentDiagnostics` mirrors the compact evidence fields that are safe to
  serialize.
- Add `segment_diagnostics: Option<Vec<SegmentDiagnostics>>` to
  `EngineStagePayload`.
- The diagnostics vector must match engine segments 1:1 when present.
- `voiced_seconds` is derived from VAD evidence when overlap exists. When no VAD
  overlap exists, VAD corroboration in later filters must require
  `vad.frame_count > 0`; a zero value alone is not proof of silence.
- Update TypeScript parser/test fixtures so stage payload diagnostics survive
  camelCase parsing.

Acceptance:

- Whisper diagnostics use each engine segment's timestamps against the trace.
- Cohere diagnostics summarize the full utterance range.
- Diagnostics are omitted or marked `vad: undefined` for no-overlap ranges
  instead of treating missing evidence as silence.

### 5. Adapter Behavior

Whisper:

- Keep engine segment timestamps as `source=engine`, `granularity=segment`.
- Continue using Whisper `avg_logprob`, `no_speech_prob`, and compression.
- Replace duration-derived `voiced_seconds` with VAD-derived evidence.
- Clamp out-of-range Whisper timestamps to the trace duration.

Cohere Transcribe:

- Keep single segment timing as `source=vad`, `granularity=utterance`.
- Keep `avg_logprob=None` and `no_speech_prob=None`.
- Use VAD evidence across `0..duration_ms` for `voiced_seconds` and
  `vad` diagnostics.

Acceptance:

- Unit tests cover Whisper helper behavior with in-range, clamped, and
  zero-overlap timestamps.
- Unit tests cover Cohere full-utterance evidence.

### PR 2 Verification

Run:

- `cargo test --manifest-path native/Cargo.toml session`
- `cargo test --manifest-path native/Cargo.toml vad_trace`
- `cargo test --manifest-path native/Cargo.toml worker`
- `cargo test --manifest-path native/Cargo.toml adapters`
- `cargo test --manifest-path native/Cargo.toml stages`
- `cargo test --manifest-path native/Cargo.toml protocol`
- `cargo test --manifest-path native/Cargo.toml`
- `npm test -- --run test/protocol.test.ts test/dictation-session-controller.test.ts test/session.test.ts test/session-journal.test.ts`

## Downstream Impact

PR 62 should not merge as-is after these two PRs. Rebase it onto the VAD trace
branch and rewrite it as hallucination filter v2:

- HARD artifacts may drop on text alone.
- SOFT phrases such as `thank you`, `bye`, and `you` require corroborating
  evidence.
- VAD corroboration reads compact segment diagnostics or `StageContext.vad_trace`
  with `frame_count > 0`.
- Dropped payloads include timing and provenance from the segment contract.
- Empty filtered finals are journaled by the PR 61 plugin contract.

This keeps the user-visible quality feature small: the filter PR becomes policy
and thresholds, not infrastructure repair.

## Assumptions

- We are still greenfield. Breaking the wire shape is acceptable.
- Silero probabilities at the 20 ms session decision cadence are the evidence
  source; raw ONNX window cadence is not exposed.
- `session_start_unix_ms` is for future wall-clock rendering only. Elapsed
  session timing uses `utterance_start_ms_in_session`.
- Word timings are a future Whisper-only implementation detail. Capability says
  false until word timing objects are actually populated.
- Whole-session LLM polish remains separate from transcript revisions.
