# Fix M1 / M2 / M3: Sidecar Correctness Bugs

## Objective

Fix three medium-severity defects identified in the 2026-04-13 code review:

- **M1** — Concurrent `ensureStarted()` can orphan sidecar processes
- **M2** — Worker thread has no `catch_unwind` around inference
- **M3** — Frame parser not reset on sidecar exit / restart

Add the remaining review findings (M4–M7, L1–L12) to the backlog.

---

## Current State

### M1 — `SidecarProcess.start()` double-spawn race

`src/sidecar/sidecar-process.ts:35–75`

`start()` is `async` but the only guard is a synchronous `isRunning()` check at the top. Two concurrent callers both pass the check before `this.child` is assigned (lines 42–49 contain two `await` points: `resolveLaunchSpec()` and `waitForSpawn()`). The second spawn produces an orphan child with no reference and no cleanup path. This is reachable on plugin load: `checkSidecarHealth` (main.ts:121) and `modelInstallManager.init()` (main.ts:125) run concurrently, both call `sendCommandAndWait` → `ensureStarted`.

### M2 — Worker thread panics are silent

`native/sidecar/src/worker.rs:60, 96–167`

The worker thread is spawned with a bare closure — no `catch_unwind`. If `engine.transcribe()` panics (corrupt model file, OOM, whisper-rs / ort invariant violation), the thread dies. The channel disconnects. `poll_event()` maps `TryRecvError::Disconnected` to `None` via `.ok()`, so the app loop silently stops receiving events. The session hangs in "transcribing" indefinitely.

The installer thread already follows the correct pattern (`installer.rs:150`): `catch_unwind(AssertUnwindSafe(...))` with a structured `failed_update` event sent on panic.

The two panic sites are:
- `engine.transcribe()` inside `WorkerCommand::TranscribeUtterance` — `session_id` is in scope
- `create_backend()` inside `WorkerCommand::BeginSession` — `session_id` is in `metadata.session_id`

Note: the outer `thread::spawn` closure needs `catch_unwind` too, but the primary risk is the transcription call. Protect both sites.

### M3 — Frame parser retains stale bytes across sidecar restarts

`src/sidecar/sidecar-connection.ts:77–84` (constructor `onExit` handler)

`this.frameParser` (a `FramedMessageParser`) is constructed once at startup and shared across process lifetimes. Its `reset()` method exists (`protocol.ts:338`) and is already called in the `catch` block of `handleStdoutChunk` (line 365). However, it is never called in `onExit`. When the sidecar crashes mid-frame, the next instance's stdout is appended to stale bytes. The first parse fails, the `catch` fires and resets the parser — but the event lost in the reset is the `health_ok` that the restart health check (4 s timeout) is waiting for.

---

## Constraints

- Zero behaviour changes outside the three target defects.
- No new external dependencies.
- Existing tests must continue to pass.
- Rust: follow the `catch_unwind(AssertUnwindSafe(...))` pattern already established in `installer.rs`. No additional crate imports needed — `std::panic` suffices.
- TypeScript: the fix for M1 must keep `start()` idempotent and must not change the public interface of `SidecarProcess`.

---

## Approach

### M3 (one line — do this first)

Add `this.frameParser.reset()` to the `onExit` handler in the `SidecarConnection` constructor, before `rejectPendingWaiters`. Resetting before rejecting means any partial parse state is cleared before any new data could arrive from a future restart.

### M1 (deduplicating promise)

Add a `private startPromise: Promise<void> | null = null` field to `SidecarProcess`. In `start()`, after the `isRunning()` guard, check if `startPromise` is non-null and return it if so. Otherwise create the promise from the existing start body (extracted to `private doStart()`), store it, and chain a `.finally()` that clears `startPromise` to null. This means concurrent callers share the same spawn operation. On failure, the promise clears and the next caller retries.

No changes to `SidecarConnection` or callers — `ensureStarted()` delegates directly to `process.start()`.

### M2 (catch_unwind on inference and backend creation)

Wrap the two panic-susceptible sites inside `worker_main`:

1. **`WorkerCommand::TranscribeUtterance` arm** — wrap `engine.transcribe(...)` in `catch_unwind(AssertUnwindSafe(...))`. On `Err(payload)`, format the panic message and `event_tx.send(WorkerEvent::SessionError { ... })`. Pattern the message extraction from `installer.rs:155–161`.

2. **`WorkerCommand::BeginSession` arm** — wrap the `create_backend(metadata.engine_id)` call similarly. On panic, emit `WorkerEvent::SessionError` with `metadata.session_id`. After the panic, `continue` the command loop (the worker remains alive with the previous engine).

Do **not** wrap the outer `thread::spawn` closure in `catch_unwind` — the inner guards cover the reachable panic sites. If a future panic occurs outside those sites, a hard crash is acceptable and more visible than a silent hang.

---

## Execution Steps

- [ ] **M3** — Add `this.frameParser.reset()` to the `onExit` handler in `SidecarConnection` constructor (`sidecar-connection.ts:79`), before the `rejectPendingWaiters` call. Confirm `FramedMessageParser.reset()` sets `this.buffered = new Uint8Array(0)` (verified: `protocol.ts:338–340`).

- [ ] **M1** — In `SidecarProcess` (`sidecar-process.ts`):
  - Add field: `private startPromise: Promise<void> | null = null`
  - Extract the body of `start()` (lines 40–74) into `private async doStart(): Promise<void>`
  - Rewrite `start()`:
    ```typescript
    async start(): Promise<void> {
      if (this.isRunning()) return;
      if (this.startPromise !== null) return this.startPromise;
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = null;
      });
      return this.startPromise;
    }
    ```
  - No changes elsewhere. `SidecarConnection.ensureStarted()` already delegates to `process.start()`.

- [ ] **M2** — In `native/sidecar/src/worker.rs`:
  - Add `use std::panic::{self, AssertUnwindSafe};` to imports
  - In the `WorkerCommand::TranscribeUtterance` arm, wrap only the `engine.transcribe(...)` call:
    ```rust
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        engine.transcribe(&TranscriptionRequest { ... })
    }));
    match result {
        Ok(Ok(transcript)) => { /* existing TranscriptReady send */ }
        Ok(Err(error)) => { /* existing SessionError send */ }
        Err(payload) => {
            let message = /* same extraction as installer.rs:155–161 */;
            let _ = event_tx.send(WorkerEvent::SessionError {
                code: "worker_panic".to_string(),
                details: None,
                message,
                session_id,
            });
        }
    }
    ```
  - In the `WorkerCommand::BeginSession` arm, wrap `create_backend(metadata.engine_id)`:
    ```rust
    let backend_result = panic::catch_unwind(AssertUnwindSafe(|| {
        create_backend(metadata.engine_id)
    }));
    match backend_result {
        Ok(backend) => {
            engine = backend;
            active_engine_id = metadata.engine_id;
            active_session = Some(metadata);
        }
        Err(payload) => {
            let message = /* same extraction */;
            let _ = event_tx.send(WorkerEvent::SessionError {
                code: "worker_panic".to_string(),
                details: None,
                message,
                session_id: metadata.session_id,
            });
            // Leave engine and active_session unchanged; worker loop continues.
        }
    }
    ```

- [ ] **Backlog** — Append M4, M5, M6, M7, and all L-findings to `docs/backlog.md` under a new `## Code Review 2026-04-13` section.

- [ ] **Verification** — Run full test suite and Rust build. See Verification section.

---

## Verification

```bash
# TypeScript type-check and tests
npm run typecheck
npm test

# Rust build (both feature configs)
cargo build --manifest-path native/sidecar/Cargo.toml
cargo build --manifest-path native/sidecar/Cargo.toml --features engine-cohere
cargo test --manifest-path native/sidecar/Cargo.toml
```

**What to confirm by inspection:**

- M3: `frameParser.reset()` is called in `onExit` before `rejectPendingWaiters`. No functional change for clean shutdowns — reset on an already-empty buffer is a no-op.
- M1: Two concurrent calls to `SidecarProcess.start()` return the same `Promise<void>`. The promise clears after resolution or rejection. A third call after resolution re-enters `doStart()` only if `isRunning()` is false.
- M2: `worker_main` compiles with `catch_unwind`. Worker thread does not crash on a transcription panic — it emits a `SessionError` and continues processing commands. A panic in `BeginSession` leaves `active_session` unchanged and emits a `SessionError`.

---

## Risks and Open Questions

**M1 — rejection semantics:** If `doStart()` rejects, all concurrent callers receive the same rejection. This is correct — none of them should proceed if the spawn failed. The `startPromise = null` in `finally` means the next caller (e.g. a retry) will attempt a fresh spawn.

**M2 — `AssertUnwindSafe`:** `Sender<WorkerEvent>` and `Box<dyn TranscriptionBackend>` are not `UnwindSafe`. `AssertUnwindSafe` is appropriate here (same assertion the installer thread makes) because we don't rely on any invariant of these values after a panic — the match arm either resets state or continues with unchanged state.

**M2 — `create_backend` panic in practice:** The `panic!()` in `create_backend` for `CohereOnnx` without the `engine-cohere` feature is a programming error, not a runtime condition. It should never fire in a correctly packaged binary. Catching it turns a hard crash into a `SessionError`, which is more graceful but also less visible. The error code `"worker_panic"` in the event will surface in the status bar — acceptable.

**M3 — ordering:** Resetting before rejecting pending waiters is intentional. There is no async code between the reset and the reject, so no new stdout can arrive in between.
