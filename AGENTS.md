# Repository Guide

## Goal

Build a desktop-first Obsidian plugin for private, local speech-to-text.

The product direction is inspired by Speech Note (`dsnote`) on Linux, but this repository is intentionally narrower and more portable:

- Obsidian is the host editor and note-taking environment
- speech-to-text is the core feature
- transcription stays local after setup
- no accounts, no cloud dependency, no telemetry
- cross-platform desktop matters more than OS-specific integration tricks

This project exists because Speech Note is strong on privacy and local inference, but it is Linux-specific and tied to platform-specific integration choices such as D-Bus. The goal here is to preserve the privacy and speed benefits while moving the editing workflow into Obsidian and keeping the architecture cross-platform.

## Product Scope

Current product intent:

- desktop-only first
- English-first first
- high-ROI local STT models first
- CPU support first, GPU acceleration later
- in-app model explorer and model downloads
- configurable note insertion behavior

High-value insertion behaviors:

- insert at cursor
- append as a new line
- append to the end of the current line or note

Explicit non-goals for bootstrap and early v1:

- translation
- text-to-speech
- global OS dictation
- D-Bus or platform-specific service integration
- mobile support in the first implementation pass

## Architecture

The repository is split into two runtime boundaries:

- root Obsidian plugin in TypeScript
- native sidecar in Rust under `native/sidecar`

Current architectural rules:

- the plugin owns Obsidian UX, commands, settings, editor insertion, and audio capture
- the sidecar owns inference, model operations, and native process concerns
- plugin-to-sidecar communication uses versioned line-delimited JSON over stdio
- v1 is CPU-first and desktop-only
- GPU work must layer onto the same boundary instead of reshaping the design

## Working Rules

Preserve these constraints when making changes:

- keep the plugin class thin and push logic into focused modules
- keep the IPC contract explicit and versioned
- do not introduce Linux-only assumptions into the product design
- do not add cloud auth, telemetry, or account dependencies
- do not broaden scope into translation or TTS because dsnote has them
- prefer simple, debuggable batch flows over premature streaming complexity

## Toolchain

Pinned baseline:

- Node.js `24.14.1`
- npm `11.12.1`
- TypeScript `6.0.2`
- Rust `1.94.1`

Use `mise` for the primary toolchain install path in this repository.

## Setup

Preferred local bootstrap:

```bash
mise install
npm install --global npm@11.12.1
npm install
cargo build --manifest-path native/sidecar/Cargo.toml
```

Local development loop:

```bash
npm run dev
npm run test
npm run check
```

Recommended Obsidian workflow:

- use a dedicated dev vault
- place or symlink this repository at `<vault>/.obsidian/plugins/obsidian-local-stt`
- build the Rust debug sidecar locally
- use the plugin settings tab to override the sidecar path if needed

## Current Milestone

The current repository milestone is the first real dictation path.

This milestone is considered healthy when all of the following work:

- the plugin builds to `main.js`
- Obsidian loads the plugin cleanly
- the plugin can spawn the Rust sidecar
- the sidecar responds to a health check over stdio
- the plugin can record microphone audio to a temp WAV file
- the sidecar can transcribe that WAV with a local Whisper model
- the transcript is inserted into the active note at the cursor

Model management is still manual in this milestone. Use a local whisper.cpp-compatible model file path in plugin settings, keep CPU inference as the default path, and layer later work such as model downloads and GPU acceleration onto the existing boundary.
