# Obsidian Local STT

Desktop-only Obsidian plugin for local speech-to-text in Obsidian with a Rust sidecar.

Current working path:

- an Obsidian plugin at the repository root
- a native sidecar under `native/sidecar`
- versioned framed stdio IPC between them
- microphone capture in the plugin
- streaming `16 kHz` mono `PCM16` audio from the plugin to the sidecar
- session-based dictation with always-on, press-and-hold, and one-sentence modes
- local CPU Whisper transcription in the sidecar
- configurable transcript placement at the cursor or the end of the note

## Architecture

```text
Obsidian plugin (TypeScript)
  -> manages settings, commands, ribbon/state UX, microphone capture, and editor insertion
  -> streams framed JSON control messages and binary PCM audio over stdio

Rust sidecar
  -> validates framed protocol messages
  -> owns listening-session state, VAD, utterance segmentation, and queueing
  -> resolves managed catalog installs or explicit external files into a runtime model path
  -> transcribes finalized in-memory utterances with whisper-rs
  -> emits asynchronous session and transcript events back to the plugin
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
- rebuild the sidecar executable with `cargo build --manifest-path native/sidecar/Cargo.toml` after Rust changes if you are only running `npm run dev`

Local note:

- `data.json` in the plugin directory is Obsidian runtime state, not checked-in source configuration

## Manual Verification

Managed models are now the primary path. The plugin ships a bundled model catalog, verifies downloads with `SHA-256`, and stores managed installs in a shared sidecar-owned model store. External `whisper.cpp`-compatible model files remain available as an explicit advanced fallback.

For the first end-to-end verification in this repository, use the bundled smaller English model first, then move up to the larger Turbo model after the full flow works. Bundled first-pass model:

- `Whisper Small English Q5_1`

Bundled follow-up model:

- `Whisper Large V3 Turbo Q8_0`

Managed-model verification flow:

1. Open a Markdown note in the dev vault.
2. Open `Settings -> Local STT`.
3. Confirm the `Current model` card shows `No model selected`.
4. Click `Browse models`.
5. Start an install for `Whisper Small English Q5_1`.
6. Wait for the install to complete, then select it.
7. Set `Listening mode` to `One sentence` for the simplest first pass.
8. Leave `Pause while processing` enabled for the first CPU verification pass.
9. Optionally set `Sidecar path override` if the debug sidecar is not at `native/sidecar/target/debug`.
10. Run `Local STT: Check Sidecar Health`.
11. Set `Transcript placement` to `Insert at cursor`.
12. Click the microphone ribbon button or run `Local STT: Start Dictation Session`.
13. Speak one short sentence.
14. Confirm the transcript replaces the current selection or inserts at the caret and the session returns to idle automatically.

External-file fallback verification:

1. Open `Settings -> Local STT`.
2. Click `Use external file`.
3. Enter an absolute `whisper.cpp`-compatible model file path.
4. Click `Validate and use`.
5. Confirm the `Current model` card shows `External file` as the source and resolves the configured path.

Append placement verification:

1. Set `Transcript placement` to `Append on a new line`.
2. Put the caret somewhere in the middle of an existing note and select some text.
3. Run another one-sentence dictation.
4. Confirm the transcript is appended at the note end, not at the selection, with exactly one newline before it.
5. Set `Transcript placement` to `Append as a new paragraph`.
6. Run another one-sentence dictation.
7. Confirm the transcript is appended at the note end with exactly one blank line before it.
8. Confirm placement changes do not add punctuation or capitalization beyond the raw transcript text.

For press-and-hold verification:

1. Set `Listening mode` to `Press and hold`.
2. Assign a hotkey to `Local STT: Press-And-Hold Gate` in Obsidian Hotkeys if you want keyboard gating. This hotkey target does not appear in the command palette.
3. Hold the ribbon button or the configured hotkey while speaking.
4. Release it and confirm the buffered utterance is transcribed and inserted.

## Commands

- `npm run build` builds the debug sidecar executable and bundles the plugin to `main.js`
- `npm run dev` watches and rebuilds the plugin
- `npm run test` runs TypeScript unit tests
- `npm run check` runs TypeScript and Rust quality gates
- `cargo run --manifest-path native/sidecar/Cargo.toml` runs the sidecar directly

Available command palette actions:

- `Local STT: Start Dictation Session`
- `Local STT: Stop Dictation Session`
- `Local STT: Cancel Dictation Session`
- `Local STT: Check Sidecar Health`
- `Local STT: Restart Sidecar`

Hotkey-only command target:

- `Local STT: Press-And-Hold Gate`

## License

MIT. See [LICENSE](LICENSE).
