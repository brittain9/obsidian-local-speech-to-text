# Plan: Stabilize The Dictation Smoke Test And Remove Current Failure Modes

## Summary

The current repository is close to a usable first dictation loop, but four issues are blocking or weakening it:

- the sidecar launch path regressed in the shipped bundle because runtime `import('node:...')` does not work under Obsidian's `app://` renderer
- `tempAudioDirectoryOverride` can be persisted as a file path, and the current local `data.json` does exactly that
- the default transcription timeout is far too short for realistic CPU Whisper runs
- microphone capture still uses deprecated `ScriptProcessorNode`

This plan fixes those issues at the source instead of papering over them. The target outcome is a clean local smoke test:

1. Obsidian loads the plugin.
2. The sidecar health check succeeds.
3. Start dictation records microphone audio.
4. Stop writes a temp WAV, transcribes it locally, and inserts text at the cursor.
5. The plugin surfaces actionable errors for bad configuration instead of silently failing.

## Current Observations

- The source tree already uses static Node imports in [src/main.ts](/home/Alex/Projects/new/src/main.ts) and [src/sidecar/sidecar-process.ts](/home/Alex/Projects/new/src/sidecar/sidecar-process.ts), and the built [main.js](/home/Alex/Projects/new/main.js) now emits `require("node:child_process")`, not dynamic `import('node:child_process')`.
- The runtime error the user saw came from a stale Obsidian-loaded bundle, not from the current source tree.
- The repo-local [data.json](/home/Alex/Projects/new/data.json) contains an invalid `tempAudioDirectoryOverride` that points at the sidecar binary path.
- [data.json](/home/Alex/Projects/new/data.json) is untracked runtime state and should not live as source input for this repo.
- [src/settings/plugin-settings.ts](/home/Alex/Projects/new/src/settings/plugin-settings.ts) still defaults `sidecarRequestTimeoutMs` to `10000`.
- [src/audio/microphone-recorder.ts](/home/Alex/Projects/new/src/audio/microphone-recorder.ts) still uses `createScriptProcessor`.

## Decisions

### 1. Keep the current sidecar architecture and close the launch regression properly

Do not redesign the plugin/sidecar boundary. The correct fix is:

- keep static imports for all Node modules used in the Obsidian bundle
- add an automated regression check against the emitted `main.js`
- require a manual Obsidian restart or plugin reload in the smoke-test checklist after rebuilds

This treats the CORS problem as a bundling regression, not as an architecture problem.

### 2. Treat `data.json` as local runtime state, not repository source

`data.json` should not be tracked or relied on as part of the codebase. The implementation should:

- add `data.json` to `.gitignore`
- keep the repo clean even when the plugin is symlinked into a dev vault
- document that `data.json` is local Obsidian plugin state

This prevents future debugging sessions from confusing local runtime settings with committed source.

### 3. Fix invalid temp-directory settings with validation plus deterministic migration

The plugin should not accept a file path where a directory is required.

Implementation choice:

- on plugin load, normalize persisted settings
- if `tempAudioDirectoryOverride` points to an existing file, clear the override and persist the corrected settings
- when a non-empty override is used at runtime, validate that it resolves to a directory path or a creatable directory path
- if validation fails, surface a direct error message that names the bad setting

This is a real settings migration, not a silent fallback branch.

### 4. Raise the default transcription timeout to a CPU-realistic baseline

Set the default `sidecarRequestTimeoutMs` to `300000`.

Rationale:

- startup health already has its own shorter timeout
- the request timeout is effectively the transcription timeout
- even `small.en` can exceed `10000` on slower CPUs or longer clips
- `large-v3-turbo` on CPU can take much longer

The UI should describe this as transcription time, even if the persisted field name stays the same for now.

### 5. Replace `ScriptProcessorNode` with `AudioWorklet`

Do not keep the deprecated capture path.

Implementation choice:

- add a dedicated recorder worklet asset
- load it explicitly from the plugin directory
- collect PCM chunks over the worklet message port
- keep the current WAV/downsample pipeline after capture

If `AudioWorklet` is unavailable, fail with a direct runtime error instead of falling back to deprecated behavior.

## Implementation Plan

### Phase 1: Sidecar launch hardening and repo hygiene

- Keep the existing static Node imports in the plugin runtime modules.
- Add a build-output verification step that fails if emitted `main.js` contains dynamic `import('node:` or `import("node:`.
- Add `data.json` to `.gitignore`.
- Remove any expectation in docs that repo-root `data.json` is source-controlled configuration.
- Update the smoke-test steps to require a rebuild plus Obsidian reload after bundle changes.

Acceptance checks:

- `npm run build` succeeds.
- The build verification step passes.
- `rg "import\\(['\\\"]node:" main.js` returns no matches.
- Manual Obsidian health check no longer hits the CORS error.

### Phase 2: Settings normalization and validation

- Introduce a settings normalization layer for persisted plugin data.
- Add explicit validation helpers for:
  - `tempAudioDirectoryOverride`
  - `sidecarPathOverride`
  - `modelFilePath` existence checks where appropriate at point of use
- On load:
  - if `tempAudioDirectoryOverride` is an existing file, clear it
  - persist the corrected settings once
- At runtime:
  - reject invalid temp-directory paths with a direct error such as `Temp audio directory override must be a directory, not a file.`
- Tighten the settings tab copy so it clearly distinguishes:
  - model file path
  - temp audio directory
  - sidecar executable path

Acceptance checks:

- A persisted file path in `tempAudioDirectoryOverride` is corrected on load.
- Stop/transcribe no longer fails because the temp audio path points at the sidecar binary.
- A user entering a bad temp path gets an actionable notice.

### Phase 3: Timeout fix for CPU transcription

- Change the default `sidecarRequestTimeoutMs` from `10000` to `300000`.
- Update the settings label/description to make clear this governs transcription latency, not sidecar startup.
- Keep `sidecarStartupTimeoutMs` separate and short.
- Verify the dictation flow does not fail early on `small.en` and is at least plausible for `large-v3-turbo`.

Acceptance checks:

- Default settings resolve to `300000` for `sidecarRequestTimeoutMs`.
- Existing tests cover the new default.
- Manual dictation no longer times out immediately on CPU transcription.

### Phase 4: Audio capture replacement with `AudioWorklet`

- Add a recorder worklet module under `src/audio/`.
- Extend the build to emit the worklet asset into the plugin directory.
- Update [src/audio/microphone-recorder.ts](/home/Alex/Projects/new/src/audio/microphone-recorder.ts) to:
  - create an `AudioContext`
  - load the worklet module
  - capture audio frames through an `AudioWorkletNode`
  - collect chunk messages into the existing PCM aggregation flow
  - dispose the worklet cleanly on stop/cancel
- Keep WAV encoding, mono normalization, and downsampling in the existing pipeline unless refactoring is required for clarity.
- Fail explicitly if `audioContext.audioWorklet` is unavailable.

Acceptance checks:

- Obsidian no longer logs the `ScriptProcessorNode` deprecation warning during dictation.
- A short recording produces non-empty PCM data.
- Stop/transcribe writes a WAV file and proceeds into sidecar transcription.

### Phase 5: Tests and documentation

- Add unit coverage for settings normalization and invalid-path correction.
- Add unit coverage for temp audio directory resolution:
  - default temp dir
  - override directory creation
  - existing file path rejection
- Add a regression check for the emitted bundle so the `node:` dynamic-import bug cannot re-enter unnoticed.
- Update [README.md](/home/Alex/Projects/new/README.md) with:
  - `data.json` as local runtime state
  - the corrected smoke-test steps
  - a recommendation to use `ggml-small.en-*` for CPU smoke testing
  - a note that `large-v3-turbo` is valid but much slower on CPU

Acceptance checks:

- `npm run test` passes with the new coverage.
- `npm run check` passes.
- The manual smoke-test instructions match the actual runtime behavior.

## Public Interface And Workflow Changes

- `sidecarRequestTimeoutMs` default changes from `10000` to `300000`.
- The settings UI copy changes to clarify that the temp audio setting is a directory and the sidecar setting is an executable file path.
- `data.json` becomes explicitly local-only and ignored by git.
- The audio capture backend changes from `ScriptProcessorNode` to `AudioWorklet`, but the user-visible dictation workflow stays the same.

## Test Plan

Automated:

- `npm run build`
- `npm run test`
- `npm run check`
- build artifact regression check for Node-module imports in `main.js`

Manual:

1. Build the plugin and Rust sidecar.
2. Reload or restart Obsidian.
3. Confirm `Local STT: Check Sidecar Health` succeeds.
4. Confirm the current invalid `tempAudioDirectoryOverride` is cleared automatically.
5. Set the model path to a local `ggml-small.en-*` whisper.cpp model.
6. Start dictation, speak for a few seconds, stop, and wait for insertion.
7. Repeat with `large-v3-turbo` only after the small-model smoke test passes.

## Assumptions And Defaults

- This remains a desktop-only, CPU-first implementation.
- The plugin continues to send a temp WAV file path to the Rust sidecar over stdio JSON.
- `ggml-small.en-*` is the default smoke-test model because it is the fastest reliable proof of the end-to-end path.
- `large-v3-turbo` remains a supported manual test target, but it is not the baseline model for first-pass verification.
- No translation, TTS, streaming partials, or GPU work is part of this change.

## Open Questions

None. The implementation choices above are explicit enough to proceed without more design work.
