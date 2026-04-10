# Plan: Fastest Correct Path To A Real Whisper Dictation Plugin

## Summary

Take the current bootstrap spine and turn it into the smallest real, usable Obsidian dictation flow:

- click a button or run a command to start recording
- speak into the microphone
- stop recording
- run local CPU Whisper transcription
- insert the transcript into the active Obsidian note

This plan is intentionally narrower than the full product vision. It does not include model browsing, automatic downloads, timestamps UI, GPU acceleration, translation, TTS, or mobile support. The goal is one correct end-to-end path that proves the product.

The key architectural decision is to keep the existing TypeScript plugin + Rust sidecar boundary and implement CPU Whisper there. Do not introduce a Python runtime or a second sidecar just to use `faster-whisper` in this phase. That would add packaging and toolchain complexity before the first usable dictation loop exists.

---

## Current Starting Point

Already implemented in the repository:

- Obsidian desktop plugin scaffold
- Rust sidecar scaffold
- versioned stdio JSON IPC
- sidecar health checks
- mock transcription request/response
- transcript insertion into the active note
- pinned toolchains and verification commands

Observed gap:

- no microphone capture
- no recording UX
- no real transcription request
- no model path setting
- no Whisper inference in the sidecar
- no manual end-to-end Obsidian smoke test documented for real audio

This plan starts from that state. It does not repeat bootstrap work that already exists.

---

## Decision Summary

### 1. Keep the Rust sidecar for the first real implementation

Use the existing Rust sidecar and add CPU transcription there.

Reasoning:

- the repo already has a working sidecar lifecycle and protocol
- it preserves the intended plugin/runtime separation
- it avoids adding Python environment management, packaging, and support burden
- it keeps future native packaging aligned with the current architecture

Recommendation:

- use `whisper-rs` in CPU-only mode for the first usable version
- keep the implementation file-oriented: plugin records a WAV file, sidecar transcribes that file

### 2. Use a file-based audio boundary for v1

Do not stream audio frames over stdio in this phase.

Use:

- plugin captures microphone audio
- plugin writes a temporary mono WAV file
- sidecar receives `audioFilePath` and `modelFilePath`
- sidecar returns final transcript text after the user stops recording

Reasoning:

- simplest to debug
- simplest to retry manually
- avoids large IPC payloads and streaming complexity
- keeps the interface stable when VAD and GPU are added later

### 3. Keep the first user workflow batch-only

The first real workflow is:

1. start dictation
2. record locally
3. stop dictation
4. transcribe locally
5. insert at cursor

Do not add live partial transcripts or push-to-talk in this phase.

### 4. Keep model management manual for the first real version

Do not build an in-app model browser or downloader yet.

Add:

- one plugin setting for the model file path
- one plugin setting for insertion mode
- one plugin setting for an optional temp audio directory override

Reasoning:

- this is enough to smoke test the real pipeline
- it separates “can transcribe correctly” from “can manage artifacts nicely”
- it avoids mixing product UX work with inference integration work

### 5. Optimize for English CPU smoke testing first

The first supported path is:

- English-only
- CPU-only
- one known-good Whisper model
- one note insertion mode guaranteed to work: insert at cursor

Everything else is follow-on work.

---

## Scope

### In scope for this plan

- real microphone capture in the Obsidian plugin
- temp WAV file creation
- real `transcribe_file` IPC contract
- CPU Whisper inference in the Rust sidecar
- one ribbon button for dictation toggle
- start/stop commands
- model file path setting
- insert transcript into the active note
- useful error handling for mic permission, sidecar failures, and missing model files
- manual smoke test instructions for real transcription

### Explicitly out of scope for this plan

- `faster-whisper` as a runtime dependency
- automatic model download UI
- model catalog/explorer
- GPU acceleration
- VAD
- timestamps in the editor output
- multiple language selection
- append-to-line and append-to-end insertion modes beyond a clean setting seam
- mobile support
- community plugin packaging

---

## Architecture For This Milestone

```text
Obsidian plugin (TypeScript)
  -> start/stop dictation UX
  -> microphone permission and capture
  -> write temp WAV file
  -> send transcribe_file request over stdio
  -> insert returned text into active editor

Rust sidecar
  -> validate request
  -> load configured Whisper model
  -> decode WAV
  -> run CPU transcription
  -> return transcript text and optional coarse segments
```

### Plugin responsibilities

- command registration
- ribbon button state
- recording state machine
- microphone capture lifecycle
- temp file lifecycle
- user-facing notices
- editor insertion
- settings storage

### Sidecar responsibilities

- protocol validation
- model loading and reuse
- WAV parsing
- Whisper inference
- structured error reporting

---

## Public Interfaces And Workflow Changes

### Plugin settings

Extend plugin settings with:

- `modelFilePath: string`
- `insertionMode: 'insert_at_cursor'`
- `tempAudioDirectoryOverride: string`
- existing sidecar timeout/path settings remain

For this phase, `insertionMode` exists as a stable interface but only `insert_at_cursor` needs to be implemented.

### Plugin commands

Replace the bootstrap-only UX with a real dictation shell:

- `Local STT: Start Dictation`
- `Local STT: Stop And Transcribe`
- `Local STT: Cancel Dictation`
- keep `Check Sidecar Health`
- keep `Restart Sidecar`

The mock transcript command can be removed once the real path is stable, or kept temporarily only if it still has verification value.

### Ribbon and status UX

Add one ribbon action that toggles between:

- idle
- recording
- transcribing
- error

The button label and status bar text must reflect state clearly. Do not hide state in logs.

### Sidecar protocol

Add a new request type:

- `transcribe_file`

Request payload:

- `audioFilePath: string`
- `modelFilePath: string`
- `language: 'en'`

Response payload:

- `text: string`
- `segments: Array<{ startMs: number; endMs: number; text: string }>`

Keep `health` and `shutdown`. Remove `transcribe_mock` only after the real path is stable and no longer useful for debugging.

### Recording workflow

1. User starts dictation.
2. Plugin requests microphone access if needed.
3. Plugin records raw audio and writes a temp WAV file.
4. User stops dictation.
5. Plugin calls `transcribe_file`.
6. Sidecar returns transcript text.
7. Plugin inserts text at the cursor.
8. Plugin deletes the temp audio file on success and on cancel.

If transcription fails, the temp file may be retained briefly for debugging during development, but release behavior should clean up by default.

---

## Implementation Plan

## Phase 0: Close The Remaining Bootstrap Gap

### Deliverables

- confirm the existing plugin and sidecar work inside a real Obsidian dev vault
- confirm the default sidecar path resolution is correct in the desktop runtime

### Concrete work

- run the existing plugin in a dedicated dev vault
- verify status bar initialization, sidecar health command, and mock transcript insertion
- fix any runtime-only issues before adding microphone capture
- document the exact local dev workflow in `README.md`

### Acceptance checks

- Obsidian desktop loads the plugin without runtime errors
- sidecar health succeeds from the command palette
- mock transcript still inserts into the active note

This is the last time the mock path is the primary milestone.

## Phase 1: Real Dictation UX Shell

### Deliverables

- a real dictation state machine in the plugin
- commands for start, stop, and cancel
- a ribbon button wired to the same behavior

### Concrete work

- add a focused dictation controller module instead of growing `src/main.ts`
- define explicit states: `idle`, `recording`, `transcribing`, `error`
- disable invalid transitions, such as starting while already recording
- surface state in the status bar and notices
- gate commands on valid state

### Acceptance checks

- commands appear in Obsidian
- ribbon button toggles state
- invalid transitions are blocked with a useful notice instead of silent failure

## Phase 2: Microphone Capture And WAV Output

### Deliverables

- microphone capture from the plugin
- temp WAV file output suitable for Whisper
- cleanup of recording resources and temp files

### Concrete work

- add an audio module responsible for microphone permission and capture
- capture PCM in the plugin and write a mono WAV file
- standardize target format for the first version:
  - 16 kHz
  - mono
  - 16-bit PCM WAV
- use a temp directory outside the vault by default
- keep the audio module separate from Obsidian editor logic and sidecar logic

### Technical direction

Use browser/Electron capture APIs in the plugin and encode the resulting PCM into WAV locally. Avoid `MediaRecorder` plus codec conversion in this phase unless a concrete Electron limitation forces that change.

### Acceptance checks

- starting dictation requests mic permission
- stopping dictation produces a valid WAV file
- canceling dictation closes the mic stream and deletes the temp file

## Phase 3: Real Sidecar Transcription Path

### Deliverables

- real `transcribe_file` IPC request
- sidecar model loading
- CPU transcription result returned to the plugin

### Concrete work

- extend TypeScript and Rust protocol definitions with `transcribe_file`
- add a sidecar transcription module isolated from protocol parsing
- add model file existence and readability validation
- add WAV file existence and readability validation
- load the model in the sidecar and reuse it between requests when the path is unchanged
- return structured errors for missing model, invalid WAV, and transcription failure

### Acceptance checks

- a real audio file request returns a real transcript
- repeated requests do not reload the model unnecessarily when the same model path is used
- protocol errors are surfaced cleanly in the plugin

## Phase 4: Editor Insertion And Minimal Settings

### Deliverables

- transcript insertion into the active note from the real path
- minimal settings needed for smoke testing

### Concrete work

- add a required `modelFilePath` setting with validation
- add an `insert_at_cursor` insertion path as the first supported mode
- refuse to start transcription when no model path is configured
- wire the end-to-end dictation flow:
  - start recording
  - stop
  - transcribe
  - insert

### Acceptance checks

- transcript text is inserted at the cursor in the active note
- missing model path produces a clear, actionable error

## Phase 5: Stabilization And Smoke-Test Documentation

### Deliverables

- repository docs for a real local smoke test
- cleaned-up debug surfaces
- high-signal tests around the new logic

### Concrete work

- document model download and placement for development
- document the dev-vault workflow for a real microphone test
- remove or demote bootstrap-only UX that no longer adds value
- tighten error messages and logs

### Acceptance checks

- a new contributor can follow the docs and complete a real dictation smoke test
- the repo has one clear path to “speak -> stop -> transcript appears”

---

## Smoke-Test Model Strategy

### Backend choice for this phase

For this implementation phase, the sidecar should use Whisper-compatible models that work with `whisper.cpp` / `whisper-rs`.

Do not plan around Hugging Face Transformers checkpoints or a Python-only `faster-whisper` setup in this phase.

### Recommended first smoke-test model

Use `ggml-base.en.bin` first.

Reasoning:

- small enough for predictable CPU testing
- English-only, which matches current scope
- widely documented in `whisper.cpp`
- fast enough to unblock product validation

### Recommended upgrade after the first successful smoke test

If `base.en` works and you want better quality on CPU, test one of these next:

- `ggml-small.en.bin`
- `ggml-base-q5_1.bin` if memory/disk pressure matters more than peak accuracy

### Note on newer model families

`openai/whisper-large-v3-turbo` is a more recent Whisper-family model, but it is not the right first smoke-test choice for a CPU-first plugin workflow. It is larger, slower, and adds debugging cost before the product loop is proven.

Use the small English models first. Upgrade only after the real dictation path is stable.

### Manual storage location for smoke tests

Until the plugin has a model browser/downloader, store models outside the vault in a dedicated per-user directory and point the plugin setting at the model file.

Recommended development locations:

- Linux: `~/.local/share/obsidian-local-stt-dev/models/`
- macOS: `~/Library/Application Support/obsidian-local-stt-dev/models/`
- Windows: `%APPDATA%\\obsidian-local-stt-dev\\models\\`

Do not place models inside the Obsidian vault or the plugin repository during normal development.

---

## Test Plan

### TypeScript

Add or update high-signal tests for:

- dictation state transitions
- plugin settings resolution for new fields
- protocol serialization/parsing for `transcribe_file`
- WAV writer behavior where it is pure and testable
- editor insertion behavior at the existing seam

Do not write tests that depend on loading a full Obsidian runtime.

### Rust

Add or update tests for:

- protocol parsing/serialization for `transcribe_file`
- model path and audio path validation
- WAV parsing
- command dispatch for successful and failing transcription requests

Keep inference tests small and deterministic. Do not require a large model download in unit tests.

### Manual verification

Required manual smoke test in a real Obsidian desktop vault:

1. configure the sidecar path if needed
2. configure `modelFilePath`
3. open a Markdown note
4. start dictation
5. speak for 5 to 10 seconds
6. stop and transcribe
7. confirm transcript text appears at the cursor
8. confirm temp audio cleanup and sane status transitions

### Required verification gates before leaving this plan

- `npm run build`
- `npm run test`
- `npm run check`
- manual Obsidian dictation smoke test with a real microphone and a real model

---

## Failure Modes To Handle Explicitly

- no microphone permission
- no active markdown editor
- model path missing
- model path points to a non-existent or unreadable file
- temp directory missing or unwritable
- sidecar startup failure
- sidecar timeout
- malformed or unsupported WAV input
- start called while already recording
- stop called while not recording
- cancel during transcription

These are product-level behaviors, not edge-case polish. They must be handled intentionally in the first real implementation.

---

## Assumptions And Defaults

- keep the plugin root at the repository root
- keep the Rust sidecar under `native/sidecar`
- keep stdio JSON as the only plugin-sidecar transport
- first real implementation supports English only
- first real implementation supports CPU only
- the user manually downloads the model and sets its file path during development
- the first shipped insertion behavior is `insert_at_cursor`
- VAD, timestamps, model browser, and GPU work are intentionally deferred

---

## Acceptance Criteria

This milestone is complete when all of the following are true:

- the plugin loads in Obsidian desktop and can start/stop dictation
- the plugin records microphone audio into a valid temp WAV file
- the sidecar accepts `transcribe_file` and returns real transcript text
- the transcript is inserted into the active note at the cursor
- the model path is configurable through plugin settings
- the repo documents exactly how to perform a real local smoke test
- automated checks pass and the manual Obsidian smoke test passes

---

## Sources Used For Current Direction

- `whisper.cpp` official repository and README for CPU-first model/runtime support and model format
- OpenAI `whisper-large-v3-turbo` Hugging Face model card for the current newer Whisper-family checkpoint context
- current repository code and docs in `AGENTS.md`, `DESIGN.md`, and the existing bootstrap implementation
