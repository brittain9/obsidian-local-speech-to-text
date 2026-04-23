# Active work

Working-plan file. Completed large-change plans are distilled into `docs/decisions.md` and `AGENTS.md`; this file tracks only in-flight work.

## Lazy install prompt

### Context

The download-on-demand installer (first-run modal + CUDA CTA + settings CPU install row) ships and works end-to-end. The remaining UX concern is _when_ the install modal appears.

Before: the plugin checked for a resolvable sidecar on `workspace.onLayoutReady()` and popped the install modal unconditionally when none was found. Too intrusive — a user who enables the plugin to poke around gets a download prompt before they've decided they want the feature.

After: the plugin stays silent on enable. The user clicks the dictation ribbon (or runs the command), the sidecar spawn fails with a specific "not downloaded" signal, and only then does the install modal appear.

Scoping requirement: the signal must fire _only_ for "no binary in any default location." If `sidecarPathOverride` points at a broken path, or the spawn itself dies, the user gets a generic error — not a misdirected "download a sidecar" CTA.

### Mechanism

- `SidecarNotInstalledError` class thrown from exactly one line — the final throw in `resolveSidecarExecutablePath` (`src/sidecar/sidecar-paths.ts`), which only runs when override is empty AND no installed binary exists AND no dev binary exists.
- `DictationSessionController` takes an `onSidecarMissing?: () => void` dep. Its `startDictation` catch branches on `instanceof SidecarNotInstalledError`, calls the callback, and returns without a notice (the modal itself is the feedback).
- `src/main.ts` wires the callback to `openFirstRunSetup()`. `runPostLayoutStartup` no longer opens the modal proactively and treats a startup-path `SidecarNotInstalledError` as a debug-level "deferred" log. `ModelInstallManager.init()` also swallows the sentinel at debug.
- Ribbon code stays state-unaware — it just reflects controller state.

### Status

- [x] Sentinel class + scoped throw in `sidecar-paths.ts`
- [x] `onSidecarMissing` callback in `DictationSessionController` + branch in catch
- [x] Delete `isSidecarAvailable()` + proactive modal trigger in `main.ts`; wire callback; demote startup/model-init sentinel logs to debug
- [x] Tests: two new controller tests + tightened sidecar-paths tests
- [ ] `npm run check` green
- [ ] Real-Obsidian manual verification (fresh install, override-broken, already-installed, command-palette paths — see the plan file for the exact steps)

### Pending non-blocking items

- Task #12: update `docs/decisions.md` + README for the download-on-demand flow. Separate docs commit, does not gate PR.
- Publish release `2026.4.20` for true end-to-end download testing.
- Open PR against `main` once manual verification passes.
