# Code Review — State, Contracts, and Roadmap Readiness

**Date:** 2026-04-14
**Branch:** `feat/ribbon-control` (2 commits ahead of `main`)
**Scope:** Full-stack state management review — sidecar state machine, plugin UI state, protocol boundary, and open issue roadmap.

---

## Summary

The current architecture is structurally sound. Protocol types match between TS and Rust, event ordering is guaranteed, session ID ownership is correct, and the ribbon UI changes are clean. The main risks center on the new graceful drain path (introduced in working-tree changes not yet committed) and a strategic contradiction between D-007 and issue #6 about where the transcript pipeline belongs.

---

## Findings

### M1 — `stopSession` timeout can drop the final transcript during drain

**Severity:** Medium
**Files:** `src/sidecar/sidecar-connection.ts:227-239`, `native/src/app.rs:524-569`

`stopSession()` uses `sendCommandAndWait`, which waits for a `session_stopped` event with a timeout (`sidecarRequestTimeoutMs`, default 300s). When the sidecar enters drain mode via `graceful_stop()`, `SessionStopped` is deferred until the last `TranscriptReady` comes back from the worker. If transcription takes longer than the timeout, the client cleans up locally via the catch block in `stopDictation()` (line 232), nulling `sessionId`. When the sidecar eventually emits `transcript_ready` and `session_stopped`, both are dropped because the session filter fails.

**Impact:** The user's final utterance (the one being transcribed at stop time) is silently lost. The sidecar session is orphaned until the next `StartSession` replaces it.

**Options:**
1. Emit an immediate "drain acknowledged" event so the client knows to wait.
2. Use a separate, longer timeout for `stopSession` specifically.
3. Emit `SessionStopped` immediately and deliver the final transcript as a post-session event.

**Decision needed:** Which approach fits the product intent? If "stop always delivers the final transcript," option 1 or 3 is needed. If "stop is best-effort," the current 300s timeout is generous enough for most cases and this becomes a known edge case.

### M2 — Draining state is invisible to the client

**Severity:** Medium
**Files:** `native/src/app.rs:505-522` (`emit_state_if_changed`), `app.rs:962-990` (`derive_session_state`)

`derive_session_state()` does not read `active_session.draining`. When `graceful_stop()` sets `draining = true` and calls `emit_state_if_changed`, the emitted state depends on `transcription_active` (true, since that's the condition for draining) and `session.base_state()` (Idle or Listening, since `clear_activity()` was called). The result is `SessionState::Transcribing`.

The client sees "Transcribing" with the active loader animation after clicking stop, even though the microphone is already off. The user cannot distinguish "actively transcribing while also listening" from "finishing up and about to stop."

**Options:**
1. Add a `Draining` variant to `SessionState` on the wire protocol.
2. Add a client-only `draining` state to `DictationControllerState`, triggered by a new "drain acknowledged" event.
3. Accept the current behavior — the drain interval is typically short (1-5 seconds), and the mic indicator turning off is the primary feedback.

**Decision needed:** Is "transcribing" sufficient UX during the drain interval, or does the user need a distinct "finishing up" indicator?

### M3 — D-007 contradicts issue #6 on pipeline ownership

**Severity:** Medium (strategic, not a code bug)
**Files:** `docs/decisions.md` (D-007), `docs/architecture/pipeline-architecture.md`, GitHub issue #6

D-007 says: "Insert a TranscriptFormatter and TextProcessor pipeline between engine output and editor insertion." The pipeline architecture doc's implementation slices (2-7) all target TypeScript. Issue #6 says: "the engine should return processed transcript output" — placing the pipeline in Rust.

These cannot all be true. If #6 is adopted as written:
- D-007 needs revision
- The pipeline-architecture.md slices become invalid
- Per-session settings (#12) must include pipeline configuration in `StartSession`
- `TranscriptReady` event shape changes (at minimum: `processed: boolean` or a `rawText` field)

If D-007 is kept, issue #6 needs to be rescoped or closed.

**Decision needed (blocking):** Where does the transcript pipeline live? This gates #12 (per-session settings) and all pipeline slice work.

### M4 — Error flash on successful cancel

**Severity:** Medium (UX concern, intentional per PLANS.md)
**Files:** `src/dictation/dictation-session-controller.ts:301-313`

When an error triggers `abortSessionAfterError` and the cancel succeeds, the sidecar sends `session_stopped`. `handleSessionStopped` immediately resets to `idle` (line 313), overwriting the `error` state. The error shake animation (0.4s) is cut short — the user sees a brief flash of `mic-off`, then snap back to `mic`. The only persistent indicator is the transient `Notice` popup.

PLANS.md explicitly calls this correct ("the sidecar has resolved the error condition"). The error persists only when cancel also fails and no `session_stopped` arrives.

**Open question:** In practice, is the error flash too fast to notice? Should `handleSessionStopped` delay the idle reset when the previous state was `error`, giving the shake animation time to complete?

### M5 — PLANS.md is stale

**Severity:** Low
**Files:** `PLANS.md:79-84,119,184`

PLANS.md specifies `loader-circle` for starting/transcribing/paused states. The implementation uses `loader` (8 spokes, not a single circular arc). The CSS chase animation is specifically designed for `loader`'s 8 `<path>` children. The code is self-consistent, but the plan document is misleading.

Per AGENTS.md: "Do not keep stale plan text as a second source of truth." PLANS.md should be updated or removed now that the ribbon work is implemented.

### M6 — Error during drain triggers harmless protocol race

**Severity:** Low
**Files:** `native/src/app.rs:607-638`, `src/dictation/dictation-session-controller.ts:283-298`

If the worker returns `SessionError` during drain, the sidecar emits `Event::Error` then `Event::SessionStopped` (from `maybe_complete_drain`). On the TS side, `handleErrorEvent` fires `abortSessionAfterError` (fire-and-forget), which sends `CancelSession`. But the session was just torn down by the drain completing. The cancel arrives for a non-existent session and produces a harmless `no_active_session` warning in sidecar logs.

Not a bug — just noise in debug logs. Could be addressed later by checking whether the session is still alive before sending `CancelSession`, or by having `abortSessionAfterError` check if `sessionId` was already cleaned up.

### M7 — `graceful_stop` re-borrow after `enqueue_utterance`

**Severity:** Low
**Files:** `native/src/app.rs:538-551`

`graceful_stop()` calls `self.enqueue_utterance(utterance, &mut events)` at line 547, then re-borrows `self.active_session.as_mut()?` at line 551. This is safe today because `enqueue_utterance` never calls `self.active_session.take()`. But if `enqueue_utterance` evolves to remove the session on error, `graceful_stop` would silently return early without emitting `SessionStopped`. The `?` operator is defensive but masks the failure mode.

No action needed now, but worth noting for future changes to `enqueue_utterance`.

---

## Confirmed Correct

These areas were reviewed and found to be sound:

- **Protocol types match.** `SessionState` (6 values), `SessionStopReason` (5 values), and PCM format constants are identical between `src/sidecar/protocol.ts` and `native/src/protocol.rs`.
- **Event ordering during drain.** The sidecar's single-threaded main loop emits `TranscriptReady` before `SessionStopped` in the same event vector. `write_events` iterates in order. The TS `dispatchEvent` delivers to listeners before resolving waiters. No reordering possible.
- **Session ID ownership.** During drain, both sides keep the session alive. The TS side keeps `sessionId` non-null until `session_stopped` arrives. The Rust side keeps `active_session` until `maybe_complete_drain`. No sync gap.
- **`CancelSession` bypasses drain.** `finish_active_session(UserCancel)` goes through the immediate `active_session.take()` path, not `graceful_stop()`.
- **`advance_transcription_queue` invariant.** `transcription_active == false` strictly implies `queued_utterances == 0`. The `maybe_complete_drain` check on `!transcription_active` alone is sufficient.
- **Worker validity during drain.** The worker holds `active_session` metadata but receives no new `TranscribeUtterance` commands (audio frames are rejected, no new utterances enqueued). `EndSession` fires in `maybe_complete_drain` after the last result arrives.
- **Double `graceful_stop` is safe.** Re-entering the function is a no-op: `maybe_finalize_utterance` returns `None`, `draining` is already true, `emit_state_if_changed` emits nothing.
- **`isBusy()` covers drain.** `sessionId` remains non-null during drain, so `isBusy()` returns true. After `session_stopped` → `cleanupLocalSession()`, `sessionId` is nulled.
- **Press-and-hold flag cleanup.** `suppressNextRibbonClick` and `ribbonHoldActive` are both reset in `cleanupLocalSession()`. Test at line 385 confirms.
- **`DictationControllerState` `starting` is client-only.** Not in the wire protocol. Set at `startDictation()` before the RPC, overwritten by the first `session_state_changed` event.
- **CSS `prefers-reduced-motion`.** Correctly resets `opacity: 1` and `animation: none` on all paths, preventing the `opacity: 0.2` base state from appearing with no animation.
- **CSS animation child counts.** `loader` has 8 `<path>` children (8-spoke chase). `audio-lines` has 6 `<path>` children (6-bar wave). Both match the nth-child selectors. Fragile by nature but degrades gracefully.
- **Worker panic during drain (L13).** Confirmed as known gap. Worker panic leaves session in `draining = true` indefinitely. Client eventually times out. Already tracked in backlog.

---

## Open Decisions

These are product or architecture decisions that must be made before the corresponding work starts. They are not bugs — they are forks in the road.

### OD-1 — Where does the transcript pipeline live?

**Context:** D-007 and `pipeline-architecture.md` place it in TypeScript. Issue #6 places it in Rust.
**Stakes:** This determines where per-session pipeline config lives, whether the `TranscriptReady` event shape changes, and whether implementation slices 2-7 in the pipeline doc are valid.
**Recommendation:** Decide before starting any pipeline or per-session settings work. If the answer is "Rust," revise D-007 and the pipeline doc. If "TypeScript," rescope or close #6.

### OD-2 — What is the utterance drop policy?

**Context:** `MAX_QUEUED_UTTERANCES = 1` in `app.rs:21`. When the queue is full, utterances are silently dropped with a warning. Issue #11 says "nothing is dropped" as a goal.
**Stakes:** Raising or removing the cap risks unbounded memory growth. Keeping it means audio loss during continuous dictation on slow hardware.
**Recommendation:** Verify the actual frequency of drops under realistic workloads (recommended models on target hardware). If drops are rare, the current policy is defensible for v1. If frequent, consider accumulating dropped audio into a catch-up buffer, but scope that as a separate design.

### OD-3 — Adjustable thresholds vs. smart boundary detection?

**Context:** Issues #8 and #10 both ask for better utterance boundaries. The simple path: expose `SPEECH_END_THRESHOLD_FRAMES` (30 = 600ms) and `MAX_UTTERANCE_FRAMES` (1000 = 20s) as settings. The smart path: text-aware boundary detection requiring partial transcription before finalization.
**Stakes:** The simple path is incremental (one PR, two new `StartSession` fields). The smart path is a research project that changes the session state machine.
**Recommendation:** Ship the simple path first. Evaluate smart detection later if the simple approach proves insufficient.

### OD-4 — Should drain have a distinct client-visible state?

**Context:** See M2 above. The client sees "Transcribing" during drain.
**Stakes:** Adding a `Draining` wire state is a protocol change. A client-only state requires a new event.
**Recommendation:** For v1, accept "Transcribing" — the drain interval is typically short. If users report confusion, add a client-only "stopping" state keyed off a new "drain acknowledged" event.

### OD-5 — Hold vs. toggle: setting scope

**Context:** Issue #9 considers adding a toggle alternative to press-and-hold. The sidecar's `SetGate` command is already mode-agnostic.
**Stakes:** If global, it's a simple settings addition. If per-session (#12), it needs to be in `StartSession`.
**Recommendation:** Global preference. It's a UX choice, not a transcription behavior. Make it overridable via #12 later if needed.

---

## Issue Dependency Map

```
#6 (pipeline location) ──blocks──▶ #12 (per-session settings)
                                     ▲
#8 (sentence detection) ────────────/
#10 (utterance length) ────────────/

#8 ◀──same mechanism──▶ #10  (both expose VAD constants)

#10 ◀──tradeoff──▶ #11       (longer utterances ↔ less queue pressure)

#9 (press-and-hold)               (independent, ship anytime)
```

**Recommended order:**
1. Resolve OD-1 (pipeline location) — gates everything downstream
2. #8 + #10 together — same change (make VAD constants configurable)
3. #11 — investigation, not feature. Run in parallel with #8/#10
4. #9 — independent, ship whenever
5. #12 — last, as the integration point that bundles settings from #6, #8, #10

---

## Ribbon UI Branch Assessment

The `feat/ribbon-control` branch (2 commits: `594ea19`, `8b558b5`) is clean and ready to merge, with one housekeeping item:

**What's done correctly:**
- `DictationControllerState` type moved out of `status-bar.ts` — no coupling to deleted module
- Status bar removed cleanly — all references deleted, no orphaned imports
- Ribbon icon mapping is complete and self-consistent
- Error persistence logic is correct (error stays until click when no `session_stopped` arrives)
- Tests updated appropriately
- CSS animations degrade gracefully with `prefers-reduced-motion`

**Housekeeping:**
- PLANS.md references `loader-circle` but implementation uses `loader`. Update or remove per AGENTS.md convention.

---

## Backlog Cross-Reference

Findings that overlap with existing backlog items (no new entries needed):

| Finding | Backlog Item | Status |
|---|---|---|
| Worker panic during drain | L13 | Already tracked |
| `FramedMessageParser` unbounded buffer | M5 | Already tracked |
| PCM constants independently defined | L12 | Already tracked |
