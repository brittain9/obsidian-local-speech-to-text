# Feature Timeline

This is the roadmap of major work in flight after the engine-registry foundation.
It's a menu, not a plan — each PR gets its own detailed plan when we pick it up.
The scope and contract surface here are the durable parts; per-PR plans cover
verification, risks, and specific test cases.

## Posture

Greenfield. No users yet. Free to break wire shapes, command schemas, and stage
IDs without migrations or compatibility branches. No `schemaVersion`, no fallback
shims, no legacy renames. Ship one PR at a time on `main`; each one breaks what
it needs to break.

## Contract

Every dictated utterance has a stable `utterance_id` and a monotonic revision
stream. Engine output creates the base revision; post-engine quality stages may
create later finalized revisions. Post-engine quality stages run only on
finalized revisions unless a stage is explicitly marked partial-safe with a
narrower partial contract. Segment text is canonical, joined text is a
projection, and timestamps are metadata with explicit provenance. Timestamp
rendering happens only when a final revision is projected into the note.
Per-utterance LLM cleanup is an alignment-preserving final-only stage.
Whole-session LLM polish is a separate experimental artifact, not a normal
transcript revision; in v1 it is mutually exclusive with rendered timestamps.

## UX Contract

Advanced features are session-scoped. Settings are snapshotted when dictation
starts; changes made during active dictation apply to the next session. Features
that cannot run together stay visible in settings, but disabled controls must
name the active conflict. The default experience stays simple: hallucination
filter on, timestamps off, LLM cleanup off, session polish off, diarization off.
Machine-owned projected text may be replaced by later revisions, but the
user-wins latch is absolute. Empty filtered utterances are silent in the note
and preserved in the journal/developer diagnostics.

## Timing Model

`start_ms` and `end_ms` are always utterance-relative. A session-level renderer
derives wall-clock or elapsed-session timestamps from
`utterance_start_ms_in_session` (added by PR 1). Every transcript segment carries
its own timing source and granularity. Word timings, when added, carry their own
provenance too. No transcript object stores editor-facing timestamp text.

Timing provenance and timing granularity are separate:

| Field | Values | Meaning |
| --- | --- | --- |
| `timestamp_source` | `engine`, `vad`, `interpolated`, `none` | Where the timing came from. |
| `timestamp_granularity` | `utterance`, `segment`, `word` | The precision the consumer may rely on. |

Examples:

- Whisper segment timing: `source=engine`, `granularity=segment`.
- Future Whisper word timing: `source=engine`, `granularity=word`.
- Cohere fallback timing: `source=vad`, `granularity=utterance`.
- Text-stage re-segmentation after timed input: `source=interpolated`,
  `granularity=segment`.

Capability flags distinguish:

- `supports_segment_timestamps`
- `supports_word_timestamps`
- `supports_diarization`
- `supports_initial_prompt`
- `produces_punctuation`

Word-level timestamp UI is not surfaced until a model path actually populates
word timing.

## Compatibility Matrix

| Combination | v1 | Contract |
| --- | --- | --- |
| Timestamps + hallucination filter | Yes | Filter is drop-only; kept segments retain timing. Dropped segments and their time ranges are recorded for the journal. |
| Timestamps + LLM cleanup | No in v1 | Mutually exclusive. Settings UI gates one when the other is on. |
| Hallucination filter + LLM cleanup | Yes | Filter runs first; LLM never sees obvious junk. |
| Session polish + timestamps | No in v1 | Whole-session rewrite can destroy alignment, so timestamps are disabled for that session. |
| Diarization + timestamps | Future yes | Speaker labels attach to timed segments; timestamp rendering remains projection-only. |
| Diarization + session polish | No in first pass | Session rewrite must preserve speaker spans before these can run together. |

## PR sequence

PRs 1 and 2 are the foundation — every later PR depends on the contract surface
they establish. After that, the order optimizes for landing the user-visible
filter fix (PR 3) early, then layering UX features on the stable finality and
timing contracts.

### PR 1 — Infrastructure baseline ✅ shipped (#61)

Lock the contracts so every later PR plugs into a stable surface.

- Add `runs_on_partials: bool` to the `StageProcessor` trait. Default `false`;
  set `true` only on stages with a documented narrower partial contract.
- Add a finality gate to `run_post_engine`: if `is_final` is false, skip stages
  with `runs_on_partials = false`, emitting `Skipped { reason: "partial" }`.
- Stop hard-coding `is_final = true` in `assemble_transcript`; take it as a
  parameter.
- Add `ContextWindow` to `StageContext` (separate from engine `initial_prompt`)
  so future stages consume note context without an engine round trip.
- Gate `ContextRequest`: don't ask the plugin for note context when family
  `supports_initial_prompt = false` and no post-engine stage requested it.
- Session contract carries a stable session t0:
  `SessionConfig.session_start_unix_ms`, and transcript-ready events carry
  utterance/session anchors derived from canonical audio bounds.
- Snapshot advanced feature settings at session start. Mid-session settings
  changes apply to the next dictation session only.

**Contract additions:** `runs_on_partials` capability, `Skipped { reason: "partial" }`
outcome, `is_final` parameter on `assemble_transcript`, typed finality on
`StageOutcome`, `utterance_start_ms_in_session`, session-scoped feature
snapshot.

### PR 2 — VAD evidence through the pipeline ✅ shipped (#67)

The VAD signal becomes a first-class pipeline input. Every downstream stage
that wants it (filter today, timestamp renderer tomorrow) reads it from a
single source. Wire format stays compact; the per-frame trace stays in-process.

- `ListeningSession` attaches start time and Silero probability to every
  buffered frame (`BufferedAudioFrame`), cleared on finalize.
- Aggregate `VoiceActivityEvidence` (audio bounds, plain `u64` speech bounds,
  `voiced_ms` / `unvoiced_ms`, mean / max probability) is built once at
  `flatten_frames` and lives on `FinalizedUtterance`.
- Per-frame trace `vad_probabilities: Vec<f32>` (one per 20 ms PCM frame, 50 Hz)
  also lives on `FinalizedUtterance`. Length is aligned to retained samples by
  construction.
- The aggregate flows through `WorkerCommand::TranscribeUtterance`, the engine
  stage payload (`stageResults[0].payload.voiceActivity` on the wire), and
  `StageContext.voice_activity`. Finality is carried by typed
  `StageOutcome.is_final` / `stageResults[].isFinal`, not by the engine payload.
- The trace flows through worker dispatch into `StageContext.vad_probabilities`
  as a borrowed slice. It is never serialized to the plugin.
- New helper `voiced_fraction(probabilities, range_start_ms, range_end_ms,
  threshold)` in `audio_metadata.rs`. Coordinates are utterance-local
  milliseconds (matches Whisper and Cohere segment timestamps).
- Aggregate `voiced_ms` / `speech_*_ms` use a fixed 0.35 threshold so ratios
  are comparable across sessions even when `SpeakingStyle` changes the per-
  session VAD threshold (0.40 / 0.50 / 0.55).
- When no retained frame meets the threshold, `speech_start_ms` and
  `speech_end_ms` collapse to `audio_start_ms`. Consumers detect "no voice"
  via `speech_end_ms == speech_start_ms`; the renderer-side `TimestampSource`
  enum carries the same signal at the projection layer.

**Pulled forward from PR 5 (landed here as architectural prerequisites):**

- Capability split: `supports_timed_segments` is replaced with
  `supports_segment_timestamps` and `supports_word_timestamps`.
- `TimestampSource = engine | vad | interpolated | none` and
  `TimestampGranularity = utterance | segment | word` ride on every
  `TranscriptSegment`. Adapters populate both at the engine boundary.
- `transcript_ready` carries `session_start_unix_ms`, `utterance_index`,
  `utterance_start_ms_in_session`, and `utterance_end_ms_in_session` so the
  PR 5 renderer has everything it needs to anchor `[MM:SS]` markers without
  another wire round trip.

**Contract additions:** `voiceActivity` on `EngineStagePayload` (wire),
`voice_activity` and `vad_probabilities` on `StageContext` (in-process),
fixed 0.35 threshold for aggregate fields, `voiced_fraction` helper,
capability split, `TimestampSource` / `TimestampGranularity` on
`TranscriptSegment`, session/utterance anchors on `transcript_ready`.

**Deferred to PR 3:** `SegmentDiagnostics.voiced_seconds` and the Whisper /
Cohere adapter wiring that calls `voiced_fraction` per segment land with the
hallucination filter that consumes them. Defining the wire shape now would
risk rework when the only real consumer arrives.

### PR 3 — Hallucination filter v2 (HARD / SOFT + corroboration) ⬅ next

The user-visible quality fix. Today's filter drops `thank you` and `bye`
unconditionally; this PR replaces that with evidence-based classification.

- Split the blocklist:
  - **HARD** — drop on text match alone. Caption/source artifacts (`subtitles
    by …`, `captions by`, `transcribed by`), bracketed sound tags (`[music]`,
    `[applause]`, `[blank_audio]`), YouTube CTA templates (`please subscribe …`,
    `see you in the next video`, `let me know in the comments`), domain markers
    (`www.mooji.org`).
  - **SOFT** — text match alone is not enough. `thank you`, `thank you for
    watching`, `thanks for watching`, `thank you so much (for watching)`,
    `thank you very much`, `bye`, `bye bye`, `goodbye`, `see you next time`,
    `i'll see you next time`.
  - Punctuation-only artifacts such as `.` stay HARD.
  - Single-word `you` moves to SOFT; exact-segment matching alone is still not
    enough to drop legitimate dictation.
- On partial revisions, run only the HARD artifact subset. Do not run SOFT
  phrase filtering, prompt-leak filtering, or confidence/VAD heuristics until
  the final revision.
- Drop a final-revision SOFT match only with at least one corroborator: existing silence rule
  (`no_speech_prob > 0.6 AND avg_logprob < -1.0`), loose silence (`> 0.5 AND
  < -0.7`), short voiced span (`voiced_seconds < 1.2 AND avg_logprob < -0.7`),
  or VAD corroboration (`voiced_fraction < 0.35`).
- Add a 5-gram-counted-2 repetition rule alongside the existing 3-gram rule.
- Add a prompt-leak rule, but never drop a single glossary term. Drop only when
  the output includes prompt scaffolding such as `Glossary:` or reproduces a
  large contiguous prompt span, and corroborating low-speech/low-confidence
  evidence is present.
- Adapters without `avg_logprob` / `no_speech_prob` (Cohere) fall back to
  VAD-only corroboration; loose-silence is skipped automatically.
- `dropped_segments` payload names the specific rule (`blocklist_hard`,
  `blocklist_soft_corroborated`, `silence`, `compression`, `repetition`,
  `prompt_leak_corroborated`) and includes `index`, `text`, `start_ms`,
  `end_ms`, `timestamp_source`, and `timestamp_granularity`.

**Contract additions:** `dropped_segments[].reason` gains `blocklist_hard`,
`blocklist_soft_corroborated`, `prompt_leak_corroborated`. Filter reads
`initial_prompt` via `StageContext`.

### PR 4 — Queuing behavior + pause metadata

Two-part PR. Closes #11 (always-on queuing) and lays the pause field that PR 5
consumes. Endpointing thresholds (`silence_end_frames`) stay as they are —
current Responsive 400 ms / Balanced 1000 ms / Patient 2000 ms is already
aligned with Deepgram / Google / iOS practice.

**Queuing behavior (issue #11).** Today `MAX_QUEUED_UTTERANCES = 1` and
overflow silently drops audio. Replace with a depth-tiered backpressure model
that processes in order and never drops audio:

| Queued utterances | Behavior |
| --- | --- |
| 0–2 | Silent. Normal. |
| 3+ | Subtle indicator: "Transcribing… catching up." |
| 10+ | Visible warning: "Transcription is falling behind — pause to let it catch up." |
| 30 (hard cap) | Stop session with a clear error. Save what's already transcribed. |

There is no pause-while-processing mode. The hard cap stops the session instead
of silently dropping audio during normal processing.

**Pause metadata (PR 5 prerequisite).**

- `FinalizedUtterance.pause_ms_before_utterance: Option<u64>`, measured
  speech-to-speech (previous utterance's `speech_end_ms` to the current
  utterance's `speech_start_ms`). Speech-to-speech is what humans perceive as
  the pause between thoughts; VAD-bound gaps inflate by trailing silence.
- `None` for the first utterance of a session.
- `None` for the continuation half of a `MAX_UTTERANCE_FRAMES` split — that
  boundary is a length cap, not a thought boundary, and downstream renderers
  must not treat it as a pause signal.
- Flows through `WorkerCommand::TranscribeUtterance`, the engine stage
  payload, and `StageContext` so PR 5's renderer can read it without another
  wire round trip.
- `MAX_UTTERANCE_FRAMES` cap and boundary-aware split unchanged.

**Contract additions:** `pause_ms_before_utterance` on `FinalizedUtterance`,
on `WorkerCommand::TranscribeUtterance`, on the engine stage payload, and on
`StageContext`. New backpressure status surface from the sidecar to the plugin
(queue depth tier).

### PR 5 — Transcript rendering: smart paragraphs + timestamps ✅ shipped

Originally scoped as two PRs (timestamps, then smart separator); shipped as one
because both are projection concerns that share the same pause classifier and
the same renderer state, and splitting them would have churned the
`NoteSurface`/`Session` boundary twice. Pure plugin-side; the metadata surface
(`pause_ms_before_utterance`, session/utterance anchors,
`TimestampSource`/`TimestampGranularity`) landed in PRs 2 and 4.

What shipped:

- `transcriptFormatting: smart | space | new_line | new_paragraph`, default
  `smart`. Smart mode joins utterances with a space when the inter-utterance
  pause is below the meaningful-pause threshold and with a blank-line paragraph
  break at or above it. The threshold is a single fixed constant
  (`SMART_PARAGRAPH_PAUSE_MS = 3000`); no user-facing density knob.
- `showTimestamps: boolean`, default `false`. When on, sparse inline elapsed-
  session markers render as `(M:SS)` below one hour and `(H:MM:SS)` at one hour
  or above. A marker is emitted on the first rendered utterance, after any
  meaningful pause, and at the next utterance boundary 30 s after the last
  emitted marker (`TIMESTAMP_LANDMARK_INTERVAL_MS = 30_000`). The same pause
  classifier drives smart-paragraph boundaries and long-pause timestamp
  emission — there is no separate timestamp threshold.
- New plugin-side module `src/transcript/renderer.ts` owns transcript projection
  state (whether anything has rendered, last emitted timestamp). `Session` owns
  one `TranscriptRenderer` per dictation session and coordinates
  `planAppend` → surface write → `commitAppend`. Renderer state is committed
  only after a successful editor write, so denied appends do not advance
  timestamp landmarks.
- `NoteSurface` becomes a prefix-only projection writer. Boundary and timestamp
  prefixes are stored inside the span (`start..end`), so user edits to either
  latch the utterance via the existing user-wins rule (D-014). Replacements
  rewrite only the utterance text region (`textStart..textEnd`); timestamp text
  and paragraph breaks from the original append remain stable across revisions.
- The old eager trailing-separator model is gone; nothing leaves dangling blank
  lines while waiting for the next utterance.
- `pauseMsBeforeUtterance` is threaded through `TranscriptRevision` and the
  session journal. `null` (first utterance, cap-split continuation) is not a
  meaningful-pause signal; cap-split continuations stay as a space in smart
  mode but the 30-s landmark interval can still fire.
- Settings: `phraseSeparator` is removed cleanly (greenfield, no migration);
  unknown persisted fields are ignored by `resolvePluginSettings`.

**Contract additions:** none in the sidecar. `TranscriptRevision` gains
`pauseMsBeforeUtterance`. `NotePlacementOptions` drops separator concerns.
`NoteSurface` exposes `readProjectionContext()` + `appendProjection()`; renderer
options are passed separately from placement options on session creation.

### PR 6 — LLM cleanup (experimental, opt-in)

Per-utterance disfluency cleanup. Park until PRs 1-5 are stable.

- New runtime: `RuntimeId::LlamaCpp` via the `llama-cpp-2` binding (pinned
  exact version).
- Two presets, both Q4_K_M: **Fast** (Qwen 2.5 1.5B Instruct, ~1 GB) and
  **Quality** (Llama 3.2 3B Instruct, ~2 GB).
- New stage `LlmCleanupStage`; `runs_on_partials = false`.
- Alignment-preserving cleanup: may delete filler/false starts and adjust light
  casing or punctuation, but must not re-segment, summarize, reorder, or
  rephrase the user's meaning.
- Validation chain (any failure → `StageStatus::Failed`, prior revision stays):
  - Output length within `[0.5×, 1.5×]` of input.
  - Word-level normalized edit distance ≤ 0.3.
  - GBNF grammar forbids leading "Sure, here is", code fences, "I cannot…",
    quote-wrapping the whole output.
  - Stop sequences: `\n\nInput:`, `\n\n#`.
- Mutual exclusion: when LLM is on, timestamps are forced off for the session.
  Settings UI surfaces the gate with a reason; runtime double-checks against
  the session-scoped feature snapshot.
- Latch: cleaned utterances are revisions; user-wins latch absorbs them
  identically to any other downstream stage.

**Contract additions:** `RuntimeId::LlamaCpp`, new `StageId::LlmCleanup`.

### Later — Session polish

Whole-session rewrite is not a transcript stage. It ships as a separate
`SessionRewrite` artifact behind an explicit "Polish session" command.

- Opt-in command, never automatic while dictation is active.
- Mutually exclusive with rendered timestamps in v1.
- Reject output that cannot preserve user-latched text.
- Do not combine with diarization until the rewrite can preserve speaker spans.

**Contract additions:** `SessionRewrite` artifact, separate from transcript
revision history.

### Later — Diarization

Speaker labeling belongs upstream in the audio pipeline alongside VAD.

- Off by default.
- Segment annotation, not a post-engine text stage.
- Fields: `speaker_id`, `speaker_source`, optional `speaker_confidence`.
- UX modes: `off`, `speaker_change_prefix`, `every_segment`.
- Compatible with timestamps because both attach to timed segments.
- Not compatible with session polish until polish preserves speaker spans.

**Contract additions:** speaker annotations on timed transcript segments.

## Guardrails

- Greenfield: no `schemaVersion`, no migration paths, no compatibility
  branches. Break what you need to break.
- Quality stages must raise quality without silent data loss.
- Empty final text can be valid after filtering; journal it, do not project it.
- Timestamp text is rendered output, never canonical transcript data.
- Word timing is optional data, not a baseline promise.
- Model capability gates drive UI affordances; TypeScript should not mirror
  engine-specific support by hand.
- Any feature that destroys alignment must not masquerade as a normal
  transcript revision.
- Diarization belongs upstream in the audio pipeline alongside VAD; it is not
  a post-engine stage.
