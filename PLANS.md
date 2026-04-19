# Dictation Anchor UX Simplification

## Objective

Remove the in-note "processing" spinner. Collapse the anchor widget to a single live affordance: a pulsing cursor that appears after 2.5s of speech and stays until the session settles. The in-note indicator owns one meaning — "session is actively working on an utterance." Transcription status stops being broadcast across two surfaces.

## Current State

Three-mode anchor: `hidden | speaking | processing`.

- `speaking` arms on `speech_detected`/`speech_ending` after `SPEAKING_INDICATOR_DELAY_MS` (2500ms).
- `processing` arms on `transcribing`/`paused` after `PROCESSING_INDICATOR_DELAY_MS` (350ms) and renders the `loader-2` spinner.
- `insertPhrase` unconditionally emits `setAnchorModeEffect.of('hidden')` after every transcript.
- Controller carries two flags (`inSpeechState`, `processingPending`) to guard re-entry and two timer handles.

Observed failures (confirmed by audit):
- 350ms threshold is crossed by virtually every real transcript — spinner reads as "processing" rather than "slow."
- Mid-session `insertPhrase` rips the cursor away even when utterance 2 is already in flight; forces a fresh 2.5s wait.
- Empty / VAD-rejected / filtered-out utterances leave the spinner with no text to deliver. Feels broken.

Ribbon already renders `transcribing`/`paused` as the `listening` visual with 0.7 opacity, but still surfaces the labels "Transcribing…" / "Processing…" — the only place ribbon duplicates the anchor's job.

Uncommitted on branch `feat/dictation-anchor-ux` from a prior `/simplify` pass: +38/−30 across `dictation-anchor-extension.ts`, `editor-service.ts`, `dictation-session-controller.ts`, and the test file. Verified (`tsc` clean, 200/200 tests). Lands as its own commit; this UX change is a separate commit on top.

## Constraints

- Preserve the 2.5s speech-onset delay (it's what filters out background noise / brief hallucinations and is the behavior the user explicitly wants).
- Preserve `hideWhenCursorOverlaps` semantics for `at_cursor` anchor (unrelated to mode narrowing).
- No protocol-version bump — this is purely a plugin-side change. Sidecar event surface is unchanged.
- No backwards-compat shims for the renamed mode (greenfield project; see lessons.md 2026-04-18).
- Keep the commit for the prior `/simplify` cleanup separate from this UX change (different intents, easier to review, easier to revert).
- Ribbon change is limited to label text. Visual treatment (0.7 opacity dim on `listening` class) stays as-is.

## Approach

**Narrow `DictationAnchorMode` to `'hidden' | 'visible'`.** Rename `speaking` → `visible`; delete the `processing` branch. The widget's "speaking" pulse visual becomes the single live affordance; remove the spinner DOM path entirely.

**Controller collapses to one timer.** Mode becomes a function of session-state family membership with a single 2.5s arming rule:

```
speech-family = { speech_detected, speech_ending, transcribing, paused }

on session_state_changed(next):
  if next ∈ speech-family:
    if anchorTimer is null and anchor.mode == 'hidden':
      arm 2.5s timer → on fire: setAnchorMode('visible')
  else:   # listening | idle | starting | error
    cancel anchorTimer
    setAnchorMode('hidden')
```

No per-utterance re-arming. No second timer. `inSpeechState` and `processingPending` deleted. Timer guard is simply "is the timer handle non-null?"

**`insertPhrase` stops touching mode.** Text insertion and anchor-position updates continue; the mode is owned solely by the controller's state-family rule. This fixes the mid-utterance cursor-rip.

**Ribbon labels.** `transcribing` → "Listening". `paused` → "Listening". Visual class and opacity stay. Anchor owns the transcription signal; ribbon owns capture state only.

**Trade-off accepted.** Slow-inference case (>5s transcription) shows no distinct indicator — the cursor keeps pulsing, same as during active speech. If dogfooding surfaces this as a problem, add a ribbon pulse/badge later (separate change). The pain points we have today outweigh a hypothetical slow-path signal.

## Execution Steps

- [ ] **Commit prior `/simplify` cleanup.** `git add` only the four files already modified; commit as `chore: simplify dictation anchor hot path` (or similar). Verify: `npm run check` clean, `git status` clean after commit.
- [ ] **Narrow `DictationAnchorMode` and delete processing branch.** In `src/editor/dictation-anchor-extension.ts`:
  - `export type DictationAnchorMode = 'hidden' | 'visible'`
  - Replace `WIDGETS` record with a single `Decoration.widget` for `visible`
  - Delete the `processing` branch of `DictationAnchorWidget` (remove `setIcon` import if no longer used elsewhere in file)
  - Update decorationsFor to handle only two modes
  - Verify: `tsc --noEmit` passes; existing `dictation-anchor-extension.test.ts` fails only in the predictable places (processing-mode assertions, speaking→visible renames).
- [ ] **Update controller state-family rule.** In `src/dictation/dictation-session-controller.ts`:
  - Delete `PROCESSING_INDICATOR_DELAY_MS`, `processingTimerId`, `processingPending`, `inSpeechState`, `clearProcessingTimer`, `clearSpeakingTimer` (fold into one `clearAnchorTimer`)
  - Replace `applySessionStateToAnchor` with the single-timer rule above
  - `handleTranscriptReady` no longer needs to clear a processing timer (does `clearAnchorTimer` only if state isn't already in a speech family — though since `transcript_ready` itself doesn't change session state, this is a no-op; confirm before touching)
  - Rename `SPEAKING_INDICATOR_DELAY_MS` → `ANCHOR_VISIBLE_DELAY_MS` (names match the new single-mode machine)
  - Verify: `tsc --noEmit` passes; unit tests that exercise controller still green.
- [ ] **Remove mode-touching from `insertPhrase`.** In `src/editor/editor-service.ts`:
  - Drop `setAnchorModeEffect.of('hidden')` from the `effects` array in `insertPhrase`. Keep the `setAnchorEffect.of(newPos)` and scroll effect.
  - Verify no callers relied on the mode change — `setAnchorMode` is the only public mode mutator now.
- [ ] **Rename ribbon labels.** In `src/ui/dictation-ribbon.ts`, change `transcribing` and `paused` branches in `buildRibbonState` from "Transcribing…" / "Processing…" to "Listening". Leave `toVisualState` alone.
- [ ] **Update tests.** In `test/dictation-anchor-extension.test.ts`:
  - Rename `setAnchorModeEffect.of('speaking')` → `setAnchorModeEffect.of('visible')` throughout
  - Delete the "does not hide the processing spinner when the cursor overlaps the anchor" test (processing mode is gone; the behavior it asserts no longer exists)
  - Update the initial-state assertion (`mode: 'hidden'` stays correct)
  - Add one new test: controller integration — entering a speech-family state arms the timer; returning to `listening` cancels it and resets mode to hidden. (If controller tests exist, put it there; otherwise skip — the unit tests on the extension cover the widget contract, and the controller behavior is small enough to verify manually.)
- [ ] **Record the decision.** Append a new active decision to `docs/decisions.md` (D-010, or next free ID) titled "Dictation anchor has a single live mode." Include the state-family rule, why the processing spinner was removed (empty/filtered/continuous-speech broken-promise cases), and the explicit trade-off (no slow-path signal). No supersede required — no prior decisions.md entry on this topic.
- [ ] **Manual dictation session.** Build the plugin, reload Obsidian, run three scenarios with dev console open: (a) long continuous sentence, (b) short utterance that VAD rejects, (c) rapid consecutive utterances with <1s gap. Confirm: no spinner appears; cursor shows after 2.5s of sustained speech; cursor clears cleanly; no flicker on utterance boundaries.
- [ ] **Ship.** Single atomic commit for the UX narrow (covering all files except the `/simplify` chore), + a separate commit for the decisions doc if preferred. PR body links to agent-audit findings by summary.

## Verification

- `npm run check` green after each code step.
- Full test suite passes with updated assertions (expect small net reduction in test count — one test deleted).
- Manual golden-path dictation session on a real note shows: (1) no spinner ever appears, (2) cursor appears only after ~2.5s of sustained speech, (3) cursor persists through processing and clears at session-idle, (4) rapid consecutive utterances don't rip the cursor away, (5) a short "mm" or cough produces nothing in the note and no cursor artifact.
- Ribbon tooltip reads "Listening" (not "Transcribing…") when the backend is mid-inference — confirmed via hover during manual test.

## Risks and Open Questions

- **Slow-inference feels dead.** Risk: a >5s transcription shows the same pulsing cursor as active speech; user might assume it's hung. Mitigation: dogfood first. If confirmed painful, add ribbon pulse after N seconds in `transcribing` — separate change, easier to tune once we have evidence.
- **VAD flapping during long speech.** The machine never sees `listening` during continuous dictation, so the cursor stays visible — correct behavior by design. If the sidecar ever emits a spurious `listening` mid-speech, the cursor would flicker. No current evidence of this, but add a note to the manual-test checklist.
- **`handleTranscriptReady` timer interactions.** Need to confirm during the controller edit that `transcript_ready` never arrives while the session is in a non-speech state in the current protocol. Agent audit suggests it doesn't, but verify while touching the code.
- **Test-controller coverage gap.** There are no existing controller-level unit tests for the anchor machine (assertions today live on the extension). Consider whether to add one lightweight test for the "state-family → mode" rule, or defer and rely on manual. Prefer to defer unless the code under test branches non-obviously.
- **Audio-reactive cursor (deferred).** Separate follow-up. Feasibility confirmed in discussion; file as its own issue with feature-request tone (what + why), matching #37 / #38. Not in scope for this plan.
