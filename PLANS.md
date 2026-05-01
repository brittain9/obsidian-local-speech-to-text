# Per-Utterance Ollama LLM Postprocess Plan

## Summary

Add an experimental `llm_postprocess` stage that runs once per finalized
utterance, after normal transcription and hallucination filtering. The user
configures an Ollama model and prompt in an always-available Local Transcript
sidebar. If Ollama is unavailable when the feature is enabled or when dictation
starts, the plugin disables the feature and continues normal transcription. If
Ollama fails during an utterance, the sidecar records a failed stage outcome and
the normal transcript is inserted.

This is not whole-session rewrite. It does not reorder, merge, summarize, or
rewrite across utterance boundaries. Sparse timestamps remain allowed because
the rendered text still belongs to one utterance start time.

## Decisions

- Name the feature and stage `llm_postprocess`.
- Keep Ollama user-managed: no bundled Ollama, no auto-start, no lifecycle
  ownership by this plugin.
- Use only the local loopback Ollama endpoint in v1:
  `http://127.0.0.1:11434`. Do not add a user-editable endpoint yet; that keeps
  the no-cloud product contract intact.
- Use Ollama `/api/chat` with `stream: false` for post-processing. Chat gives a
  cleaner system/user message split for instruction-following models than
  `/api/generate`.
- Use `/api/version` for availability checks and `/api/tags` for the sidebar
  model dropdown. Show only raw model names.
- Keep post-transcript enrichment in the Rust sidecar. The plugin may call the
  same local Ollama API only for UI probing and model-list population.
- Keep timestamps enabled with per-utterance postprocess. Revisit timestamp
  exclusion only for later whole-session polish.
- Do not add strong semantic guardrails in v1. This is experimental and the user
  owns the model/prompt choice. Still bound request timeout and output size to
  prevent runaway behavior.

## User-Facing Behavior

- A Local Transcript sidebar tab is always registered and created in the left
  sidebar on layout ready. It should not steal focus on startup.
- The sidebar contains only LLM postprocess controls in this PR:
  - enable toggle
  - Ollama status line
  - Refresh models button
  - model dropdown populated from Ollama model names
  - prompt textarea
- Enabling `llm_postprocess` runs a short Ollama preflight:
  - `GET /api/version`
  - `GET /api/tags`
  - if no model is selected yet, the first returned model becomes the selected
    model
  - if a selected model is no longer present, enabling fails instead of
    silently switching models
- If preflight fails, no models are installed, or the selected model is absent:
  - save `llmPostprocessEnabled: false`
  - leave dictation otherwise unaffected
  - show: `Start Ollama, then enable LLM post-processing again.`
- Starting dictation also preflights if persisted settings say the feature is
  enabled. If Ollama is unavailable then, disable it, show the same Notice, and
  start normal dictation.
- During dictation, if an Ollama request fails for a finalized utterance, insert
  the normal transcript for that utterance. Do not spam Notices per utterance;
  log details through the existing developer logger/stage outcome.

## Settings Contract

Extend `PluginSettings` with:

- `llmPostprocessEnabled: boolean`, default `false`
- `llmPostprocessModel: string`, default `""`
- `llmPostprocessPrompt: string`, default:
  `Clean up the transcript text. Preserve the speaker's meaning. Return only the final text.`

Resolution rules:

- Model names are strings trimmed at settings boundaries.
- Prompt text is preserved as user-authored text, except normal string fallback
  when persisted data is not a string.
- Unknown persisted fields remain ignored as today.
- Settings continue to be snapshotted at dictation start. Mid-session sidebar
  edits apply to the next session.

## Plugin Implementation

Add a small TypeScript Ollama client, likely under `src/llm/ollama-client.ts`.

- Use Node HTTP APIs against `127.0.0.1:11434` so Obsidian/Electron browser CORS
  behavior is irrelevant.
- Implement:
  - `probeOllama(): Promise<void>`
  - `listOllamaModels(): Promise<string[]>`
- Use a short UI/preflight timeout, about 2 seconds.
- Parse JSON strictly enough to reject malformed responses, but do not model
  every Ollama metadata field.

Add a sidebar view, likely under `src/ui/local-transcript-view.ts`.

- Subclass Obsidian `ItemView`.
- Constants:
  - view type: `local-transcript-sidebar`
  - display text: `Local Transcript`
  - icon: use a stable built-in icon, likely `audio-lines` or `mic`
- Render with Obsidian `Setting` primitives.
- Keep view state derived from `PluginSettings` plus transient Ollama status.
- Save settings through the plugin's existing `updateSettings` path.
- On enable:
  - refresh model list
  - select the first model only when no model is currently selected
  - disable on failure/no models/selected model missing
  - save enabled config on success
- On model refresh:
  - update dropdown names
  - if currently enabled and refresh fails, disable and notify

Update `src/main.ts`.

- Register the sidebar view in `onload`.
- On layout ready, ensure a left side leaf exists for the Local Transcript view
  with `active: false` and no focus steal.
- Pass view dependencies:
  - `getSettings`
  - `saveSettings`
  - `notice`
  - `logger`
  - Ollama client
- Extend `DictationSessionController` dependencies with a preflight function or
  pass an `ollamaClient` so `startDictation` can disable stale enabled settings
  before snapshotting.

Update `DictationSessionController`.

- Add `llmPostprocess` to the active session snapshot as either `null` or:
  - `model`
  - `prompt`
- Before creating the snapshot, if settings enable postprocess:
  - preflight Ollama and selected model
  - on failure save settings with `llmPostprocessEnabled: false`
  - continue start with postprocess disabled
- Include postprocess config in `startSession` only when enabled and model is
  non-empty.

## Sidecar Protocol

Break the internal wire contract directly; this project is greenfield and does
not need compatibility shims.

TypeScript `src/sidecar/protocol.ts`:

- Add `LlmPostprocessConfig`:
  - `model: string`
  - `prompt: string`
- Add optional `llmPostprocess?: LlmPostprocessConfig` to `StartSessionCommand`.
- Add `llm_postprocess` to `STAGE_IDS` in `src/session/session-journal.ts`.
- Parse and encode the new command field through existing start-session helpers.

Rust `native/src/protocol.rs`:

- Add matching `LlmPostprocessConfig`.
- Add `llm_postprocess: Option<LlmPostprocessConfig>` to `Command::StartSession`.
- Add `StageId::LlmPostprocess`.

Rust `native/src/worker.rs`:

- Add optional postprocess config to `SessionMetadata`.
- Pass it into `StageContext`.
- Report `processing_duration_ms` as total worker processing time including
  post-engine stages. Keep the engine stage duration in its own `StageOutcome`.

## Sidecar Stage Implementation

Add `native/src/stages/llm_postprocess.rs`.

Stage behavior:

- Registered after `HallucinationFilterStage`.
- `runs_on_partials = false`.
- If no config is present, return `Skipped { reason: "disabled" }`.
- If the transcript joined text is empty, return
  `Skipped { reason: "empty_input" }`.
- Build an Ollama chat request:
  - `model`: configured model
  - `stream`: `false`
  - `think`: `false`
  - `keep_alive`: `"5m"`
  - low temperature, around `0.2`
  - bounded `num_predict`; start with `512`
  - system message: `Return only the post-processed transcript text.`
  - user message: configured prompt plus the current utterance text
- Use a blocking HTTP client with a bounded request timeout, about 60 seconds.
  Add `reqwest`'s `blocking` feature rather than introducing a second HTTP
  dependency.
- On HTTP, JSON, timeout, or Ollama API failure:
  - return `StageProcess::Failed`
  - leave transcript segments unchanged
  - include a concise error, without raw transcript or prompt text
- On success:
  - trim only transport artifacts around the returned content
  - preserve the model output as text otherwise
  - replace the first existing segment's text with the returned content
  - set later segment texts to `""`
  - preserve all original segment timing metadata so existing validation passes
  - return payload with model name and output character count only

This "first segment carries transformed text" representation is intentional for
v1. The stage is utterance-level, not segment-aligned. Current note projection
uses `Event.text`, and sparse timestamps use utterance start metadata, so this
keeps behavior correct without inventing fake timing boundaries.

## Error And Privacy Rules

- No transcript text or prompt text in normal logs, stage payloads, or Notice
  messages.
- Failed LLM postprocess must never abort dictation.
- Failed LLM postprocess must never prevent normal transcript insertion.
- Do not emit repeated user Notices for per-utterance Ollama failures.
- The only network target is `127.0.0.1:11434`.

## Tests

TypeScript unit tests:

- `plugin-settings.test.ts`
  - defaults include LLM disabled, empty model, default prompt
  - persisted model is trimmed
  - persisted prompt text is preserved
  - invalid persisted fields fall back safely
- `protocol.test.ts`
  - `start_session` encodes/decodes `llmPostprocess`
  - `llm_postprocess` stage id parses in stage outcomes
- Add tests for the plugin Ollama client with a local fake HTTP server:
  - version probe succeeds
  - model names come from `/api/tags`
  - malformed JSON, connection failure, no models fail cleanly
- Add sidebar/view tests if the existing Obsidian mock supports enough DOM:
  - enabling with unavailable Ollama saves disabled and emits Notice
  - enabling with models saves enabled and selects a model
  - enabling with a stale selected model saves disabled instead of switching
  - dropdown labels are raw model names only
- `dictation-session-controller.test.ts`
  - enabled postprocess preflight failure disables setting and starts normal
    dictation
  - successful preflight includes postprocess config in `startSession`
  - mid-session settings changes do not affect the active snapshot

Rust unit tests:

- `protocol.rs`
  - deserialize `start_session` with `llmPostprocess`
  - serialize `StageId::LlmPostprocess` as `llm_postprocess`
- `stages/llm_postprocess.rs`
  - disabled config skips without calling client
  - empty transcript skips without calling client
  - success replaces joined text while preserving segment timing metadata
  - empty successful output is accepted
  - client failure returns `Failed` and leaves prior revision intact
  - request payload uses `/api/chat` shape with `stream: false`
- `worker.rs` or stage pipeline tests
  - stage runs after hallucination filter
  - failed LLM stage does not increment revision
  - successful LLM stage increments revision and appears in stage history

Integration/build checks:

- `npm run typecheck`
- `npm run test`
- `cargo test` in `native/`
- `npm run build:frontend`
- If dependencies/features changed, run the repo's Rust check script:
  `npm run check:rust`

Manual checks:

- With Ollama stopped, enable in sidebar: feature turns off and Notice tells
  user to start Ollama.
- With Ollama running and at least one model installed, refresh models and
  enable postprocess.
- Dictate one utterance with timestamps off: transformed text is inserted.
- Dictate with timestamps on: timestamp prefix remains and transformed text is
  inserted.
- Stop Ollama mid-session: subsequent utterances insert normal transcript.

## Acceptance Criteria

- Local Transcript sidebar appears in the left sidebar without a settings toggle
  and without stealing focus on startup.
- Enabling `llm_postprocess` requires reachable local Ollama and at least one
  model from `/api/tags`.
- Model dropdown shows model names only.
- Per-utterance finalized transcript text is sent to Ollama `/api/chat` when
  enabled.
- Successful LLM output becomes the inserted note text for that utterance.
- Any Ollama failure falls back to the normal transcript.
- Timestamps continue to work with per-utterance LLM output.
- No whole-session rewrite behavior is introduced.
- No remote endpoint, Ollama auto-start, bundled Ollama, telemetry, or account
  flow is introduced.

## Assumptions

- Obsidian desktop provides Node APIs to plugins; using Node HTTP from the
  plugin is acceptable for localhost probing.
- The default Ollama host is `127.0.0.1:11434`; users who run Ollama elsewhere
  are out of scope for v1.
- A 2 second UI preflight timeout and 60 second sidecar generation timeout are
  acceptable starting defaults for an experimental feature.
- Prompt-injection resistance is not a v1 goal because the feature is explicitly
  user-authored local postprocess. The hard boundary is operational safety:
  local-only endpoint, bounded request, fail-open transcript behavior.

## Sources Checked

- Ollama API introduction: `https://docs.ollama.com/api/introduction`
- Ollama chat endpoint: `https://docs.ollama.com/api/chat`
- Ollama model listing: `https://docs.ollama.com/api/tags`
