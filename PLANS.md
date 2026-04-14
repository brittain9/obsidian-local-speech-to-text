# Ribbon Listening Control and State Model

## Objective

Make the ribbon icon the single, primary live status surface for dictation state. Remove the status bar text. Each state should be visually distinct and the icon should feel alive during active sessions.

This is the first step toward polishing the app's listening behavior before adding pipeline complexity. The goal is that a user understands what the app is doing at a glance from the ribbon icon alone.

---

## Current State

### Ribbon Icon (`src/ui/dictation-ribbon.ts`)

The ribbon icon currently shows two icons: `mic` (idle, error) and `square` (everything else). All active states look identical — a square stop button. No animation. No visual distinction between listening, speech detected, or transcribing. State is stored in `element.dataset.localSttState` (line 20).

Created in `src/main.ts:61` via `addRibbonIcon('mic', ...)`. Pointer events registered on lines 84-97 for press-and-hold support.

### Status Bar (`src/ui/status-bar.ts`)

Displays `"Local STT: {state}"` in the bottom-right. Carries optional detail text (e.g., `"starting (opening session)"`). Referenced in `main.ts` at lines 42, 78-79, 152, 158, 163, 177, 192, 197.

### State Flow

`DictationSessionController` owns the canonical state. On state change, it calls two callbacks injected at construction:

```
applyUiState(state, detail?)
  → this.state = state
  → setRibbonState(state)        // main.ts:75-77 → ribbonController.setState()
  → setStatusState(state, detail) // main.ts:78-80 → statusBar.setState()
```

### Type Coupling

`DictationControllerState` is aliased to `PluginRuntimeState` (defined in `status-bar.ts:1-8`). This creates a dependency from the dictation controller to the status bar module.

### Sidecar Speech Priority

The sidecar's `derive_session_state` in `app.rs:879-907` already checks `SpeechDetected` before `Transcribing`:

```rust
if base_state == SessionBaseState::SpeechDetected {
    return SessionState::SpeechDetected;  // Speech always wins
}
if transcription_active {
    return SessionState::Transcribing;    // Only if no speech
}
```

This means speech-during-processing already produces `speech_detected` events on the wire. No client-side composite tracking is needed — the sidecar handles the priority.

---

## Constraints

- Zero change to the sidecar or protocol. All changes are TypeScript/CSS.
- Existing tests must pass after adapting to removed `setStatusState`.
- All icons must be from Lucide (included with Obsidian) — no custom SVGs in this PR.
- Animations use CSS only (no JS timers for visual state).
- Respect `prefers-reduced-motion`.
- Error state persists until user clicks the ribbon to acknowledge.

---

## Approach

### 1. Move `DictationControllerState` out of `status-bar.ts`

Define the type inline in `dictation-session-controller.ts`. This breaks the import dependency before we delete the status bar module.

### 2. Update ribbon icon mapping

Replace the two-icon system (`mic` / `square`) with state-specific icons:

| State | Icon | Animation | Tooltip |
|-------|------|-----------|---------|
| `idle` | `mic` | None | "Local STT: Click to start" |
| `starting` | `loader-circle` | Spin | "Local STT: Starting..." |
| `listening` | `audio-lines` | Static | "Local STT: Listening" |
| `speech_detected` | `audio-lines` | Pulse | "Local STT: Hearing speech" |
| `transcribing` | `loader-circle` | Spin | "Local STT: Transcribing..." |
| `paused` | `loader-circle` | Spin | "Local STT: Processing..." |
| `error` | `mic-off` | Shake (once) | "Local STT: Error" |

### 3. Add CSS animations

Target the SVG inside the ribbon element using the existing `data-local-stt-state` attribute. Three keyframe animations:

- **Spin** (`local-stt-spin`): 360deg rotation, linear, infinite. For `starting`, `transcribing`, `paused`.
- **Pulse** (`local-stt-pulse`): Scale 1→1.15→1 with slight opacity shift. For `speech_detected`.
- **Shake** (`local-stt-shake`): Horizontal wiggle, plays once. For `error`.

Selector pattern: `.side-dock-ribbon-action[data-local-stt-state="X"] > svg`

### 4. Delete status bar

Remove `StatusBarController`, its import, instantiation, callbacks, and disposal. Remove `setStatusState` from the controller dependency interface.

### 5. Handle error-persists-until-click

Currently, `abortSessionAfterError` resets to idle after the cancel completes (line 419). With error persisting until click, the ribbon click handler needs to check: if state is `error` and no session is active, reset to `idle` instead of starting a new session.

---

## Execution Steps

- [ ] **Step 1: Move `DictationControllerState` type**
  - In `src/dictation/dictation-session-controller.ts`: Replace `import type { PluginRuntimeState } from '../ui/status-bar'` and `export type DictationControllerState = PluginRuntimeState` with a direct type definition:
    ```typescript
    export type DictationControllerState =
      | 'idle' | 'starting' | 'listening' | 'speech_detected'
      | 'transcribing' | 'paused' | 'error';
    ```
  - Verify: `npm run typecheck` passes. No behavior change.

- [ ] **Step 2: Rewrite `dictation-ribbon.ts` with new icon mapping**
  - Write `src/ui/dictation-ribbon.ts` fresh. Same class name, same interface (`setState`, `getElement`, `dispose`), same import path. No consumer changes needed.
  - Icon type union: `'mic' | 'mic-off' | 'audio-lines' | 'loader-circle'`.
  - `buildRibbonState()` switch cases per the mapping table above.
  - Verify: `npm run typecheck` passes. Ribbon shows new icons for each state.

- [ ] **Step 3: Add CSS animations to `styles.css`**
  - Add keyframes: `local-stt-spin`, `local-stt-pulse`, `local-stt-shake`.
  - Add state selectors targeting `.side-dock-ribbon-action[data-local-stt-state="X"] > svg`.
  - Add `@media (prefers-reduced-motion: reduce)` to disable all animations.
  - Verify: Start dictation → see static audio-lines. Speak → see pulse. Stop speaking → see spinner.

- [ ] **Step 4: Remove status bar**
  - Delete `src/ui/status-bar.ts`.
  - In `src/main.ts`:
    - Remove `import { StatusBarController } from './ui/status-bar'` (line 23).
    - Remove `private statusBar: StatusBarController | null = null` (line 36).
    - Remove `this.statusBar = new StatusBarController(this.addStatusBarItem())` (line 42).
    - Remove `setStatusState` callback from controller dependencies (lines 78-80).
    - Remove `this.statusBar?.setState(...)` calls in `checkSidecarHealth` (lines 158, 163), `handleError` (line 177), `restartSidecar` (lines 192, 197).
    - Remove `this.statusBar?.dispose()` in `onunload` (line 152).
  - In `src/dictation/dictation-session-controller.ts`:
    - Remove `setStatusState` from `DictationSessionControllerDependencies` interface (line 28).
    - Remove `this.dependencies.setStatusState(state, detail)` from `applyUiState` (line 237).
  - In `test/dictation-session-controller.test.ts`:
    - Remove `setStatusState: () => {}` from `createController` (line 432).
  - Note: `checkSidecarHealth` (lines 158, 163) and `restartSidecar` (lines 192, 197) used the status bar as a transient progress indicator (`"starting (health check)"`, `"starting (restarting)"`). The `Notice` popups in those methods already cover the result. The transient progress indicator is intentionally dropped — these operations take 1-2 seconds and the status bar text was barely visible in practice.
  - Verify: `npm run typecheck` passes. `npm test` passes. No status bar text visible.

- [ ] **Step 5: Error persists until click**
  - In `dictation-session-controller.ts`, modify `abortSessionAfterError` (lines 395-423): Remove the auto-reset to idle in the `finally` block (lines 419-421). The error state should remain.
  - In `toggleDictation` (called by `handleRibbonClick`): Add a check at the top — if `this.state === 'error'` and `this.sessionId === null`, call `this.applyUiState('idle')` and return. This lets clicking the ribbon acknowledge the error.
  - **Interaction with `handleSessionStopped`:** Error state persists until click only when no `session_stopped` event follows the error. If the sidecar confirms session teardown via `session_stopped`, `handleSessionStopped` unconditionally resets to `idle` (line 297) — this is correct because the sidecar has resolved the error condition. Error persistence applies to the case where the cancel itself fails and no `session_stopped` arrives, which is exactly when the user needs to acknowledge.
  - **Test update required** in `test/dictation-session-controller.test.ts`:
    - Line 271 (`returns to idle after cancel cleanup fails for an errored session`): This test mocks `cancelSession` to throw, so no `session_stopped` event fires. Currently expects `'idle'` at line 295 because the `finally` block auto-resets. After removing the auto-reset, the test must expect `'error'`, then call `controller.handleRibbonClick()` and expect `'idle'`.
    - Line 300 (`cancels an errored session only once`): No change needed. The `resolveCancel()` emits `session_stopped` → `handleSessionStopped` resets to `idle`. This test still passes as-is.
  - Verify: `npm test` passes. Trigger an error → ribbon shows `mic-off` with shake → click ribbon → returns to `idle` `mic`.

---

## Verification

```bash
npm run typecheck
npm test
npm run build
```

**Manual testing matrix (per listening mode):**

| Mode | Flow | Expected visuals |
|------|------|------------------|
| Always-on | Click start → speak → stop speaking → speak again → click stop | mic → audio-lines(static) → audio-lines(pulse) → loader(spin) → audio-lines(pulse) → mic |
| Press-and-hold | Hold key → speak → release | mic → audio-lines(static) → audio-lines(pulse) → loader(spin) → mic |
| One-sentence | Click start → speak → auto-stop | mic → audio-lines(static) → audio-lines(pulse) → loader(spin) → mic |
| Error | Start with no model selected | mic → mic-off(shake) → stays until click → mic |

**Accessibility:** Enable `prefers-reduced-motion` in browser devtools → all animations should be disabled.

**Theme check:** Verify icon visibility in both light and dark Obsidian themes.

---

## Risks and Open Questions

**CSS selector specificity**: `.side-dock-ribbon-action` is Obsidian's internal class for ribbon icons. It's stable across versions but not an official API. If Obsidian changes this class name, our animations break silently (icons still work, just no animation). Low risk — the class has been stable for years.

**`loader-circle` icon availability**: This icon requires Obsidian ≥1.4 (Lucide). Our `minAppVersion` is `1.8.7` — safe.

**Error persistence edge case**: If an error occurs during `abortSessionAfterError` and the cancel also fails, we currently clean up locally and show error then reset to idle. With the new behavior, we show error and stop. If a subsequent auto-cleanup runs (from `handleSessionStopped`), it will reset to idle, which is correct — the session actually ended.

**No status bar replacement**: Removing the status bar means the detail text (e.g., `"starting (opening session)"`, `"error (connection timeout)"`) is lost. The tooltip partially replaces this, but detailed error messages will only be visible via the Notice popup. This is acceptable — the ribbon is a glanceable indicator, not a log.
