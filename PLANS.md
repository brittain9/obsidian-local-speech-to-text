# Refine Transcript Insertion UX

## Objective

Replace the conflated `insertionMode` setting with two orthogonal settings (`dictationAnchor` × `phraseSeparator`), pin the anchor at session start, and render an inline CodeMirror 6 widget at the anchor for the lifetime of the session so the user always sees where the next phrase will land. Out of scope: post-transcript pipeline (D-009), session-locked-to-note (issue #5), VAD-pause-derived "smart" separator.

## Current State

- `src/settings/plugin-settings.ts` exposes `insertionMode ∈ { insert_at_cursor | append_on_new_line | append_as_new_paragraph }`. The three values mash together *where* the session writes and *how* phrases separate.
- `src/editor/editor-service.ts::insertTranscript(text, mode)` reads the active editor on every `transcript_ready` and writes via Obsidian's `Editor` abstraction.
- `src/editor/transcript-placement.ts::resolveAppendTranscriptPlacement` computes append placement; not separator-aware.
- `src/dictation/dictation-session-controller.ts::handleSidecarEvent` (~line 223) calls `insertTranscript` on `transcript_ready`. There is no anchor concept and no in-document indicator of where the next phrase lands.
- Concrete defects today: `always_on` + `insert_at_cursor` concatenates with no separator (`foxjumped`); append modes teleport the cursor to end-of-doc with no auto-scroll, transcripts land off-screen in long notes; during the 200 ms–5 s inference window there is no visible anchor.
- `esbuild.config.mjs::externalModules` lists `['electron', 'obsidian', ...builtinModules]`. `@codemirror/*` is **not** externalized. `package.json` has no `@codemirror/*` devDependencies. `vitest` runs in Node (no jsdom).
- `styles.css` already defines `var(--interactive-accent)` usage and a `@media (prefers-reduced-motion: reduce)` block (~line 439). The existing `local-stt-chase` keyframe is per-spoke opacity targeting — unworkable for an inline 1 em widget.

## Constraints

- AGENTS.md: surgical changes, no speculative abstractions, match existing style.
- Memory rule: greenfield project, **no settings versioning** — old `insertionMode` field is silently dropped, no migration shim.
- D-005: UI uses Obsidian primitives (`Setting`, `Notice`, `setIcon`).
- The plugin/sidecar boundary stays clean: this PR is plugin-only, no sidecar changes.
- CM6 identity: `@codemirror/state` and `@codemirror/view` MUST be esbuild externals — bundling a second copy makes our `StateField`/`StateEffect` instances `!==` the host's and dispatches silently no-op.
- Holding a raw `EditorView` across async boundaries is unsafe — Obsidian destroys the view when the leaf closes; need an `active-leaf-change` guard.

## Approach

### Settings model

```ts
// src/settings/plugin-settings.ts
export type DictationAnchor = 'at_cursor' | 'end_of_note';
export type PhraseSeparator = 'space' | 'new_line' | 'new_paragraph';
```

Defaults: `dictationAnchor: 'at_cursor'`, `phraseSeparator: 'space'` (reproduces today's default behavior). Remove `insertionMode`, `INSERTION_MODES`, `isInsertionMode`, `readInsertionMode`. Old field silently dropped in `resolvePluginSettings`.

### Insertion semantics

- **Anchor** = a live document position pinned at `session_started`. `at_cursor` pins at the caret (or selection end if a selection is active — selection is **not** replaced; this differs from macOS Voice Control/Dragon, deliberate). `end_of_note` pins at doc end.
- **First phrase**: `at_cursor` → no prefix; `end_of_note` → `\n` prefix iff doc non-empty and doesn't end in `\n`.
- **Subsequent phrases**: prefix by `phraseSeparator` (`" "`, `"\n"`, `"\n\n"`). Paragraph separator dedups: if the char immediately preceding the anchor is already `\n`, use `"\n"` instead so consecutive `new_paragraph` inserts don't accumulate `\n\n\n\n`.
- After every insertion the anchor advances via `tr.changes.mapPos(newPos, -1)` against the same transaction's change set — never `oldPos + text.length`. The user's cursor is **not** moved.
- The anchor auto-maps through unrelated edits via `ChangeSet.mapPos(pos, -1)`. The `-1` (bias left) is required so text inserted *at* the anchor stays to the right of it, letting the next phrase concatenate cleanly.
- **Cursor mid-word at session start** is a documented carry-over: anchor pins at the caret offset and the first phrase doesn't auto-prefix a space. User responsibility.

### Anchor widget

New file: `src/editor/dictation-anchor-extension.ts`. CM6 extension with:

- `StateField<{ pos: number | null; mode: 'hidden' | 'dot' | 'pulse' }>` — remaps `pos` via `tr.changes.mapPos(pos, -1)` on every transaction. `StateField` (not `ViewPlugin`) so state survives view re-creation (theme switches).
- `StateField<DecorationSet>` derived from the above: zero or one widget decoration at `pos` when `mode !== 'hidden'`. CSS class `local-stt-dictation-anchor local-stt-dictation-anchor--{mode}` — visual states are pure CSS.
- `StateEffect`s: `setAnchor(pos)`, `clearAnchor()`, `setMode(mode)`. Insertion uses a normal `ChangeSpec` in the same transaction as the anchor-advance effect (no separate `insertAt` effect).
- Widget `toDOM()` builds `<span role="status" aria-label="Dictation anchor" class="local-stt-dictation-anchor local-stt-dictation-anchor--{mode}">` and calls `setIcon(span, 'audio-lines')`. `WidgetType.ignoreEvent` returns `true`.
- Registered globally via `this.registerEditorExtension(...)` in `src/main.ts`. Per-editor cost is negligible (one null-pos `StateField`).

**Mode mapping** (sidecar state → widget mode):

| Sidecar state | Mode |
|---|---|
| `starting`, `listening` | `dot` |
| `speech_detected`, `speech_paused`, `transcribing` | `pulse` |
| `idle`, `paused`, `error` | `hidden` |

On `transcript_ready`, mode drops to `dot` *inside the same transaction* that inserts the text — no flicker. Next `speech_detected` returns it to `pulse`.

### EditorService

Replace `insertTranscript(text, mode)` with:

```ts
class EditorService {
  beginAnchor(anchor: DictationAnchor): void;             // capture EditorView, pin pos, subscribe to active-leaf-change
  insertPhrase(text: string, sep: PhraseSeparator): void; // single transaction: insert + advance anchor + scrollIntoView
  setAnchorMode(mode: 'dot' | 'pulse' | 'hidden'): void;
  endAnchor(): void;                                      // clear pos + widget + listener
}
```

- Stores `EditorView` once on `beginAnchor` plus a `firstPhrase` flag.
- Registers `workspace.on('active-leaf-change')` via `plugin.registerEvent`. On any change where the new active `editor?.cm !== storedView`, calls `endAnchor()` and emits a `Notice("Dictation anchor moved to {note name}")`. Re-anchor happens on the next `session_state_changed`/`transcript_ready` via the controller.
- Defensive guard: every `setAnchorMode` / `insertPhrase` checks `storedView === app.workspace.activeEditor?.editor?.cm` before dispatch; silent no-op on mismatch.
- `insertPhrase` builds one transaction with `ChangeSpec` (`separator + text` at anchor) + `setMode('dot')` + `setAnchor(newPos)` where `newPos = tr.changes.mapPos(oldPos + separator.length + text.length, -1)`. Followed by `EditorView.scrollIntoView(EditorSelection.cursor(newPos), { y: 'nearest' })` so scroll only fires when the anchor leaves the viewport.
- First-vs-subsequent prefix logic moves to `src/editor/transcript-placement.ts` as a pure `computePhrasePrefix({ anchor, separator, isFirstPhrase, charBeforeAnchor }): string`. EditorService prepends, then builds the `ChangeSpec`.
- Direct `editor.cm.dispatch` is safe — Obsidian's `Editor.replaceRange` wraps the same call, history extension captures the transaction, `vault.on('modify')` debouncing unchanged.

### Session wiring (`src/dictation/dictation-session-controller.ts`)

In `handleSidecarEvent`:
- `session_started` → `editorService.beginAnchor(settings.dictationAnchor)` then `setAnchorMode('dot')`.
- `session_state_changed` → `setAnchorMode(...)` per the table above.
- `transcript_ready` → `editorService.insertPhrase(event.text, settings.phraseSeparator)`.
- `session_stopped` (any reason) → `editorService.endAnchor()`.

The existing `assertActiveEditorAvailable()` pre-flight at session start (line 88) stays — no active editor means we never reach `beginAnchor`.

### Settings UI (`src/settings/settings-tab.ts`)

Replace the single "Transcript placement" `Setting` (lines 147–164) with two dropdowns under the existing "Transcription" heading:

- **Dictation anchor**: "At cursor" / "End of note". Desc: *"Where each dictation session anchors. The first phrase lands here and stays pinned for the rest of the session, even if you click elsewhere in the note."*
- **Phrase separator**: "Space" / "New line" / "New paragraph (use this if you pause between thoughts)". Desc: *"How consecutive phrases are joined within one session. Does not affect the first phrase."*

### Build config

- `package.json` → add `@codemirror/state`, `@codemirror/view` to `devDependencies` (types only).
- `esbuild.config.mjs` → add `'@codemirror/state'`, `'@codemirror/view'` to `externalModules`.

### CSS (`styles.css`)

Add `.local-stt-dictation-anchor` plus `--dot`/`--pulse` modifiers and a new `local-stt-pulse` keyframe. Do **not** reuse `local-stt-chase` (per-spoke `nth-child` rules unworkable at 1 em). Extend the existing `@media (prefers-reduced-motion: reduce)` block (~line 439).

```css
.local-stt-dictation-anchor {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  line-height: 1;
  vertical-align: 0.1em;
  overflow: hidden;
  color: var(--interactive-accent);
  pointer-events: none;
  user-select: none;
}
.local-stt-dictation-anchor--dot   { opacity: 0.55; }
.local-stt-dictation-anchor--pulse { animation: local-stt-pulse 1.4s ease-in-out infinite; }

@keyframes local-stt-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .local-stt-dictation-anchor--pulse { animation: none; opacity: 0.85; }
}
```

## Execution Steps

- [ ] **Build config**: add `@codemirror/state`, `@codemirror/view` to `devDependencies`; add both strings to `externalModules` in `esbuild.config.mjs`. Run `npm install`. Verify `npm run build` succeeds and `main.js` does not contain a bundled CM6 (`grep -c '@codemirror/state' main.js` should be small / import-only).
- [ ] **Settings model**: rewrite `src/settings/plugin-settings.ts` to remove `insertionMode` and add `dictationAnchor` + `phraseSeparator`. Outcome: `tsc` clean; old saved-data values silently fall back to defaults.
- [ ] **Pure prefix calculator**: rewrite `src/editor/transcript-placement.ts` as `computePhrasePrefix({ anchor, separator, isFirstPhrase, charBeforeAnchor }): string`. Delete the old `resolveAppendTranscriptPlacement` shape.
- [ ] **CM6 extension**: create `src/editor/dictation-anchor-extension.ts` with the `StateField` pair, `StateEffect`s, `WidgetType`. Register it in `src/main.ts` via `this.registerEditorExtension(...)`.
- [ ] **EditorService**: replace `insertTranscript` with `beginAnchor` / `insertPhrase` / `setAnchorMode` / `endAnchor`. Wire the `workspace.on('active-leaf-change')` listener via `plugin.registerEvent`, with `Notice` on re-anchor.
- [ ] **Session wiring**: update `src/dictation/dictation-session-controller.ts::handleSidecarEvent` to call the new EditorService API per the mode-mapping table.
- [ ] **CSS**: add `.local-stt-dictation-anchor` + modifier styles + `local-stt-pulse` keyframe + reduced-motion override.
- [ ] **Settings UI**: replace the single "Transcript placement" `Setting` in `src/settings/settings-tab.ts` with two dropdowns and the copy above.
- [ ] **Tests** (Vitest, Node env, `EditorState` only — no `EditorView`):
  - [ ] `test/plugin-settings.test.ts` — new fields resolve correctly; legacy `insertionMode` silently dropped; defaults applied; unknown values rejected.
  - [ ] `test/transcript-placement.test.ts` — `computePhrasePrefix` matrix: each anchor × first-vs-subsequent, paragraph dedup when char-before is `\n`.
  - [ ] **NEW** `test/dictation-anchor-extension.test.ts` — construct `EditorState` with the extension; `setAnchor` updates pos; `setMode` changes class; `mapPos(-1)` keeps anchor at left edge of an at-anchor insertion; edits above the anchor shift `pos`.
  - [ ] `test/editor-service.test.ts` — replace `FakeEditor` with a CM6 `EditorState`-backed fake; `beginAnchor → insertPhrase(×3) → endAnchor` for each (anchor × separator); user-cursor-moves preserved; user-edits-above-anchor preserves alignment; `setAnchorMode` no-ops when stored view ≠ active view.
  - [ ] `test/dictation-session-controller.test.ts` — mode transitions match the table; `endAnchor` on `session_stopped` regardless of reason.

## Verification

- `npm run build` — TypeScript compiles. `grep '@codemirror' main.js` returns only externalized references (no bundled module bodies).
- `npm test` — all suites pass.
- Manual, in dev vault, across all 6 (`dictationAnchor` × `phraseSeparator`) combos under both listening modes:
  1. Start dictation → static dot at correct anchor on `session_started`.
  2. Begin speaking → dot transitions to pulse.
  3. Click elsewhere in the same note mid-inference → widget stays put.
  4. Transcript inserts at anchor, not cursor.
  5. `always_on` × 3 phrases → separator only between phrases (not before first); anchor advances past each.
  6. `end_of_note` in a long note → editor auto-scrolls so anchor stays visible.
  7. Type above the anchor mid-inference → insertion lands in same logical spot.
  8. OS reduced-motion enabled → pulse suppressed, anchor still visible.
- Edge cases (manual):
  - Empty note → first-phrase prefix empty.
  - Doc ending in `\n` + `end_of_note` → first-phrase prefix empty.
  - `at_cursor` with selection at start → anchor pins at selection end; selection **not** replaced.
  - `at_cursor` with cursor mid-word → anchor pins at caret offset (splits the word; documented).
  - Two consecutive `new_paragraph` inserts → dedup to `\n` between them.
  - Switch notes mid-`always_on` → old widget vanishes immediately, `Notice` appears with new note name, next utterance re-anchors as "first phrase".
  - Close anchored leaf (`Cmd+W`) → no crash on next state event; next `transcript_ready` dropped with `Notice` if no active markdown editor.
  - Switch from markdown leaf to graph/canvas mid-session → same as close-leaf path.
  - Theme switch mid-session → anchor state survives view re-creation.

## Risks and Open Questions

- **CM6 identity**: if the esbuild externals step is missed, the extension silently no-ops and the bug looks like "the widget never appears" with no error. Mitigation: explicit verification step on `main.js`.
- **Active-leaf-change race**: the proactive listener runs before `transcript_ready` arrives in most cases, but a tight race could mean an in-flight `insertPhrase` sees a stale `storedView`. Defensive identity check in EditorService handles this; cost is one dropped insertion in the rare race.
- **Selection-replace divergence from Dragon/Voice Control**: explicit choice not to replace selection. Revisit if user feedback says otherwise.
- **Mid-word anchor**: documented carry-over rather than a fix — acceptable for now; could add a "snap to next word boundary" later if it surfaces as friction.
- **`active-leaf-change` test coverage**: verified manually only. Building a fake workspace to unit-test the listener is not worth the cost for this single path.
- **Smart pause-based paragraph separator**: deferred. Requires VAD pause metadata on `transcript_ready` — wait for D-009 work before adding.
