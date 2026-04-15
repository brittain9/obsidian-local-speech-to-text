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
  | Windows | CUDA | CUDA | No sandbox, just works |
  | macOS | Metal | CPU only | CoreML not viable; CPU performance is acceptable |
  | Linux native | CUDA | CUDA | Host env inherited, RPATH resolves |
  | Linux Flatpak | CUDA | CUDA | Requires advanced setup (see `docs/guides/linux-flatpak-gpu-setup.md`) |

### D-004: Ships Both Whisper And Cohere Transcribe

- Status: active
- Decision: V1 includes Whisper (via whisper-rs) and Cohere Transcribe (via ONNX Runtime / `ort` crate). Both run in the same Rust sidecar binary — no Python, no subprocesses. Three Cohere tiers: fp16 (~4.1 GB), int8 (~3.1 GB), q4 (~2.1 GB).
- Why: Cohere leads the HuggingFace Open ASR Leaderboard. Rust-native ONNX avoids fragile Python dependencies. ONNX Runtime provides GPU on CUDA and DirectML from one runtime.

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
