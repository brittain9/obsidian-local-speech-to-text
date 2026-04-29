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
stream. Engine output creates revisions; speculative output is `is_final=false`,
and one finalized engine revision is `is_final=true`. Post-engine quality stages
run only on finalized revisions unless a stage is explicitly marked
partial-safe with a narrower partial contract. Segment text is canonical, joined
text is a projection, and timestamps are metadata with explicit provenance.
Timestamp rendering happens only when a final revision is projected into the
note. Per-utterance LLM cleanup is an alignment-preserving final-only stage.
Whole-session LLM polish is a separate experimental artifact, not a normal
transcript revision; in v1 it is mutually exclusive with rendered timestamps and
with speculative transcription.

## UX Contract

Advanced features are session-scoped. Settings are snapshotted when dictation
starts; changes made during active dictation apply to the next session. Features
that cannot run together stay visible in settings, but disabled controls must
name the active conflict. The default experience stays simple: hallucination
filter on, timestamps off, live partials auto, LLM cleanup off, session polish
off, diarization off. Partial text may be replaced until finalization, but the
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
| Speculative + hallucination filter | Yes | Partial-safe mode may drop only obvious HARD artifacts; full SOFT/evidence filter runs on finals. Other post-engine stages skip on partials. |
| Speculative + timestamps | Yes (read-only on partial) | Partials may carry provisional timing for diagnostics; timestamp markers render in the note only on `is_final=true`. |
| Speculative + accumulate pauses | Yes | Same audio pipeline. Pause boundary triggers the final decode. |
| Speculative + smart separator | Yes | Separator is a final-revision projection concern. |
| Timestamps + hallucination filter | Yes | Filter is drop-only; kept segments retain timing. Dropped segments and their time ranges are recorded for the journal. |
| Timestamps + LLM cleanup | No in v1 | Mutually exclusive. Settings UI gates one when the other is on. |
| Speculative + LLM cleanup | No in v1 | LLM cleanup runs on `is_final=true` only and would mis-render against still-replacing partials. Settings UI gates. |
| Hallucination filter + LLM cleanup | Yes | Filter runs first; LLM never sees obvious junk. |
| Session polish + timestamps | No in v1 | Whole-session rewrite can destroy alignment, so timestamps are disabled for that session. |
| Diarization + timestamps | Future yes | Speaker labels attach to timed segments; timestamp rendering remains projection-only. |
| Diarization + session polish | No in first pass | Session rewrite must preserve speaker spans before these can run together. |

## PR sequence

PRs 1 and 2 are the foundation — every later PR depends on the contract surface
they establish. After that, the order optimizes for landing the user-visible
filter fix (PR 3) early, then layering speculative + UX features on the stable
finality and timing contracts.

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

### PR 4 — Pause accumulation

Thought-level finalization in always-on mode. Smart separator and timestamp
rendering both depend on pause metadata, so this PR ships before either.

- One-sentence mode unchanged.
- Always-on mode: short pause keeps accumulating into the same utterance; a
  sustained low-VAD thought boundary finalizes it. Threshold is driven by
  `SpeakingStyle`: Responsive 1.5 s / Balanced 2.5 s / Patient 3.5 s.
- `FinalizedUtterance.pause_ms_before_utterance: Option<u64>`, computed at the
  current utterance's start; `None` for the first utterance of a session. This
  lets timestamp and separator projection decide before inserting the current
  utterance, with no retroactive note edit.
- `MAX_UTTERANCE_FRAMES` cap and boundary-aware split unchanged.

**Contract additions:** `pause_ms_before_utterance` on `FinalizedUtterance`.

### PR 5 — Timestamp rendering

User-facing timestamps with explicit provenance. The metadata surface
(`TimestampSource`, `TimestampGranularity`, capability split, session/
utterance anchors) landed in PR 2; PR 5 only adds the renderer + settings.

- Settings: `timestampMode (off | utterance | long_pause | interval)`,
  `timestampFormat ([MM:SS] | [HH:MM:SS])`, `timestampMinIntervalSec`,
  `timestampPlacement (inline_prefix | own_line)`.
- Renderer uses `utterance_start_ms_in_session` +
  `pause_ms_before_utterance` to decide marker emission for `long_pause` mode.
- Render markers only on `is_final = true` revisions.
- Word-timestamp UI is not surfaced until an engine populates word timing.

**Contract additions:** none in the sidecar; renderer and settings are
plugin-side. All required segment metadata and session anchors shipped in
PR 2.

### PR 6 — Speculative transcription

Live partials on tiny.en / base.en. Depends on PRs 1-5 for the contract surface.

- Whisper adapter only. Cohere is request-response; nothing to do.
- Worker partial loop: re-decode-on-grow with an `audio_ctx` ramp. Skip below
  1.0 s of audio; cadence is 400-750 ms by audio length; final decode at full
  settings.
- Partial decode params: `set_audio_ctx`, `set_no_context(true)`,
  `set_single_segment(true)`, `set_temperature(0)`. Pad to ≥ 1.0 s with zeros
  if needed.
- LocalAgreement-2 per active utterance: `committed` + `buffer` lists. Two
  consecutive decodes agree on a token at the same position → it moves to
  `committed`. Volatile suffix is `buffer`. Port the n-gram dedup against
  `committed_in_buffer`.
- Each partial decode → `revision = N+1`, `is_final = false`. VAD finalization
  → final decode at full settings → `is_final = true`. Buffer cleared.
- Race guard: each decode carries an internal `(utterance_id,
  requested_revision)` tuple. Worker writes only if `requested_revision >
  last_committed_revision` and the utterance is not yet finalized; the final
  decode supersedes any in-flight partial unconditionally.
- `initial_prompt` is identical on every decode in an utterance. Do not feed
  prior partial output back via `set_tokens`.
- Settings: `livePartials: auto | always | off`. `auto` = on for tiny.en /
  base.en, off otherwise.
- Plugin uses `replace_anchor`; user-wins latch absorbs partial revisions
  identically to final ones.

**Contract additions:** worker becomes the canonical producer of
`is_final = false` revisions; multiple `TranscriptReady` events per utterance
with monotonic `revision`.

### PR 7 — Smart separator

Choose space / newline / paragraph between consecutive utterances.

- Pure plugin-side. Not a transcript stage.
- Inputs: current utterance's `pause_ms_before_utterance`, user setting (`separator:
  space_default | newline_short_pause | paragraph_long_pause`).
- `selectSeparator(prevPauseMs, settings)` returns `" "`, `"\n"`, or `"\n\n"`.
- When the existing `phraseSeparator` setting is `new_line` or `new_paragraph`,
  smart separator is disabled.

**Contract additions:** none in the sidecar; pure plugin projection.

### PR 8 — LLM cleanup (experimental, opt-in)

Per-utterance disfluency cleanup. Park until PRs 1-7 are stable.

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
- Mutual exclusion: when LLM is on, timestamps and speculative are forced off
  for the session. Settings UI surfaces the gate with a reason; runtime
  double-checks against the session-scoped feature snapshot.
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
