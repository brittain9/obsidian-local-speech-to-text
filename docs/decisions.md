# Obsidian Local STT Decisions

## What Belongs Here

Durable workflow, product, and architecture decisions. Update in the same change that alters a decision. Superseded decisions move to `docs/archive/decisions-superseded.md` once they no longer inform new work.

## Active Decisions

### D-001: GPU Is Opt-In, CPU Is Default

- Decision: CPU-only builds are the default. GPU acceleration is an opt-in sidecar Cargo feature and runtime setting.
- Why: Keeps the default path simple. GPU packaging, binary selection, and redistribution are separate concerns that shouldn't block the core product.

### D-002: Flatpak Is The Primary Linux Target

- Decision: Flatpak Obsidian is the primary Linux target.
- Why: Flatpak sandboxing hides host CUDA libraries; supporting it as primary forces the override and scoping mechanics that native installs get for free. See `docs/guides/linux-flatpak-gpu-setup.md` for the GPU setup procedure.

### D-003: Shipped Plugin Is CPU-Only By Default; GPU Is Per-Platform Additive

- Decision: Every shipped plugin includes a CPU-only sidecar. GPU support is additive per platform — Whisper supports Metal (macOS) and CUDA (Windows/Linux); Cohere supports CUDA encoder-only on Windows/Linux, CPU on macOS.
- Why: Single CPU baseline keeps the install path simple and makes the inventory promise honest. GPU choices flow through the runtime probe, not hard-coded UI logic.
- See: `docs/architecture/platform-runtime-dependencies.md` for the full platform matrix and the Cohere decoder constraint.

### D-004: Ships Both Whisper And Cohere Transcribe Families

- Decision: V1 registers two model families: Whisper (`whisper_cpp` runtime via whisper-rs) and Cohere Transcribe (`onnx_runtime` runtime via the `ort` crate). Both run in the same Rust sidecar binary.
- Why: Cohere leads the HuggingFace Open ASR Leaderboard; Whisper has the long tail of community quantizations. ONNX Runtime gives GPU on CUDA and DirectML from one runtime. Family/runtime terminology matches D-008's three-layer abstraction.

### D-005: UI Must Be Obsidian-Native

- Decision: All plugin UI uses Obsidian's built-in primitives (Setting, Modal, Notice, toggles, dropdowns). Custom CSS extends Obsidian's patterns, never replaces them.
- Why: Users expect plugin settings to look and behave like core Obsidian. Custom UI components accumulate bugs disproportionate to their value.

### D-008: Engine Abstraction Is A Three-Layer Registry

- Decision: Inference dispatch is layered as **runtime / model family / model**. A `Runtime` owns execution-framework concerns; a `ModelFamilyAdapter` owns model-shape semantics; a `LoadedModel` owns per-session inference state. `EngineRegistry::build()` is the single registration site. Selections use the triple `(runtimeId, familyId, modelId)`.
- Capability seams: **inventory** (`system_info.compiledRuntimes[]` + `compiledAdapters[]` — what this binary can do at all) and **selected-model** (`model_probe_result.mergedCapabilities` — what the current selection supports). UI gating reads the merged capabilities; there is no TypeScript mirror of which engine supports what.
- Why: Removes scattered `match EngineId` dispatch, unblocks capability-gated features (initial-prompt conditioning, per-engine GPU UI, per-adapter post-processing), and gives future adapters an OCP-friendly registration path behind a single Cargo feature flag.
- Implication: Unsupported request fields are warn+dropped at the worker, surfaced as `RequestWarning[]` on `transcript_ready` (dev console only).
- See: `docs/architecture/system-architecture.md` Stage 4 for layer details and capability flow.

### D-009: Post-Transcript Enrichment Runs In The Rust Sidecar

- Decision: Post-transcript processing — hallucination filter, punctuation, user rules, diarization, optional LLM, final render — runs in the Rust sidecar, not the plugin. The plugin receives final rendered text plus a `stageResults[]` report. Diarization runs in the audio pipeline alongside VAD; LLM post-processing is an experimental side branch outside the text pipeline because it may restructure text freely and destroy alignment.
- Why: Keeps the plugin/sidecar boundary clean — audio in, final text out. The canonical transcript struct is the architectural seam between audio-domain and text-domain processing. Capability-gated features degrade gracefully without engine-specific branches in the plugin. Supersedes D-007.
- See: `docs/architecture/system-architecture.md` for the full pipeline and protocol seams.

### D-011: No Python In The Sidecar

- Decision: The Rust sidecar does not link, embed, or subprocess Python. All inference and post-processing run in Rust against native libraries (whisper.cpp, ONNX Runtime, etc.).
- Why: Python in the sidecar means a per-platform Python distribution to bundle, virtualenv management, and a fragile dependency tree at install time. Rust-native runtimes give the same model coverage with one binary per platform. The "just shell out to faster-whisper" path looks tempting and is repeatedly the wrong call.

### D-012: No Cloud, No Telemetry, No Accounts

- Decision: After model setup, the plugin operates fully offline. No network calls for transcription, no analytics or telemetry, no account or login flow. Model downloads from HuggingFace (user-initiated) are the only sanctioned outbound traffic.
- Why: Privacy is the product. Anything that calls home or requires an account changes the value proposition fundamentally — even an anonymous "crash report" defaults users into trust they didn't grant. Treat this as a hard constraint when evaluating new features.

### D-013: No Settings Versioning Or Migration Code

- Decision: No `schemaVersion` field on settings, no migration code paths, no "preserve newer version" downgrade guards, no compatibility shims for hypothetical past schemas.
- Why: This project is greenfield with no released installed-user base. Versioning and migration code is dead weight added for users that don't exist. Change settings shape in place; fix defaults; delete old code. Reintroduce versioning only when a real released schema needs to evolve without breaking installed users.
