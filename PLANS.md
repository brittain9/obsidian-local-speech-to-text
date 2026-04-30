# Timestamp Rendering and Smart Paragraphs Implementation Plan

## Summary

Implement the `DESIGN.md` transcript UX as two tightly related PRs:

- **PR 5: Timestamp rendering** adds sparse, optional elapsed-session timestamps.
- **PR 6: Smart paragraphs** makes intelligent paragraphing the default transcript formatting mode.

The core architectural move is to replace the current trailing-separator insertion model with a per-utterance projection renderer:

```text
boundary prefix + optional timestamp prefix + utterance text
```

That renderer lives in the Obsidian plugin because timestamp text and Markdown spacing are note projections, not canonical transcript data. The sidecar already emits the required VAD/session timing fields, so this work should not add Rust timing logic or engine-specific branches.

Implementation should start from `main` after `refactor/remove-pause-while-processing` lands.

## Product Decisions

- Smart paragraphs are the default shipped transcript formatting mode.
- Timestamps are optional and default off.
- Timestamp format is fixed:
  - `(M:SS)` below one hour.
  - `(H:MM:SS)` at one hour or above.
- Timestamp placement is fixed as an inline prefix before the utterance text.
- Timestamp density is fixed in the first pass:
  - first rendered utterance,
  - every meaningful-pause boundary,
  - and the next utterance boundary after 30 seconds since the last emitted timestamp.
- Meaningful pause threshold is **3000 ms**.
- Silence counts. Timestamps use `utteranceStartMsInSession`, not active-speech-only duration.
- Smart paragraphing uses pause metadata only in this pass. No semantic paragraphing, LLM rewrite, speaker labels, or user threshold setting.
- `pauseMsBeforeUtterance === null` is not a meaningful-pause signal. It covers first utterances and continuation splits such as the sidecar's 30-second utterance cap.

## Current State Observations

- `TranscriptReadyEvent` already contains:
  - `pauseMsBeforeUtterance`,
  - `utteranceStartMsInSession`,
  - `utteranceEndMsInSession`,
  - `utteranceIndex`.
- `DictationSessionController.handleTranscriptReady` currently drops `pauseMsBeforeUtterance` when creating `TranscriptRevision`.
- `SessionJournal.TranscriptRevision` stores utterance timing but not pause metadata.
- `NoteSurface.append` currently accepts only `(utteranceId, text)`.
- `computePhraseSeparators` currently returns `{ prefix, trailing }`; `new_line` and `new_paragraph` are eager trailing separators.
- That trailing model is the main thing to change. Smart paragraphs cannot decide the previous utterance's suffix because the needed pause duration arrives with the next utterance.
- `NoteSurface` already tracks spans with `start`, `textStart`, `textEnd`, and `end`, which is the right shape for preserving timestamp/boundary prefixes while replacing only ASR text on later revisions.
- `NoteSurface` should not also own transcript projection state. It should remain the editor-write boundary from D-014; `Session` should own a renderer object that tracks live projection state.

## Target Types and Settings

Replace phrase-separator terminology with transcript-formatting terminology.

```ts
export const TRANSCRIPT_FORMATTING_MODES = [
  'smart',
  'space',
  'new_line',
  'new_paragraph',
] as const;

export type TranscriptFormattingMode = (typeof TRANSCRIPT_FORMATTING_MODES)[number];

export interface PluginSettings {
  // existing fields...
  showTimestamps: boolean;
  transcriptFormatting: TranscriptFormattingMode;
}
```

Defaults:

```ts
showTimestamps: false
transcriptFormatting: 'smart'
listeningMode: 'always_on'
speakingStyle: 'balanced'
useNoteAsContext: true
```

No compatibility shim is needed for the old `phraseSeparator` field. This is a greenfield project; persisted unknown fields can be ignored by `resolvePluginSettings`.

Settings UI:

- Rename **Phrase separator** to **Transcript formatting**.
- Options:
  - Smart paragraphs
  - Space
  - New line
  - New paragraph
- Add **Show timestamps** toggle in the Transcription section.
- Settings remain session-scoped through the existing snapshot behavior: changes during an active session apply to the next session.

## Renderer Design

Create one plugin-side renderer/policy module at `src/transcript/renderer.ts`.

This is not an editor module. It owns transcript projection policy: boundary classification, sparse timestamp emission, timestamp formatting, and live renderer state. `Session` owns one `TranscriptRenderer` per dictation session. `NoteSurface` remains the imperative editor surface: it exposes a small read-only projection context from the current writing tail and writes the fully rendered insert projection that `Session` gives it.

This state ownership is intentional:

- `TranscriptRenderer` owns transcript projection state such as whether any text has rendered and the last emitted timestamp.
- `NoteSurface` owns editor state, spans, latching, and CodeMirror writes.
- `Session` coordinates them transactionally: ask the surface for tail context, ask the renderer to plan the append, ask the surface to write it, then commit renderer state only after the write succeeds.

Authoritative constants:

```ts
export const SMART_PARAGRAPH_PAUSE_MS = 3000;
export const TIMESTAMP_LANDMARK_INTERVAL_MS = 30_000;
```

Core concepts:

- **Pause classification** answers whether the incoming utterance follows a meaningful pause.
- **Formatting boundary** answers what Markdown prefix to insert before this utterance.
- **Timestamp policy** answers whether this utterance should get an inline elapsed-time marker.

Keep those concepts separate so fixed-space mode can still emit sparse timestamps after long pauses.

Suggested interfaces:

```ts
export interface TranscriptRenderOptions {
  readonly showTimestamps: boolean;
  readonly transcriptFormatting: TranscriptFormattingMode;
}

export interface TranscriptAppendInput {
  readonly pauseMsBeforeUtterance: number | null;
  readonly text: string;
  readonly utteranceId: UtteranceId;
  readonly utteranceStartMsInSession: number;
}

export interface TranscriptRenderContext {
  readonly tailContent: string;
}

export interface EmittedTimestamp {
  readonly elapsedMs: number;
  readonly text: string;
}

export interface TranscriptInsertProjection {
  readonly emittedTimestamp: EmittedTimestamp | null;
  readonly insertedText: string;
  readonly projectedText: string;
  readonly textEndOffset: number;
  readonly textStartOffset: number;
}

export class TranscriptRenderer {
  constructor(options: TranscriptRenderOptions);
  planAppend(input: TranscriptAppendInput, context: TranscriptRenderContext): TranscriptInsertProjection;
  commitAppend(projection: TranscriptInsertProjection): void;
}
```

`planAppend` reads renderer state but does not mutate it. `commitAppend` updates renderer state only after `NoteSurface` successfully writes the projection. If the append is denied, renderer state stays unchanged.

`tailContent` must be a string, not a single character. In the first implementation `NoteSurface` should pass at least the last two characters of the current writing region so the renderer can distinguish no newline, one newline, and an existing blank-line paragraph break. The renderer owns the slicing/normalization rules from that string.

Timestamp formatter contract:

```ts
export function formatSessionTimestamp(elapsedMs: number): string;
```

`formatSessionTimestamp` floors sub-second values with `Math.floor(elapsedMs / 1000)`. Its input contract is a non-negative elapsed millisecond value already validated by the protocol parser; do not clamp, synthesize, or recover from negative values in the formatter.

The renderer should be deterministic and unit-tested. It should not read editor state directly.

### Boundary Rules

For the first phrase:

- No inter-utterance separator.
- Preserve the existing end-of-note behavior: when anchoring at end of note and the note ends mid-line, the first dictated text starts on a new line.
- Avoid leading whitespace in an empty writing region.

For subsequent phrases:

- `space`: insert a single space unless the tail already ends in whitespace.
- `new_line`: insert enough newlines to produce exactly one line break before the next utterance.
- `new_paragraph`: insert enough newlines to produce exactly one blank-line paragraph break before the next utterance.
- `smart`:
  - pause `< SMART_PARAGRAPH_PAUSE_MS` or `null`: behave like `space`,
  - pause `>= SMART_PARAGRAPH_PAUSE_MS`: behave like `new_paragraph`.

The same `isMeaningfulPause` helper and `SMART_PARAGRAPH_PAUSE_MS` constant must drive both smart paragraph boundaries and timestamp emission after long pauses. Do not introduce a separate timestamp pause threshold.

Do not emit trailing separators. The note should not be left with dangling blank lines while waiting for the next utterance.

### Timestamp Rules

When `showTimestamps` is false, emit no timestamp text.

When `showTimestamps` is true, emit a timestamp if any of these are true:

- `lastTimestampMsInSession === null`,
- `pauseMsBeforeUtterance >= SMART_PARAGRAPH_PAUSE_MS`,
- `utteranceStartMsInSession - lastTimestampMsInSession >= TIMESTAMP_LANDMARK_INTERVAL_MS`.

The first condition covers the first rendered utterance. The interval condition is evaluated only when `lastTimestampMsInSession` is not `null`. If multiple conditions are true for the same utterance, emit exactly one timestamp. The marker uses `utteranceStartMsInSession` and updates `lastTimestampMsInSession` only after a successful append commit.

Timestamp examples:

```text
(0:00) First idea.
(12:04) Later idea.
(1:02:03) Long session idea.
```

When a boundary and timestamp both exist, the timestamp follows the boundary prefix:

```text
previous paragraph.

(1:10) next paragraph
```

Fixed-space mode with timestamps remains valid:

```text
(0:15) first thought. second thought. (0:48) thought after a long pause.
```

## NoteSurface Changes

Update `NotePlacementOptions`:

```ts
export interface NotePlacementOptions {
  anchor: DictationAnchor;
}
```

`NotePlacementOptions` keeps only editor-placement concerns. `showTimestamps` and `transcriptFormatting` belong to `TranscriptRenderer`, not `NoteSurface`.

Update `NoteSurfaceLike` / `NoteSurface` to support:

```ts
interface NoteProjectionContext {
  readonly tailContent: string;
}

interface NoteSurfaceLike {
  readProjectionContext(): NoteProjectionContext;
  appendProjection(utteranceId: UtteranceId, projection: TranscriptInsertProjection): AppendResult;
}
```

`NoteSurface` responsibilities:

- keep owning all editor writes per D-014,
- expose the current writing-tail context needed for prefix normalization,
- store spans so `textStart`/`textEnd` cover only the utterance text,
- include boundary/timestamp prefixes inside `start`/`end` so user edits to rendered timestamp text latch the utterance,
- clear pending initial-prefix cleanup after the first successful append.

Replacement behavior:

- `replaceAnchor` replaces only `span.textStart..span.textEnd`.
- Timestamp text and boundary prefixes from the original append remain stable through later revisions.
- If the user edits text, timestamp text, or boundary whitespace inside the span, the existing user-wins latch denies later replacements.

Trailing cleanup:

- Remove trailing separator cleanup for phrase modes because separators become prefixes.
- Keep cleanup only for any eager initial end-of-note prefix if that implementation remains. Prefer a small rename such as `pendingInitialPrefix` if the old `pendingTrailingContent` name becomes misleading.

## Session and Controller Flow

Add pause metadata to the canonical plugin revision:

```ts
export interface TranscriptRevision {
  // existing fields...
  pauseMsBeforeUtterance: number | null;
}
```

Flow:

1. Sidecar emits `transcript_ready`.
2. `DictationSessionController.handleTranscriptReady` trims `event.text` as it does today.
3. Controller passes `pauseMsBeforeUtterance` and utterance timing into `Session.acceptTranscript`.
4. `SessionJournal` records the revision with pause metadata.
5. `Session.applyAppend` asks `NoteSurface.readProjectionContext()` for `tailContent`.
6. `Session.applyAppend` asks its `TranscriptRenderer` to `planAppend(revision, context)`.
7. `Session.applyAppend` passes the planned projection to `NoteSurface.appendProjection`.
8. If the append succeeds, `Session.applyAppend` calls `renderer.commitAppend(projection)`.
9. Later revisions for the same utterance replace only the utterance text.

Validation:

- Keep protocol parsing as the source of truth for non-negative wire timing via `readNonNegativeNumber` / `readNullableNumber`.
- Do not add duplicate timing validation to `SessionJournal`; that would create a second internal failure path for data already accepted at the protocol boundary.
- `SessionJournal` should keep validating only its existing ownership concerns: session identity, utterance identity, revision ordering, and finalized/frozen state.

Do not read `TranscriptSegment.startMs/endMs` for note-facing timestamp markers in PR 5 or PR 6. Segment timing remains canonical metadata for future playback/export features.

Renderer state is live-session state only and intentionally does not appear in `createRecoverySnapshot`. D-013 says there is no resume across plugin reload, so persisting `lastTimestampMsInSession` would create an unused recovery contract.

## PR 5: Timestamp Rendering

Scope:

- Add `showTimestamps` setting, default `false`.
- Thread `pauseMsBeforeUtterance` into `TranscriptRevision`.
- Introduce `src/transcript/renderer.ts` with pause classification, timestamp formatting, timestamp emission, and prefix-only insert projections.
- Refactor `Session` to own a `TranscriptRenderer`.
- Refactor `NoteSurface` to write prefix-only projections without owning renderer state.
- While the persisted setting is still named `phraseSeparator`, map its fixed values into renderer `transcriptFormatting` options for the session snapshot.
- Scaffold all four renderer mode branches (`space`, `new_line`, `new_paragraph`, `smart`) in PR 5, but do not make `smart` the default or expose it as the shipped setting until PR 6.
- Add timestamp rendering to note insertion when `showTimestamps` is enabled.

Important implementation order:

1. Add renderer constants and pure tests first.
2. Add `pauseMsBeforeUtterance` to `TranscriptRevision`, fixtures, controller tests, and journal tests.
3. Add `TranscriptRenderer` ownership to `Session` with `planAppend` / `commitAppend`.
4. Refactor `NoteSurface.append` into `readProjectionContext` + `appendProjection`.
5. Add `showTimestamps` to settings resolution and session snapshot.
6. Pass renderer options and editor placement options separately from controller to `Session`.
7. Update tests for no trailing separator behavior.
8. Update docs that describe timestamp rendering as plugin-side projection.

Acceptance checks:

- With timestamps off, existing space-separated dictation still produces clean prose.
- With timestamps on, first utterance renders `(0:00) text`.
- A second utterance after a short pause does not get another timestamp unless the 30-second interval rule fires.
- A second utterance after `pauseMsBeforeUtterance >= SMART_PARAGRAPH_PAUSE_MS` gets a timestamp.
- A long continuous paragraph emits a timestamp at the next utterance boundary after 30 seconds.
- Revisions replace only utterance text, not timestamp prefixes.

## PR 6: Smart Paragraphs

Scope:

- Rename settings and types from phrase separator to transcript formatting.
- Add `smart` transcript formatting mode.
- Make `smart` the default.
- Update settings UI label/description to "Transcript formatting".
- Use the renderer's same pause classification for smart paragraph boundaries.
- Keep fixed modes: `space`, `new_line`, `new_paragraph`.

Important implementation order:

1. Replace `phraseSeparator` with `transcriptFormatting` across settings, controller snapshots, renderer options, tests, and UI.
2. Add `smart` to allowed values and make it the default.
3. Extend renderer tests for smart below-threshold and above-threshold pauses.
4. Add `NoteSurface` integration tests for smart paragraphs with and without timestamps.
5. Update docs/timeline language that still describes the older configurable timestamp/separator plan.

Acceptance checks:

- Default settings resolve to Always On, Balanced, note context on, Smart Paragraphs, timestamps off.
- Smart mode joins short pauses with a space.
- Smart mode renders a blank-line paragraph break after pauses of at least `SMART_PARAGRAPH_PAUSE_MS`.
- Smart mode never emits single-newline Markdown by default.
- Smart mode with timestamps renders paragraph starts as:

```text
(0:18) first thought.

(2:41) next thought after a pause.
```

- Fixed modes still work and do not accidentally inherit smart paragraphing.

## Edge Cases

- **Empty final transcript:** keep the journal entry but do not append to the note; the first later non-empty append still counts as the first rendered utterance for timestamp purposes.
- **First utterance starts after silence:** timestamp uses the utterance start, so first marker may be `(0:12)`, not forced to `(0:00)`.
- **Long pause in fixed-space mode:** timestamp can still appear inline after a space; paragraphing remains fixed-space.
- **Cap split continuation:** sidecar sends `pauseMsBeforeUtterance: null`; smart mode treats it as continuation, while the 30-second timestamp interval can still emit a marker.
- **User edits timestamp prefix:** the span includes the prefix, so the user-wins latch blocks future replacements for that utterance.
- **End-of-note anchor on a non-empty final line:** first rendered utterance starts on a new line as today.
- **Existing whitespace before tail:** renderer normalizes spaces/newlines so appends do not create duplicate spaces or excessive blank lines.
- **Session setting changes during dictation:** ignored until next session through the existing session snapshot pattern.

## Non-Goals

- No timestamp density setting.
- No timestamp placement setting.
- No timestamp format setting.
- No explicit pause annotations such as `[pause 38s]`.
- No word-level timestamp UI.
- No playback/click-to-seek behavior.
- No export formats such as SRT/VTT.
- No semantic or LLM paragraphing.
- No Rust engine-specific timestamp path.
- No persisted-setting migration shim for `phraseSeparator`.

## Test Plan

Unit tests:

- `test/transcript-renderer.test.ts`:
  - `formatSessionTimestamp`,
  - timestamp format boundary: `3_599_999 ms -> (59:59)` and `3_600_000 ms -> (1:00:00)`,
  - meaningful-pause classification,
  - 30-second timestamp interval,
  - long-pause timestamp emission and smart paragraphing both use `SMART_PARAGRAPH_PAUSE_MS`,
  - co-occurring long-pause and 30-second interval conditions emit exactly one timestamp,
  - fixed formatting prefixes,
  - smart formatting prefixes,
  - cap-split continuation with `pauseMsBeforeUtterance: null` does not create a smart paragraph break,
  - whitespace/newline normalization.
- `test/plugin-settings.test.ts`:
  - defaults,
  - supported `transcriptFormatting` values,
  - invalid formatting fallback,
  - `showTimestamps` boolean resolution,
  - old `phraseSeparator` ignored as an unknown field.
- `test/session-journal.test.ts`:
  - pause metadata retained.

Integration-style TypeScript tests:

- `test/note-surface.test.ts`:
  - timestamp prefix insertion,
  - timestamp plus paragraph boundary,
  - no dangling trailing separators,
  - replacement preserves timestamp prefix,
  - user edit inside timestamp/prefix latches the span,
  - smart short pause vs long pause.
- `test/session.test.ts`:
  - append receives timing metadata,
  - `Session` commits renderer state only after a successful surface append,
  - replacement still uses last projected text only,
  - recovery snapshot includes pause metadata through latest revisions.
- `test/dictation-session-controller.test.ts`:
  - controller passes `pauseMsBeforeUtterance`,
  - session creation receives editor placement and renderer options separately,
  - start-session sidecar command remains unchanged except existing model/listening fields.

Verification commands:

```bash
npm run typecheck
npm test
npm run lint
npm run build:frontend
```

Rust verification is not required if implementation stays plugin-only. If any native protocol or session code changes, also run:

```bash
cargo fmt --check
cargo test
```

## Rollout Notes

- Because this is greenfield, break the TypeScript settings shape cleanly instead of adding compatibility branches.
- Keep PR 5 and PR 6 separate. PR 5 must do the prefix-only renderer refactor and scaffold all four boundary branches; PR 6 should only expose/default the smart mode and finish UX naming, not rewrite boundary logic.
- Do not update `PLANS.md` during implementation unless the user asks for a plan change. If implementation reveals a better approach, document the final durable decision in `docs/decisions.md` or `docs/system-architecture.md` after the code lands.
