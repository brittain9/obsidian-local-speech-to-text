# Obsidian Local STT

Desktop-only Obsidian plugin for local speech-to-text in Obsidian with a Rust sidecar.

Current working path:

- an Obsidian plugin at the repository root
- a native sidecar under `native/sidecar`
- versioned stdio JSON IPC between them
- microphone capture in the plugin
- local CPU Whisper transcription in the sidecar
- transcript insertion at the active cursor position

## Architecture

```text
Obsidian plugin (TypeScript)
  -> manages settings, commands, ribbon/state UX, microphone capture, temp WAV files
  -> speaks line-delimited JSON over stdio

Rust sidecar
  -> validates protocol messages
  -> loads a whisper.cpp-compatible model file
  -> validates WAV input
  -> runs CPU transcription with whisper-rs
  -> returns structured responses to the plugin
```

## Toolchain

Project baseline:

- Node.js `24.14.1`
- npm `11.12.1`
- TypeScript `6.0.2`
- Rust `1.94.1`

Pinning:

- `package.json` `engines` and `packageManager`
- `rust-toolchain.toml`
- lockfiles for JavaScript and Rust once dependencies are installed

## Repository Layout

```text
src/                  Obsidian plugin source
test/                 TypeScript unit tests
native/sidecar/       Rust sidecar crate
```

## Local Development

1. Install Node.js `24.14.1`.
2. Upgrade npm to `11.12.1` with `npm install --global npm@11.12.1`.
3. Install Rust `1.94.1`.
4. Run `npm install`.
5. Build the sidecar with `cargo build --manifest-path native/sidecar/Cargo.toml`.
6. Run `npm run dev` for the plugin bundle watcher.
7. Point an Obsidian dev vault plugin directory at this repository.

Recommended dev-vault workflow:

- create a dedicated vault for plugin development
- place this repository at `<vault>/.obsidian/plugins/obsidian-local-stt`, or symlink it there
- enable the plugin from Obsidian's community plugin screen
- use the settings tab to override the sidecar path if your debug binary is not at the default location
- reload or restart Obsidian after rebuilding the plugin bundle so it picks up the current `main.js`

Local note:

- `data.json` in the plugin directory is Obsidian runtime state, not checked-in source configuration

## Real Smoke Test

This implementation expects a `whisper.cpp`-compatible model file, not the raw Hugging Face `safetensors` checkpoint.

For the first real smoke test in this repository, use a smaller English model first, then move up to `large-v3-turbo` after the end-to-end path works. Recommended first-pass model:

- Linux: `~/.local/share/obsidian-local-stt-dev/models/ggml-small.en-q5_1.bin`
- macOS: `~/Library/Application Support/obsidian-local-stt-dev/models/ggml-small.en-q5_1.bin`
- Windows: `%APPDATA%\obsidian-local-stt-dev\models\ggml-small.en-q5_1.bin`

You can switch to a converted `large-v3-turbo` model file afterward, such as:

- Linux: `~/.local/share/obsidian-local-stt-dev/models/ggml-large-v3-turbo.bin`
- macOS: `~/Library/Application Support/obsidian-local-stt-dev/models/ggml-large-v3-turbo.bin`
- Windows: `%APPDATA%\obsidian-local-stt-dev\models\ggml-large-v3-turbo.bin`

Minimal verification flow:

1. Open a Markdown note in the dev vault.
2. Open `Settings -> Local STT`.
3. Set `Whisper model file path` to your local `ggml-small.en-q5_1.bin`.
4. Optionally set `Sidecar path override` if the debug sidecar is not at `native/sidecar/target/debug`.
5. Run `Local STT: Check Sidecar Health`.
6. Click the microphone ribbon button or run `Local STT: Start Dictation`.
7. Speak for 5 to 10 seconds.
8. Click the ribbon button again or run `Local STT: Stop And Transcribe`.
9. Confirm the transcript text is inserted at the cursor.
10. Only after that passes, switch to `ggml-large-v3-turbo-*` and allow a much longer CPU transcription time.

## Commands

- `npm run build` bundles the plugin to `main.js`
- `npm run dev` watches and rebuilds the plugin
- `npm run test` runs TypeScript unit tests
- `npm run check` runs TypeScript and Rust quality gates
- `cargo run --manifest-path native/sidecar/Cargo.toml` runs the sidecar directly

Available plugin commands:

- `Local STT: Start Dictation`
- `Local STT: Stop And Transcribe`
- `Local STT: Cancel Dictation`
- `Local STT: Check Sidecar Health`
- `Local STT: Restart Sidecar`

## License

MIT. See [LICENSE](LICENSE).
