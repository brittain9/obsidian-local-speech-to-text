# Code Review

My notes from PLANS.md bugs: Root Causes

  - Primary defect: src/sidecar/sidecar-connection.ts:162 accepts the
    first model_probe_result event for any probe request, and src/
    sidecar/sidecar-connection.ts:397 resolves every matching waiter from
    the same incoming event. There is no correlation to the requested
    selection, even though the event includes selection in src/sidecar/
    protocol.ts:154 and is parsed with that field in src/sidecar/
    protocol.ts:431. That means an older Whisper probe result can satisfy
    a newer Cohere probe request.
  - The visible title mismatch is then caused by src/models/model-
    management-service.ts:404 trusting probeResult.displayName, message,
    resolvedPath, and sizeBytes without checking that
    probeResult.selection matches currentSelection. So the card can
    combine a stale Whisper probe result with the new Cohere selection:
    engine label from the new selection, title from the old probe. That
    exactly matches your screenshot.
  - The race window is widened by overlapping snapshot loads.
    getSnapshot() fires five sidecar requests in parallel in src/models/
    model-management-service.ts:127. After a modal action, the modal
    triggers both a settings redraw via src/settings/settings-tab.ts:482
    and its own reload via src/models/model-management-modals.ts:360. The
    settings callback does not await the async redraw, so those snapshot/
    probe requests overlap routinely.
  - The “Loading model catalog…” behavior is a separate UX flaw in the
    reload path. src/models/model-management-modals.ts:90 clears the
    modal immediately and replaces it with a loading message on every
    full refresh. During install completion or model switching, that
    causes the blank loading state you saw instead of keeping the
    previous list visible while refresh completes.
  - The main settings install row can also look stale because the
    settings page is snapshot-based, not live. src/settings/settings-
    tab.ts:412 loads once, and the settings tab does not subscribe to
    install updates. So completed installs do not disappear until
    something else calls display().

  Bottom line

  This is not one bug. It is:

  1. a protocol waiter correlation bug,
  2. a missing stale-result guard in the card builder,
  3. overlapping snapshot reloads that make the race easy to hit,
  4. a destructive reload UX that makes the issue look worse.

  I also ran npm run test -- test/model-management-service.test.ts; it
  passes, which confirms the current test coverage does not exercise this
  race at all.

  END MY NOTES

## Fixed

### Probe waiter correlation bug (root cause 1)

`sidecar-connection.ts:probeModelSelection` now matches events by `selectedModelEquals(event.selection, payload.modelSelection)` instead of accepting any `model_probe_result`. An older Whisper probe can no longer satisfy a newer Cohere probe request.

### Stale probe result guard in card builder (root cause 2)

`model-management-service.ts:buildCurrentModelCardState` now discards the probe result if `probeResult.selection` does not match `currentSelection`. The card no longer mixes metadata from a stale probe with the current selection's engine label.

### N-7: `LD_LIBRARY_PATH` prepend fix

`main.ts:resolveSidecarLaunchSpec` now prepends the configured CUDA path to the inherited `LD_LIBRARY_PATH` instead of replacing it.

### N-6: Multi-artifact install progress totals

Verified already correct — `InstallReporter.total_bytes` is set from `required_download_bytes()` (aggregate) and all progress calls use `reporter.total_bytes`. The UI layer also clamps downloaded to total.

## Open Findings

### N-4. Low: Whisper CUDA probe is weaker than Cohere CUDA probe

`native/sidecar/src/capabilities.rs:51-53`: Whisper CUDA checks for `/dev/nvidiactl` and `/dev/nvidia0` device nodes. This confirms the driver is loaded but not that the userspace CUDA runtime libraries (`libcudart.so`, `libcublas.so`) are available. The Cohere probe actually tries to register the CUDA EP, so it catches library-level failures.

This means the settings UI could show `Whisper: CUDA` when Whisper will actually fail at runtime due to missing libraries. The asymmetry is acceptable as a fast heuristic, but worth a comment in the code or a backlog note.

### N-5. High: launch-affecting sidecar settings do not take effect until a manual restart

`src/main.ts:198-200`: The `CUDA library path` and `Sidecar path override` settings both affect the sidecar launch spec, but changing them only persists settings. The already-running sidecar stays alive, and `Check Sidecar Health` only pings that existing process.

Suggested fix: restart the sidecar automatically when launch-affecting settings change while dictation is idle, or block the save with an explicit "restart required" notice and refresh path.

### N-6. ~~Medium~~ Verified correct: multi-artifact install progress totals

Verified: `InstallReporter.total_bytes` uses `required_download_bytes()` (aggregate), and all progress calls pass `Some(reporter.total_bytes)`. The UI layer clamps downloaded to total. No fix needed.

### N-7. ~~Medium~~ Fixed: `CUDA library path` now prepends to inherited `LD_LIBRARY_PATH`

Fixed in `main.ts:resolveSidecarLaunchSpec`. See Fixed section above.

### R1-6. Medium: KV cache outputs are still matched by iterator position instead of output name

`native/sidecar/src/cohere.rs:510,526`: Code comments acknowledge the assumed output order (`present.{layer}.{decoder,encoder}.{key,value}`). Not yet addressed.

### R3-L4. Low: `isMacOsRuntime()` still uses `process.platform` instead of `Platform.isMacOS`

`src/dictation/shortcut-matcher.ts:107-109`: Should use `Platform.isMacOS` from the `obsidian` package (already used in `main.ts`).
