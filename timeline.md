# Feature Timeline

## Contract

Every dictated utterance has a stable `utterance_id` and a monotonic revision
stream. Engine output creates revisions; speculative output is
`is_final=false`, and one finalized engine revision is `is_final=true`.
Post-engine quality stages run only on finalized revisions unless a stage is
explicitly marked partial-safe. Segment text is canonical, joined text is a
projection, and timestamps are metadata with explicit provenance. Timestamp
rendering happens only when a final revision is projected into the note.
Whole-session LLM rewrite is a separate experimental artifact, not a normal
transcript revision; in v1 it is mutually exclusive with rendered timestamps.

## Timing Model

`start_ms` and `end_ms` are always utterance-relative. A later session-level
renderer may derive wall-clock or elapsed-session timestamps, but transcript
segments do not store editor-facing timestamp text.

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

Capability flags should distinguish:

- `supports_segment_timestamps`
- `supports_word_timestamps`
- `supports_diarization`
- `supports_initial_prompt`
- `produces_punctuation`

Do not expose word-level timestamp UI until a model path actually populates
word timing. Cohere Transcribe does not provide timestamps or diarization, so
its v1 timing is `source=vad`, `granularity=utterance`.

## Compatibility Matrix

| Combination | V1 status | Contract |
| --- | --- | --- |
| Speculative + hallucination filter | Yes | Partials bypass post-engine stages; final revision is filtered. |
| Speculative + timestamps | Yes | Partials may carry provisional timing but never render timestamp markers. |
| Speculative + smart separator | Yes | Separator choice is final-revision projection behavior. |
| Speculative + accumulate pauses | Yes | Same audio-pipeline state; pause accumulation defines finalization. |
| Timestamps + hallucination filter | Yes | Drop-only filtering preserves timing on kept segments and audits dropped ranges. |
| Timestamps + user rules | Conditional | Rules that rewrite within segments keep timing; rules that re-segment must mark timing `estimated` or drop word timing. |
| Timestamps + LLM post-process | No in v1 | Enabling session rewrite disables rendered timestamps for that session. |
| Hallucination filter + LLM post-process | Yes | Filter runs before LLM so obvious junk is not rewritten into polished junk. |

## Timeline

### 1. Infrastructure Baseline

Keep the PR 61 stage-runner shape, but harden the contract before adding more
features.

- Add worker-level integration tests for real post-engine chain assembly:
  stage order, revision bumps, disabled-stage outcomes, diagnostics forwarding,
  and final DTO shape.
- Add an explicit finality gate: the worker may emit partial engine revisions,
  but the post-engine runner must skip non-partial-safe stages unless
  `is_final=true`.
- Add `ContextWindow` to `StageContext` separately from engine
  `initial_prompt`, so future stages can use context even when an engine cannot.
- Gate context requests before asking the plugin for note context when the
  selected engine cannot consume it.
- Align durable docs: D-015 and `docs/system-architecture.md` currently disagree
  on whether text stages may re-segment.
- Add utterance start offsets to the audio/session contract. Per-utterance
  `0..duration` timing is enough for transcript internals, but timestamp
  rendering and pause-aware features need a stable session timeline.

### 2. Hallucination Filter

Ship first as a conservative quality stage.

- Drop-only in v1: no reflow, no boundary changes.
- Use evidence-based classification. Common phrases such as `thank you` and
  `bye` are never unconditional drops.
- Split phrase rules into hard artifacts and soft phrases:
  - hard: caption/source artifacts such as `subtitles by ...`
  - soft: common hallucinated speech that requires corroboration from VAD,
    `no_speech_prob`, low logprob, compression, repetition, or very low voiced
    duration
- Include dropped segment `index`, `text`, `start_ms`, `end_ms`, timing source,
  timing granularity, and reasons in the stage payload.
- Preserve filtered-empty final revisions in the session journal while skipping
  note projection of empty text.

### 3. Accumulate Pauses

Implement thought-level finalization before speculative transcription.

- One-sentence mode stays eager.
- Always-on mode uses two thresholds:
  - short pause: update UI and keep accumulating
  - thought boundary: finalize after sustained low speech probability or user stop
- Store pause duration between finalized utterances for smart separator and
  timestamp rendering policy.
- Keep a max utterance cap with boundary-aware split.

### 4. Timestamp Rendering

Add user-facing timestamps only after provenance exists.

- Modes:
  - `off`
  - `utterance`
  - `long_pause`
  - `interval`
  - later: `word` only when populated by a capable engine
- Settings:
  - timestamp mode
  - format: `[MM:SS]`, `[HH:MM:SS]`
  - minimum interval between rendered markers
  - placement: inline prefix or own line
- Render markers only on final revisions. Never commit timestamp text for a
  speculative partial.

### 5. Speculative Transcription

Build after pause accumulation and final projection semantics are stable.

- Start with Whisper only.
- Re-decode the growing utterance buffer at a bounded cadence when the selected
  model can keep up.
- Emit `is_final=false` revisions for partials.
- On VAD finalization, decode once more and emit `is_final=true`.
- Post-engine stages run on the final revision only.
- Treat speculative timing as diagnostic-only. Segment and word boundaries can
  move between re-decodes, so downstream timestamp consumers require `isFinal`.
- Plugin uses `replace_anchor`; if the user edits the span, user-wins latch
  stops further replacement for that utterance.

### 6. Smart Separator

Make separator selection final-revision projection behavior.

- Inputs: prior utterance end, current utterance start, VAD pause duration, and
  user setting.
- Output: space, newline, or paragraph break.
- Do not make this a transcript stage; it is note-rendering policy.

### 7. LLM Post-Processing

Park until the transcript, timestamp, and projection contracts are stable.

- Opt-in experimental setting.
- Local-only, no telemetry, no cloud dependency.
- Whole-session rewrite is a separate `SessionRewrite` artifact.
- V1 disables rendered timestamps for the session.
- User-wins latch remains absolute. If the rewrite cannot preserve latched text,
  reject it.

## Guardrails

- Quality stages must raise quality without silent data loss.
- Empty final text can be valid after filtering; journal it, do not project it.
- Timestamp text is rendered output, never canonical transcript data.
- Word timing is optional data, not a baseline promise.
- Model capability gates drive UI affordances; TypeScript should not mirror
  engine-specific support by hand.
- Any feature that destroys alignment must not masquerade as a normal transcript
  revision.
