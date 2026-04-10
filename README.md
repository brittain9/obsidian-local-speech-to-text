# Obsidian Local STT

Desktop-only Obsidian plugin bootstrap for local speech-to-text with a Rust sidecar.

This repository is intentionally scoped to the project spine first:

- an Obsidian plugin at the repository root
- a native sidecar under `native/sidecar`
- versioned stdio JSON IPC between them
- a mock transcription command that inserts text into the active note

Real audio capture, model management, and Whisper inference come after this bootstrap path is stable.

## Architecture

```text
Obsidian plugin (TypeScript)
  -> manages settings, commands, editor insertion, sidecar lifecycle
  -> speaks line-delimited JSON over stdio

Rust sidecar
  -> validates protocol messages
  -> handles deterministic bootstrap commands
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
.github/workflows/    CI quality gates
```

## Local Development

If you use `mise`, run `mise install` first. This repository includes [`.mise.toml`](.mise.toml) for Node.js and Rust.

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

Bootstrap verification flow:

1. Open a Markdown note in the dev vault.
2. Run `Local STT: Check Sidecar Health`.
3. Run `Local STT: Insert Mock Transcript`.
4. Confirm the transcript text is inserted at the cursor.

## Commands

- `npm run build` bundles the plugin to `main.js`
- `npm run dev` watches and rebuilds the plugin
- `npm run test` runs TypeScript unit tests
- `npm run check` runs TypeScript and Rust quality gates
- `cargo run --manifest-path native/sidecar/Cargo.toml` runs the sidecar directly

## License

MIT. See [LICENSE](LICENSE).
