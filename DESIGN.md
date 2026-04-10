# Obsidian STT Plugin - Design Document

## Inspiration: Speech Note (dsnote)

[Speech Note](https://github.com/mkiol/dsnote) is a Linux-only on-device speech-to-text notepad by mkiol. It is the closest existing application to what this project wants to achieve: fully offline transcription after setup, local model management, timestamps, and a workflow centered on speaking into notes instead of dictating into a cloud service.

### What dsnote does well

- Fully on-device inference after models are installed
- Strong STT-focused UX instead of a generic "AI assistant" product
- Local model browser and download flow
- Voice activity detection (VAD) to avoid transcribing silence
- Timestamp-aware output for reference and note review
- Clear proof that there is real demand for an offline speech note workflow

### What dsnote does not do well for this project

- Linux-native stack and distribution model
- Custom editor instead of integrating with an existing note workflow
- Large footprint and complex packaging when GPU support is included
- Broader feature surface than we need for v1

---

## Product Goal

Build a desktop-only Obsidian plugin that adds local speech-to-text to the active note.

The user experience should feel like "Obsidian, but with an offline dictation button," not like a separate STT application bolted onto the side. Obsidian remains the editor, file manager, and note-taking environment. The plugin adds microphone capture, model management, transcription, and note insertion.

---

## Delivery Principles

### CPU-first

v1 must work reliably on CPU across macOS, Linux, and Windows. GPU acceleration is important, but it is not allowed to distort the architecture or delay a stable first release.

### Offline after setup

Transcription must happen locally with no network dependency after the sidecar and models are installed. The only network activity in scope is downloading the sidecar binary and speech models, and that must be clearly disclosed.

### Obsidian is the only host

We are not building a system-wide dictation service. No D-Bus layer, no global shortcuts, no typing into arbitrary windows. Integration stays inside Obsidian.

### Explicit installation and storage behavior

Large binaries and models are a core product constraint, not an implementation detail. The design must define where the sidecar lives, where models live, how they are updated, and how users understand what is on disk.

---

## Our Approach: Obsidian Plugin + Rust Sidecar

### Why Obsidian as the host

Building a cross-platform notepad is a separate product. Obsidian already gives us a strong Markdown editor, vault management, sync options, and a mature plugin ecosystem. Using Obsidian as the host lets us spend engineering effort on local STT instead of rebuilding note-taking fundamentals.

The tradeoff is intentional: we give up OS-wide integrations and focus on the single workflow that matters here, inserting transcript text into the current Obsidian note.

### Why a native sidecar

Speech inference is the heavy part of the system. A native sidecar keeps that complexity out of the plugin runtime and makes platform-specific packaging explicit.

Rust is a strong fit because:

- it is well-suited to shipping a small native executable per platform
- it gives us direct access to local filesystem, model loading, audio preprocessing, and process-level IPC
- it keeps the plugin itself thin and focused on Obsidian UX
- it gives us a clean path to whisper.cpp-based inference now and possible backend expansion later

For v1, the sidecar is CPU-first. GPU acceleration is a future extension once the packaging and backend story are proven in a spike.

---

## Architecture

```
Obsidian Plugin (TypeScript, desktop-only)
  | ensures sidecar is installed and version-matched
  | captures microphone audio via getUserMedia
  | sends PCM audio + settings over stdio JSON messages
  v
Rust Sidecar (one CPU-first binary per platform)
  | loads cached model from local disk
  | resamples audio to 16 kHz mono
  | runs VAD and batch transcription
  v
whisper.cpp integration
  | CPU inference in v1
  v
Transcript + timing data -> plugin -> inserted into active note
```

### Why stdio IPC instead of localhost HTTP

The plugin and sidecar have a 1:1 relationship. There is no need for a local web server in v1.

Using stdio gives us:

- no port allocation
- no firewall prompts
- no localhost attack surface
- simpler lifecycle management
- easier request/response correlation for a single client

If a future version needs multiple clients or external integrations, we can add a different transport later. v1 should not pay that complexity cost.

---

## Plugin Layer (TypeScript)

Responsible for everything the user sees and touches inside Obsidian:

- Desktop-only plugin manifest and runtime gating
- Sidecar install, update, checksum verification, and launch
- Audio capture via Web Audio API (`getUserMedia`)
- Commands for start recording, stop and transcribe, cancel, and reinsert last transcript
- Status bar indicator showing state: idle / recording / transcribing / error
- Obsidian `Notice` messages for errors and completion events
- Settings panel for model, language, timestamp mode, insertion mode, and storage path overrides
- Model manager UI with model list, size, local state, download, and delete actions
- Insertion into the active editor at the cursor or as an append action, depending on settings

### Recording UX for v1

v1 uses a simple toggle flow:

1. Start recording
2. Stop recording
3. Transcribe locally
4. Insert into the active note

This is lower risk than a hold-to-record push-to-talk design and fits Obsidian's command model better. Push-to-talk can be added later after a proof-of-concept confirms reliable key down / key up handling.

---

## Sidecar Layer (Rust)

Responsible for inference and local model operations:

- Start as a child process when needed and shut down on plugin unload or idle timeout
- Accept JSON messages over stdin and emit JSON events over stdout
- Load and cache the selected model in memory between requests
- Resample incoming audio to 16 kHz mono PCM
- Run VAD so silence does not dominate the transcript
- Execute batch transcription and return transcript text plus timing metadata
- Download, verify, and delete models in the configured model cache
- Report health and version information back to the plugin

### Sidecar command surface

The sidecar should expose a small internal protocol, not a public API. Example commands:

- `health`
- `list-models`
- `download-model`
- `delete-model`
- `transcribe`
- `shutdown`

The plugin is the only supported client in v1.

### Audio ownership

The plugin captures audio. The sidecar does not talk directly to microphones in v1.

This keeps device permission prompts in one place, avoids platform-specific audio capture code in Rust, and keeps the sidecar focused on inference.

---

## Distribution and Storage

### Plugin distribution

The Obsidian plugin release remains a normal community-plugin package: `manifest.json`, `main.js`, and optional `styles.css`.

### Sidecar distribution

The sidecar is distributed separately from plugin release assets and installed on first use or from the plugin settings screen.

The plugin will:

- determine the current platform
- download the matching sidecar release from GitHub Releases
- verify a pinned checksum before activation
- store the binary in a plugin-managed cache location
- update the sidecar only when the plugin version expects a newer compatible sidecar

This keeps the plugin package small and makes native binary lifecycle management explicit.

### Model storage

Models are stored outside the vault by default in a per-user cache directory. This avoids polluting vault sync, backups, and source repositories with large binary artifacts.

The settings UI should allow an advanced override so a user can point the plugin at an existing model directory if they want to share models across tools.

### Disclosures

The README and plugin manifest documentation must clearly disclose:

- transcription runs locally after setup
- the plugin downloads a native sidecar binary
- the plugin downloads speech models on demand
- models may consume significant disk space
- there is no telemetry

---

## Scope

### In scope (v1)

- Speech-to-text only
- Desktop-only Obsidian plugin
- CPU inference on macOS ARM, macOS Intel, Linux x64, and Windows x64
- Whisper-family models with a curated starter catalog
- In-plugin model browser and download manager
- Local batch transcription after the user stops recording
- Status bar indicator and error notices
- Configurable insertion behavior for active note editing
- Timestamp formatting modes suitable for note-taking
- Language selection where supported by the chosen model

### Explicitly out of scope (v1)

- GPU acceleration
- Mobile (iOS, Android)
- Real-time streaming transcription
- Hold-to-record push-to-talk UX
- Global system keyboard shortcuts
- Typing into applications outside Obsidian
- D-Bus service or third-party app integration
- Text-to-speech
- Translation
- LLM post-processing or "text repair"
- Multiple inference backends

### Future scope (v1.1 / v2)

- GPU acceleration after a dedicated packaging spike
- Push-to-talk once key event handling is proven reliable
- Streaming transcription mode
- Additional backends if whisper.cpp is not sufficient
- Optional OS notifications when transcription completes
- Speaker diarization and richer transcript metadata

---

## Timestamps

The sidecar returns timing metadata from the transcription engine, and the plugin formats that data into note-friendly output.

Timestamp modes for v1:

| Mode | Output example |
|---|---|
| None | Plain transcript, no markers |
| Per segment | `[00:00:05] This is the first thought.` |
| Per paragraph | `[00:00:05] This is the first thought.` followed by a new paragraph after a pause boundary |
| Dense | Detailed timing output intended for reference transcripts rather than normal note-taking |

Sentence and paragraph formatting are plugin-level presentation choices built from transcription timing data and pause heuristics. They are not separate inference modes.

Format should be user-configurable: `[HH:MM:SS]`, `[MM:SS]`, `(MM:SS)`, or a custom prefix pattern.

---

## In-App Integration (vs. dsnote's OS Integration)

dsnote integrates at the OS level because it is trying to behave like a general local speech utility. We are not doing that. Our integration surface is entirely inside Obsidian.

| dsnote feature | Our equivalent |
|---|---|
| System tray icon | Obsidian status bar item |
| Desktop notifications | Obsidian `Notice` API |
| Global keyboard shortcut | Obsidian command and hotkey while Obsidian is focused |
| "Type into active window" | Insert at cursor in active note |
| D-Bus service API | Not needed in v1 |

This is narrower than dsnote by design. The narrower scope is what makes the cross-platform Obsidian plugin feasible.

---

## Implementation Decisions

1. v1 is CPU-first. GPU acceleration is deferred until after the base architecture is stable.
2. The plugin captures audio. The sidecar only handles inference and model operations.
3. Plugin-to-sidecar communication uses stdio JSON messages, not localhost HTTP.
4. The sidecar is downloaded separately and checksum-verified.
5. Models are stored outside the vault by default.
6. v1 recording UX is start/stop batch transcription, not hold-to-talk.

## Remaining Questions

1. What is the exact per-OS cache path strategy for the sidecar binary and models?
2. Which starter models should be first-class in the curated catalog for v1?
3. Do we want the plugin or the sidecar to own resumable model downloads, or is a simpler non-resumable v1 flow sufficient?
