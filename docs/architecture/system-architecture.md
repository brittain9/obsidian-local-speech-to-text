# System Architecture

## System Overview

Local Speech-to-Text is an Obsidian plugin that transcribes speech to text entirely on-device. Audio flows from the microphone through a browser-based capture layer, across a binary protocol into a native Rust sidecar process, through a Whisper (or Cohere) inference engine, and back as text that is inserted into the active editor.

```mermaid
---
config:
  flowchart:
    nodeSpacing: 20
    rankSpacing: 25
    diagramPadding: 8
    wrappingWidth: 120
---
flowchart LR
    subgraph Obsidian ["Obsidian - Electron"]
        MIC["Microphone"] --> CAPTURE["Audio Capture + PCM Framing"]
    end

    CAPTURE --> PROTO_TS["Protocol Encoder"]
    PROTO_TS -->|"stdin"| PROTO_RS["Protocol Decoder"]

    subgraph Sidecar ["Rust Sidecar"]
        PROTO_RS --> SESSION["Session + VAD"] --> WORKER["Inference: Whisper / Cohere"]
    end

    WORKER -->|"stdout"| CTRL["Session Controller"] --> EDITOR["Editor Insert"]
```

**Total codebase:** ~8,500 LOC TypeScript + ~6,600 LOC Rust = ~15,100 LOC

---

## Pipeline Stages

### Stage 1: Audio Capture

```mermaid
---
config:
  flowchart:
    nodeSpacing: 20
    rankSpacing: 25
    diagramPadding: 8
    wrappingWidth: 120
---
flowchart LR
    subgraph capture ["Audio Thread"]
        MIC["getUserMedia (mono)"] --> SRC["MediaStreamSource"] --> WORKLET["AudioWorklet: resample + quantize"]
    end

    WORKLET -->|"postMessage (640 B)"| MAIN

    subgraph transport ["Main Thread"]
        MAIN["Frame Listener"] --> ENCODE["Encode Binary Frame"] --> STDIN["stdin.write()"]
    end
```

**What it does:** Captures raw microphone audio, resamples to 16 kHz, quantizes to 16-bit PCM, and packages into fixed 640-byte frames at 50 fps.

**Key technology:**
- **Web Audio API** (AudioContext, AudioWorkletNode) -- browser-native audio processing
- **AudioWorklet** runs in a dedicated real-time audio thread, separate from the main thread
- **PcmFrameProcessor** performs linear interpolation resampling from the browser's native sample rate (44.1/48 kHz) down to 16 kHz

**PCM format (shared constants, identical in TS and Rust):**

| Parameter | Value |
|-----------|-------|
| Sample rate | 16,000 Hz |
| Channels | 1 (mono) |
| Bit depth | 16-bit signed LE (Int16) |
| Frame duration | 20 ms |
| Samples per frame | 320 |
| Bytes per frame | 640 |

**Inputs/outputs:** Microphone MediaStream in, 640-byte PCM frames out at 50 fps.

**Code weight:** ~410 LOC across 4 files (`audio-capture-stream.ts`, `pcm-frame-processor.ts`, `pcm-recorder.worklet.ts`, `pcm-format.ts`).

**Time cost:** ~3-6 ms AudioContext latency + 20 ms frame accumulation. Effectively real-time; this stage is never a bottleneck.

---

### Stage 2: Binary Protocol Transport

```mermaid
---
config:
  flowchart:
    nodeSpacing: 20
    rankSpacing: 25
    diagramPadding: 8
    wrappingWidth: 120
---
flowchart LR
    subgraph frame ["Frame Format"]
        KIND["kind: u8"] --- LEN["payload_len: u32 LE"] --- PAYLOAD["payload: bytes"]
    end
```

```mermaid
sequenceDiagram
    participant TS as TypeScript Plugin
    participant RS as Rust Sidecar

    Note over TS,RS: stdin (TS → Rust): Audio frames + JSON commands
    Note over TS,RS: stdout (Rust → TS): JSON event frames only

    TS->>RS: [0x02] Audio frame (640 bytes)
    TS->>RS: [0x02] Audio frame (640 bytes)
    TS->>RS: [0x01] JSON: start_session
    RS->>TS: [0x01] JSON: session_started
    RS->>TS: [0x01] JSON: session_state_changed
    TS->>RS: [0x02] Audio frame (640 bytes)
    RS->>TS: [0x01] JSON: transcript_ready
```

**What it does:** Multiplexes JSON commands/events and raw audio on a single bidirectional byte stream (stdin/stdout) using a 5-byte header framing protocol.

**Key technology:**
- **Node.js child_process.spawn** with `stdio: 'pipe'` -- the sidecar is a subprocess of Obsidian
- **Custom binary framing** (5-byte header: 1 byte kind + 4 byte LE length + payload) -- no HTTP, no WebSocket, no IPC library
- **FramedMessageParser** (TS) and **read_frame** (Rust) handle stream reassembly across chunk boundaries

**Frame direction rules:**
- `stdin` (TS → Rust): Both audio frames (`0x02`) and JSON command frames (`0x01`)
- `stdout` (Rust → TS): JSON event frames (`0x01`) only

**Commands (TS → Rust): 13 types**

| Command | Purpose |
|---------|---------|
| `health` | Liveness ping |
| `get_system_info` | Query compiled backends and runtime capabilities |
| `start_session` | Begin transcription (specifies model, mode, sessionId) |
| `stop_session` | Graceful stop (drain pending transcriptions) |
| `cancel_session` | Immediate cancel (discard pending) |
| `shutdown` | Request sidecar exit |
| `get_model_store` | Query model store path |
| `list_model_catalog` | Fetch built-in model catalog |
| `list_installed_models` | List locally installed models |
| `probe_model_selection` | Check if a model selection is usable |
| `install_model` | Start model download + install |
| `cancel_model_install` | Cancel a pending install |
| `remove_model` | Delete an installed model |

**Events (Rust → TS): 14 types**

| Event | Purpose |
|-------|---------|
| `health_ok` | Health reply with version |
| `system_info` | Backend/engine/capability matrix |
| `session_started` | Session confirmed active |
| `session_state_changed` | State machine transition |
| `transcript_ready` | Completed transcript with segments + timing |
| `session_stopped` | Session ended with reason |
| `warning` | Non-fatal warning |
| `error` | Fatal error |
| `model_store` | Model store path info |
| `model_catalog` | Full catalog payload |
| `installed_models` | Installed model list |
| `model_probe_result` | Model availability check result |
| `model_install_update` | Install progress updates |
| `model_removed` | Deletion confirmation |

**Code weight:** ~1,700 LOC TypeScript (`protocol.ts`, `sidecar-connection.ts`, `sidecar-process.ts`, logging/build-state) + ~655 LOC Rust (`protocol.rs`) = ~2,350 LOC total.

**Time cost:** Near-zero. Frame encoding/decoding is trivial. The main loop polls at 10 ms intervals. Total transport latency: < 1 ms per frame.

---

### Stage 3: Session Management + Speech Boundary Detection

```mermaid
stateDiagram-v2
    direction LR

    [*] --> Listening : start
    Listening --> SpeechDetected : min_speech frames above threshold
    SpeechDetected --> SpeechPaused : probability drops, silence accumulates
    SpeechPaused --> SpeechDetected : probability recovers
    SpeechPaused --> Listening : silence_end reached, utterance finalized
    SpeechDetected --> Listening : max length (boundary-aware split)
    Listening --> [*] : stop
    SpeechDetected --> [*] : stop + flush
    Listening --> Timeout : one_sentence timeout
```

**What it does:** Receives 20 ms PCM frames, runs voice activity detection on each frame, maintains a state machine to detect speech boundaries, and packages completed utterances for transcription.

**Key technology:**
- **Silero VAD** (ONNX model via `ort` crate) — returns a speech probability (0.0–1.0) for each 512-sample (32 ms) window. The detector buffers 320-sample (20 ms) pipeline frames internally, carries 64 samples of context forward, and threads a `[2, 1, 128]` RNN state across inferences
- **Preset-driven boundary state machine** in `session.rs` — the user picks a named `SpeakingStyle`; Rust owns the tuning table. Hysteresis (the negative threshold is 0.15 below the start threshold, floored at 0.05) plus a min-speech gate reject transients; a separate pending-end timer fires finalization

**Speaking-style presets (Rust-authoritative `VadTuning`):**

| Preset | `speech_threshold` | `min_speech_frames` | `silence_end_frames` | Pre-pad | Post-pad |
|---|---|---|---|---|---|
| Responsive | 0.40 | 3 (60 ms) | 20 (400 ms) | 2 (40 ms) | 2 (40 ms) |
| Balanced (default) | 0.50 | 5 (100 ms) | 50 (1000 ms) | 2 (40 ms) | 2 (40 ms) |
| Patient | 0.55 | 6 (120 ms) | 100 (2000 ms) | 2 (40 ms) | 2 (40 ms) |

The silence-window values are calibrated against industry streaming-dictation norms: `Responsive` (400 ms) matches AssemblyAI Streaming v2's legacy end-of-turn default, `Balanced` (1000 ms) matches AssemblyAI Universal-Streaming's `max_turn_silence` default and Deepgram's end-of-speech recommendation, and `Patient` (2000 ms) is near Azure dictation territory for long-form thinking pauses.

**Preset-independent constants:**

| Constant | Value | Duration | Purpose |
|---|---|---|---|
| `NEGATIVE_THRESHOLD_DELTA` | 0.15 | — | Gap between start and end probability thresholds (hysteresis) |
| `NEGATIVE_THRESHOLD_FLOOR` | 0.05 | — | Lower bound on the end threshold (defensive, prevents `< 0` for low-threshold presets) |
| `ONE_SENTENCE_TIMEOUT_FRAMES` | 500 | 10 s | No-speech timeout in one_sentence mode |
| `MAX_UTTERANCE_FRAMES` | 1500 | 30 s | Hard cap on utterance length |
| `BOUNDARY_STALENESS_CAP_FRAMES` | 250 | 5 s | A remembered silence boundary is discarded if this old when the cap fires |

**Finalization paths:**
1. **Natural end** — probability drops below the negative threshold, arming `pending_end_start`; when the gap reaches `silence_end_frames`, the utterance is trimmed to the pending-end frame plus `post_speech_pad_frames` and finalized.
2. **Boundary-aware split at cap** — at `MAX_UTTERANCE_FRAMES` (30 s), the session cuts at the most recent silence boundary (if within `BOUNDARY_STALENESS_CAP_FRAMES`) and keeps the tail running. If no usable boundary exists, it falls back to a hard cut.
3. **Graceful stop** — on user stop, any pending utterance is emitted before `SessionStopped`.

**Code weight:** ~730 LOC (`session.rs`) + ~240 LOC (`vad.rs`) + session management in `app.rs`.

**Time cost:** Silero ONNX inference runs once per ~32 ms window (~1 ms per call amortised across 20 ms frames). The perceived end-of-speech delay is the preset's `silence_end_frames`: 400 ms on Responsive, 1000 ms on Balanced, 2000 ms on Patient.

---

### Stage 4: Inference (Transcription)

```mermaid
flowchart LR
    subgraph Main Thread
        ENQUEUE["enqueue_utterance (i16 samples)"]
    end

    subgraph Worker Thread
        CMD["command_rx.recv()"] --> NORM["Normalize: i16 → f32"]
        NORM --> WHISPER["Whisper / Cohere Inference"]
        WHISPER --> SEG["Extract Segments"]
        SEG --> EVT["WorkerEvent::TranscriptReady"]
    end

    ENQUEUE -->|"mpsc channel"| CMD
    EVT -->|"mpsc channel"| DRAIN["drain_worker_events()"]
```

**What it does:** Runs the speech-to-text model on a completed utterance and produces timestamped text segments.

**Key technology:**

| Engine | Library | Model Format | Description |
|--------|---------|-------------|-------------|
| `whisper_cpp` | **whisper-rs** (Rust bindings to whisper.cpp) | GGML quantized `.bin` | OpenAI Whisper models, quantized for CPU/GPU |
| `cohere_onnx` | **ort** (ONNX Runtime for Rust) | ONNX | Cohere Transcribe 2B-param model |

**Whisper inference parameters:**
- Strategy: `Greedy { best_of: 0 }`
- Threads: `min(available_parallelism, 4)` with GPU, `min(available_parallelism, 8)` CPU-only
- Language: `"en"` (hardcoded, only English supported)
- Translate: `false`
- GPU: `use_gpu` and `flash_attn` both set from acceleration config
- Model caching: model context persists across utterances; reloads only on path or GPU config change

**Worker architecture:**
- Dedicated thread communicating via two `mpsc` channels (commands in, events out)
- All inference is **synchronous and blocking** in the worker thread
- Back-pressure: `MAX_QUEUED_UTTERANCES = 1`. If a transcription is in-flight and 1 is already queued, additional utterances are **dropped** with a warning event
- `pause_while_processing` setting (default `true`): discards incoming audio frames while the worker is busy, preventing unbounded queue growth
- Panic safety: `catch_unwind` wraps model loading and inference; panics produce `SessionError` events rather than crashing

**Available models:**

| Model | Engine | Quantization | Size | Notes |
|-------|--------|-------------|------|-------|
| Whisper Tiny EN | whisper_cpp | Q8_0 | 42 MB | Fastest, lowest quality |
| Whisper Base EN | whisper_cpp | Q8_0 | 78 MB | |
| Whisper Small EN | whisper_cpp | Q5_1 | 181 MB | Recommended starter |
| Whisper Medium EN | whisper_cpp | Q5_0 | 514 MB | |
| Whisper Large V3 Turbo | whisper_cpp | Q8_0 | 834 MB | Best with GPU |
| Cohere Transcribe FP16 | cohere_onnx | FP16 | 3.8 GB | 2B params, 14 languages |
| Cohere Transcribe INT8 | cohere_onnx | INT8 | 2.9 GB | |
| Cohere Transcribe Q4 | cohere_onnx | Q4 | 2.0 GB | |

**Code weight:** ~540 LOC (`worker.rs` 214 + `transcription.rs` 326) for whisper, ~846 LOC (`cohere.rs`) for Cohere, ~431 LOC (`mel.rs`) for audio preprocessing.

**Time cost: This is the bottleneck.** Inference time depends heavily on model size, hardware, and utterance length. The `processing_duration_ms` field in `transcript_ready` events tracks this. Typical ranges:

| Model | ~3s utterance | Hardware |
|-------|--------------|----------|
| Whisper Tiny | ~200-500 ms | CPU |
| Whisper Small | ~1-3 s | CPU |
| Whisper Small | ~200-500 ms | Metal/CUDA |
| Whisper Large V3 Turbo | ~2-5 s | Metal/CUDA |

During inference, the preset's silence window (400–2000 ms) is fully overlapped with model compute — on smaller models the user is typically still pausing when inference completes.

---

### Stage 5: Text Insertion

```mermaid
flowchart LR
    TR["transcript_ready event"] --> NORM["normalizeTranscriptText()"]
    NORM --> MODE{"insertionMode?"}
    MODE -->|insert_at_cursor| REPL["editor.replaceSelection()"]
    MODE -->|append_on_new_line| APPEND["append at EOF + newline"]
    MODE -->|append_as_new_paragraph| PARA["append at EOF + blank line"]
```

**What it does:** Takes the transcribed text string and inserts it into the active Obsidian editor according to the user's insertion mode preference.

**Key technology:**
- **Obsidian Editor API** (`MarkdownView.editor`) -- standard Obsidian text manipulation
- Three insertion modes: `insert_at_cursor` (default), `append_on_new_line`, `append_as_new_paragraph`

**Code weight:** ~155 LOC (`editor-service.ts` 55 + `transcript-placement.ts` 98).

**Time cost:** < 1 ms. Pure DOM/editor API call.

---

## Plugin Orchestration

### Listening Modes

| Mode | Behavior | Auto-stop |
|------|----------|-----------|
| `one_sentence` | Capture one utterance, transcribe, stop | Yes (after first transcript or 10 s timeout) |
| `always_on` | Continuous capture, transcribe every utterance | No (manual stop) |

### Ribbon UI States

| State | Icon | Tooltip |
|-------|------|---------|
| `idle` | mic | Click to start |
| `starting` | loader | Starting... |
| `listening` | audio-lines | Listening |
| `speech_detected` | audio-lines | Hearing speech |
| `speech_paused` | audio-lines | Hearing speech (paused) |
| `transcribing` | loader | Transcribing... |
| `paused` | loader | Processing... |
| `error` | mic-off | Error |

`speech_paused` fires when `frames_since_confident_speech >= silence_end_frames` *before* finalization runs on the same frame, so in today's flow it is only externally observable when the probability sits in the intermediate range (between the end and start thresholds) rather than true silence. See architectural seams below.

### Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `listeningMode` | `one_sentence` | Dictation trigger behavior |
| `insertionMode` | `insert_at_cursor` | Where transcript text lands |
| `speakingStyle` | `balanced` | UX preset driving the VAD tuning table (Responsive / Balanced / Patient) |
| `pauseWhileProcessing` | `true` | Discard audio during inference |
| `accelerationPreference` | `auto` | GPU vs CPU-only |
| `selectedModel` | `null` | Active model selection |
| `sidecarRequestTimeoutMs` | 300,000 (5 min) | Command/response timeout |
| `sidecarStartupTimeoutMs` | 4,000 (4 s) | Health check timeout on launch |
| `sidecarPathOverride` | `""` | Custom sidecar executable path |
| `modelStorePathOverride` | `""` | Custom model storage directory |
| `cudaLibraryPath` | `""` | Linux LD_LIBRARY_PATH for CUDA |
| `developerMode` | `false` | Verbose logging |

---

## Technology Reference

| Technology | What It Is | Role in System |
|------------|-----------|----------------|
| **Obsidian Plugin API** | Extension framework for the Obsidian note-taking app (Electron) | Host runtime; provides editor access, commands, settings, UI hooks |
| **Web Audio API / AudioWorklet** | Browser-native audio processing with real-time thread scheduling | Microphone capture and PCM frame production at 50 fps |
| **whisper-rs** | Rust bindings to whisper.cpp (C++ Whisper implementation) | Primary transcription engine; runs GGML-quantized Whisper models |
| **whisper.cpp** | C++ implementation of OpenAI's Whisper model | Underlying inference runtime; supports CPU, Metal, CUDA |
| **GGML** | Tensor library for quantized model inference on consumer hardware | Model format for Whisper; enables Q5/Q8 quantization for smaller files and faster inference |
| **ort (ONNX Runtime)** | Cross-platform ML inference runtime | Alternative engine for Cohere Transcribe models |
| **Silero VAD** | ONNX-based voice activity detection model | Returns speech probability (0.0–1.0) per 512-sample window; drives boundary detection with hysteresis |
| **Node.js child_process** | Process spawning in Node.js/Electron | Launches and manages the Rust sidecar as a subprocess |
| **reqwest** | Async HTTP client for Rust | Downloads model files from HuggingFace |
| **sha2** | SHA-256 implementation in Rust | Verifies downloaded model file integrity |

---

## Time Budget: End-to-End Pipeline

```mermaid
gantt
    title Typical utterance timeline (~3 s speech, Whisper Small, CPU)
    dateFormat X
    axisFormat %s s

    section Speaking
    User speaks           :a1, 0, 3000

    section Audio Capture
    Frame accumulation    :a2, 0, 3000

    section Transport
    Frames to sidecar     :a3, 20, 3000

    section VAD
    Per-frame VAD         :a4, 20, 3000

    section Silence Wait
    1000 ms silence detect (Balanced) :a5, 3000, 1000

    section Inference
    Whisper Small CPU     :crit, a6, 4000, 2000

    section Insert
    Text insertion        :a7, after a6, 10
```

**Where time is spent:**

| Stage | Wall-clock cost | % of total | Notes |
|-------|----------------|------------|-------|
| Audio capture + framing | ~20 ms latency | < 1% | Real-time, pipelined with speech |
| Protocol transport | < 1 ms per frame | < 1% | Trivial encoding/decoding |
| VAD + boundary detection | < 1 ms per inference | < 1% | Silero ONNX inference on buffered frames |
| **Silence detection wait** | **400–2000 ms (preset-dependent)** | **~15–40%** | User-perceptible; gap between speech ending and transcription starting. Balanced is 1000 ms, Responsive 400 ms, Patient 2000 ms |
| **Model inference** | **200 ms - 5 s** | **~85-90%** | The dominant cost; scales with model size and hardware |
| Text insertion | < 1 ms | < 1% | DOM operation |

---

## Code Weight by Area

| Area | TS LOC | Rust LOC | Total | % |
|------|--------|----------|-------|---|
| Audio capture | 410 | -- | 410 | 3% |
| Protocol + transport | 1,700 | 655 | 2,355 | 16% |
| Session + VAD + boundary | 468 | 865 | 1,333 | 9% |
| Inference engines | -- | 1,820 | 1,820 | 12% |
| Model management | 1,630 | 1,170 | 2,800 | 19% |
| Plugin orchestration + UI | 1,270 | -- | 1,270 | 8% |
| Settings + commands | 800 | -- | 800 | 5% |
| App state + glue | 290 | 1,475 | 1,765 | 12% |
| Tests | ~1,500 | -- | 1,500 | 10% |
| Build/config | ~900 | ~200 | 1,100 | 7% |
