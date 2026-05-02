# Per-Utterance Ollama LLM Postprocess Plan

## Summary

Add an experimental `llm_postprocess` text-pipeline stage that runs once per
finalized utterance, after the engine and the hallucination filter. The user
configures an Ollama model plus the full LLM cleanup tuning surface in an
always-available Local Transcript sidebar: context source, context budget,
system prompt, user-message template, and the quality-affecting Ollama
generation options. Preflight runs once at sidebar enable; if Ollama is
unreachable then, the toggle stays off. After enable, per-utterance Ollama
failures fall through: the stage records `Failed`, the transcript keeps its
post-hallucination-filter shape (raw text), and that revision is what the
plugin appends to the note.

There is exactly one `transcript_ready` event per utterance, fired after every
stage in the chain finishes. There is no raw-then-replace flow, no
`replace_anchor` write, and no user-wins latch interaction for this stage; the
LLM revision (or the raw fallback) is the only write per utterance.

This is not a whole-session rewrite. The LLM operates inside one utterance's
boundaries. The output may freely be Markdown, bullets, or restructured prose
— that is accepted as-is. To avoid mis-aligning per-segment timestamps with
utterance-level transformed text, `llm_postprocess` and `showTimestamps` are
mutually exclusive in v1: when timestamps are on at session snapshot, the
stage is skipped and the raw transcript is appended normally.

## Decisions

- Name the feature and stage `llm_postprocess`.
- Place the stage inside the text pipeline in
  `native/src/stages/mod.rs::post_engine_processors`, registered after
  `HallucinationFilterStage`. The "experimental side branch" framing in
  `docs/system-architecture.md:32` refers to product/release gating, not code
  placement; that doc is amended in lockstep with this plan.
- Keep Ollama user-managed: no bundled Ollama, no auto-start, no lifecycle
  ownership by this plugin.
- Use only the local loopback Ollama endpoint in v1: `http://127.0.0.1:11434`.
  No user-editable endpoint; preserves the no-cloud product contract.
- Use Ollama `/api/chat` with `stream: false`. Chat gives a cleaner
  system/user message split for instruction-tuned models than `/api/generate`.
- Treat LLM cleanup as an experimental developer surface. Expose context
  source, context budget, system prompt, user-message template, temperature,
  max prediction count, seed, and keep-alive in the sidebar. The reset control
  restores all of these editable LLM knobs to their defaults in one action.
- Default context source is `both`: recent note text plus recent finalized
  session transcript text. This covers established notes and fresh empty
  notes without asking the user to predict which source will help a given
  model.
- Default context budget is `2000` characters. The plugin truncates context on
  paragraph, sentence, then word boundaries, never mid-word.
- The LLM context is raw reference prose, isolated inside explicit prompt
  sections. This is intentionally different from Whisper `initial_prompt`,
  where raw prose is forbidden by the 2026-04-27 lesson.
- Use `/api/version` for liveness and `/api/tags` for the dropdown. Use the
  canonical `model` field (not display `name`) for chat dispatch; show `name`
  in the dropdown.
- Keep post-transcript enrichment in the Rust sidecar. The plugin's Ollama
  calls are limited to UI preflight, model listing, and pre-warm.
- `llm_postprocess` and `showTimestamps` are mutually exclusive in v1.
  Revisit only once a segment-aligned LLM design exists.
- One `transcript_ready` per utterance. The LLM revision (on success) or the
  pre-LLM revision (on failure) is what fires. The plugin appends it via the
  normal append path. No two-event protocol, no in-place replacement.
- The LLM revision collapses the utterance's segments into a single synthetic
  segment spanning `[0, voice_activity.duration_ms()]` carrying the
  transformed text. Joined text equals trimmed LLM output. No empty trailing
  segments, no fake per-segment alignment.
- Relax the post-engine validator with a per-stage opt-in. Add
  `StageProcessor::collapses_segment_boundaries(&self) -> bool` (default
  `false`); when `true`, the validator skips the "preserved boundaries" check
  but still enforces in-bounds (`end_ms <= utterance_duration_ms`),
  `start_ms <= end_ms`, and non-overlap. `LlmPostprocessStage` opts in;
  every other stage stays segment-preserving.
- Run the LLM call synchronously on the worker thread. v1 accepts that a
  slow Ollama response head-of-line blocks the next utterance until it
  returns or hits the 60s timeout. Document this as a known v1 trade-off.
- Concurrency cap is implicitly 1 in-flight LLM call per session because the
  worker is single-threaded. We do not add a queue manager; we let Ollama
  handle its own concurrency (`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_QUEUE`).
- Cancellation: a per-session `tokio::sync::watch::Sender<bool>` flips on
  session stop, graceful stop (D-013), and plugin unload. The LLM stage
  wraps its `send/await` in `tokio::select!` against a receiver clone; on
  flip, return `StageProcess::Failed { error: "cancelled" }`. The
  pre-cancellation transcript (raw post-hallucination-filter) flows through
  to the note.
- Preflight runs only at sidebar enable. No second preflight at dictation
  start; per-utterance failure already covers Ollama-died-mid-session and
  avoids mutating persisted settings behind the user's back.
- Pre-warm on enable: send an `/api/chat` with a one-token user message and
  `num_predict: 1`, `keep_alive: "30m"` to load the model into RAM so the
  first utterance does not pay cold-load latency. Empty `messages` is
  unreliable across Ollama versions.
- Filter the model dropdown by name pattern, dropping likely-non-chat
  entries (`embed`, `embedding`, `bge`, `nomic`, `clip`); sort the remainder
  alphabetically. Do not auto-select; require an explicit choice.
- Generation parameter defaults: `temperature: 0.2`, `num_predict: 512`,
  `seed: 0`, `keep_alive: "30m"`. These four are user-editable in the
  experimental sidebar. Transport/response-shape controls stay fixed:
  `think: false`, `stream: false`, no `format`, and no user-editable endpoint.
- HTTP timeouts: `connect_timeout: 2s`, request `timeout: 60s`. Plugin
  preflight uses a 3s overall timeout to tolerate cold Ollama starts.
- Treat `done_reason != "stop"` as failure (including `"length"`) and fall
  back to the raw transcript. Truncated mid-sentence output is worse than
  the original. Surface a single dev-logger warning per session if `length`
  ever hits, so the user can adjust the prompt or model.
- Length-explosion guard: reject when `len(output) > 10 * len(input) + 1000`
  characters. The user owns the prompt, so this only fires on pathological
  blow-up (e.g., model spirals into repetition past `num_predict: 512`); the
  bound is generous enough that "expand into paragraphs" prompts work.
- No semantic guardrails beyond the length cap. The user owns model and
  prompt. Operational safety only: localhost endpoint, bounded timeouts,
  bounded output, fail-open on any error.
- In-flight indicator: derive from existing events. The sidebar renders
  "Processing N utterance(s)…" when `transcription_queue_changed` reports
  `queued_utterances > 0` or `session_state_changed` reports `Transcribing`,
  AND `llm_postprocess` is enabled in the active snapshot. No new wire
  event is added.
- `processing_duration_ms` on `TranscriptReady` becomes total worker
  processing time (engine + hallucination filter + LLM). Per-stage duration
  is preserved on each `StageOutcome.duration_ms` as today.
- Tokio runtime: the worker owns one `tokio::runtime::Runtime` built once at
  worker spawn (current-thread, `enable_all`). Stage code receives a
  `&Runtime` via `StageContext` and calls `runtime.block_on(...)` for the
  HTTP request. Keep `tokio` features as-is (`["macros", "rt", "sync"]`);
  current-thread does not need `rt-multi-thread`.
- Settings reset: a "Reset LLM defaults" button near the LLM controls. It
  restores context source, context budget, system prompt, user-message
  template, temperature, max prediction count, seed, and keep-alive to
  defaults. It does not touch the enable toggle or selected model.
- Plugin unload: send `StopSession` (which flips the cancel watch),
  optionally `await` up to 500ms for the worker to acknowledge, then tear
  down sidecar IPC regardless. Avoids orphan Ollama requests in the common
  case without blocking unload on a misbehaving sidecar.

## User-Facing Behavior

- A Local Transcript sidebar tab is always registered and created in the
  left sidebar on layout ready. It does not steal focus on startup.
- The sidebar contains only LLM postprocess controls in this PR:
  - enable toggle
  - Ollama status line
  - Refresh models button
  - model dropdown populated from Ollama (filtered, sorted)
  - context source dropdown: note, session transcripts, or both
  - context budget character input
  - system prompt textarea
  - user-message template textarea
  - temperature number input
  - max prediction count number input
  - seed number input
  - keep-alive text input
  - "Reset LLM defaults" button
  - mutex hint: when `showTimestamps` is on, show "Disabled while
    timestamps are enabled" near the toggle. Toggle still saves the
    preference; it just won't apply at the next session start.
  - in-flight indicator: a small line that reads "Processing N
    utterance(s)…" while the worker pipeline is non-empty.
- Enabling `llm_postprocess` runs a short Ollama preflight:
  - `GET /api/version`
  - `GET /api/tags`, then filter and sort
  - require an explicit model choice (no auto-select)
  - if a previously selected model is no longer present, enabling fails
    instead of silently switching models
  - on success, fire a pre-warm `/api/chat` with a one-token user message,
    `num_predict: 1`, and `keep_alive: "30m"` against the chosen model.
    Pre-warm failure downgrades to a Notice; it does not block enable.
- If preflight fails, no models are installed, or the selected model is
  absent:
  - leave `llmPostprocessEnabled: false`
  - show: `Start Ollama, then enable LLM post-processing again.`
- No preflight at dictation start. The session honors the snapshot; if
  Ollama is unreachable mid-session, the per-utterance stage returns
  `Failed` and the raw transcript flows through normally.
- When `showTimestamps` is on at session snapshot, `llm_postprocess` is
  treated as disabled for the session. The sidecar receives no
  `llmPostprocess` config and the stage records
  `Skipped { reason: "timestamps_enabled" }` if invoked.
- Per-utterance flow when LLM is active:
  - finalize → engine → hallucination filter → LLM postprocess (single
    blocking call per utterance against `127.0.0.1:11434`)
  - on success: transcript carries one synthetic segment with the LLM
    text; `transcript_ready` fires; plugin appends it to the note
  - on Ollama failure or cancellation: transcript carries the raw
    post-hallucination-filter segments; `transcript_ready` fires; plugin
    appends the raw text
  - failures are recorded on the stage outcome only; no per-utterance
    Notice spam

## Settings Contract

Extend `PluginSettings` with:

- `llmPostprocessEnabled: boolean`, default `false`
- `llmPostprocessModel: string`, default `""` (canonical Ollama model id)
- `llmPostprocessContextSource: "note" | "session" | "both"`, default
  `"both"`
- `llmPostprocessContextBudgetChars: number`, default `2000`
- `llmPostprocessSystemPrompt: string`, default:
  `You clean a single dictated utterance. Use reference context only for spelling, terminology, continuity, and style. Never modify, continue, summarize, or quote the reference context. Return only the cleaned utterance.`
- `llmPostprocessUserTemplate: string`, default:
  `<note_context>\n{{note_context}}\n</note_context>\n\n<session_context>\n{{session_context}}\n</session_context>\n\n<utterance>\n{{utterance}}\n</utterance>\n\n<cleaned>`
- `llmPostprocessTemperature: number`, default `0.2`
- `llmPostprocessNumPredict: number`, default `512`
- `llmPostprocessSeed: number`, default `0`
- `llmPostprocessKeepAlive: string`, default `"30m"`

Resolution rules:

- Model id is trimmed at the settings boundary.
- Context source falls back to `"both"` when persisted data is not one of the
  allowed values.
- Context budget is clamped at the settings boundary to a reasonable positive
  range, e.g. `0..20000`, with `0` meaning no context.
- System prompt and user-message template are preserved as user-authored text,
  except normal string fallback when persisted data is not a string.
- If the user-message template omits `{{utterance}}`, the LLM stage fails open
  for that utterance instead of sending a prompt that lacks the dictated text.
- Temperature is clamped to a practical Ollama range, e.g. `0..2`.
- `num_predict` is clamped to a positive bounded range, e.g. `1..4096`.
- Seed is clamped to a signed 32-bit integer range.
- Keep-alive is trimmed; empty or non-string values fall back to `"30m"`.
- Unknown persisted fields remain ignored as today.
- Settings continue to be snapshotted at dictation start. Mid-session
  sidebar edits apply to the next session.

The default context source, context budget, system prompt, user-message
template, temperature, max prediction count, seed, and keep-alive are exported
from single constants in `src/settings/defaults.ts` (or wherever the existing
defaults live) so the reset button and persisted-default fallbacks share one
source of truth.

## Plugin Implementation

Add a small TypeScript Ollama client under `src/llm/ollama-client.ts`.

- Use Node HTTP APIs against `127.0.0.1:11434` so Obsidian/Electron browser
  CORS behavior is irrelevant.
- Implement:
  - `probeOllama(): Promise<void>` (uses `/api/version`)
  - `listOllamaModels(): Promise<{ id: string; displayName: string }[]>`
    (uses `/api/tags`, filters `embed|embedding|bge|nomic|clip` by display
    name, sorts alphabetically; returns `{ id: model, displayName: name }`)
  - `prewarmModel(modelId: string): Promise<void>` (POST `/api/chat` with
    a one-token user message, `num_predict: 1`, `keep_alive: "30m"`;
    fire-and-forget on failure)
- 3s overall timeout for preflight calls.
- Parse JSON strictly enough to reject malformed responses; do not model
  every Ollama metadata field.

Add a sidebar view under `src/ui/local-transcript-view.ts`.

- Subclass Obsidian `ItemView`.
- Constants:
  - view type: `local-transcript-sidebar`
  - display text: `Local Transcript`
  - icon: stable built-in icon (`audio-lines` or `mic`)
- Render with Obsidian `Setting` primitives.
- Keep view state derived from `PluginSettings` plus transient Ollama
  status plus the in-flight count.
- Save settings through the plugin's existing `updateSettings` path.
- "Reset LLM defaults" button restores `llmPostprocessContextSource`,
  `llmPostprocessContextBudgetChars`, `llmPostprocessSystemPrompt`,
  `llmPostprocessUserTemplate`, `llmPostprocessTemperature`,
  `llmPostprocessNumPredict`, `llmPostprocessSeed`, and
  `llmPostprocessKeepAlive` to the shared defaults and re-saves settings.
- On enable:
  - refresh model list
  - require an explicit model selection; do not auto-select
  - disable on preflight failure, no models, or selected model missing
  - on success: save settings, then fire pre-warm (best-effort)
- On model refresh:
  - update dropdown
  - if currently enabled and refresh fails, disable and emit a single
    Notice
- When `showTimestamps` is true, render the mutex hint and visually mark
  the LLM controls as inactive. Do not auto-mutate either setting.
- Subscribe to `transcription_queue_changed` and `session_state_changed`
  via the existing sidecar bridge to drive the in-flight indicator. The
  count is `queueDepth + (sessionState === 'transcribing' ? 1 : 0)`,
  rendered only when `llmPostprocessEnabled` is true in the active
  snapshot (so the line stays hidden when there is no LLM in play).

Update `src/main.ts`.

- Register the sidebar view in `onload`.
- On layout ready, ensure a left side leaf exists for the Local
  Transcript view with `active: false` and no focus steal.
- Pass view dependencies:
  - `getSettings`
  - `saveSettings`
  - `notice`
  - `logger`
  - Ollama client
  - sidecar event source for queue + state events
- On `onunload`, send `StopSession` if a session is active, await the
  sidecar's stop acknowledgement with a 500ms cap, then tear down IPC.

Update `DictationSessionController`.

- Add `llmPostprocess` to the active session snapshot as either `null` or:
  - `model` (canonical id)
  - `contextSource`
  - `contextBudgetChars`
  - `systemPrompt`
  - `userTemplate`
  - `temperature`
  - `numPredict`
  - `seed`
  - `keepAlive`
- At snapshot time:
  - if settings have `llmPostprocessEnabled: true` AND `showTimestamps:
    false` AND `llmPostprocessModel` is non-empty: include the config
  - otherwise: snapshot `llmPostprocess: null`
- Do not preflight Ollama here; do not mutate persisted settings here.
- Include `llmPostprocess` in `startSession` only when non-null.

## Sidecar Protocol

Break the internal wire contract directly; greenfield project, no compat
shims (`docs/lessons.md` 2026-04-26).

TypeScript `src/sidecar/protocol.ts`:

- Extend `ContextWindowSource` with a raw note source:
  - `{ kind: "note_text"; text: string; truncated: boolean }`
  This is distinct from `note_glossary`; Whisper still receives glossary-shaped
  context, while the LLM receives reference prose.
- Add `LlmPostprocessConfig`:
  - `model: string` (canonical Ollama id)
  - `contextSource: "note" | "session" | "both"`
  - `contextBudgetChars: number`
  - `systemPrompt: string`
  - `userTemplate: string`
  - `temperature: number`
  - `numPredict: number`
  - `seed: number`
  - `keepAlive: string`
- Add optional `llmPostprocess?: LlmPostprocessConfig` to
  `StartSessionCommand`.
- Add `'llm_postprocess'` to `STAGE_IDS` in
  `src/session/session-journal.ts`.
- Parse and encode the new command field through existing start-session
  helpers.

Rust `native/src/protocol.rs`:

- Add matching `ContextWindowSource::NoteText { text, truncated }`.
- Add matching `LlmPostprocessConfig`.
- Add `llm_postprocess: Option<LlmPostprocessConfig>` to
  `Command::StartSession`.
- Add `StageId::LlmPostprocess` (serializes as `llm_postprocess`).

Rust `native/src/worker.rs`:

- `SessionMetadata` gains `llm_postprocess: Option<LlmPostprocessConfig>`
  and a `cancel_rx: tokio::sync::watch::Receiver<bool>`.
- The worker owns a long-lived `tokio::runtime::Runtime` built once at
  spawn (current-thread, `enable_all`).
- Plumb the runtime handle and cancel receiver into `StageContext`.
- `processing_duration_ms` on `WorkerEvent::TranscriptReady` becomes total
  per-utterance worker time (engine + post-engine stages).

Context request flow:

- When `llm_postprocess` is enabled in the session snapshot, context is
  required even if the selected speech engine does not support Whisper
  initial prompts.
- The sidecar requests at least `llmPostprocess.contextBudgetChars` when the
  LLM stage needs context. If Whisper initial prompt context is also needed,
  request a budget large enough for both consumers and let the plugin assemble
  source-typed context.
- The plugin answers with `ContextWindow.sources` filtered by
  `llmPostprocessContextSource` for LLM sources, while preserving existing
  `note_glossary` behavior for Whisper-capable engines.
- For `contextSource: "both"`, include both `note_text` and
  `session_utterance` sources when available. For `"note"` include only
  `note_text`; for `"session"` include only `session_utterance`.
- Session transcript context uses finalized utterances already accepted by the
  session journal; it never includes the utterance currently being processed.
- Context truncation happens in the plugin on paragraph, sentence, then word
  boundaries. It sets each source's `truncated` flag plus the aggregate
  `ContextWindow.truncated`.

`StageContext` gains:

- `tokio_runtime: &'a tokio::runtime::Runtime`
- `llm_postprocess: Option<&'a LlmPostprocessConfig>`
- `context: Option<&'a ContextWindow>` is already present and is consumed by
  this stage when `llm_postprocess` is enabled.
- `cancel_rx: &'a tokio::sync::watch::Receiver<bool>`

The hallucination filter ignores the LLM config, runtime, and cancellation
fields; it continues to use context only for prompt-leak filtering.

Stage outcome payload for `llm_postprocess` includes:

- `model: String` (canonical id)
- `output_chars: u32`
- `truncated: bool` (set when output was rejected by length-explosion
  check or `done_reason == "length"`)
- `duration_ms: u32`
- `prompt_eval_count: Option<u32>`
- `eval_count: Option<u32>`
- `done_reason: String` (Ollama field; `"stop"` on success)

No transcript or prompt text appears in the payload.

## Validator Extension

In `native/src/stages/mod.rs`:

- Add `fn collapses_segment_boundaries(&self) -> bool { false }` to the
  `StageProcessor` trait.
- `validate_stage_segments` accepts a new `boundary_collapsing: bool`
  parameter. When `true`, skip the "preserved boundaries" check; keep the
  in-bounds and non-overlap checks unchanged.
- `run_post_engine` queries `processor.collapses_segment_boundaries()`
  per stage and threads it into the validator call.

This is the only change to the validator. Hallucination filter and any
future segment-preserving stages remain governed by the original contract.

`LlmPostprocessStage` returns `true` from `collapses_segment_boundaries`.

## Sidecar Stage Implementation

Add `native/src/stages/llm_postprocess.rs`.

Stage registration and skip rules:

- Registered after `HallucinationFilterStage` in `post_engine_processors`.
- `runs_on_partials = false`.
- `collapses_segment_boundaries = true`.
- If `ctx.llm_postprocess` is `None` (timestamps on, or feature disabled
  in snapshot), return `Skipped { reason: "disabled" }` (or
  `"timestamps_enabled"` when the snapshot path indicates that case).
- If the joined transcript text is empty after trim, return
  `Skipped { reason: "empty_input" }`.
- If `*ctx.cancel_rx.borrow()` is already true, return
  `Skipped { reason: "cancelled" }` without making the request.

HTTP request:

- Use the existing async `reqwest::Client`. Build it once per stage
  instance (or share via `OnceLock`) with `connect_timeout: 2s`,
  `timeout: 60s`.
- Drive the call via `ctx.tokio_runtime.block_on(async { ... })`.
- Wrap the `send().await` in `tokio::select!` against a clone of
  `ctx.cancel_rx.changed()`:
  - on cancellation: return `StageProcess::Failed { error: "cancelled" }`
  - on response: continue to parsing
- POST `/api/chat` body:
  - `model`: configured canonical id
  - `stream`: `false`
  - `think`: `false`
  - `keep_alive`: configured `keepAlive`
  - `messages`:
    - `system`: configured `systemPrompt`
    - `user`: configured `userTemplate` after placeholder substitution
  - `options`:
    - `temperature`: configured `temperature`
    - `num_predict`: configured `numPredict`
    - `seed`: configured `seed`

Prompt/template rendering:

- The sidecar renders only these placeholders:
  - `{{note_context}}`
  - `{{session_context}}`
  - `{{utterance}}`
- Unknown placeholders are left verbatim so development users can experiment
  without the renderer inventing semantics.
- `{{note_context}}` is replaced with the joined text of note-context sources
  in the `ContextWindow`; empty string when absent.
- `{{session_context}}` is replaced with the joined text of
  session-transcript sources in the `ContextWindow`; empty string when absent.
- `{{utterance}}` is replaced with the current utterance joined text.
- If the template does not contain `{{utterance}}`, return
  `StageProcess::Failed { error: "missing utterance placeholder" }` and let
  the raw transcript flow through.
- Do not perform XML escaping. The default template uses XML-like tags as
  prompt structure, not as a parsed document format.

Failure handling (all return `StageProcess::Failed`, transcript stays at
the prior revision):

- HTTP error, connection error, timeout
- Non-2xx status
- JSON parse error
- Missing `{{utterance}}` placeholder in the user template
- `done_reason != "stop"` (including `"length"`)
- Empty `message.content` after trim
- `len(output) > 10 * len(input) + 1000` (length-explosion guard)
- Cancellation while in flight

Success path:

- Trim only leading/trailing whitespace; preserve model output otherwise
  (Markdown, lists, line breaks all flow through verbatim).
- Build the new revision's segments as a single synthetic segment:
  - `start_ms`: `0`
  - `end_ms`: `ctx.voice_activity.duration_ms()`
  - `text`: trimmed LLM output
  - `timestamp_granularity`: `Utterance`
  - `timestamp_source`: `None`
- Joined text equals the LLM output.
- Return `StageProcess::Ok { segments, payload }` with the payload shape
  defined in *Sidecar Protocol*.

Why a single synthetic segment: D-015 makes segments the unit of truth and
joined text a projection. The LLM operates at utterance scale, not segment
scale; collapsing to one segment spanning the full utterance keeps text
and timing honest. This is also why `llm_postprocess` and `showTimestamps`
are mutually exclusive in v1 — sparse timestamps render at utterance
boundaries either way, but per-segment timestamp UI (future) cannot work
against a single collapsed segment.

## Error and Privacy Rules

- No transcript text or prompt text in normal logs, stage payloads, or
  Notice messages. A unit test asserts this by capturing all log lines
  and stage payloads during a stage run with known input and verifying
  none contain the input string.
- No model id or display name in user-facing Notices. The dropdown shows
  the model name; failure Notices stay generic. A unit test asserts this
  by running the "selected model is no longer present" path with a known
  model name and verifying the emitted Notice does not contain it.
- Failed LLM postprocess must never abort dictation.
- Failed LLM postprocess must never block the raw transcript from reaching
  the note. The stage returning `Failed` leaves the prior transcript in
  place, which is what `transcript_ready` then carries.
- When `showTimestamps` is on at session snapshot, the stage records
  `Skipped { reason: "timestamps_enabled" }`. The raw transcript flow is
  unchanged.
- Cancellation: in-flight requests abort on session stop, graceful stop
  (D-013), and plugin unload via the per-session cancel watch. Cancelled
  requests return `StageProcess::Failed { error: "cancelled" }` and do
  not increment revision.
- Do not emit repeated user Notices for per-utterance Ollama failures.
  Surface failure counts via the developer logger and stage outcomes.
- The only network target is `127.0.0.1:11434`.

## Tests

Test bar: each test below must fail meaningfully if the named behavior
breaks. Tests that pass with a constant return value or that re-assert
constants are rejected. No test for the user-wins latch interaction —
this stage never writes before LLM lands, so the latch contract is not
exercised here (it is already covered by NoteSurface tests).

TypeScript unit tests:

- `plugin-settings.test.ts`
  - persisted model id is trimmed
  - persisted system prompt and user-message template are preserved verbatim
  - persisted context source is validated and invalid values fall back to
    `"both"`
  - persisted context budget is clamped to the allowed range
  - persisted temperature, max prediction count, seed, and keep-alive are
    normalized by the settings boundary
  - invalid persisted types fall back to defaults
  - "Reset LLM defaults" restores context source, context budget, system
    prompt, user-message template, temperature, max prediction count, seed,
    and keep-alive constants verbatim
- `ollama-client.test.ts` (against a local `http.createServer` fake):
  - `/api/version` probe succeeds, parses version
  - `/api/tags` returns `{ id, displayName }` pairs, filtered
    (`embed|embedding|bge|nomic|clip` excluded), sorted alphabetically
    by display name
  - malformed JSON, connection refused, and 500 responses surface as
    typed errors
  - `prewarmModel` POSTs `/api/chat` with a one-token user message,
    `num_predict: 1`, and `keep_alive: "30m"`, and tolerates non-2xx
    silently
- Sidebar/view tests (use the existing Obsidian mock; skip cleanly if
  DOM coverage is insufficient):
  - enabling with unavailable Ollama leaves `llmPostprocessEnabled:
    false` and emits the documented Notice
  - enabling with no model selected refuses to enable
  - enabling with a previously selected model that is no longer
    installed refuses to enable (and the Notice does not name the model)
  - mutex hint renders when `showTimestamps` is true
  - in-flight indicator renders "Processing N utterance(s)…" when
    `transcription_queue_changed` reports `queued_utterances > 0` or
    `session_state_changed` reports `Transcribing`, and only while
    `llmPostprocessEnabled` is true in the active snapshot
  - "Reset LLM defaults" button restores all editable LLM prompt, context,
    and generation defaults without changing the enable toggle or selected
    model
- `dictation-session-controller.test.ts`
  - snapshot includes `llmPostprocess` config when enabled, model
    non-empty, and timestamps off
  - snapshot sets `llmPostprocess: null` when timestamps are on, even
    if enabled
  - mid-session settings edits do not mutate the active snapshot
  - `onunload` sends `StopSession` and awaits the stop ack up to 500ms
    before tearing down IPC

Rust unit tests:

- `protocol.rs`
  - deserialize `start_session` with `llmPostprocess`
  - serialize `StageId::LlmPostprocess` as `"llm_postprocess"`
- `stages/mod.rs`
  - new validator parameter: a stage with
    `collapses_segment_boundaries() == true` may emit a single segment
    spanning `[0, utterance_duration_ms]` even when prior segments had
    different boundaries — accepted, revision bumps
  - same stage emitting `end_ms > utterance_duration_ms` still rejected
  - same stage emitting overlapping segments still rejected
  - segment-preserving stages still rejected when boundaries drift
- `stages/llm_postprocess.rs` (HTTP via a local mock server):
  - `None` config skips with `reason: "disabled"` without calling client
  - empty transcript skips with `reason: "empty_input"` without calling
    client
  - cancelled-before-send skips with `reason: "cancelled"` without
    calling client
  - success collapses segments to one synthetic segment spanning
    `[0, utterance_duration_ms]`; joined text equals trimmed LLM output;
    revision bumps
  - request body matches `/api/chat` shape (`stream: false`,
    `think: false`, configured `keep_alive`, configured `temperature`,
    configured `num_predict`, configured `seed`, configured system message,
    user message rendered from the configured template)
  - template renderer substitutes `{{note_context}}`,
    `{{session_context}}`, and `{{utterance}}`; unknown placeholders remain
    verbatim
  - template missing `{{utterance}}` returns `Failed` without calling Ollama
  - `done_reason: "length"` returns `Failed`, no revision increment
  - empty `message.content` returns `Failed`
  - length-explosion (`output > 10*input + 1000` chars) returns `Failed`
  - HTTP timeout returns `Failed { error: "..." }`
  - cancellation while request is in flight returns
    `Failed { error: "cancelled" }` within the cancellation poll budget
  - privacy: capture all log lines and the returned `payload`; assert
    none contain the test transcript or prompt strings; assert payload
    `model` field is the canonical id (this is allowed in payloads, only
    forbidden in user-facing Notices and logs)
- `worker.rs` / stage pipeline tests:
  - stage runs after hallucination filter
  - `Failed` outcome leaves the transcript at its post-hallucination
    revision; `transcript_ready` text equals the raw fallback
  - `Ok` outcome bumps revision and `transcript_ready` text equals the
    LLM output
  - `processing_duration_ms` includes the LLM stage wall time

Integration/build checks:

- `npm run typecheck`
- `npm run test`
- `cargo test` in `native/`
- `npm run build:frontend`
- If Cargo features changed, run `npm run check:rust`

Manual checks:

- With Ollama stopped, enable in sidebar: toggle stays off and Notice
  tells the user to start Ollama.
- With Ollama running and one chat-capable model installed, select model
  and enable. Pre-warm fires (verify via `/api/ps`).
- Dictate with timestamps off and llm enabled: indicator line shows
  while utterance is in flight; LLM-cleaned text appears in the note
  on completion; nothing appears earlier.
- Dictate with timestamps on and llm enabled: raw transcript appears
  with timestamp prefix; LLM stage skipped; sidebar mutex hint visible.
- Stop Ollama mid-session: subsequent utterances appear in the note as
  raw text within ~60s of finalize (one timeout); no Notice spam;
  failure counts visible via dev logger.
- Stop dictation while an LLM request is in flight: the in-flight
  request is cancelled within the cancellation poll budget; the raw
  transcript for that utterance appears in the note; sidecar logs show
  no orphan request continuing past stop.
- Trigger a head-of-line block: speak two utterances rapidly while
  Ollama is artificially slow (e.g., `OLLAMA_HOST` pointed at a sleep
  proxy). Confirm utterance K+1's `transcript_ready` does not arrive
  until K's LLM call returns or times out — this is the documented v1
  trade-off and the test is to confirm the behavior is what we expect.

## Acceptance Criteria

- Local Transcript sidebar appears in the left sidebar without a settings
  toggle and without stealing focus on startup, and includes editable
  context source, context budget, system prompt, user-message template,
  generation options, and a "Reset LLM defaults" button.
- Enabling `llm_postprocess` requires reachable local Ollama, an explicit
  model selection, and that model still being present in `/api/tags`.
- Enabling fires a one-token pre-warm `/api/chat` against the chosen
  model.
- Model dropdown shows filtered, alphabetically sorted display names; the
  canonical model id is what gets sent on `/api/chat`.
- When `showTimestamps` is on at session snapshot, `llm_postprocess` is
  not invoked for that session and the raw transcript appears as normal.
- When `llm_postprocess` is active and succeeds, the LLM revision is the
  only write into the note for that utterance; segments collapse to one
  synthetic segment spanning `[0, utterance_duration_ms]` whose text
  equals trimmed LLM output. Joined text equals that segment's text.
- Any Ollama failure (HTTP, timeout, parse, `done_reason != "stop"`,
  empty output, length explosion, cancellation) records
  `StageProcess::Failed` and the raw transcript appears in the note via
  the same single `transcript_ready` event.
- In-flight LLM requests abort on session stop, graceful stop (D-013),
  and plugin unload, returning `Failed { error: "cancelled" }`. Plugin
  unload waits up to 500ms for the cancellation ack, then tears down IPC.
- Sidebar shows "Processing N utterance(s)…" derived from existing
  queue and state events; no new wire event is added.
- No transcript text, prompt text, or model id/name appears in normal
  logs or user-facing Notices, verified by test.
- No whole-session rewrite behavior is introduced.
- No remote endpoint, Ollama auto-start, bundled Ollama, telemetry, or
  account flow is introduced.

## Assumptions

- Obsidian desktop provides Node APIs to plugins; using Node HTTP from
  the plugin is acceptable for localhost probing.
- The default Ollama host is `127.0.0.1:11434`. Users who run Ollama
  elsewhere are out of scope for v1.
- `tokio` features `["macros", "rt", "sync"]` are sufficient — the
  worker uses a current-thread runtime, not multi-thread.
- 3s UI preflight, 2s connect timeout, 60s request timeout are
  acceptable defaults for an experimental feature.
- A single synthetic segment spanning `[0, utterance_duration_ms]` is
  acceptable timing fidelity for an LLM-revised utterance. Segment-aware
  timestamp rendering against an LLM revision is out of scope.
- The 60s worst-case head-of-line block on a hung Ollama is an accepted
  v1 trade-off. If real usage shows queue bloat, v2 moves the LLM call
  off the worker thread.
- Cancellation polling latency on the sidecar side is bounded by the
  `tokio::select!` granularity (effectively zero for an awaiting send).
  No additional timer is added.
- Prompt-injection resistance is not a v1 goal. The user authors the
  prompt and chooses the model. The hard boundary is operational safety:
  local-only endpoint, bounded timeouts, bounded output, fail-open
  transcript behavior.
- Output Markdown formatting (headings, code fences, lists) is accepted
  as-is. The user owns the prompt and can constrain the model. v1 does
  not strip or normalize Markdown.
- `docs/system-architecture.md:32` will be amended in the same PR to
  reflect that per-utterance LLM cleanup IS a text-pipeline stage (with
  a documented boundary-collapsing exception), while whole-session
  rewrite remains a separate experimental artifact.

## Sources Checked

Verified against Ollama docs as of 2026-05-01. The plan targets Ollama
≥ 0.5 (where `think`, `keep_alive`, and `done_reason` semantics are
stable); older versions are out of scope for v1.

- Chat endpoint and `messages`/`options`/`stream`/`think`/`keep_alive`
  fields, plus `done_reason` semantics: `https://docs.ollama.com/api/chat`
- Generate endpoint (for comparison; not used):
  `https://docs.ollama.com/api/generate`
- Model listing (`/api/tags` returns all installed models, not loaded):
  `https://docs.ollama.com/api/tags`
- Loaded-model status (`/api/ps`, used for manual verification of
  pre-warm): `https://docs.ollama.com/api/ps`
- Concurrency (`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_QUEUE`) and
  `keep_alive` semantics: `https://docs.ollama.com/faq`
- Ollama API introduction: `https://docs.ollama.com/api/introduction`
