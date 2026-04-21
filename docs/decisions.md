# Obsidian Local STT Decisions

## What Belongs Here

Durable workflow, product, and architecture decisions. Update in the same change that alters a decision. Superseded decisions move to `docs/archive/decisions-superseded.md` once they no longer inform new work.

## Active Decisions

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
