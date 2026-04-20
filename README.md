# Local Transcript

Run cutting-edge local transcription directly in Obsidian. Choose between Cohere Transcribe, a new best-in-class model, and Whisper, a well-known standard for offline speech recognition.

## Features
- **Cross-platform design** — built for desktop Obsidian on macOS, Linux, and Windows, with Windows support planned for a later release.
- **Cohere Transcribe support** — use a [Hugging Face Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)-topping speech recognition model directly inside Obsidian.
- **Whisper support** — choose a mature offline transcription model with a wide range of size and performance options.
- **Silero v6 voice activity detection** — [enterprise-grade neural VAD](https://github.com/snakers4/silero-vad) for accurate, real-time speech boundary detection.
- **One-click model management** — browse, download, and remove models from inside the plugin.
- **Hardware acceleration** — supports Metal on macOS and CUDA on Linux, with Windows hardware acceleration planned alongside Windows support.
- **Obsidian-native experience** — integrates cleanly with the app through native settings, commands, and interface elements.
- **English-first** — optimized for English; other languages supported where engines allow
- **Privacy-first** — transcription happens locally, with no cloud processing, no telemetry, and no account required for model downloads.
- **Offline after setup** — only model downloads require a network connection

## Platform Support

| Platform | Support Status | Hardware Acceleration |
|---|---|---|
| macOS | Supported | Metal support for Whisper. |
| Linux Native | Supported | CUDA support for Whisper and Cohere. |
| Linux Flatpak | Supported | CUDA supported - [Flatpak GPU setup](docs/guides/linux-flatpak-gpu-setup.md). |
| Windows | Planned | Not supported yet. |

## Quick Start

1. Clone this repo into `<vault>/.obsidian/plugins/local-transcript` and enable it in Obsidian's community plugins settings.
2. Open `Settings -> Local Transcript`.
3. Click `Manage models` and install a model.
4. Open a note, click the microphone ribbon button or run `Local Transcript: Start Dictation Session`.
5. Talk. Text appears in your note.

## Development

### Prerequisites

- Node.js `24.14.1`, npm `11.12.1`
- TypeScript `6.0.2`
- Rust `1.94.1`

Versions are pinned in `package.json` (`engines`, `packageManager`) and `rust-toolchain.toml`. If you use [mise](https://mise.jdx.dev), `mise install` will set up the correct toolchain automatically.

### Project Structure

The plugin has two runtime boundaries: a TypeScript Obsidian plugin in `src/` and a Rust native sidecar in `native/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details.

### Setup

```sh
npm install
npm run build:sidecar
npm run dev
```

Symlink or clone this repo into `<vault>/.obsidian/plugins/local-transcript`, enable the plugin, and reload Obsidian after rebuilds.

### Scripts

**Build:**
```sh
npm run build            # build sidecar + bundle plugin
npm run build:frontend   # bundle plugin only (skip sidecar rebuild)
npm run build:sidecar    # build sidecar only
npm run dev              # watch mode for plugin
```

**Test and check:**
```sh
npm run test             # TypeScript unit tests
npm run typecheck        # type checking
npm run lint             # Biome linting
npm run check            # full quality gate (TS + Rust)
```

`npm run check` is the gate that must pass before a PR.

**Format:**
```sh
npm run format           # auto-format with Biome
```

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branching conventions, PR workflow, and architecture overview.

## License

MIT. See [LICENSE](LICENSE).