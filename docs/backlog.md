# Obsidian Local STT Backlog

## Maintenance

- [ ] Strengthen Whisper CUDA probe to verify userspace libraries, not just device nodes. Current heuristic (`/dev/nvidiactl` + `/dev/nvidia0`) can report CUDA available when `libcudart.so` / `libcublas.so` are missing.
- [ ] KV cache outputs matched by iterator position, not name (`native/src/cohere.rs:538-557`). ONNX Runtime does not guarantee output ordering across model versions or opset versions. Current code assumes first output is logits and collects the rest positionally as KV cache. Fix: collect `decoder_outputs` into a `HashMap<String, DynValue>` and look up `"logits"` and each `present.*` cache name explicitly. Medium priority — won't break with current Cohere export but risks silent failures if a model changes.
- [ ] Restart sidecar automatically when launch-affecting settings change (`CUDA library path`, `Sidecar path override`) while dictation is idle, or show an explicit "restart required" notice.
- [ ] Evaluate ONNX Runtime `preload-dylibs` after the current Linux / Flatpak path-based workflow stabilizes. It may simplify Cohere CUDA library loading, but Whisper CUDA still needs sidecar-scoped `LD_LIBRARY_PATH`.


## Later

- [ ] Investigate global push-to-talk or hotkeys without pushing OS-specific assumptions into the core design.
- [ ] Consider showing the active transcript placement mode in the status bar once multiple placement modes ship.
- [ ] Add optional start/stop tones and lightweight processing statistics if the main dictation flow is already reliable.
- [ ] Evaluate single-binary CPU+GPU via ggml backend dlopen registry once whisper.cpp adopts the llama.cpp `GGML_BACKEND_DL` pattern — would eliminate the need for a separate CUDA binary entirely.
- [ ] Tiny model for language detection. Option to use a tiny model for auto language detection instead of the selected model — faster but less accurate. Reference pattern from upstream app.
- [ ] Performance options. Expose engine tuning via profile presets (Best performance / Best quality / Custom). Custom exposes threads, beam width, audio context size, flash attention.

## Code Review 2026-04-13

Medium findings deferred from the M1/M2/M3 fix batch:

- [ ] **M4** `dictation-session-controller.ts:173–208` — Race during dictation start: `this.sessionId` is set before `captureStream.start()`, so a stale sidecar error from a prior session can pass the session filter and call `abortSessionAfterError` on a not-yet-started session. Fix: defer setting `this.sessionId` until after sidecar confirms session start, or add an explicit "starting" state.
- [ ] **M5** `src/sidecar/protocol.ts:333–383` — `FramedMessageParser.pushChunk` has no upper bound on buffered data. A corrupt frame header can cause unbounded memory growth. Add a `MAX_BUFFERED` check matching the Rust side's `MAX_FRAME_PAYLOAD` (16 MiB). The `concatBytes` loop is also quadratic on accumulation — flatten on first write instead.
- [ ] **M6** `native/src/cohere.rs:70,451` — Two `unwrap()` calls in production code on the worker thread. Convert to `expect()` with invariant documentation. Also `transcription.rs:182`, `app.rs:132`. Becomes safe to defer once M2 (`catch_unwind`) is in.
- [ ] **M7** `native/src/worker.rs:148,156` — `let _ = event_tx.send(...)` silently discards send errors. Log a warning on failure, or detect channel disconnect and exit the worker loop.

Low findings (cleanup, no correctness impact):

- [ ] **L1** Remove `isInsertionMode` duplicate in `settings-tab.ts:49` — import from `plugin-settings.ts:110` instead.
- [x] **L2** Replace inline `error instanceof Error ? error.message : String(error)` in `main.ts:174` and `dictation-session-controller.ts:359` with `formatErrorMessage` from `shared/format-utils.ts:17`.
- [ ] **L3** Remove dead export `DEFAULT_PCM_SAMPLES_PER_FRAME` from `src/audio/pcm-frame-processor.ts:139`.
- [ ] **L5** Extract a helper on `AppState` for the repeated `resolve_model_store_info(model_store_path_override.as_deref())` + error-map pattern in `native/src/app.rs` (appears 6+ times).
- [ ] **L6** `native/src/session.rs:170` — `push_pre_roll_frame(frame.clone())` clones ~32 KB/s during active speech. Check `speech_started` before cloning, or restructure.
- [ ] **L7** `native/src/session.rs:70` — `Vec<Vec<i16>>` utterance storage allocates one heap object per 20 ms frame. Flatten to `Vec<i16>`; `maybe_finalize_utterance` already flattens for output.
- [ ] **L8** `settings-tab.ts:456–458` — bare `catch {}` swallows sidecar errors with no logging. Add a debug-level log.
- [ ] **L9** `model-install-manager.ts:493–498` — `fetchSupportedEngineIds` silently falls back to `['whisper_cpp']` on error. Log a warning on the fallback path.
- [ ] **L10** `native/src/app.rs:238` — `RemoveModel` error detail is discarded at the protocol boundary (`removed: false` with no message). Include the error string in the event or emit a warning event.
- [ ] **L11** `native/src/protocol.rs:409` — every outbound event is cloned to wrap in `EventEnvelope`. Take `Event` by value to avoid the clone.
- [ ] **L12** Structural: PCM constants (`PCM_SAMPLE_RATE_HZ`, `PCM_BYTES_PER_FRAME`, etc.) are independently defined in `src/shared/pcm-format.ts` and `native/src/protocol.rs`. A mismatch would produce silent audio corruption undetected by the version string. Options: add PCM parameters to the health handshake, generate one side from the other, or document as a protocol invariant.

Test coverage gaps (from the review's Top 10 list — add when touching the relevant module):

- [ ] `sidecar-connection`: `sendCommandAndWait` timeout behaviour
- [ ] `sidecar-connection`: `rejectPendingWaiters` on process exit
- [ ] `protocol (TS)`: `FramedMessageParser.pushChunk` with a header-level split across two chunks
- [ ] `pcm-frame-processor`: state continuity across multiple `push()` calls
- [ ] `dictation-session-controller`: transcript fallback to segment text (real Whisper edge case)
- [ ] `editor-service`: `assertActiveEditorAvailable` throws when no editor
- [ ] `worker.rs (Rust)`: session matching and engine switching

Fixture deduplication: `sampleCatalog()`, `sampleCatalogModel()`, `sampleInstalledModel()`, `sampleInstallUpdate()` are defined independently in `model-install-manager.test.ts:87–186` and `model-row-state.test.ts:20–119`. Extract to a shared fixture module when touching either test file.

Graceful stop (added 2026-04-14):

- [ ] **L13** Drain timeout: if the transcription worker hangs or panics during a graceful stop, the session stays in `draining` indefinitely. The plugin-side `isBusy()` returns true, blocking new sessions. Add a watchdog timeout or detect worker channel disconnect during drain.
- [ ] **L14** Rust test for drain path: `stop_session_emits_stopped_event` only covers immediate stop (no in-flight transcription). Add a test that starts a session, ingests enough audio to enqueue a transcription, then calls `StopSession` and verifies the drain-then-stop sequence.

## Blocked

- [ ] Finalize native sidecar distribution and update strategy for community-plugin releases. This includes CPU/CUDA dual-binary packaging where needed, runtime binary selection, checksum/update flow, and CUDA redistribution/licensing constraints.
- [ ] Provision a CUDA-capable CI or release runner so automated release builds can emit Linux CUDA artifacts instead of relying on manual local builds.

## Pipeline (D-007, see `docs/architecture/pipeline-architecture.md`)

- [ ] Cohere synthetic segments — produce at least one segment with timing from Cohere backend (`feat/cohere-segments`)
- [ ] TranscriptFormatter layer — extract formatting step between engine output and insertion (`feat/transcript-formatter`)
- [ ] TextProcessor pipeline — composable text transforms between formatting and insertion (`feat/text-processor-pipeline`)
- [ ] Smart cursor insertion — context-aware spacing and capitalization at cursor (`feat/smart-insertion`)
- [ ] Inline timestamp format — `[MM:SS]` prefix per segment, template-based (`feat/inline-timestamps`)
- [ ] Hallucination filtering — detect and strip repeated phrases, phantom words (`feat/hallucination-filter`)
- [ ] User text transformation rules — configurable find/replace rules applied to transcripts (`feat/user-text-rules`)
