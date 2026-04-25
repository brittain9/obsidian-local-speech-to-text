# Local Transcript

Run cutting-edge local transcription directly in Obsidian. Choose between Cohere Transcribe, a new best-in-class model, and Whisper, a well-known standard for offline speech recognition.

## Features
- **Cross-platform design** — built for desktop Obsidian on macOS, Linux, and Windows.
- **Cohere Transcribe support** — use a [Hugging Face Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)-topping speech recognition model directly inside Obsidian.
- **Whisper support** — choose a mature offline transcription model with a wide range of size and performance options.
- **Silero v6 voice activity detection** — [enterprise-grade neural VAD](https://github.com/snakers4/silero-vad) for accurate, real-time speech boundary detection.
- **One-click model management** — browse, download, and remove models from inside the plugin.
- **Hardware acceleration** — supports Metal on macOS and CUDA on Linux/Windows with Turing-or-newer NVIDIA GPUs.
- **Obsidian-native experience** — integrates cleanly with the app through native settings, commands, and interface elements.
- **English-first** — optimized for English; other languages supported where engines allow
- **Privacy-first** — transcription happens locally, with no cloud processing, no telemetry, and no account required for model downloads.
- **Offline after setup** — only model downloads require a network connection

## Platform Support

| Platform | Support Status | Hardware Acceleration |
|---|---|---|
| macOS | Supported | Metal support for Whisper. |
| Linux Native | Supported | CUDA support for Whisper and Cohere on Turing-or-newer NVIDIA GPUs. |
| Linux Flatpak | Supported | CUDA supported on Turing-or-newer NVIDIA GPUs - [Flatpak GPU setup](docs/guides/linux-flatpak-gpu-setup.md). |
| Windows | Supported | CUDA support for Whisper and Cohere on Turing-or-newer NVIDIA GPUs. [Windows CUDA setup](docs/guides/windows-cuda-setup.md). |

## Runtime Dependencies

The CPU sidecar has no GPU runtime dependencies. On macOS, Whisper can use Metal through system frameworks; CUDA, cuDNN, and the CUDA Toolkit are not required.

Linux and Windows CUDA acceleration requires an NVIDIA Turing-generation or newer GPU, meaning compute capability 7.5 or newer. In consumer GPU terms, that means RTX 20-series / GTX 16-series or newer. CUDA release archives bundle the CUDA runtime libraries used by Whisper CUDA, so release users do not need to install the CUDA Toolkit or `nvcc`.

Use an NVIDIA driver compatible with CUDA 12.9. NVIDIA's CUDA 12.9 release notes list Linux driver 575.51.03+ and Windows driver 576.02+ as the toolkit release baseline. Cohere CUDA additionally requires cuDNN 9 runtime libraries; when cuDNN is not available, Cohere falls back to CPU with an explicit runtime status.

For the full platform contract, see [Platform Runtime Dependencies](docs/release/platform-runtime-dependencies.md). NVIDIA references: [CUDA 12.9 release notes](https://docs.nvidia.com/cuda/archive/12.9.0/cuda-toolkit-release-notes/index.html) and [CUDA GPU compute capability](https://developer.nvidia.com/cuda-gpus).

## Quick Start

### Users

The community-plugin package contains only Obsidian's three plugin files:

- `main.js`
- `manifest.json`
- `styles.css`

After those files are installed, open `Settings -> Local Transcript` and install the sidecar from the plugin settings. The plugin downloads the sidecar archive from the GitHub Release matching its own `manifest.version`, verifies it, and stores it under the plugin's `bin/` directory. Then click `Manage models`, install a model, open a note, and start dictation from the ribbon button or `Local Transcript: Start Dictation Session`.

The sidecar and model downloads are separate on purpose: Obsidian installs the plugin UI, the plugin installs the native sidecar, and the sidecar manages model downloads. Transcription runs locally after setup.

### Manual Release Install

For manual testing of a published release, download these files from the same GitHub Release tag and place them in `<vault>/.obsidian/plugins/local-transcript/`:

```text
main.js
manifest.json
styles.css
```

Restart Obsidian or reload plugins, enable `Local Transcript`, then use the settings page to download the sidecar and models.

Do not mix plugin files from one version with sidecar assets from another version. Sidecar downloads are version-locked to `manifest.version`, not to the latest GitHub Release.

## Development

### Prerequisites

- Node.js `24.14.1`, npm `11.12.1`
- TypeScript `6.0.2`
- Rust `1.94.1`
- CMake and a platform C/C++ toolchain for native sidecar builds
- CUDA Toolkit `12.9` with `nvcc` for Linux/Windows CUDA sidecar builds only
- cuDNN `9.x` runtime libraries for local Cohere CUDA verification only

Versions are pinned in `package.json` (`engines`, `packageManager`) and `rust-toolchain.toml`. If you use [mise](https://mise.jdx.dev), `mise install` will set up the Node and Rust toolchains automatically.

The CUDA Toolkit is a build-from-source dependency. Published Linux/Windows CUDA sidecar archives bundle the CUDA runtime libraries needed by Whisper CUDA; release users need only a Turing-or-newer NVIDIA GPU and a compatible NVIDIA driver. Cohere CUDA additionally needs cuDNN `9.x` runtime libraries installed until cuDNN redistribution is reviewed.

### Project Structure

The plugin has two runtime boundaries: a TypeScript Obsidian plugin in `src/` and a Rust native sidecar in `native/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details.

### Setup

Install dependencies:

```sh
npm install
```

For fast frontend iteration, symlink or clone this repo into `<vault>/.obsidian/plugins/local-transcript`, run watch mode, and reload Obsidian after rebuilds:

```sh
npm run build:sidecar
npm run dev
```

For release-style local testing without cutting a GitHub Release, build the output and copy it into a test vault:

```sh
npm run build:frontend
npm run build:sidecar
npm run install:dev -- --vault ~/Documents/test-vault-stt --sidecars --enable
```

This installs the built `main.js`, `manifest.json`, and `styles.css` into the vault. With `--sidecars`, it also copies locally built sidecars into the plugin-local `bin/cpu` and `bin/cuda` layout. That lets you test the installed-plugin path without publishing a GitHub Release first.

For Linux CUDA testing:

```sh
npm run build:frontend
npm run build:sidecar
npm run build:sidecar:cuda
npm run install:dev -- --vault ~/Documents/test-vault-stt --sidecars --enable
```

For macOS testing, `npm run build:sidecar` builds the Metal-capable sidecar automatically.

### Scripts

**Build:**
```sh
npm run build            # build sidecar + bundle plugin
npm run build:frontend   # bundle plugin only (skip sidecar rebuild)
npm run build:sidecar    # build sidecar only
npm run build:sidecar:cuda            # Linux CUDA sidecar
npm run build:sidecar:cuda:windows    # Windows CUDA sidecar
npm run dev              # watch mode for plugin
npm run install:dev -- --vault <vault> --sidecars --enable
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
