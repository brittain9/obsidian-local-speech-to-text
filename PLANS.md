# Foundational Rollout: Intelligent Dictation Engine

## Objective

Build the foundation for Local Transcript as an intelligent, local dictation engine rather than a thin `audio -> model -> note` pipe.

The simple system is:

`audio -> speech model -> text inserted into the note`

The product foundation we need is:

`audio -> local engine -> revisioned transcript -> quality stages -> session journal -> safe note projection -> context for future engine work`

This rollout does **not** ship every advanced feature. It does not wire speculative Whisper partials, LLM whole-note rewrites, diarization UI, or a debug timeline. It creates the state model, ownership boundaries, and protocol shape those features need: strict note lock, session journal, immutable transcript revisions, quality-stage reporting, context windows, and a NoteSurface write contract where user edits win.

The first visible product win is concrete: fix the current bug where new transcript text can push user-typed text because insertion follows a remapped cursor anchor. The structural fix is that new dictated text appends at the session writing-region tail, not at the editor cursor.

## Current State

**Plugin (`src/`).** `DictationSessionController` owns capture lifecycle, sidecar start/stop/cancel, UI state, anchor visibility timing, transcript normalization, warning logging, and editor writes. `EditorService` writes each phrase at a CodeMirror anchor. The anchor is mapped with `assoc: -1`, so when the user types at the anchor, the anchor can remain before the user's text and the next transcript insert lands in the wrong place. Active leaf changes intentionally move the anchor today; the new model must lock a session to the note where dictation started.

**Sidecar (`native/`).** `transcription::Transcript` stores `{ segments, text }`. There is no utterance identity, revision number, quality-stage history, or `isFinal` signal. `transcript_ready` carries final text and segments only. `initialPrompt` exists on `start_session`, and the engine registry can warn/drop it when unsupported, but it is session-static rather than assembled per utterance.

**Protocol.** Framing is binary `[kind:u8, len:u32 LE]` plus JSON body, with JSON discriminator `type`. Existing wire fields are camelCase (`processingDurationMs`, `utteranceDurationMs`). This is a greenfield protocol: do not add protocol versions, compatibility shims, synthesized IDs, or dual parser paths. When the transcript contract changes, change both TypeScript and Rust together.

## Architectural Target

The foundation has five ownership boundaries:

- `DictationSessionController` remains the outer lifecycle/UI coordinator: start, stop, cancel, capture stream, sidecar connection, ribbon state, user notices, and high-level sidecar error handling.
- `Session` owns the dictation session contract: locked file identity, session state transitions, journal, note projection, recovery lifecycle, and context assembly.
- `SessionJournal` owns what was dictated: latest transcript per utterance, revision history, dictation order, finalization, and context-window reads.
- `NoteSurface` owns what is safe to write into the editor: spans, latches, byte-identity checks, append/replace/rewrite capability checks, placement, and trailing cleanup.
- The Rust sidecar owns inference and quality stages. It emits transcript revisions and stage results; it does not own note state or journal state.

The note is a projection target, not the source of truth. The journal is the source of truth for the dictation session. Note projection may be skipped forever when the note is closed, deleted, externally modified, or manually edited.

## Constraints

- Greenfield: no protocol versioning, no compatibility shims, no synthesized IDs, no fake revisions, no fallback parser branches for removed shapes.
- TypeScript and Rust protocol changes land together in the same implementation PR.
- Trunk-based development still applies: keep earlier additive PRs releasable, then make the protocol replacement as one coordinated change.
- No Python in the sidecar (D-011). No cloud, telemetry, or accounts (D-012).
- D-008 engine registry work is not part of this rollout.
- Existing phrase-placement behavior must be preserved: first-phrase prefix, configured phrase separator, and trailing cleanup move out of `EditorService` but do not disappear.

## Rollout Shape

Four PRs. The first three are additive plugin foundation work. The fourth is the coordinated protocol/runtime replacement across TypeScript and Rust.

```
PR1 journal -> PR2 note surface -> PR3 session projection -> PR4 engine protocol + context integration
```

### PR 1 — `feat/session-journal`

Add plugin-side transcript/session types and `SessionJournal`. Pure addition; no runtime path reaches it yet.

Core types:

- `UtteranceId`
- `TranscriptRevision`
- `TranscriptSegment`
- `StageOutcome`
- `ContextWindow`
- `ContextWindowSpec`

`SessionJournal.upsert(revision)` returns an explicit result:

- `accepted` with `previous?: TranscriptRevision`
- `stale` when revision number is older than the latest known revision
- `duplicate` when the same revision already exists
- `rejected` for impossible identity/session errors

Context assembly is newest-finalized-within-budget, emitted in chronological order. It uses journal truth by default, not note projection text. The first implementation includes only finalized session utterances; surrounding note context is a later extension behind the same `ContextWindow` type.

Verification:

- stale/duplicate revision behavior
- history retention
- finalized-only context assembly
- newest-within-budget selection with chronological output
- word-boundary truncation
- `finalize()` freezes future writes

### PR 2 — `feat/note-surface`

Add `src/editor/note-surface.ts` and the shared CodeMirror update-listener extension. Pure addition until PR 3 wires it.

`NoteSurface` API:

```ts
class NoteSurface {
  constructor(view: EditorView, placement: NotePlacementOptions);
  observeTransaction(update: ViewUpdate): void;
  append(utteranceId: UtteranceId, text: string): AppendResult;
  replaceAnchor(utteranceId: UtteranceId, newText: string, expectedOldText: string): ReplaceResult;
  rewriteRegion(range: RewriteRange, newText: string, preservedSpans: PreservedSpan[]): RewriteResult;
  validateExternalModification(): void;
  latchAll(reason: string): void;
  trimPendingTrailingContent(): void;
  dispose(): void;
}
```

Important details:

- `NoteSurface` is editor-pure. It does not decide whether the locked note is open; `Session` does.
- The shared `EditorView.updateListener` is registered once in `main.ts` and routes only when `update.view === activeNoteSurface.view`.
- New dictated text appends at the writing-region tail: `max(initialAnchorPos, ...projectedSpanEnds)`.
- Phrase placement moves here: `computeFirstPhrasePrefix`, `computePhraseSeparators`, first-phrase state, configured separator, and trailing cleanup are preserved.
- Span starts map with `assoc: -1`; span ends map with `assoc: +1`.
- User edits latch intersected spans unless the user event is undo/redo. Undo/redo is checked by prefix (`undo`, `undo.selection`, `redo`, etc.). IME composition commits latch.
- External `vault.modify` does not blindly latch all spans. `validateExternalModification()` compares recorded projected text to the current CM6 document and latches only spans whose bytes no longer match.

`NoteSurface` returns result objects; callers route by result, not by assuming writes succeeded.

Verification:

- full latch matrix
- span mapping edge cases
- byte-identity checks
- external-modify selective latch
- typing-bug regression
- phrase separator / first phrase / trailing cleanup parity with current `EditorService`

Implementation status for PR 2:

- Added `src/editor/note-surface.ts` as an additive editor-pure surface. Runtime dictation still uses `EditorService` until PR 3 wires `Session`.
- Registered the shared CodeMirror update listener once from `main.ts`; it routes updates only to the active `NoteSurface` for the matching `EditorView`.
- Covered the highest-risk behavior in `test/note-surface.test.ts`: writing-region-tail append regression, phrase placement/trailing cleanup parity, span mapping, user-wins latching, undo/redo exemption, IME-style user events, byte-identity denial, external-modify selective latching, latch-all, and rewrite boundary checks.
- Verified with `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build:frontend`.

### PR 3 — `feat/session-projection`

Introduce `Session` as the note/journal/projection owner while keeping `DictationSessionController` as lifecycle/UI owner.

`Session` owns:

- locked `TFile` identity
- `SessionJournal`
- `NoteSurface`
- projection state per utterance
- workspace/vault subscriptions for close, delete, rename, and modify
- recovery file lifecycle
- context-window assembly

Projection state replaces any simple "seen utterance" routing:

- `unprojected`
- `projected { lastRevision, projectedText }`
- `latched { reason, lastProjectedRevision? }`
- `denied { reason, lastAttemptedRevision }`

Routing:

1. `journal.upsert(revision)` always runs first.
2. Stale/duplicate revisions do not project.
3. If the locked note is closed or deleted, projection is skipped.
4. `unprojected` revisions attempt `surface.append`.
5. `projected` revisions attempt `surface.replaceAnchor` with the **last projected text**, not merely the previous journal revision.
6. Failed append/replace updates projection state from the result and is never queued for retry.
7. Recovery persistence runs after accepted journal updates.

`DictationSessionController` continues to own capture start/stop, sidecar calls, ribbon state, anchor visibility timing, and top-level sidecar errors. It delegates accepted transcript events to `session.acceptTranscript`.

Verification:

- active tab switch does not redirect writes
- locked background note still receives writes while open
- locked note close gracefully stops with Notice
- locked note delete cancels and never writes
- rename follows by `TFile` identity
- external modify latches only changed spans
- stop drains in-flight transcript into journal/projection before cleanup
- start failure after capture begins cleans up capture/session state

### PR 4 — `feat/intelligent-engine-foundation`

Replace the transcript protocol and wire the sidecar pipeline, plugin session, and context flow together. This PR intentionally changes both TypeScript and Rust in one coordinated implementation because this is greenfield and there is no old contract to preserve.

Protocol replacement:

- `transcript_ready` requires `utteranceId`, `revision`, `isFinal`, `stageResults`, `segments`, `text`, `processingDurationMs`, `utteranceDurationMs`, `warnings`, and `sessionId`.
- `health_ok` remains a health event with no protocol version field.
- Add `context_request` with `correlationId`, `utteranceId`, and `budgetChars`.
- Add `context_response` with `correlationId` and `context: ContextWindow | null`.
- Use camelCase on the wire.
- Delete parser expectations and tests for the removed transcript shape.

Rust sidecar changes:

- Add `uuid = { version = "1", features = ["v4"] }`.
- `Transcript` becomes `{ utterance_id, revision, segments, stage_history }`; joined text is derived by `joined_text()`.
- Add `StageOutcome`, `StageStatus`, and fixed stage identifiers.
- Add a standard post-engine pipeline with real engine outcome plus skipped stubs for hallucination filter, punctuation, and user rules.
- Rendering is **not** a transcript revision. Joined text is a DTO projection derived from segments.
- Generate UUID v4 utterance IDs when enqueueing finalized utterances for transcription.
- Speculative engine partials are not wired here. The foundation supports multiple revisions per utterance; the first sidecar implementation emits one final revision per utterance.

Context bridge:

- `AppState`, not the worker directly, emits `context_request` to the plugin before enqueueing a `TranscribeUtterance`.
- The pending utterance waits up to 2 seconds for `context_response`.
- On timeout or null context, transcription proceeds with `initial_prompt: None`.
- If the selected adapter does not support initial prompts, existing capability gating drops the prompt and reports a dev-console warning.
- Correlation state is cleared on response, timeout, session stop, and session replacement.

Plugin integration:

- `DictationSessionController` creates `Session` before starting capture/sidecar work and delegates transcript revisions to it.
- `Session` handles `context_request`, calls `journal.assembleContext({ maxChars: budgetChars })`, and replies with `sendContextResponse`.
- First utterance returns `context: null`.
- The old `EditorService` and dictation anchor extension are deleted once `NoteSurface` is active.

Verification:

- TypeScript protocol tests for required transcript fields and context request/response
- Rust serde tests for transcript and context events
- `joined_text()` whitespace behavior
- stage outcome serde round trips
- worker/app call sites use derived joined text, not stored text
- context request/response happy path
- context timeout path proceeds without blocking session
- first utterance sends null context
- second/third utterances include prior finalized text in sidecar debug logs when supported
- full frontend and Rust checks

## Follow-Up Issues After Foundation

- Wire `whisper-rs` new-segment callback for speculative revisions.
- Implement real hallucination filtering.
- Implement punctuation/formatting stage.
- Add note-surrounding context as an explicit `ContextWindow` source.
- Add debug timeline/export UI for stage history and revision replay.
- Design `SessionRewrite` for LLM whole-note workflows.

## Risks

- **CodeMirror observer correctness.** Span mapping and user-wins latching are the highest-risk plugin code. PR 2 must be exhaustive before wiring PR 3.
- **Controller/session split.** The controller currently owns many behaviors. PR 3 should avoid a large rewrite by moving only note/journal/projection ownership into `Session`.
- **Cross-boundary PR size.** PR 4 is deliberately cross-cutting because the protocol is being replaced, not versioned. Keep it focused on the transcript contract, sidecar pipeline, session wiring, and context bridge.
- **Context bridge complexity.** The current worker cannot initiate plugin IPC directly. The first context implementation should request context from `AppState` before worker dispatch, which is simpler and matches existing command/event flow.
- **Projection divergence.** Journal truth and note projection intentionally diverge. Tests must assert this rather than treating skipped note writes as failure.
- **Recovery churn.** Recovery files are useful but secondary. Keep implementation simple and avoid turning recovery into a multi-session history system.

## Manual Smoke Checklist

1. Dictate, type into the note mid-session, dictate again: new dictated text lands after typed text.
2. Switch active tabs while dictating: writes continue to the locked note, not the active note.
3. Edit transcribed text manually, then receive a later revision: the manual edit is not overwritten.
4. Rename the locked file and continue dictating: writes follow the renamed file.
5. Close the locked note: session stops with Notice after drain.
6. Delete the locked note: session cancels, journal records accepted transcript events, note writes stop.
7. Dictate three utterances after PR 4: utterance two/three receive prior finalized context when supported by the engine.

## Deliberately Out Of Scope

- Multi-window Obsidian correctness beyond the known D-013 limitation.
- D-008 registry refactor.
- Speculative partial callback wiring.
- LLM whole-session rewrite.
- Diarization UI.
- GPU-specific inference changes.
- Cloud or account-based processing.
