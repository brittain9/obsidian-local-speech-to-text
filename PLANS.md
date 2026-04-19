# Dictation UX v2 — flush caret, stable in-note processing, VAD rename

## Objective

Fix two live-repro bugs and one cross-boundary rename surfaced during real use of the newly-landed dictation anchor, while keeping one canonical UX model:

1. **Phantom spinner mid-phrase.** Mid-sentence pauses can produce a real processing phase, but the resulting transcript may arrive empty or so quickly that the spinner is more confusing than helpful. The user sees a loader at the insertion point and then no text lands.
2. **Caret not flush with insertion point.** The anchor widget sits in a 1em-wide inline-flex box, so the 2px caret renders ~0.5em from where text will actually land.
3. **Naming: `speech_paused` is a misleading label for the Silero hysteresis state.** Rename to `speech_ending` across the wire protocol (Rust) + plugin types + tests + docs.

Canonical UX target:

- **Ribbon = global session status only.** Idle / starting / listening-active / hearing-speech / error. No processing spinner once a session is running.
- **In-note anchor = insertion and progress.** Delayed purple caret while speaking or in the speech-ending hysteresis window; spinner at the insertion point only when processing lasts long enough to be useful.
- **No feature flags or alternate UX paths.** We are not supporting both ribbon-processing and in-note-processing modes.

## Current State

**VAD finalization (`native/src/session.rs`)** — frames are 20ms. Style → `silence_end_frames`:

- `Responsive` → 20 frames = 400ms (`session.rs:70`)
- `Balanced` (default) → 50 frames = 1000ms (`session.rs:71`)
- `Patient` → 100 frames = 2000ms (`session.rs:72`)

`pending_end_start` latches when `probability < negative_threshold` (`session.rs:248-251`); finalization fires when `silence_end_frames` additional frames have elapsed since that latch (`session.rs:258-261`). `negative_threshold = speech_threshold − 0.15` (`session.rs:13,17-24`).

**State derivation (`native/src/app.rs:980-1013`)** — once an utterance is enqueued, `transcription_active = true` (`app.rs:759`), which maps to `Transcribing` or `Paused` in `derive_session_state`. The base state (`SpeechDetected` / `SpeechPaused`) wins over transcription only while still inside the same utterance (`app.rs:988-994`). In other words: the sidecar already only emits processing states after a real utterance handoff; those states do **not** guarantee user-visible text.

**Plugin anchor mapping (`src/dictation/dictation-session-controller.ts`)** — per-state:

- `speech_detected` / `speech_paused` → `'speaking'` (after 2500ms delay, `:189-211`)
- `transcribing` / `paused` → `'processing'` (spinner), after last commit
- other → `'hidden'`

**Empty-transcript handling** — `normalizeTranscriptText` returns `null` for blank text, and the controller drops the insert (`dictation-session-controller.ts:330-337`). The spinner was still shown for the dropped attempt because the plugin surfaces processing immediately on `transcribing` / `paused`.

**UX history — why this surfaced now.** `derive_session_state` (`app.rs:988-994`) returns `SpeechDetected` / `SpeechPaused` *before* falling through to `Transcribing` / `Paused`, so while any speech is active the sidecar does not emit a processing state. In the ribbon-only UX this priority hid the churn: a short mid-phrase finalization was only visible during the narrow gap between `Listening` and the next speech frame, and even then it competed with speech animations for attention. Moving processing into the note removed that cover — the flicker we see now is the same sidecar behavior that was always there, just newly visible. The fix must preserve in-note progress value without reintroducing the churn.

**Widget layout (`styles.css:459-491`)**:

```css
.local-stt-dictation-anchor {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1.2em;
  vertical-align: middle;
  /* … */
}
```

The 1em width + `justify-content: center` puts the 2px caret ~0.5em off the insertion offset. `side: -1` on the widget decoration (`src/editor/dictation-anchor-extension.ts:88`) renders it immediately before `pos`.

**Rename scope for `speech_paused → speech_ending`**:

- Rust: `native/src/protocol.rs:94`, `native/src/session.rs:100,166,572,575,586`, `native/src/app.rs:992,993,1010`
- TS: `src/sidecar/protocol.ts:44,656`, `src/dictation/dictation-session-controller.ts:15,190,397`, `src/ui/dictation-ribbon.ts:49,74`
- Tests: `test/dictation-session-controller.test.ts`, `test/dictation-ribbon.test.ts`, native session tests
- Docs: `docs/architecture/system-architecture.md:199-201,365,370`

Serde `rename_all = "snake_case"` (`protocol.rs:89`) turns the Rust variant name into the wire string — renaming the variant to `SpeechEnding` emits `"speech_ending"` automatically.

## Constraints

- **Root-cause-first for the spinner bug.** Repro and instrument before deciding whether the problem is solved by plugin-side spinner debounce/cancellation or whether Balanced-mode VAD tuning is also required.
- **One UX model only.** No feature flags, no hidden toggles, no fallback path that restores ribbon-based processing feedback.
- **Wire protocol rename is atomic.** Rust variant + TS parser + type union + all branches must land in one commit. Session state is transient (no persisted string), so no migration is needed.
- **Preserve everything from the last round**: delayed pulse (2500ms), ribbon/anchor split, reduced-motion fallbacks.
- **No speculative VAD constant changes.** If we adjust `silence_end_frames` or `negative_threshold`, a new Rust test must demonstrate a scenario that fails before and passes after.
- **Zero-width widget must still be keyboard/screen-reader inert.** `aria-hidden="true"`, `pointer-events: none`, `user-select: none` stay.
- **Do not expose hysteresis detail in the UI.** `speech_ending` is an internal/protocol rename; ribbon and anchor behavior should stay grouped with the speaking phase.

## Approach

### 1. Rename `speech_paused` → `speech_ending`

One atomic commit:

- Rust: rename `SessionBaseState::SpeechPaused` and `SessionState::SpeechPaused` to `SpeechEnding`. All match arms, test names, and comments that reference the old name move with it. The serde tag becomes `"speech_ending"` via existing `rename_all`.
- TS: update the `SessionState` union (`src/sidecar/protocol.ts:44`), parser (`:656`), `DictationControllerState` (`dictation-session-controller.ts:15`), and all match arms in `applySessionStateToAnchor` and `buildRibbonState` / `toVisualState`.
- UX mapping stays intentionally grouped with speech: `speech_ending` keeps the same delayed purple-caret behavior as `speech_detected`, and the ribbon keeps the same speaking-phase visual treatment rather than surfacing a new user-facing mode.
- Tests: rename the case in the ribbon parametrised table, update the short-utterance test narrative, rename the Rust session test `speech_paused_state_during_brief_silence`.
- Docs: update `system-architecture.md` state diagram (lines 199-201), the ribbon mapping table (line 365), and the explanatory paragraph (line 370).

### 2. Flush the widget to the insertion offset (CSS)

Replace the 1em inline-flex box with a zero-width, absolutely-positioned overlay. The caret and the spinner become positioned children; text layout is not displaced.

```css
.local-stt-dictation-anchor {
  display: inline-block;
  position: relative;
  width: 0;
  height: 1.2em;
  vertical-align: middle;
  overflow: visible;
  pointer-events: none;
  user-select: none;
}

.local-stt-dictation-anchor--speaking::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 1em;
  /* existing border-radius / background / animations */
}

.local-stt-dictation-anchor--processing {
  /* spinner icon sits in a child <span>; pin it with absolute positioning */
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  /* existing color / opacity / animation */
}
```

Because `setIcon` writes to the span itself (not a child — `dictation-anchor-extension.ts:58`), the `--processing` rules target the same element. We either (a) keep the SVG inside the span and let the SVG inherit positioning, or (b) wrap the icon in a child and position the child. (a) is simpler — the SVG from `setIcon` is a direct child and natural flow keeps it at `left: 0`. Verify under Obsidian's lucide SVG sizing.

This change is only about making the purple dictation caret/spinner flush with the insertion point. Native/white-caret overlap remains out of scope for this plan.

### 3. Root-cause and stabilize the phantom spinner

Instrument first, decide second. No constant changes before we see the emitted event sequence for a real repro. The sidecar already only surfaces processing after queueing a real utterance, so the first fix path is about **when the plugin chooses to show the in-note spinner**, not about restoring ribbon loading or adding toggles.

- **3a. Instrument.** Add temporary debug logging for the emitted event sequence we actually have access to:
  - plugin side: every `session_state_changed` with timestamp and state, plus every `transcript_ready` with normalized-text length
  - only if that is insufficient, add Rust-side debug around `emit_state_if_changed`
  - do **not** try to log a plugin-side `transcription_active` snapshot; that value only exists inside the Rust sidecar
- **3b. Classify.** With the log, answer:
  - Is this primarily a **fast/empty processing window** where no useful spinner should be shown?
  - Or is this a **real utterance split** where a short but substantive transcript lands and the VAD boundary itself is wrong?
  - How long is the gap between the first processing state and `transcript_ready` / resumed speech?
- **3c. Fix, ordered by preference.** (i) and (ii) are complementary and should land together if the repro supports both.
  - **(i) Plugin: debounce the in-note processing indicator.** Delay `setAnchorMode('processing')` by ~300-350ms. If the state flips back to `speech_detected` / `speech_ending`, `listening`, `idle`, or `error` before that window expires, cancel the pending spinner. Also clear the pending timer on `transcript_ready` so a fast result cannot surface a late spinner after text insertion or an empty drop. Matches the UX problem directly: show processing only when the user benefits from seeing it.
  - **(ii) Sidecar: suppress micro-utterance handoff.** When `FinalizeUtterance` fires with committed audio shorter than a threshold (~150ms, i.e. under `silence_end_frames` worth of real speech frames), drop it in `enqueue_utterance` without setting `transcription_active`. These rounds almost always produce blank or hallucinated transcripts and the processing state they trigger is pure noise. Add a Rust test that drives the session to a sub-threshold utterance and asserts no `Transcribing`/`Paused` emission.
  - **(iii) Sidecar: VAD tightening, only if logs show a real utterance-boundary bug.** Bump `silence_end_frames` for Balanced (e.g., 50 → 60 frames = 1200ms) and/or widen `NEGATIVE_THRESHOLD_DELTA` (0.15 → 0.20). Add a Rust test with a mid-phrase pause that finalized before and no longer finalizes after.
  - **(iv) Do not add feature flags or alternate indicator surfaces.** Ribbon processing is not coming back as a fallback path.

### 4. Deferred / out of scope

- Native/white-caret overlap: out of scope for this change.
- Any broader VAD redesign or SpeakingStyle UX copy changes.
- Engine-level hallucination post-filter (e.g., whisper's known filler-token outputs). Complementary to §3c-ii but whisper-specific and larger in scope; track separately if the micro-utterance suppression doesn't cover enough of the real cases.

## Execution Steps

- [ ] Reproduce the spinner bug on the current build; capture the event sequence for the phantom-spinner repro (needs the debug instrumentation from §3a).
- [ ] Rename `speech_paused → speech_ending`: Rust (protocol.rs, session.rs, app.rs, session tests) + TS (protocol.ts, session controller, ribbon, tests) + docs. Gate on `npm run test && cargo test --manifest-path native/Cargo.toml`.
- [ ] Rework `.local-stt-dictation-anchor` CSS to zero-width / absolute-positioned overlay. Live-verify caret flush at 14px / 16px / 18px editor font, light and dark theme.
- [ ] Implement §3c(i) plugin debounce with controller tests locking it down.
- [ ] Implement §3c(ii) sidecar micro-utterance suppression with a Rust test, unless §3b classifies every observed flicker as already-covered by the debounce.
- [ ] Only touch Rust VAD thresholds (§3c-iii) if §3b proves a real utterance-splitting bug in Balanced mode.
- [ ] Remove the debug instrumentation added in the first step, or gate it behind the existing plugin logger level if it has ongoing value.
- [ ] `npm run check` clean — typecheck, biome, vitest, esbuild, cargo fmt, clippy, cargo test.

## Verification

**Automated:**

- `npm run typecheck && npm run test` — covers controller mapping, ribbon visual state, protocol parser, session-controller state sequences with the new `speech_ending` label.
- `cargo test --manifest-path native/Cargo.toml --features engine-cohere-transcribe,engine-whisper` — covers the VAD state machine and the serialized wire name.
- `npm run check` before PR.

**Live (requires user):**

- Mid-sentence pause in **Balanced** mode that used to produce a phantom spinner → no visible spinner flicker if processing resolves quickly or resumes into speech.
- Longer deliberate stop → spinner appears once, transcript lands, single contiguous phrase.
- Caret is flush with the start of a new line / next-word boundary at all three editor font sizes.
- Ribbon shows active/listening or hearing-speech only; processing feedback is in-note only.
- Reduced-motion still collapses animations on ribbon and anchor.

## Risks and Open Questions

- **SpeakingStyle setting.** If the user is on `Responsive` (`silence_end_frames = 400ms`), mid-phrase pauses split utterances by design and no sidecar fix short of a VAD redesign helps. Confirm the current setting during §3a repro.
- **Rename breakage across boundary.** Plugin and sidecar ship together; rename is safe. Flag in the commit message that an older sidecar binary in someone's sandbox would break — this is intrinsic to changing the wire enum.
- **Zero-width widget vs. IME / composition.** Obsidian Markdown editor uses CM6; CM handles widgets with `side: -1` cleanly. Watch for any composition-input weirdness during the live check.
- **Debounce delays real spinner.** This is intentional UX trade-off: sub-350ms processing should usually complete without a spinner. Cap at ~350ms so longer processing still gets feedback.
- **Real utterance splits may remain after the UX fix.** If the repro still produces short, substantive split transcripts in Balanced mode, the follow-up is a Rust VAD tuning change with a targeted regression test.
- **Micro-utterance threshold tuning.** Too low (~100ms) and hallucination-prone rounds still slip through; too high (~300ms) and genuine short words ("yes", "no") get dropped. Pick the threshold off §3b log data, not off intuition; include the threshold constant in the Rust test so regressions are obvious.
- **Spinner CSS — SVG sizing.** Obsidian's lucide icons render at `currentColor` with intrinsic `width: 16px; height: 16px`. Confirm they still display correctly inside an absolutely-positioned, zero-width parent; if not, wrap the icon in a positioned child.
