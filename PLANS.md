# Plan: Bootstrap The Obsidian Local STT Plugin

## Summary

Set up a clean, desktop-only Obsidian plugin repository with a Rust sidecar and a strict, low-friction development workflow.

This plan is intentionally scoped to bootstrap, not full STT delivery. The first milestone is:

- the plugin builds and loads in Obsidian
- the plugin spawns a native sidecar
- plugin and sidecar communicate over a versioned stdio protocol
- a command triggers a mock transcription flow
- the returned text is inserted into the active editor

That gives us a working vertical slice for process management, protocol design, note insertion, local development, and verification. Real audio capture, model download, and Whisper inference come after this spine is stable.

---

## Toolchain Baseline

Use current stable tooling and pin the project to it at bootstrap time.

### Project standard

- Node.js `24.14.1` LTS
- npm `11.12.1` (installed over the npm bundled with Node.js `24.14.1`)
- TypeScript `6.0.2`
- Rust `1.94.1` stable
- Cargo from Rust `1.94.1`

### Local machine status on 2026-04-10

- `node -v` -> `v24.12.0`
- `npm -v` -> `11.6.2`
- `rustc` -> not installed
- `cargo` -> not installed

### Pinning strategy

- Add `package.json` `engines` requiring Node `24.14.x`
- Commit a lockfile so JS dependencies are reproducible
- Add `rust-toolchain.toml` pinned to `1.94.1`
- Document the exact expected tool versions in `README.md`

Rationale:

- Node LTS is the right baseline for an Electron/Obsidian plugin
- npm is sufficient and avoids adding a second package manager dependency
- TypeScript should track the current stable compiler
- Rust should be pinned exactly because native sidecar reproducibility matters more than convenience

---

## Scope

### In scope for this bootstrap plan

- Repository initialization for an Obsidian desktop plugin
- TypeScript build, typecheck, lint, format, and test setup
- Rust sidecar crate setup with fmt, clippy, and tests
- Initial project structure with clear subsystem boundaries
- Versioned plugin-sidecar IPC contract
- Plugin command that inserts a mock transcript through the sidecar path
- Documentation for local development and release expectations
- Minimal CI for the bootstrap quality gates

### Explicitly out of scope for this bootstrap plan

- Real Whisper inference
- Model download and storage
- Real microphone capture
- Timestamp formatting beyond placeholder support
- GPU acceleration
- Cross-platform packaging of release binaries
- Community-plugin submission

---

## Architecture Decisions

### 1. Repo shape

Use one repository with the Obsidian plugin at the root and the Rust sidecar in a subdirectory.

Proposed layout:

```text
/
  src/
    main.ts
    commands/
    editor/
    settings/
    sidecar/
    ui/
  test/
  native/
    sidecar/
      Cargo.toml
      src/
      tests/
  scripts/
  manifest.json
  versions.json
  package.json
  package-lock.json
  tsconfig.json
  esbuild.config.mjs
  biome.json
  rust-toolchain.toml
  README.md
  LICENSE
  .gitignore
  .github/
    workflows/
```

Rationale:

- Obsidian expects plugin release artifacts at the repo root
- Keeping the sidecar under `native/sidecar` makes ownership explicit without overengineering a workspace
- This structure keeps future packaging and CI work straightforward

### 2. JavaScript toolchain

Use:

- TypeScript for source code
- esbuild for plugin bundling
- Vitest for unit tests on pure TypeScript logic
- Biome for formatting and linting

Rationale:

- esbuild matches the standard Obsidian plugin workflow and keeps build configuration small
- Vitest is fast, modern, and sufficient for protocol, settings, and formatting logic
- Biome replaces the ESLint + Prettier stack with one fast tool and less config overhead

### 3. Rust toolchain

Use:

- stable Rust `1.94.1`
- `serde` and `serde_json` for protocol types
- `anyhow` for application errors
- `cargo test`, `cargo fmt --check`, and `cargo clippy -- -D warnings`

Rationale:

- the sidecar needs a simple, explicit, dependable baseline
- `serde` is the obvious fit for line-delimited JSON messages
- bootstrap work should optimize for correctness and debuggability, not async sophistication

### 4. IPC contract

Use line-delimited JSON messages over stdio.

Initial protocol shape:

- request envelope: `id`, `type`, `payload`
- response envelope: `id`, `ok`, `payload | error`
- event envelope only if needed later; do not introduce it during bootstrap unless the implementation needs it

Initial command set:

- `health`
- `transcribe_mock`
- `shutdown`

Rationale:

- this is enough to prove process lifecycle and end-to-end behavior
- it avoids premature complexity around streaming, ports, or binary framing
- request IDs keep the protocol extensible even if commands become asynchronous later

### 5. Audio transport default

Do not implement real audio transport during bootstrap.

When audio capture work starts, default to:

- control messages over stdio JSON
- audio written to a temporary WAV file by the plugin
- sidecar receives a file path, not a base64 payload

Rationale:

- batch transcription does not need binary streaming on day one
- temp WAV files are easier to debug and test than large JSON payloads
- this avoids prematurely locking the protocol into an inefficient large-message path

### 6. Initial plugin UX

Bootstrap commands:

- `Check sidecar health`
- `Insert mock transcript`
- `Restart sidecar`

Bootstrap UI:

- one status bar item
- one settings tab with placeholder sections for sidecar path/version and future STT settings

Rationale:

- these surfaces are enough to exercise the plugin shell without building throwaway UI

---

## Implementation Plan

## Phase 0: Repo Bootstrap

### Deliverables

- initialize the repository structure
- add base docs and ignore files
- establish pinned toolchain metadata
- create the plugin and sidecar directories

### Concrete work

- Create `README.md` describing the project goal, architecture summary, and local dev workflow
- Add `.gitignore` covering Obsidian build artifacts, Node modules, Rust targets, temporary audio files, and release assets
- Add `LICENSE`
- Add `package.json` with scripts for build, dev, test, check, lint, and format
- Add `manifest.json` with `isDesktopOnly: true`
- Add `versions.json`
- Add `tsconfig.json` with strict settings
- Add `esbuild.config.mjs`
- Add `biome.json`
- Add `rust-toolchain.toml`
- Create `native/sidecar/Cargo.toml`

### Acceptance checks

- `npm install` succeeds
- `cargo` commands are possible once Rust is installed
- project structure is understandable from the root

## Phase 1: Obsidian Plugin Skeleton

### Deliverables

- plugin loads in Obsidian
- status bar item renders
- commands are registered
- active editor insertion works through a dedicated service

### Concrete work

- Create `src/main.ts` as a thin composition root
- Create `src/settings/plugin-settings.ts` for typed plugin settings and defaults
- Create `src/settings/settings-tab.ts` for the settings UI shell
- Create `src/ui/status-bar.ts` for plugin state display
- Create `src/editor/editor-service.ts` for active-editor lookup and text insertion
- Create `src/commands/register-commands.ts` for command registration
- Keep `main.ts` orchestration-only; no business logic in the plugin class

### Acceptance checks

- Obsidian loads the plugin without runtime errors
- command palette shows the bootstrap commands
- a direct plugin-only command can insert text into the active note

## Phase 2: Rust Sidecar Skeleton

### Deliverables

- sidecar builds and runs on the local machine
- sidecar accepts line-delimited JSON requests
- sidecar returns deterministic JSON responses

### Concrete work

- Create `native/sidecar/src/main.rs` as the binary entry point
- Create `native/sidecar/src/protocol.rs` for request/response structs
- Create `native/sidecar/src/app.rs` for command dispatch
- Implement `health`, `transcribe_mock`, and `shutdown`
- Emit structured stderr logging for local debugging
- Add unit tests for request parsing and response serialization

### Acceptance checks

- `cargo run --manifest-path native/sidecar/Cargo.toml` starts successfully
- sending a `health` request returns protocol version and sidecar version
- sending `transcribe_mock` returns deterministic transcript text

## Phase 3: Plugin-Sidecar Integration

### Deliverables

- plugin spawns the sidecar process
- plugin performs a startup health check
- plugin can send a mock transcription request and insert the response

### Concrete work

- Create `src/sidecar/sidecar-process.ts` for process spawn, shutdown, restart, and stderr capture
- Create `src/sidecar/sidecar-client.ts` for request/response handling over stdio
- Create `src/sidecar/protocol.ts` for the TypeScript protocol types
- Gate all Node/Electron imports behind desktop-only runtime boundaries even though `isDesktopOnly` is true
- Add user-facing error handling via `Notice`
- Add a small plugin state machine: `idle`, `starting`, `ready`, `error`

### Acceptance checks

- plugin startup performs a successful health handshake
- `Insert mock transcript` sends `transcribe_mock` to the sidecar
- returned text is inserted into the active editor at the cursor
- sidecar restart works from the command palette

## Phase 4: Verification, CI, and Developer Experience

### Deliverables

- local commands for build/test/check are stable
- CI enforces the same quality gates
- docs explain exactly how to run the bootstrap setup

### Concrete work

- Add `npm run build`
- Add `npm run dev`
- Add `npm run test`
- Add `npm run check` that runs TypeScript typecheck, Biome checks, and Rust checks
- Add `npm run format`
- Add a CI workflow that installs Node `24.14.1`, upgrades npm to `11.12.1`, installs Rust `1.94.1`, then runs the quality gates
- Document a recommended Obsidian dev-vault workflow in `README.md`

### Acceptance checks

- one command path exists for local verification
- CI and local verification run the same high-signal checks
- a new contributor can clone the repo and reach the mock transcript milestone by following the docs

---

## Initial File And Module Standards

### TypeScript

- Keep the plugin class thin
- Isolate Obsidian API usage behind focused modules
- Prefer plain objects and small classes over framework-like abstractions
- Use strict TypeScript with no `any`
- Keep editor, sidecar, and settings logic separate from UI wiring

### Rust

- Keep `main.rs` minimal
- Separate protocol types from command handling
- Avoid async runtime adoption until real work requires it
- Return structured errors with enough context for the plugin to display useful messages

### Cross-language boundary

- The IPC contract is a first-class interface
- Version the protocol from day one, even if it only has `v1`
- Keep message shapes small and explicit
- Add tests that lock the protocol shape on both sides

---

## Test Plan

### TypeScript

- Unit tests for editor insertion helper logic where possible
- Unit tests for protocol serialization/parsing helpers
- Unit tests for settings defaults and migration scaffolding
- Avoid brittle tests that depend on Obsidian internals unless there is no better seam

### Rust

- Unit tests for protocol parsing/serialization
- Unit tests for command dispatch
- Unit tests for deterministic `transcribe_mock` response behavior

### Integration

- Manual verification in an Obsidian dev vault:
  - enable plugin
  - check status bar state
  - run health check command
  - run mock transcript command
  - confirm text insertion into an active note

### Required verification gates before leaving bootstrap

- `npm run build`
- `npm run test`
- `npm run check`
- manual Obsidian smoke test

---

## Acceptance Criteria

Bootstrap is complete when all of the following are true:

- the repo has a clean, documented structure
- the plugin builds into `main.js` and loads in Obsidian
- the plugin is marked desktop-only
- the sidecar builds locally with pinned Rust
- plugin and sidecar complete a health handshake over stdio
- a plugin command inserts mock transcript text received from the sidecar
- local and CI verification are defined and passing

---

## Assumptions And Defaults

- This directory will be turned into a git repository before implementation begins
- The plugin root will remain the repository root
- npm is the package manager; no pnpm, bun, or yarn
- We optimize for a clean bootstrap on one primary development OS first, while keeping the structure cross-platform
- We will not implement real transcription until the plugin/sidecar spine is proven
- We will not implement downloader, model management, or audio capture in the same change as bootstrap

---

## Open Questions

These do not block bootstrap and should not delay implementation:

- Final public plugin name and plugin ID
- Whether the initial README should document BRAT beta distribution now or wait until the first usable build
- Whether the future audio pipeline should use temporary WAV files or a framed binary protocol after profiling

---

## Sources Used For Current Version Decisions

- Rust stable release announcements: `Rust 1.94.1` released March 26, 2026
- TypeScript official blog: `TypeScript 6.0` released March 23, 2026
- Node.js releases page: `Node.js 24.14.1` Active LTS as of March 24, 2026
- Obsidian sample plugin and manifest docs for plugin structure and release artifacts
