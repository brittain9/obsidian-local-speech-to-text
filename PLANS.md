# PR 4 Plan - Queuing Behavior and Pause Metadata

## Summary

Replace the current one-item, drop-on-overflow utterance queue with explicit backpressure that preserves finalized audio, processes utterances in order, and stops capture at saturation. In the same PR, add `pause_ms_before_utterance` as canonical sidecar metadata so timestamp rendering and smart separators can consume pause information without re-deriving it in the plugin.

This is a coordinated contract change across the Rust sidecar, the TypeScript protocol parser, and the dictation UI. The repo is greenfield, so update the current wire shapes directly; do not add schema negotiation, compatibility aliases, or fallback parsers.

## Current State

- `native/src/app.rs` has `MAX_QUEUED_UTTERANCES = 1`; when `transcription_active` is true and the queued count is already at the cap, `enqueue_utterance` emits `utterance_queue_overload` and drops the finalized utterance.
- `pause_while_processing` currently prevents ingesting audio while one utterance is processing by clearing activity in `handle_audio_frame`; this remains a separate user setting and is not the overload policy.
- Session state is coarse: `listening`, speech states, `transcribing`, `paused`, and `error`. There is no queue-depth event or queue tier exposed to the plugin.
- `FinalizedUtterance` carries audio, index, VAD trace, and aggregate voice activity. It does not carry pause metadata.
- `transcript_ready` already carries utterance/session timing anchors. PR 4 adds the pause field beside these anchors.

## Target Contract

### Queue Backpressure

Use queued waiting depth, not active-worker count, for the thresholds:

| Waiting utterances | Tier | Behavior |
| --- | --- | --- |
| 0-2 | `normal` | No user-facing backpressure message. |
| 3-9 | `catching_up` | Subtle active-session indicator: `Transcribing... catching up.` |
| 10-29 | `falling_behind` | Visible warning on tier entry: `Transcription is falling behind - pause to let it catch up.` |
| 30 | `saturated` | Accept the utterance that reaches depth 30, stop capturing new audio, drain queued work in order, then stop the session with a queue-overload reason. |

Add a sidecar event for tier changes:

```rust
Event::TranscriptionQueueChanged {
    session_id: String,
    queued_utterances: usize,
    tier: QueueBackpressureTier,
}
```

`QueueBackpressureTier` serializes as `normal | catching_up | falling_behind | saturated`.

Important semantics:

- Emit only on tier changes, including the transition back down while the worker drains.
- Do not emit duplicate warnings on every utterance once already in `falling_behind`.
- `pause_while_processing=true` still pauses capture whenever transcription is active. It should usually keep queue depth at zero, but the queue machinery must still be correct because context requests, worker errors, and stop/drain paths can overlap.
- `pause_while_processing=false` allows queuing until saturation.
- Saturation is not a silent drop. The sidecar accepts the utterance that reaches the hard cap, marks the session as overload-draining, ignores subsequent audio frames, emits a clear error, and continues processing the backlog already accepted.
- Add `SessionStopReason::QueueOverload`. Emit `session_stopped` with this reason after the overload drain completes. Do not end the worker session immediately at the moment of saturation because that would discard queued worker commands.

### Pause Metadata

Add:

```rust
FinalizedUtterance {
    pause_ms_before_utterance: Option<u64>,
    ...
}

WorkerCommand::TranscribeUtterance {
    pause_ms_before_utterance: Option<u64>,
    ...
}

EngineStagePayload {
    pause_ms_before_utterance: Option<u64>,
    ...
}

StageContext {
    pause_ms_before_utterance: Option<u64>,
    ...
}

TranscriptReadyEvent {
    pauseMsBeforeUtterance: number | null,
    ...
}
```

Measurement rules:

- Measure speech-to-speech pause: current `voice_activity.speech_start_ms - previous_final_utterance.voice_activity.speech_end_ms`, saturated at zero.
- First utterance of a session: `None`.
- Continuation after a `MAX_UTTERANCE_FRAMES` split: `None`, because that boundary is a length cap rather than a pause between thoughts.
- Natural VAD finalization and manual graceful stop finalization both update the previous speech end after producing a finalized utterance.
- Empty/no-voice aggregates keep the existing `speech_end_ms == speech_start_ms` signal. Do not invent a pause from no-voice spans; if the prior or current utterance has no speech, use `None`.

## Implementation Plan

### 1. Sidecar Queue State

- Replace `MAX_QUEUED_UTTERANCES = 1` with `MAX_QUEUED_UTTERANCES = 30`.
- Extend `ActiveSession` with:
  - `last_reported_queue_tier: Option<QueueBackpressureTier>`
  - `overload_draining: bool`
  - optionally `stop_after_drain_reason: Option<SessionStopReason>` if cleaner than a boolean.
- Keep `queued_utterances` as waiting depth behind the active transcription. Do not change it to include the active worker item.
- Add `queue_backpressure_tier(queued_utterances) -> QueueBackpressureTier`.
- Add `emit_queue_tier_if_changed(&mut self, events: &mut Vec<Event>)`.
- Call the emitter after enqueue, after `advance_transcription_queue`, and when a session starts/stops enough to reset state.

### 2. Saturation Stop Without Dropping Accepted Audio

- In `enqueue_utterance`, compute the next waiting depth before returning:
  - If nothing is active, dispatch immediately and depth remains zero.
  - If transcription is active and current waiting depth is `< 30`, accept the utterance and increment depth.
  - If accepting the utterance makes depth exactly 30, set overload drain state and emit an `Error` with code `utterance_queue_overload`.
  - If already saturated/draining, ignore additional finalized utterances because capture should already be stopped; this path should be unreachable except for race-like calls from existing buffered actions, so cover it with a defensive warning rather than broad fallback behavior.
- Update `handle_audio_frame` to return immediately when `overload_draining` is true, matching the existing `draining` behavior.
- Update drain completion so `overload_draining` completes like graceful stop: when `transcription_active` is false and no queued work remains, send `EndSession` and emit `SessionStopped { reason: QueueOverload }`.
- Keep one-sentence `SentenceComplete` behavior unchanged except that queue-drain completion must not be preempted by sentence-complete stop while overload draining.

### 3. Plugin Backpressure UI

- Update `src/sidecar/protocol.ts` to parse `transcription_queue_changed`, `QueueBackpressureTier`, and `queue_overload` stop reason.
- Add controller state for the current queue tier without replacing `SessionState`.
- On `catching_up`, make the subtle indicator the ribbon/anchor active label while the current session state is transcribing-like: `Local Transcript: Transcribing... catching up`.
- On entering `falling_behind`, show one Obsidian notice: `Local Transcript: Transcription is falling behind - pause to let it catch up.`
- On overload error, use the normal error path and notice text from the sidecar. Do not add a second plugin-side synthetic error.
- Update the settings copy for `Pause while processing`; it currently says incoming audio is discarded while processing. Make the trade-off current: enabled pauses capture while processing; disabled allows queued transcription with warnings and a hard cap.

### 4. Pause Metadata in `ListeningSession`

- Add `last_final_speech_end_ms: Option<u64>` and `next_utterance_is_continuation: bool` to `ListeningSession`.
- Change `flatten_frames` or its caller to accept `pause_ms_before_utterance: Option<u64>`.
- Compute the pause at finalization time from the new fields and the finalized utterance's `VoiceActivityEvidence`.
- Set `next_utterance_is_continuation = true` whenever finalization is caused by `MAX_UTTERANCE_FRAMES`, including the hard-cut fallback.
- When `next_utterance_is_continuation` is true, assign `None` to the next finalized utterance and clear the flag after that utterance is finalized.
- Update `last_final_speech_end_ms` only after a finalized utterance is produced.
- Reset both fields on new session construction. Do not reset them on normal utterance activity clearing within the same session.

### 5. Pause Metadata Through Worker, Stages, and Wire

- Thread the field through `WorkerCommand::TranscribeUtterance` and `WorkerEvent::TranscriptReady`.
- Add it to `EngineStagePayload` so engine stage history carries the same metadata as other canonical audio evidence.
- Add it to `StageContext` for PR 6's separator logic and future stages.
- Add `pause_ms_before_utterance` to the Rust `Event::TranscriptReady` and TypeScript `TranscriptReadyEvent` as `pauseMsBeforeUtterance`.
- Update protocol parsing tests to require `null` or a non-negative number. Because this is greenfield, do not default a missing field to `null`.

## Tests

### Rust

- `ListeningSession`:
  - first utterance has `pause_ms_before_utterance == None`;
  - second natural utterance reports speech-to-speech pause using `speech_end_ms` to `speech_start_ms`;
  - manual `maybe_finalize_utterance` path computes the same metadata;
  - continuation after `MAX_UTTERANCE_FRAMES` split has `None`;
  - no-voice evidence yields `None` rather than a fabricated pause.
- `AppState`:
  - enqueue depths 0-2 emit no backpressure tier beyond `normal`;
  - depth 3 emits `catching_up`;
  - depth 10 emits `falling_behind` once;
  - depth 30 accepts the utterance, emits overload error, enters overload drain, and does not drop already accepted work;
  - overload drain emits `SessionStopped { reason: QueueOverload }` only after the last transcript/error drains;
  - worker error paths decrement queued depth and update tier correctly;
  - `pause_while_processing=true` still clears activity during active transcription.
- `worker.rs`:
  - engine stage payload includes `pauseMsBeforeUtterance`;
  - `StageContext.pause_ms_before_utterance` is visible to a test processor.
- Rust protocol serialization tests cover the new event, new tier enum, new stop reason, and `pauseMsBeforeUtterance` on `transcript_ready`.

### TypeScript

- `protocol.test.ts`:
  - parses `transcription_queue_changed`;
  - rejects unknown queue tiers;
  - parses `pauseMsBeforeUtterance: null` and a non-negative number;
  - rejects missing `pauseMsBeforeUtterance`.
- `dictation-session-controller.test.ts`:
  - catching-up tier updates the active label without changing the core session state;
  - falling-behind notice is emitted once per tier entry;
  - overload error follows the existing error cleanup path;
  - stale queue events for another session are ignored.
- `dictation-ribbon.test.ts`:
  - transcribing with catching-up tier uses the catching-up label/tooltip;
  - normal tier preserves existing labels.
- `settings-tab.test.ts` or the closest existing settings test covers the updated `Pause while processing` description if descriptions are asserted.

## Verification

Run:

```bash
npm run typecheck
npm run test
npm run build:frontend
npm run check:rust
```

If full `npm run check:rust` is blocked by the known clippy/build environment issue, follow `docs/lessons.md`: verify with `cargo build` and `cargo test`, and run clippy only with `DOCS_RS=1`.

Acceptance checks:

- Always-on dictation with slow transcription never silently drops finalized utterances below the saturation cap.
- Queue tier messages appear only at threshold crossings.
- Saturation stops capture, drains already accepted work, and ends with a clear queue-overload stop.
- `pauseMsBeforeUtterance` is present on every `transcript_ready` event as either a non-negative number or `null`.
- Existing final transcript insertion and user-wins latch behavior are unchanged.

## Assumptions

- Thresholds are based on waiting queued utterances behind the active worker item.
- The utterance that reaches waiting depth 30 is accepted and drained; subsequent audio after saturation is intentionally ignored because the session is stopping.
- `QueueOverload` is a new stop reason rather than overloading `UserStop`, `UserCancel`, or `Timeout`.
- The subtle catching-up indicator can be represented by existing Obsidian-native ribbon/anchor labels; no custom panel or progress UI is needed for this PR.
- No migration or compatibility handling is required for the changed wire contract.
