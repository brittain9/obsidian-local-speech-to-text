# Add NVIDIA Canary STT Engine

## Objective

Ship Whisper and Canary as two coexisting STT engines in v1. Canary runs as a persistent Python subprocess managed by the Rust sidecar. CUDA-only, feature-gated at compile time, capability-detected at runtime. macOS and CPU-only users are completely unaffected.

## Current State

- Rust sidecar (~4,400 lines) owns protocol, VAD, sessions, model catalog, installer, and transcription
- `TranscriptionEngine` in `transcription.rs` is a concrete struct wrapping `whisper-rs` directly
- `TranscriptionWorker` in `worker.rs` owns a `TranscriptionEngine` on a dedicated thread, receives `WorkerCommand::TranscribeUtterance`, returns `WorkerEvent::TranscriptReady`
- `EngineId` is a single-variant enum (`WhisperCpp`) used across protocol, catalog, types, and serde
- The TS plugin has `ENGINE_IDS = ['whisper_cpp']` as a const array driving type safety
- Model catalog JSON has one engine, one collection, five Whisper models
- Model explorer modal renders a flat searchable list, no grouping
- `installer.rs` downloads artifacts by URL with SHA-256 verification — Canary models use HuggingFace `from_pretrained` instead, so a different install strategy is needed

## Constraints

- D-003: CPU-first remains the default. Canary is additive, never changes the CPU path.
- D-014: GPU acceleration is feature-gated and opt-in. Canary follows the same pattern.
- D-017: V1 ships both engines. Executive decision.
- Canary requires CUDA — no Metal, no CPU-only. macOS builds don't compile `engine-canary` at all, so there's no runtime detection needed on macOS.
- Canary requires Python 3.10+ and `nemo_toolkit[asr]` on the user's machine. We do not bundle Python.
- On Windows, the Python executable is typically `python` (not `python3`). The sidecar must try both names and validate the version.
- The sidecar binary must still compile and run without Python when `engine-canary` feature is off.
- Existing Whisper tests, builds, and workflows must not break.
- Canary models are trained on segments up to 30 seconds. Audio segments exceeding this must be truncated or rejected.
- `engine-canary` requires `gpu-cuda` in Cargo (Canary won't compile without CUDA awareness). Declared as `engine-canary = ["gpu-cuda"]` in `Cargo.toml`.

## Approach

### Sidecar: Backend Trait Abstraction

Extract the transcription interface behind a trait so the worker can dispatch to either engine.

```
                     TranscriptionWorker
                            │
                    ┌───────┴───────┐
                    ▼               ▼
             WhisperBackend    CanaryBackend
             (whisper-rs)      (Python subprocess)
```

The trait takes audio samples, model identity, and returns text. The worker already handles threading, session metadata, and timing. The backend just does inference.

Model identity is polymorphic — Whisper needs a file path, Canary needs a HuggingFace model ID:

```rust
pub enum ModelIdentity {
    FilePath(PathBuf),
    PretrainedId(String),
}
```

The `TranscriptionRequest` uses `ModelIdentity` instead of the current `model_file_path: PathBuf`. Each backend ignores the variant it doesn't use (enforced at session start, not per-request).

The worker thread blocks on `engine.transcribe()` for both backends. This is fine — Whisper blocks on inference, Canary blocks on subprocess I/O. The worker is already designed for one utterance at a time, and VAD/session logic runs on the main thread.

### Canary Backend: Persistent Python Subprocess

The `CanaryBackend` manages a long-lived Python child process:
- Spawns `canary_worker.py` at session start (`BeginSession`), not on first transcription request — model loading takes 10-30 seconds and this latency must not hit the first utterance
- Keeps the process alive between utterances (model stays warm in GPU memory)
- Communicates via stdin/stdout JSON lines with correlation IDs (one request, one response per utterance)
- Captures stderr for diagnostic logging but does not parse it as protocol (NeMo is verbose)
- Writes PCM audio to a temp WAV file, sends the path, gets transcript text back
- Kills the subprocess on session end or sidecar shutdown

**Subprocess as a design advantage**: Running Python out-of-process means (1) Canary's PyTorch CUDA runtime loads independently of whisper-rs's CUDA linkage — no version conflicts, (2) if NeMo segfaults or OOMs, only the subprocess dies, the sidecar survives, (3) no pybind11/PyO3 build dependency, the sidecar stays a standalone Rust binary.

**Crash recovery**: If the subprocess dies mid-transcription (broken pipe / EOF on stdout), return a `TranscriptionError` for that utterance. The next transcription request attempts to re-spawn. Cap at 2 restart attempts per session before surfacing a persistent error to the user. Don't auto-restart indefinitely.

**JSON line protocol envelope**:
```
→ Init:      {"type": "init", "model_name": "nvidia/canary-1b-flash"}
← Ready:     {"type": "ready", "model_name": "nvidia/canary-1b-flash"}
→ Request:   {"id": "uuid", "type": "transcribe", "wav_path": "/tmp/utt.wav"}
← Response:  {"id": "uuid", "type": "transcript", "text": "hello world"}
← Error:     {"id": "uuid", "type": "error", "message": "CUDA out of memory"}
→ Shutdown:  {"type": "shutdown"}
```

The `id` field correlates requests and responses. The `ready` message signals that model loading is complete — the Rust side must wait for this before allowing transcription requests. A new `SessionState` value (`loading_model`) lets the UI show the user that Canary is warming up before the first utterance is accepted.

The Python script (`canary_worker.py`, ~200 lines) is shipped alongside the sidecar binary:
- Loads `nemo.collections.asr.models.EncDecMultiTaskModel` via `from_pretrained`
- Calls `model.eval()` and `torch.cuda.empty_cache()` after loading (matches upstream pattern)
- Keeps model resident on `cuda:0`
- Reads JSON requests from stdin, transcribes, writes JSON responses to stdout
- Sets `HF_HUB_OFFLINE=1` during inference to prevent network access — but **not** during model installation (the install path needs HuggingFace Hub access)

### Runtime Capability Detection

At startup (or on demand), the sidecar probes for Canary availability with granular per-dependency results:
1. Is the `engine-canary` feature compiled in?
2. Is Python 3.10+ on PATH? (try `python3` first, then `python`, validate with `--version`)
3. Can `python3 -c "import nemo.collections.asr"` succeed?
4. Can `python3 -c "import torch; assert torch.cuda.is_available()"` succeed?

Results are reported via a new `EngineCapabilities` event with **individual check results**, not just a boolean:

```json
{
  "type": "engine_capabilities",
  "engineId": "canary",
  "available": false,
  "checks": {
    "featureCompiled": true,
    "pythonFound": true,
    "pythonVersion": "3.11.2",
    "nemoImportable": false,
    "cudaAvailable": true
  }
}
```

This lets the plugin show targeted guidance:
- Python not found → "Install Python 3.10+ and add it to PATH"
- NeMo not found → "Run `pip install nemo_toolkit[asr]`"
- CUDA not available → "Requires an NVIDIA GPU with CUDA drivers"
- Feature not compiled → collection hidden entirely (no message needed)

### Catalog and Model Management

Canary models don't use the existing download-by-URL installer. NeMo's `from_pretrained` handles model download to its own cache (`~/.cache/huggingface/hub/`). The catalog needs schema changes to accommodate this:

**New catalog field**: `installStrategy` on `CatalogModelRecord` — either `"download"` (existing Whisper behavior, default) or `"nemo_pretrained"` (Canary). The `artifacts` array is optional for `nemo_pretrained` models. The parser validation in `protocol.ts` must relax the "primary artifact required" check for models with `installStrategy: "nemo_pretrained"`.

**New catalog field**: `huggingfaceModelId` on Canary model entries — the exact HuggingFace repo ID (e.g., `"nvidia/canary-1b-flash"`). This flows from catalog → protocol → Python worker. No string-matching heuristics.

**New collection field**: `engineId` on `ModelCollectionRecord` — ties the collection to an engine so the UI can check collection visibility against engine capabilities without inspecting individual models.

Install and probe behavior for `nemo_pretrained` models:
- Install dispatches to a Python subprocess that runs `from_pretrained` with network access (no `HF_HUB_OFFLINE`)
- The Python subprocess reports the actual HuggingFace cache directory (respecting `HF_HOME` if set)
- Install progress: since `from_pretrained` doesn't provide callbacks, the Rust side polls the HuggingFace cache directory for size changes and emits approximate `ModelInstallUpdate` events
- Probing checks whether the model directory exists in the HuggingFace cache

### Model Explorer UI Grouping

The model explorer modal gets grouped sections based on `collectionId`:
- "Whisper" collection — existing CPU-first models, always visible
- "NVIDIA Canary" collection — Canary models, only shown when capability detection passes (collection's `engineId` checked against cached `EngineCapabilities`)
- Each collection renders as a collapsible group with a heading
- When Canary capability check fails, show a collapsed info section with the **specific missing dependency** from the granular check results (not a generic banner)

## Execution Steps

### Phase 1: Backend Trait and Whisper Extraction

- [ ] 1.1 Define a `TranscriptionBackend` trait in a new `engine/mod.rs` with a `transcribe` method taking `TranscriptionRequest` (updated with `ModelIdentity` enum instead of `model_file_path`) and returning `Result<Transcript>`
- [ ] 1.2 Add `ModelIdentity` enum (`FilePath(PathBuf)` / `PretrainedId(String)`) to replace `model_file_path` in `TranscriptionRequest` and `SessionMetadata`
- [ ] 1.3 Move the existing `TranscriptionEngine` into `engine/whisper.rs` as `WhisperBackend` implementing the trait (uses `ModelIdentity::FilePath`, errors on `PretrainedId`)
- [ ] 1.4 Update `TranscriptionWorker` to hold a `Box<dyn TranscriptionBackend>` instead of a concrete `TranscriptionEngine`
- [ ] 1.5 Add `EngineId::Canary` variant to the Rust protocol, gated behind `#[cfg(feature = "engine-canary")]`
- [ ] 1.6 Existing tests pass, `npm run check:rust` clean

### Phase 2: Canary Backend (Rust Side)

- [ ] 2.1 Create `engine/canary.rs` behind `#[cfg(feature = "engine-canary")]`
- [ ] 2.2 Implement `CanaryBackend` managing a persistent `Child` process (stdin/stdout JSON line protocol with correlation IDs)
- [ ] 2.3 Handle subprocess lifecycle: spawn at session start (`BeginSession`), wait for `{"type": "ready"}` before accepting transcription requests, keep-alive between utterances, kill on session end or sidecar shutdown
- [ ] 2.4 Add `loading_model` to `SessionState` — emitted while waiting for the Python worker's readiness signal so the UI can show a warm-up indicator
- [ ] 2.5 Capture subprocess stderr into sidecar diagnostic logs (NeMo is verbose). Do not parse stderr as protocol.
- [ ] 2.6 Write temp WAV from PCM samples, send path to Python with correlation ID, parse transcript response by matching ID
- [ ] 2.7 Implement crash recovery: detect broken pipe / EOF on stdout, return `TranscriptionError` for current utterance, attempt re-spawn on next request, cap at 2 restarts per session before surfacing a persistent error
- [ ] 2.8 Reject or truncate audio segments exceeding 30 seconds (Canary training limit)
- [ ] 2.9 Wire `CanaryBackend` into `TranscriptionWorker` — select backend based on `EngineId` in `SessionMetadata`
- [ ] 2.10 Add `engine-canary = ["gpu-cuda"]` feature to `Cargo.toml`
- [ ] 2.11 Python discovery: try `python3` first, then `python`, validate version ≥ 3.10 via `--version`
- [ ] 2.12 Unit tests for the JSON line protocol parsing, correlation ID matching, crash recovery logic, and subprocess management (mock, no real Python)

### Phase 3: Python Worker Script

- [ ] 3.1 Create `native/sidecar/scripts/canary_worker.py` — stdin/stdout JSON line protocol with correlation IDs
- [ ] 3.2 On startup: read `{"type": "init", "model_name": "..."}` from stdin, load model via `EncDecMultiTaskModel.from_pretrained(model_name)`, move to CUDA, call `model.eval()`, call `torch.cuda.empty_cache()`, emit `{"type": "ready", "model_name": "..."}` on stdout
- [ ] 3.3 Request loop: read JSON line → load temp WAV → `model.transcribe([path], batch_size=1, source_lang="en", target_lang="en", task="asr", pnc="yes")` → write JSON response with matching `id` field → delete temp WAV
- [ ] 3.4 Set `HF_HUB_OFFLINE=1` after model loading completes to prevent network access during inference
- [ ] 3.5 Handle shutdown: clean exit on stdin EOF or explicit `{"type": "shutdown"}` message
- [ ] 3.6 Error handling: catch Python exceptions, return `{"id": "...", "type": "error", "message": "..."}` JSON instead of crashing. Include diagnostic detail for common failures (CUDA OOM, version mismatch, import errors)
- [ ] 3.7 Model load failure is terminal for this subprocess instance — no retry. The Rust side handles restart decisions.

### Phase 4: Runtime Capability Detection

- [ ] 4.1 Add a `CheckEngineCapabilities` command and `EngineCapabilities` event to the protocol (both Rust and TS), with granular per-check result fields (`featureCompiled`, `pythonFound`, `pythonVersion`, `nemoImportable`, `cudaAvailable`)
- [ ] 4.2 Implement the probe chain in Rust: feature flag → try `python3` then `python` on PATH → validate version ≥ 3.10 → `import nemo.collections.asr` → `torch.cuda.is_available()`
- [ ] 4.3 Report each check individually in the response so the plugin can show targeted missing-dependency messages
- [ ] 4.4 Plugin calls `CheckEngineCapabilities` at startup and caches the result
- [ ] 4.5 Add `loading_model` to `SessionState` in both Rust and TS protocol definitions

### Phase 5: Catalog, Install, and Protocol Updates

- [ ] 5.1 Add `EngineId::Canary` to TS `ENGINE_IDS` array and `EngineId` type
- [ ] 5.2 Add `installStrategy` field to `CatalogModelRecord` type (`"download"` default, `"nemo_pretrained"` for Canary). Relax the `getPrimaryArtifact` required check in `protocol.ts` for `nemo_pretrained` models (artifacts array is optional).
- [ ] 5.3 Add optional `huggingfaceModelId` field to `CatalogModelRecord` for `nemo_pretrained` models
- [ ] 5.4 Add `engineId` field to `ModelCollectionRecord` — ties collection to an engine for UI gating
- [ ] 5.5 Add `canary` engine and `nvidia_canary` collection (with `engineId: "canary"`) to `model-catalog.json`
- [ ] 5.6 Add two Canary model entries with exact HuggingFace model IDs:
  - `nvidia/canary-1b-flash` (Canary 1B Flash, ~2GB) — `installStrategy: "nemo_pretrained"`
  - `nvidia/canary-qwen-2.5b` (Canary Qwen 2.5B, ~5GB) — `installStrategy: "nemo_pretrained"`
  - Verify exact model IDs against the HuggingFace model registry before implementation
- [ ] 5.7 Extend installer to handle NeMo pretrained install strategy: dispatch to Python subprocess for `from_pretrained` download. Do not set `HF_HUB_OFFLINE` during install. Poll HuggingFace cache directory size for approximate progress and emit `ModelInstallUpdate` events.
- [ ] 5.8 Extend model probe to check HuggingFace cache for Canary models. Python subprocess reports actual cache path (respects `HF_HOME` if set).
- [ ] 5.9 Update `getEngineDisplayName` and related TS helpers for the new engine ID
- [ ] 5.10 Bump `catalogVersion` and `PROTOCOL_VERSION`

### Phase 6: UI — Model Explorer Grouping and Capability Gating

- [ ] 6.1 Group models by `collectionId` in `ModelExplorerModal` — render each collection as a section with a heading
- [ ] 6.2 Filter Canary collection visibility based on collection's `engineId` checked against cached `EngineCapabilities`
- [ ] 6.3 When `engine-canary` feature is not compiled, hide the Canary collection entirely (no message)
- [ ] 6.4 When `engine-canary` is compiled but dependencies are missing, show a collapsed info section with **specific** missing dependency from the granular capability check:
  - Python not found → "Install Python 3.10+ and add it to PATH"
  - NeMo not found → "Run `pip install nemo_toolkit[asr]`"
  - CUDA not available → "Requires an NVIDIA GPU with CUDA drivers"
  - Link to `docs/nvidia-canary-setup.md` in all cases
- [ ] 6.5 Show `loading_model` session state in the UI — warm-up indicator while Canary loads its model on first session start
- [ ] 6.6 Settings tab model card correctly displays Canary engine label and status
- [ ] 6.7 External file modal scopes engine selection (Whisper files vs Canary model names)

### Phase 7: Documentation and Verification

- [ ] 7.1 Add `docs/nvidia-canary-setup.md` — prerequisites, install steps, verification
- [ ] 7.2 Update README with optional Canary section
- [ ] 7.3 `npm run check:js` clean (TS tests, typecheck, lint, build)
- [ ] 7.4 `npm run check:rust` clean with default features (Whisper-only)
- [ ] 7.5 `npm run check:rust` clean with `--features engine-canary` (implies `gpu-cuda`)
- [ ] 7.6 Manual end-to-end test: install NeMo, start Canary session, transcribe, verify output
- [ ] 7.7 Manual test: verify Canary models hidden when NeMo not installed
- [ ] 7.8 Manual test: verify granular dependency messages (remove Python, remove NeMo, no CUDA) show correct per-dependency guidance
- [ ] 7.9 Manual test: verify `loading_model` warm-up indicator displays during Canary model load
- [ ] 7.10 Manual test: kill Python subprocess mid-session, verify crash recovery and re-spawn

## Verification

- All existing Whisper tests pass unchanged (no regression from trait extraction)
- Default `cargo build` produces the same binary as before (no new dependencies without feature flag)
- `cargo build --features engine-canary` compiles the Canary backend (implies `gpu-cuda`)
- TS typecheck passes with the expanded `EngineId` union, `installStrategy` field, `huggingfaceModelId` field, and `ModelCollectionRecord.engineId` field
- Model catalog validates with new engine, collection, and model entries (including relaxed artifact validation for `nemo_pretrained` strategy)
- Runtime without Python: Canary collection hidden, specific missing-dependency message shown, Whisper works normally
- Runtime with Python but no NeMo: Canary collection shows "Run `pip install nemo_toolkit[asr]`" guidance
- Runtime with Python + NeMo + CUDA: Canary models appear, install works, transcription produces text
- Canary session start shows `loading_model` state during warm-up, transitions to `listening` after readiness signal
- Subprocess crash during transcription returns error, next utterance triggers re-spawn (up to 2 retries)

## Risks and Mitigations

1. **HuggingFace cache location**: NeMo stores models in `~/.cache/huggingface/hub/`. This path differs if `HF_HOME` is set. **Mitigation**: The Python subprocess reports the actual cache path in its responses. The Rust side never hardcodes the cache location.

2. **Python subprocess reliability**: The Python process can crash mid-session from CUDA OOM, driver mismatch, or NeMo bugs. **Mitigation**: Detect broken pipe / EOF on stdout, return `TranscriptionError` for current utterance, attempt re-spawn on next request, cap at 2 restarts per session. Model load failure is terminal for the subprocess instance (no retry within the subprocess itself). CUDA OOM has no explicit catch in NeMo — it surfaces as a generic Python exception, logged and returned as an error JSON.

3. **Model download size**: Canary 1B Flash is ~2GB, Qwen 2.5B is ~5GB, plus the one-time PyTorch CUDA install (~2-4GB). NeMo's `from_pretrained` doesn't provide progress callbacks. **Mitigation**: Poll the HuggingFace cache directory for size changes during install and emit approximate `ModelInstallUpdate` events. Show "Downloading model, this may take several minutes" in the UI.

4. **Multi-language support**: Canary is multilingual. D-003 says English-first. For v1, hardcode `source_lang="en"`, `target_lang="en"`, `task="asr"`, `pnc="yes"`. Multi-language is a follow-up.

5. **Temp file overhead**: Writing a WAV to disk per utterance adds ~1-2ms for a 10-second clip. Confirmed necessary — NeMo's `EncDecMultiTaskModel.transcribe()` takes file paths, not numpy arrays directly (validated against the upstream implementation). Negligible against inference time. A named pipe or direct PCM-over-stdin could eliminate it later if NeMo adds array input support.

6. **CUDA version mismatch between engines**: Whisper (via whisper-rs) links against host CUDA libraries, while NeMo/PyTorch ships its own CUDA runtime inside the pip wheel. These could target different CUDA major versions. **Mitigation**: The subprocess architecture isolates the two — each process loads its own CUDA runtime. This is a design advantage of the subprocess model, not just an implementation convenience.

7. **Cold-start latency**: NeMo model loading takes 10-30 seconds (CUDA init + model deserialization + GPU memory allocation). **Mitigation**: Pre-spawn the Python subprocess at session start, not on first transcription request. The `loading_model` session state lets the UI show a warm-up indicator. The readiness signal (`{"type": "ready"}`) gates the first utterance.

8. **Windows Python discovery**: The Python executable is `python` (not `python3`) on Windows. The Microsoft Store installs a `python3.exe` alias that opens the Store. **Mitigation**: Try `python3` first, fall back to `python`, validate version ≥ 3.10 via `--version` output.
