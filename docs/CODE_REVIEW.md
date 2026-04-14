# Code Review — 2026-04-13

Full-codebase review covering architecture, correctness, error handling, SOLID/DRY, test coverage, TypeScript best practices, Rust best practices, and integration seams. ~30k lines across TypeScript (Obsidian plugin) and Rust (sidecar).

## Executive Summary

The codebase is well-structured for a greenfield project. Architecture matches stated design goals. No critical defects. The plugin class is thin, modules are cohesive, the plugin/sidecar boundary is explicit and versioned, and dependencies flow cleanly with no cycles. Zero `any` types in TypeScript, zero `unsafe` blocks in Rust, no legacy shims or compatibility code.

The most actionable findings are a sidecar process double-spawn race, missing `catch_unwind` on the worker thread, and three modules on critical paths with zero test coverage.

---

## Findings by Severity

### Medium

#### M-1: Concurrent `ensureStarted()` can orphan sidecar processes

`src/sidecar/sidecar-process.ts:35-75`

`SidecarProcess.start()` checks `isRunning()` synchronously, but the method is async. Between the check and `this.child = child` (line 65), there are two `await` points (resolve launch spec, wait for spawn). Any concurrent caller passes the guard and spawns a second process. The first becomes orphaned — running with no references, never cleaned up.

This is reachable during plugin init: `checkSidecarHealth` (main.ts:121) and `modelInstallManager.init()` (main.ts:125) both run concurrently and both call `sendCommandAndWait` which calls `ensureStarted`.

**Fix**: Store the pending start promise and return it to concurrent callers.

#### M-2: Worker thread has no `catch_unwind`

`native/sidecar/src/worker.rs:96-167`

The installer thread has `catch_unwind` protection (installer.rs:150), but the worker thread does not. If a corrupt or incompatible model file causes whisper-rs or ONNX Runtime to panic, the worker thread dies silently. The channel disconnects, `poll_event()` returns `None` forever (worker.rs:69 maps `Disconnected` to `None`), and future transcription produces no output and no error. The user sees the session stuck in "listening" or "transcribing" indefinitely.

**Fix**: Wrap `worker_main` in `catch_unwind` and send a `SessionError` event on panic, matching the installer thread pattern.

#### M-3: Frame parser not reset on sidecar exit/restart

`src/sidecar/sidecar-connection.ts:72,78`

The `FramedMessageParser` is constructed once and never reset on process exit. If the sidecar crashes mid-frame (partial bytes buffered), the next sidecar instance's output is concatenated with stale bytes. The first parse fails, triggering the catch at line 362 which calls `reset()` — so it self-heals after one lost event. But if the lost event is `health_ok`, the restart health check times out (4s), making restart appear to fail.

**Fix**: Call `this.frameParser.reset()` in the `onExit` handler.

#### M-4: Race condition during dictation start

`src/dictation/dictation-session-controller.ts:173-208`

`this.sessionId` is set before `captureStream.start()`, and the sidecar subscription is already wired up. If a sidecar error event from a prior session arrives during the async `startSession` call, it can pass the session filter (event.sessionId === undefined passes at line 268-272) and call `abortSessionAfterError` on a session that hasn't been started on the sidecar side yet.

**Fix**: Defer setting `this.sessionId` until after the sidecar confirms session start, or add an explicit "starting" state that rejects stale events.

#### M-5: TS frame parser has no upper bound on buffered data

`src/sidecar/protocol.ts:333-383`

`FramedMessageParser.pushChunk` accumulates bytes without limit. The Rust side enforces `MAX_FRAME_PAYLOAD` (16 MiB), so a conforming sidecar won't trigger this. But a corrupt header claiming a large payload causes unbounded memory growth. The `concatBytes` at line 381 also copies the entire remaining buffer on every call, making accumulation quadratic.

**Fix**: Add a `MAX_BUFFERED` check matching the Rust side's `MAX_FRAME_PAYLOAD`.

#### M-6: `unwrap()` on worker thread without panic protection

`native/sidecar/src/cohere.rs:70,451`

Two `unwrap()` calls in production code running on the unprotected worker thread. Both are structurally safe (invariants hold after preceding method calls), but if the invariant is ever violated, the worker thread dies silently per M-2. `transcription.rs:182` and `app.rs:132` have similar `expect()` calls.

**Fix**: Convert to `expect()` with invariant documentation (for cohere.rs), and add `catch_unwind` per M-2.

#### M-7: Worker thread event send failures silently dropped

`native/sidecar/src/worker.rs:148,156`

`let _ = event_tx.send(...)` discards send errors with no logging. If the main thread drops the receiver outside of shutdown, transcription results and errors vanish with no trace.

**Fix**: Log a warning on send failure, or at minimum detect channel disconnect and exit the worker loop.

### Low

#### L-1: Duplicate `isInsertionMode` function

`src/settings/plugin-settings.ts:110` and `src/settings/settings-tab.ts:49` define the same function. The `plugin-settings.ts` version accepts `unknown` and is strictly more general.

**Fix**: Remove the `settings-tab.ts` copy, import from `plugin-settings.ts`.

#### L-2: `handleError` duplicates `formatErrorMessage` logic

Both `main.ts:174` and `dictation-session-controller.ts:359` inline `error instanceof Error ? error.message : String(error)`, but `formatErrorMessage` in `shared/format-utils.ts:17` already exists for this.

**Fix**: Use the existing utility.

#### L-3: Dead export `DEFAULT_PCM_SAMPLES_PER_FRAME`

`src/audio/pcm-frame-processor.ts:139` exports a re-alias of `PCM_SAMPLES_PER_FRAME` that nothing imports.

**Fix**: Remove.

#### L-4: Hotkey resolution duplicated in keydown/keyup handlers

`src/dictation/dictation-session-controller.ts:88-93` and `113-118` are near-identical blocks resolving and matching gate hotkeys.

**Fix**: Extract a private `matchesGateHotkey(event)` method.

#### L-5: Repeated `resolve_model_store_info` call pattern

`native/sidecar/src/app.rs` — the pattern `resolve_model_store_info(model_store_path_override.as_deref())` followed by error mapping appears 6+ times.

**Fix**: Extract a helper on `AppState` when convenient.

#### L-6: Unnecessary frame clone during active speech

`native/sidecar/src/session.rs:170` — `push_pre_roll_frame(frame.clone())` clones even when `speech_started` is true and the method returns immediately. ~32 KB/s wasted allocation during active speech.

**Fix**: Check `speech_started` before cloning, or restructure the call.

#### L-7: `Vec<Vec<i16>>` for utterance storage

`native/sidecar/src/session.rs:70` — each 20ms frame is a separate heap allocation. A flat `Vec<i16>` would eliminate thousands of small allocations per utterance and improve cache locality. `maybe_finalize_utterance` already flattens for output.

#### L-8: `settings-tab.ts:456-458` swallows sidecar errors entirely

Bare `catch {}` with no logging. The only place in the TS codebase that catches without any form of logging.

**Fix**: Add a debug-level log.

#### L-9: `model-install-manager.ts:493-498` silently falls back on error

`fetchSupportedEngineIds` catches all errors and falls back to `['whisper_cpp']` with no logging. If the sidecar connection is broken, Cohere Transcribe silently disappears from the UI.

**Fix**: Log a warning on the fallback path.

#### L-10: `RemoveModel` error detail discarded

`native/sidecar/src/app.rs:238` — the actual error from `remove_installed_model` is mapped to `removed: false` with the error detail lost at the protocol boundary.

**Fix**: Include the error message in the event or emit a warning event.

#### L-11: Event clone in `write_event_frame`

`native/sidecar/src/protocol.rs:409` — every outbound event is cloned to wrap in `EventEnvelope`. Contains nested `Vec<String>` and `Vec<TranscriptSegment>`. Since events are written at IPC rate (not audio-frame rate), this is unlikely to bottleneck, but `write_event_frame` could take `Event` by value to avoid the clone.

#### L-12: `shutdown()` writes to potentially dead process

`src/sidecar/sidecar-connection.ts:260-270` — narrow race between `isRunning()` check and `write()`. The `try/finally` ensures `stop()` still runs, and `onunload` catches the thrown error. No practical impact.

---

## Structural Observations

### Dual PCM/Protocol Constants Across Language Boundary

PCM constants (`PCM_SAMPLE_RATE_HZ`, `PCM_BYTES_PER_FRAME`, etc.) and frame header constants are independently defined in `src/shared/pcm-format.ts` and `native/sidecar/src/protocol.rs`. Values match today. A mismatch would produce silent audio corruption. The protocol version string does not encode PCM parameters.

**Risk**: Low probability, high severity. Options: (a) add PCM parameters to the health handshake, (b) generate one side from the other, (c) document the invariant as a protocol constraint.

### `AppState.handle_command` Is a Large Dispatcher

`native/sidecar/src/app.rs` — ~300 lines handling 14 command variants. Each arm is self-contained and delegates to focused helpers. Defensible at current scale but would benefit from splitting into handler sub-modules if the command set grows.

### Obsidian Internal API Access

`src/dictation/shortcut-matcher.ts:4-13` — reaches into undocumented `App.commands` and `App.hotkeyManager` internals for press-and-hold hotkey resolution. Fully defensive with optional chaining. Could break on an Obsidian update. No alternative API exists.

---

## Test Coverage Assessment

### Test Quality

The existing test suite is lean and well-structured. No low-value tests found. Tests verify behavior (state transitions, emitted commands, inserted text), not implementation details. Hand-written fakes with minimal surface area. The `ModelInstallManager` test harness is particularly well done.

### Critical Coverage Gaps

| Module | Tests | Risk |
|--------|-------|------|
| `src/dictation/shortcut-matcher.ts` | 0 | Regression silently disables press-and-hold for all users |
| `src/sidecar/sidecar-connection.ts` | 0 | Orchestration layer: timeout resolution, waiter dispatch, crash recovery |
| `native/sidecar/src/worker.rs` | 0 | Session matching, engine switching, audio conversion at inference boundary |

### Near-Duplicate Fixtures

`sampleCatalog()`, `sampleCatalogModel()`, `sampleInstalledModel()`, and `sampleInstallUpdate()` are defined independently in both `test/model-install-manager.test.ts` (lines 87-186) and `test/model-row-state.test.ts` (lines 20-119) with near-identical content.

### Platform Branch Not Exercised

The Obsidian mock (`test/__mocks__/obsidian.ts`) hardcodes `Platform.isMacOS = false`. The `Mod -> Meta/Ctrl` expansion in `shortcut-matcher.ts:92-96` is tested only for the non-Mac branch.

### Top 10 High-ROI Missing Tests

1. **shortcut-matcher: `matchesHotkey` with `Mod` on macOS vs non-macOS** — the platform branch that determines whether hotkeys work on macOS
2. **shortcut-matcher: `resolveCommandHotkeys` fallback chain** — four-level fallback silently controls whether press-and-hold works
3. **shortcut-matcher: `shouldIgnoreHeldKeyEvent` in editable contexts** — without this, press-and-hold interferes with typing
4. **sidecar-connection: `sendCommandAndWait` timeout behavior** — primary failure mode users hit
5. **sidecar-connection: `rejectPendingWaiters` on process exit** — crash-recovery path
6. **protocol (TS): `FramedMessageParser.pushChunk` with header-level split** — hardest partial-read case
7. **pcm-frame-processor: state continuity across multiple `push()` calls** — catches resampler state bugs
8. **dictation-session-controller: transcript fallback to segment text** — real Whisper edge case
9. **editor-service: `assertActiveEditorAvailable` throws when no editor** — user-facing error path
10. **Rust worker.rs: session matching and engine switching** — mismatched session ID silently drops audio

---

## Positive Observations

These are patterns worth preserving as the codebase grows.

**Architecture**: Plugin class is genuinely thin (~310 lines of wiring). Logic lives in focused modules with clean, acyclic dependency graphs on both sides.

**Protocol layer**: Binary framing independently implemented on both sides with matching constants. Versioned (`v3`). TS side hand-parses every field with explicit validators — no `as SidecarEvent` shortcut. Rust uses serde with explicit renames.

**Type safety**: Zero `any` types across the entire TS codebase. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables` all enabled. Discriminated unions for protocol messages and model selection.

**Zero unsafe Rust**: All FFI goes through safe wrapper crates (whisper-rs, ort, webrtc-vad).

**Dependency injection**: `Pick<SidecarConnection, ...>` interfaces throughout TS. `ListeningSession<TVad>` generic over `VoiceActivityDetector`. `TranscriptionBackend` trait. `DownloadSource` trait. `ModelPathProbe` function pointer. All major components are testable without module-level mocking.

**Logger discipline**: All `console.*` calls are exclusively inside `shared/plugin-logger.ts`. No raw console calls anywhere else.

**Catalog architecture**: Single source of truth in `config/model-catalog.json`, parsed authoritatively by the sidecar, reflected to TS through protocol events. TS never reads the file directly.

**Error propagation (TS)**: Consistent pattern of catch -> log -> status bar -> Notice. `asError()` and `formatErrorMessage` utilities handle non-Error throws.

**Error propagation (Rust)**: `anyhow` with `.context()` at IO boundaries, structured `TranscriptionError` at domain boundaries. Clean split.

**Concurrency (Rust)**: `std::sync::mpsc` channels, no mutexes, no shared mutable state, no deadlock potential. `AtomicBool` + `Notify` for install cancellation with `SeqCst` ordering.

**Installer safety**: Staging directory with atomic rename. `catch_unwind` around install thread. Cooperative cancellation with test fixtures.

**Naming consistency**: Kebab-case files, PascalCase types, camelCase functions, SCREAMING_SNAKE constants — no exceptions.

**No dead abstractions**: No premature generalization, no unused extension points, no speculative interfaces.

---

## Open Questions

1. **Worker thread panic policy**: Was the absence of `catch_unwind` on the worker thread intentional (panics in inference should crash the sidecar) or an oversight? The installer thread has it.

2. **Automatic sidecar recovery**: When the sidecar crashes mid-transcription, the user must manually trigger a new action. Is there a desire for automatic restart, or is the current model intentional?

3. **`ort` pinned to release candidate**: `Cargo.toml` pins `ort = "=2.0.0-rc.12"`. When ort 2.0 ships stable, this pin blocks receiving it. Worth a backlog item.

4. **Structured sidecar logging**: `sidecar-logging.ts` uses regex heuristics to classify stderr lines. If whisper-rs or ort change their log format, panics could be classified as debug-level. Is there a plan for structured stderr output?
