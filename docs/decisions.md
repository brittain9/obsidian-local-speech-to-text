# Obsidian Local STT Decisions

## What Belongs Here

Durable workflow, product, and architecture decisions. Update in the same change that alters a decision. Mark superseded decisions explicitly.

## Active Decisions

### D-001: GPU Is Opt-In, CPU Is Default

- Status: active
- Decision: CPU-only builds are the default. GPU acceleration is an opt-in sidecar Cargo feature and runtime setting.
- Why: Keeps the default path simple. GPU packaging, binary selection, and redistribution are separate concerns that shouldn't block the core product.

### D-002: Flatpak Is The Primary Linux Target

- Status: active
- Decision: Flatpak Obsidian is the primary Linux target. GPU on Flatpak requires advanced setup (`--filesystem=host-os`, `--device=all`, sidecar override, scoped `LD_LIBRARY_PATH`). Documented in `docs/guides/linux-flatpak-gpu-setup.md`.
- Why: Flatpak sandboxing hides host CUDA libraries. The override path works but requires manual configuration.

### D-003: Platform GPU Support Matrix

- Status: active
- Decision: GPU support varies by platform and engine. Shipped plugin always includes CPU-only sidecar.

  | Platform | Whisper GPU | Cohere GPU | Notes |
  |---|---|---|---|
  | Windows | CUDA | Encoder only (CUDA) | Decoder pinned to CPU — see Cohere note below |
  | macOS | Metal | CPU only | CoreML not viable; CPU performance is acceptable |
  | Linux native | CUDA | Encoder only (CUDA) | Decoder pinned to CPU — see Cohere note below |
  | Linux Flatpak | CUDA | Encoder only (CUDA) | Requires advanced setup (see `docs/guides/linux-flatpak-gpu-setup.md`); decoder still CPU |

- Cohere note: the Cohere Transcribe decoder runs on CPU even when CUDA is the
  selected accelerator. ORT's CUDA `GroupQueryAttention` kernel does not support
  the `attention_bias` input that the decoder graph requires, so offloading the
  decoder triggers a runtime kernel-fallback error. Only the encoder benefits
  from CUDA today. Enforced in `native/src/adapters/cohere_transcribe.rs` by
  building the decoder session with `GpuConfig { use_gpu: false }`.

### D-004: Ships Both Whisper And Cohere Transcribe Families

- Status: active
- Decision: V1 registers two model families: Whisper (`whisper_cpp` runtime via whisper-rs) and Cohere Transcribe (`onnx_runtime` runtime via the `ort` crate). Both run in the same Rust sidecar binary — no Python, no subprocesses. Three Cohere tiers: fp16 (~4.1 GB), int8 (~3.1 GB), q4 (~2.1 GB).
- Why: Cohere leads the HuggingFace Open ASR Leaderboard. Rust-native ONNX avoids fragile Python dependencies. ONNX Runtime provides GPU on CUDA and DirectML from one runtime. Family/runtime terminology matches D-008's three-layer abstraction.

### D-005: UI Must Be Obsidian-Native

- Status: active
- Decision: All plugin UI uses Obsidian's built-in primitives (Setting, Modal, Notice, toggles, dropdowns). Custom CSS extends Obsidian's patterns, never replaces them.
- Why: Users expect plugin settings to look and behave like core Obsidian. Custom UI components accumulate bugs disproportionate to their value.

### D-006: Trunk-Based Development

- Status: active
- Decision: Short-lived feature branches merged via PR. `main` stays releasable. CI must pass. Incomplete work goes behind feature flags.
- Why: The project is mature enough that direct-to-main risks destabilizing working features. See `CONTRIBUTING.md`.

### D-007: Transcript Pipeline Architecture

- Status: active
- Decision: Insert a TranscriptFormatter and TextProcessor pipeline between engine output and editor insertion. Formatter selects output format (plain text, inline timestamps). Processor applies composable text transforms (filtering, user rules). Each layer ships in its own PR.
- Why: The current pipeline goes directly from engine output to insertion with no formatting or processing step. See `docs/architecture/pipeline-architecture.md`.

### D-008: Engine Abstraction Is A Three-Layer Registry

- Status: active
- Decision: Inference dispatch is layered as **runtime / model family / model**. A `Runtime` owns execution-framework concerns (accelerator registration, probe, supported formats). A `ModelFamilyAdapter` owns model-shape semantics (graph I/O, tokenizer, prompt tokens, audio limits, per-model probe rules). A `LoadedModel` owns per-session inference state. `EngineRegistry::build()` is the single registration site; worker dispatch is `registry.lookup((runtimeId, familyId)) → adapter.load → loaded.transcribe`. Capabilities are declared statically per runtime and per adapter, and flow to the plugin through two seams:
  - **Inventory** (`system_info.compiledRuntimes[]` + `system_info.compiledAdapters[]`) — every runtime and adapter compiled into this sidecar, with its declared capabilities. The plugin uses this for "what this binary can do at all" context (e.g. show `DirectML` only on Windows builds).
  - **Selected-model capabilities** (`model_probe_result.mergedCapabilities`) — the merged `RuntimeCapabilities ⊕ ModelFamilyCapabilities` for the current selection, present iff the probe returned `ready`. The plugin exposes this as `ModelManagerState.selectedModelCapabilities`, a discriminated union of `{none | pending | unavailable | ready}`. UI gating (initial-prompt field, language picker, segment formatter) reads from this union; there is no TypeScript mirror of which engine supports what. For unknown-family external files, the merge falls back to `ModelFamilyCapabilities::unknown()` so the struct shape is stable.
- Why: Removes scattered `match EngineId` dispatch, unblocks capability-gated features (initial-prompt conditioning, per-engine GPU UI, per-adapter post-processing), and gives future adapters an `OCP`-friendly registration path behind a single Cargo feature flag without touching dispatch sites. Selections use the triple `(runtimeId, familyId, modelId)` — so one runtime can host multiple families and one family can be delivered by multiple runtimes.
- Implication: Settings carry `schemaVersion: 2`. Unsupported request fields are warn+dropped at the worker, surfaced as `RequestWarning[]` on `TranscriptReadyEvent` (dev console only). Cargo features renamed: `engine-cohere-transcribe`, `engine-whisper`, `gpu-ort-cuda`. Per-model capability overrides are a planned additive extension: a new optional field on `EngineCapabilities` (e.g. `modelOverrides`) that consumers default to merged family caps when absent — no breaking change required.
