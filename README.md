# Obsidian Local STT

Local, private speech-to-text for Obsidian. Transcription runs entirely on your machine — no accounts, no cloud, no telemetry.

## Features

- Streaming dictation directly into your notes
- Three listening modes: always-on, press-and-hold, and one-sentence
- Managed model catalog with one-click downloads (SHA-256 verified)
- Two local transcription engines: Whisper (mature, smaller models) and Cohere Transcribe (newer, higher quality, larger models, still experimental)
- Transcript placement at the cursor, end of note, or as a new paragraph
- Optional GPU acceleration where supported
- Works entirely offline after initial model download

## Design Principles

- **Desktop-first** — built for Obsidian on desktop operating systems
- **Privacy-first** — transcription stays on your machine; no accounts, no cloud, no telemetry
- **English-first** — optimized for English; other languages supported where engines allow
- **Offline after setup** — only model downloads require a network connection

## Quick Start

1. Clone this repo into `<vault>/.obsidian/plugins/obsidian-local-stt` and enable it in Obsidian's community plugins settings.
2. Open `Settings -> Local STT`.
3. Click `Browse models` and install a model — start with `Whisper Small English Q5_1` for a quick first test. The browser also includes Cohere Transcribe models if you want the higher-accuracy experimental path.
4. Open a note, click the microphone ribbon button or run `Local STT: Start Dictation Session`.
5. Talk. Text appears in your note.

## How It Works

An Obsidian plugin (TypeScript) handles the UI, settings, mic capture, and editor insertion. A native Rust sidecar handles audio processing, VAD, and Whisper and Cohere inference. They communicate over framed stdio IPC — the sidecar runs as a managed child process, no server or port binding.

## Commands

| Command | What it does |
|---|---|
| `Local STT: Start Dictation Session` | Begin transcribing |
| `Local STT: Stop Dictation Session` | Stop and finalize |
| `Local STT: Cancel Dictation Session` | Discard the current session |
| `Local STT: Check Sidecar Health` | Verify the sidecar is running |
| `Local STT: Restart Sidecar` | Restart the sidecar process |
| `Local STT: Press-And-Hold Gate` | Hotkey-only — hold to record, release to transcribe |

## GPU Acceleration

The default build is CPU-only and works everywhere. GPU acceleration is opt-in via a separate sidecar build.

| Platform | GPU | Notes |
|---|---|---|
| Windows | Planned | Runtime support is planned, but Windows is not yet tested or supported in this repo. |
| macOS | Metal | Whisper can use Metal. Cohere runs CPU-only on macOS and performs well there. |
| Linux native | CUDA | Whisper and Cohere can use CUDA when built with the CUDA sidecar. |
| Linux Flatpak | CUDA | Whisper and Cohere can use CUDA with manual overrides — see [Flatpak GPU setup](docs/linux-flatpak-gpu-setup.md) |

Engine/backend matrix: Whisper supports Metal on macOS and CUDA on Linux. Cohere supports CUDA on Linux only; on macOS it stays CPU-only, and there is no planned Metal/CoreML path.

Build the CUDA sidecar on Linux:

```sh
bash scripts/build-cuda.sh           # debug
bash scripts/build-cuda.sh --release # optimized
```

Then point `Settings -> Local STT -> Advanced -> Sidecar path override` to the CUDA binary. On Linux Flatpak, also set `CUDA library path` so the plugin scopes `LD_LIBRARY_PATH` to the sidecar child process only. `GPU acceleration` defaults to `Use when available`, which uses a working GPU backend when one is available for the selected engine.

## Development

### Toolchain

- Node.js `24.14.1`, npm `11.12.1`
- TypeScript `6.0.2`
- Rust `1.94.1`

Versions are pinned in `package.json` (`engines`, `packageManager`) and `rust-toolchain.toml`.

### Setup

```sh
npm install
cargo build --manifest-path native/sidecar/Cargo.toml
npm run dev
```

Symlink or clone this repo into `<vault>/.obsidian/plugins/obsidian-local-stt`, enable the plugin, and reload Obsidian after rebuilds.

### Build and Check

```sh
npm run build          # build sidecar + bundle plugin
npm run dev            # watch mode for plugin
npm run test           # TypeScript unit tests
npm run check          # full quality gates (TS + Rust)
```

## Versioning

Calendar versioning: `YYYY.M.D.patch` (e.g., `2026.4.11.0`).

## License

MIT. See [LICENSE](LICENSE).
