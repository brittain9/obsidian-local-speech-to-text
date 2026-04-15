# Remove Press-and-Hold Listening Mode

Closes #25.

## Objective

Remove the press-and-hold listening mode and all supporting infrastructure from both the TypeScript plugin and the Rust sidecar. The mode's use case (momentary dictation triggered by a key) is covered by always-on and one-sentence modes combined with the existing start/stop keybinds.

---

## Current State

Press-and-hold spans five layers:

1. **Protocol**: `set_gate` command (TS + Rust), `press_and_hold` variant in `ListeningMode` enum (TS + Rust).
2. **Sidecar session logic**: `gate_open` field on `ListeningSession`, `open_gate()` / `close_gate()` methods, gate checks in `ingest_audio_frame()` and `base_state()`. Command handler in `app.rs:390–431` with `invalid_gate_warning` helper.
3. **Controller**: `gateOpen` state, `openPressAndHoldGate()` / `closePressAndHoldGate()` methods, `isPressAndHoldMode()` helper, `handleDocumentKeyDown` / `handleDocumentKeyUp` / `handleRibbonPointerDown` / `handleRibbonPointerUp` methods, `ribbonHoldActive` / `suppressNextRibbonClick` fields.
4. **Commands & UI wiring**: `PRESS_AND_HOLD_GATE_COMMAND_ID` export, hidden Obsidian command registration, pointer event listeners on ribbon, keydown/keyup document listeners, shortcut-matcher module (sole consumer), settings dropdown option, settings tab hint paragraph.
5. **Settings persistence**: `press_and_hold` accepted in `readListeningMode()`, test fixtures use it.

---

## Constraints

- Both TS and Rust protocol definitions must stay in sync — remove the variant from both sides in the same logical step.
- Existing users with `listeningMode: 'press_and_hold'` persisted in `data.json` must fall back to the default (`one_sentence`) on next load, not crash.
- `shortcut-matcher.ts` has no consumers outside press-and-hold. It should be deleted entirely.
- The three backlog items referencing `shortcut-matcher` test coverage should be removed (the module no longer exists).
- Docs (`system-architecture.md`, `CODE_REVIEW.md`, `backlog.md`) must be updated to remove press-and-hold references.

---

## Approach

Bottom-up removal: protocol → sidecar → controller → commands/UI → settings → docs. Each step removes a clean slice and the codebase compiles after each step.

---

## Execution Steps

### Step 1: Remove gate from Rust protocol and session

**Files:** `native/src/protocol.rs`, `native/src/session.rs`

- Remove `PressAndHold` from `ListeningMode` enum (`protocol.rs:58`).
- Remove `SetGate` from `Command` enum (`protocol.rs:199–201`).
- In `session.rs`:
  - Remove `gate_open` field from `ListeningSession` struct (line 66).
  - Remove `let gate_open = config.mode != ListeningMode::PressAndHold` and the field initializer (lines 83, 88).
  - Remove `base_state()` press-and-hold branch (lines 99–101).
  - Remove `close_gate()` method (lines 119–126).
  - Remove `gate_open()` accessor (lines 132–134).
  - Remove gate check in `ingest_audio_frame()` (lines 151–154).
  - Remove `open_gate()` method (lines 212–215).
  - Remove test `finalizes_on_gate_close_in_press_and_hold_mode` (lines 357–383).
- **Verify:** `cargo test` passes, `cargo clippy` passes (with `DOCS_RS=1 WHISPER_DONT_GENERATE_BINDINGS=1`).

### Step 2: Remove gate command handler from `app.rs`

**File:** `native/src/app.rs`

- Remove the entire `Command::SetGate { open } => { ... }` match arm (lines 390–431).
- Remove the `invalid_gate_warning` helper function (lines 1012–1019).
- **Verify:** `cargo test` passes.

### Step 3: Remove gate from TS protocol and sidecar connection

**Files:** `src/sidecar/protocol.ts`, `src/sidecar/sidecar-connection.ts`

- In `protocol.ts`:
  - Remove `'press_and_hold'` from `ListeningMode` type (line 26).
  - Remove `SetGateCommand` interface (lines 103–105).
  - Remove `SetGateCommand` from `SidecarCommand` union (line 126).
  - Remove `createSetGateCommand()` function (lines 285–290).
  - Remove `'press_and_hold'` from `readListeningMode()` (line 621).
- In `sidecar-connection.ts`:
  - Remove `createSetGateCommand` import (line 15).
  - Remove `setGate()` method (lines 277–279).
- **Verify:** `npm run typecheck` passes.

### Step 4: Remove press-and-hold from dictation controller

**Files:** `src/dictation/dictation-session-controller.ts`, `src/dictation/shortcut-matcher.ts`

- In `dictation-session-controller.ts`:
  - Remove `shortcut-matcher` import (lines 11–14).
  - Remove `pressAndHoldGateCommandId` and `pressAndHoldGateDefaultHotkeys` from `DictationSessionControllerDependencies` (lines 32–33).
  - Remove `'setGate'` from sidecar connection `Pick` type (line 37).
  - Remove `gateOpen` field (line 43).
  - Remove `ribbonHoldActive` field (line 45).
  - Remove `suppressNextRibbonClick` field (line 46).
  - Remove `handleDocumentKeyDown()` method entirely (lines 85–112).
  - Remove `handleDocumentKeyUp()` method entirely (lines 114–132).
  - Simplify `handleRibbonClick()` — remove the `isPressAndHoldMode()` / suppress check (lines 135–138), keep only `void this.toggleDictation()`.
  - Remove `handleRibbonPointerDown()` method entirely (lines 143–151).
  - Remove `handleRibbonPointerUp()` method entirely (lines 153–165).
  - In `startDictation()`: remove `openGateAfterStart` option and the gate-open block (lines 167, 207–210). Signature becomes `async startDictation(): Promise<void>`.
  - In `cleanupLocalSession()`: remove `gateOpen`, `ribbonHoldActive`, `suppressNextRibbonClick` resets (lines 258–259, 261).
  - Remove `closePressAndHoldGate()` method (lines 268–281).
  - Remove `isPressAndHoldMode()` method (lines 381–383).
  - Remove `openPressAndHoldGate()` method (lines 385–407).
- Delete `src/dictation/shortcut-matcher.ts` entirely — no other consumers.
- **Verify:** `npm run typecheck` passes.

### Step 5: Remove press-and-hold from commands and main plugin wiring

**Files:** `src/commands/register-commands.ts`, `src/main.ts`

- In `register-commands.ts`:
  - Remove `PRESS_AND_HOLD_GATE_COMMAND_ID` constant and export (line 6).
  - Remove the hidden command registration block (lines 43–48).
- In `main.ts`:
  - Remove `PRESS_AND_HOLD_GATE_COMMAND_ID` import (line 7).
  - Remove `pressAndHoldGateCommandId` from controller dependencies (line 72).
  - Remove ribbon `pointerdown` event registration (lines 79–85).
  - Remove window `pointerup` event registration (lines 86–88).
  - Remove document `keydown` event registration (lines 89–91).
  - Remove document `keyup` event registration (lines 92–94).
- **Verify:** `npm run typecheck` passes.

### Step 6: Remove press-and-hold from settings

**Files:** `src/settings/plugin-settings.ts`, `src/settings/settings-tab.ts`

- In `plugin-settings.ts`:
  - Remove `'press_and_hold'` from `readListeningMode()` (line 115). Existing users with `press_and_hold` persisted will fall back to the default (`one_sentence`).
- In `settings-tab.ts`:
  - Remove the `press_and_hold` dropdown option (line 214).
  - Remove `'press_and_hold'` from the onChange validation (line 221).
  - Remove the press-and-hold hotkey hint paragraph (lines 378–380).
- **Verify:** `npm run typecheck` passes.

### Step 7: Update tests

**Files:** `test/dictation-session-controller.test.ts`, `test/plugin-settings.test.ts`

- In `dictation-session-controller.test.ts`:
  - Remove `setGate` from `FakeSidecarConnection` (line 50).
  - Remove `press_and_hold ? 'idle' : 'listening'` ternary — always emit `'listening'` (line 60).
  - Remove test `opens and closes the press-and-hold gate on the configured hotkey` (lines 346–368).
  - Remove test `clears ribbon click suppression during local cleanup` (lines 370–398).
  - Remove `pressAndHoldGateCommandId` from `createController` (line 423).
- In `plugin-settings.test.ts`:
  - Change `listeningMode: 'press_and_hold'` to `'always_on'` in the "merges valid persisted values" test (lines 16, 33). This test exercises round-tripping a non-default listening mode.
- **Verify:** `npm test` passes (all TS tests). `npm run check` passes (typecheck + lint + test + build).

### Step 8: Update documentation

**Files:** `docs/architecture/system-architecture.md`, `docs/backlog.md`, `docs/CODE_REVIEW.md`

- In `system-architecture.md`:
  - Remove `set_gate` row from commands table (line 138).
  - Remove "Gate mechanism (press_and_hold)" paragraph (line 209).
  - Remove `press_and_hold` row from listening modes table (line 319).
- In `backlog.md`:
  - Remove three `shortcut-matcher` test coverage items (lines 46–48).
- In `CODE_REVIEW.md`:
  - Remove OD-5 section "Hold vs. toggle: setting scope" (lines 154–158).
  - Update issue dependency map — remove `#9 (press-and-hold)` line (line 174) and the recommended order entry (line 181).

---

## Verification

```bash
cargo test                              # 65+ Rust tests
cargo clippy -- -D warnings             # (with DOCS_RS=1 WHISPER_DONT_GENERATE_BINDINGS=1)
npm run check                           # typecheck + lint + 119 TS tests + build
```

Grep for residual references:
```bash
rg 'press.and.hold|press_and_hold|PressAndHold|pressAndHold|set_gate|setGate|SetGate|open_gate|close_gate|gate_open|gateOpen|shortcut-matcher' --type ts --type rust
```

Expected: zero matches.

---

## Risks and Open Questions

**Settings migration**: Users with `listeningMode: 'press_and_hold'` in their persisted `data.json` will silently fall back to `one_sentence` (the default) on next load. This is the correct behavior — `readListeningMode()` already handles unknown values by returning the default. No migration code needed.

**Issue #9 references**: `CODE_REVIEW.md` references issue #9 (hold vs. toggle). Since press-and-hold is being removed, the open decision (OD-5) and the dependency map entry should be removed. Issue #9 itself can be closed separately.

**`shortcut-matcher` deletion scope**: The module has zero consumers outside `dictation-session-controller.ts`'s press-and-hold key handlers, zero tests, and three backlog items requesting test coverage. Deleting it is cleaner than keeping dead code. If key-driven shortcuts are needed later (e.g., toggle dictation from keyboard), they should use Obsidian's built-in command hotkeys rather than a custom key matcher.
