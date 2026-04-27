# Obsidian Local Transcript Decisions

## What Belongs Here

Durable workflow, product, and architecture decisions. Update in the same change that alters a decision. Superseded decisions move to `docs/archive/decisions-superseded.md` once they no longer inform new work.

## Active Decisions

### D-005: UI Must Be Obsidian-Native

- Decision: All plugin UI uses Obsidian's built-in primitives (Setting, Modal, Notice, toggles, dropdowns). Custom CSS extends Obsidian's patterns, never replaces them.
- Why: Users expect plugin settings to look and behave like core Obsidian. Custom UI components accumulate bugs disproportionate to their value.

### D-008: Engine Abstraction Is A Three-Layer Registry

- Decision: Inference dispatch is layered as **runtime / model family / model**. A `Runtime` owns execution-framework concerns; a `ModelFamilyAdapter` owns model-shape semantics; a `LoadedModel` owns per-session inference state. `EngineRegistry::build()` is the single registration site. Selections use the triple `(runtimeId, familyId, modelId)`.
- Capability seams: **inventory** (`system_info.compiledRuntimes[]` + `compiledAdapters[]` — what this binary can do at all) and **selected-model** (`model_probe_result.mergedCapabilities` — what the current selection supports). UI gating reads the merged capabilities; there is no TypeScript mirror of which engine supports what.
- Why: Removes scattered `match EngineId` dispatch, unblocks capability-gated features (initial-prompt conditioning, per-engine GPU UI, per-adapter post-processing), and gives future adapters an OCP-friendly registration path behind a single Cargo feature flag.
- Implication: Unsupported request fields are warn+dropped at the worker, surfaced as `RequestWarning[]` on `transcript_ready` (dev console only).
- See: `docs/system-architecture.md` Stage 4 for layer details and capability flow.

### D-009: Post-Transcript Enrichment Runs In The Rust Sidecar

- Decision: Post-transcript processing that improves an utterance while preserving its utterance identity — hallucination filter, punctuation, formatting/user rules, and similar correction stages — runs in the Rust sidecar, not the plugin. The plugin receives transcript revisions with `stageResults[]` and a joined-text DTO projection for convenience. Diarization runs in the audio pipeline alongside VAD. LLM whole-session rewrite is a separate experimental artifact, not a transcript stage, because it may restructure text freely and destroy utterance/segment alignment.
- Why: Keeps the plugin/sidecar boundary clean: the sidecar owns inference and transcript-quality work; the plugin owns Obsidian state, journal accumulation, context assembly, and safe note projection. The canonical transcript struct is the architectural seam between audio-domain and text-domain processing. Capability-gated features degrade gracefully without engine-specific branches in the plugin. Supersedes D-007.
- See: `docs/system-architecture.md` for the full pipeline and protocol seams.

### D-011: No Python In The Sidecar

- Decision: The Rust sidecar does not link, embed, or subprocess Python. All inference and post-processing run in Rust against native libraries (whisper.cpp, ONNX Runtime, etc.).
- Why: Python in the sidecar means a per-platform Python distribution to bundle, virtualenv management, and a fragile dependency tree at install time. Rust-native runtimes give the same model coverage with one binary per platform. The "just shell out to faster-whisper" path looks tempting and is repeatedly the wrong call.

### D-012: No Cloud, No Telemetry, No Accounts

- Decision: After model setup, the plugin operates fully offline. No network calls for transcription, no analytics or telemetry, no account or login flow. Model downloads from HuggingFace (user-initiated) are the only sanctioned outbound traffic.
- Why: Privacy is the product. Anything that calls home or requires an account changes the value proposition fundamentally — even an anonymous "crash report" defaults users into trust they didn't grant. Treat this as a hard constraint when evaluating new features.

### D-013: Strict Session-To-Note Lock

- Decision: A dictation session is locked to a single note at start, by file identity (not path, not active tab). Writes follow the file across rename or move. Switching the active tab does not redirect writes; the locked note may be in any tab, including a background pane. Closing the locked note (no leaf in the workspace with `leaf.view.file === lockedFile`, regardless of visibility) ends the session via graceful stop — drain any in-flight utterance, write what's pending, then end. Deleting the locked note cancels the session immediately. Reopening a closed note does not resume it.
- Identity primitive: a session-scoped `TFile` reference. Within a session, identity is `===` on the TFile object. Cross-session lookup (crash recovery) uses the vault path resolved via `vault.getAbstractFileByPath()` at recovery time.
- Rename and modify events: rename-follow uses `vault.on('rename')`. External renames that bypass Obsidian's event system (Finder, git checkout while Obsidian is running) are out of scope. External `modify` events (Obsidian Sync, iCloud, Dropbox) trigger a span-validity check on the locked file; spans whose recorded text no longer matches the file's current content are user-wins-latched (D-014) for the session's lifetime.
- Closed-note graceful stop UX: a Notice ("Dictation stopped — locked note was closed") fires on graceful stop so the user is not surprised by silent termination.
- Delete-cancel: in-flight audio already in the sidecar pipeline completes and is recorded in the journal (D-016) but is never written to the deleted note. The note half of the two-halves rule (D-014) is unreachable; the journal half still runs.
- Plugin hot-reload mid-session: `onunload` ends the session like graceful stop. No resume across reload, ever.
- Multi-window Obsidian: the lock binds to the editor view in the window where dictation was started. Edits to the locked file made through a second window are invisible to the user-wins latch — known limitation, not a defect.
- No resume affordance: once a session ends — for any reason — it is permanently closed. A new session can target the same note.
- Why: Note-as-context, speculative replacement, and future LLM rewrites all depend on knowing exactly which surface a session writes to. "Follow active tab" makes those features incoherent — the user could not glance at a reference note without redirecting dictation. Hard-locking is the only model that supports the rest of the contract.
- Implication: The plugin observes workspace events (close, delete, rename, modify) on the locked file and reacts per the rules above. The lock is owned by the session, not by any view.

### D-014: Note Surface Capability Tiers And Write Contract

- Decision: A single `NoteSurface` object owns the locked note and is the only code in the plugin permitted to edit the editor. Every write declares one of four capabilities, ordered by "how intact the note must be":
  - `record` — in-memory journal only, never touches the editor. Always available.
  - `append` — write new text at the writing-region tail. Requires the locked note open in the workspace per D-013.
  - `replace_anchor` — swap an utterance's text in place. Requires `append` plus the previously-written text byte-identical at its recorded anchor.
  - `rewrite_region` — replace a contiguous range. Requires `append` plus the entire range intact end-to-end.
  Tiers form a partial order: `record` ⊂ `append` ⊂ {`replace_anchor`, `rewrite_region`}. The latter two are siblings, not nested — a note can satisfy `rewrite_region` while failing `replace_anchor` (e.g., one anchor's text was mutated but the range is still contiguous), so capability checks must be evaluated independently. Each feature declares the capability it needs; `NoteSurface` evaluates and routes.
- Span tracking: each utterance has start and end positions tracked as CM6 mapped positions. Start uses `assoc: -1`, end uses `assoc: +1` so insertions adjacent to the span are attributed correctly (insertions before start stay outside; insertions at the tail extend the end). Both endpoints update in the same transaction observer.
- Byte-identity check: `replace_anchor` and `rewrite_region` compare the recorded text against `doc.sliceString(from, to)` on the CM6 in-memory document — not against vault file bytes. This holds across save/reload only within a session, which is acceptable given D-013's session-ends-on-close rule.
- Two-halves rule: every action has a journal half (always runs, owned by D-016) and a note half (only runs if the requested capability is currently available). When the note half cannot run, it is skipped — never queued, retried, or applied later. The journal stays correct; the note simply does not receive that update. Capability denial is logged at debug level with utterance ID and reason (span mismatch, anchor not found, latched, note closed); not surfaced as a user-facing Notice.
- Projection state: the caller routes note writes by actual projection state, not by whether an utterance has been seen in the journal. Per utterance, the plugin tracks `unprojected`, `projected { lastRevision, projectedText }`, `latched`, or `denied`. `replace_anchor` uses the last text successfully projected into the note as `expectedOldText`, not merely the previous journal revision, because journal revisions may advance after note writes were denied.
- User-wins latch trigger: a CM6 transaction latches an utterance's span if and only if (a) it is annotated with `Transaction.userEvent`, (b) the user-event kind is not `undo` or `redo`, and (c) the change set intersects the utterance's span. Plugin-driven writes (Templater, autoformatters, NoteSurface itself) do not set this annotation and do not trigger the latch.
- Undo/redo exception: a transaction where `tr.isUserEvent('undo')` undoes a NoteSurface write does not latch. The span resets to its pre-write state and remains writable. Redo similarly. This is the difference between "user edited our text" and "user reverted our write."
- Multi-cursor and IME: multi-cursor edits latch only the utterances whose spans were actually intersected; non-intersected spans remain writable. IME composition events (`compositionstart`/`compositionend`) are treated as user events for latch purposes.
- Latch is permanent for the session: once latched, an utterance is locked from further note writes regardless of capability or revision quality. The journal continues to accumulate revisions; they simply do not flow to the note for that utterance.
- Speculative serialization: multiple in-flight `replace_anchor` writes for the same utterance are ordered by revision number. An older revision arriving after a newer one is dropped at the capability check, before the byte-identity test runs.
- LLM whole-rewrite tier: LLM whole-rewrite uses `rewrite_region` over the full session writing region. The user-wins latch is absolute — latched utterances within the rewrite region are preserved verbatim from the note's current content, not replaced from the LLM's output. The `SessionRewrite` producer receives the latched-utterance list as input and is responsible for producing a rewrite that respects them; if it cannot, the rewrite is rejected at the capability check.
- Why: Each future feature (speculative, punctuation, LLM, diarization) has different preconditions for safe writes. Re-deriving those checks per feature is the bug class this contract designs out. Centralizing them in `NoteSurface` makes the rules auditable in one place and the feature code declarative. The user-wins latch is the absolute invariant that prevents the system from silently undoing manual edits.
- Implication: The session tracks per-utterance spans, not just an insertion cursor. The latch trigger algorithm and span tracking are fully specified above; the highest-risk piece of code under this contract is the transaction observer that implements them. The "transcription pushes user-typed text" bug is fixed because `append` lands at the writing-region tail (after the last span's end), not at the cursor.

### D-015: Canonical Transcript Is Immutable And Revision-Versioned

- Decision: The audio/text seam named in D-009 is realized as a `Transcript` value object identified by `(utteranceId, revision)`. Transcripts are immutable; each quality stage is a function `(Transcript, PipelineContext) -> StageResult` that either produces a new transcript revision and appends a `StageOutcome`, or records a skipped/failed outcome and passes the input revision through unchanged. Segments are the unit of truth — joined plaintext is a derived view, not a stored field.
- Revision numbering: monotonic per-utterance starting at 0. No revision number is reserved for any stage; the producing stage is identified by `StageOutcome.stage_id` on each revision. Revisions are assigned strictly serially per utterance — no parallel stage execution in the initial pipeline. Different utterances may run their stage chains concurrently.
- Engine output and speculative partials: speculative engine partials and the engine's finalized result are revisions of the same utterance ID, produced by the engine stage. They are distinguished by an `is_final: bool` flag in the engine's `StageOutcome` payload. Pre-final partials flow through NoteSurface via `replace_anchor` (D-014) like any other revision. Post-process stages run only after `is_final = true`.
- Re-segmentation: text stages may change segment boundaries — merging, splitting, or otherwise reflowing content within an utterance. New segment timestamps interpolate linearly across the boundary segments' `(start_ms, end_ms)`. Word-level alignment is not preserved within a segment; features needing word-level precision must request a separate `WordAlignment` artifact (out of scope for the initial foundation). This supersedes any "segment-preserving" claim in older architecture notes.
- StageOutcome shape (sketch — final field names follow code style):
  - `stage_id`: one of `engine`, `hallucination_filter`, `punctuation`, `user_rules`
  - `status`: `Ok` | `Skipped { reason }` | `Failed { error }`
  - `duration_ms`
  - `revision_in: u32` (0 for the engine stage)
  - `revision_out: Option<u32>` (None on Skipped/Failed)
  - `payload`: typed per-stage extension. Revision 0's payload carries the engine triple `(runtimeId, familyId, modelId)`, the resolved model file hash, the `initial_prompt` digest, and the resolved language — the minimum reproducibility record.
- PipelineContext: stages take explicit resolved inputs such as language, model parameters, user dictionary, and a `ContextWindow` assembled by the plugin (D-017). The sidecar never receives a handle to the plugin journal. Stages are referentially transparent given the same `(Transcript, PipelineContext)` pair.
- Stage failure and skip: a Failed or Skipped stage emits its outcome with `revision_out = None` and passes its input revision through unchanged — no new revision is created. The pipeline continues. The wire DTO carries the latest revision plus the full stage history including failures and skips. Downstream consumers that depend on a particular stage check the stage history, not the revision number.
- Pipeline order: stages run in fixed order — engine → hallucination filter → punctuation → user rules. Rendering/joining text is not a transcript stage and does not bump the revision; it is a DTO projection derived from segments. Diarization runs in the audio pipeline (pre-engine); its output is a per-segment speaker label as a field on `TranscriptSegment`, not a text-pipeline revision.
- Wire DTO: `transcript_ready` and successor events carry `utteranceId`, `revision`, the latest segments, the joined text (for plugin convenience), and the `StageOutcome[]` history. The plugin correlates utterances by `utteranceId` to drive D-014 `replace_anchor` and to populate the journal (D-016).
- LLM whole-rewrite as separate artifact: LLM output is a `SessionRewrite` artifact, not a Transcript revision. Its alignment-destroying nature (segments may reflow across utterance boundaries) is incompatible with the segment-preserving contract and with speculative. It carries its own identity `(sessionId, sourceRevisions[], llmRunId)` and is stored alongside the journal (D-016), not as a journal revision.
- Why: Speculative transcription, post-process stages, and any future revision producer share one shape — produce a better version of an existing utterance. Modeling this as immutable revisions keeps stages composable, individually skippable, and testable given an explicit `PipelineContext`. Storing only segments removes the "text vs. segments drift" bug class at the source.
- Implication: Wire DTOs are projections of the latest revision and may include the joined text for plugin convenience; the canonical type does not store it. Plugin and sidecar communicate in utterance IDs and revisions, never by text identity. `TranscriptionRequest.initial_prompt: Option<String>` remains an engine-adapter input fed from the richer plugin-assembled `ContextWindow` once D-017 lands.
- See: D-009 for the seam's role in the broader pipeline.

### D-016: Session Journal Is The Source Of Truth

- Decision: Each session owns a `SessionJournal` — the source of truth for "what was dictated this session." Distinct from "what is currently in the note," which is owned by NoteSurface state. The two are allowed to diverge whenever user edits or capability denials skip the note half of the two-halves rule (D-014).
- Ownership: the journal lives in the plugin (TypeScript). The sidecar runs the pipeline (D-009), emits a wire event per produced revision, and forgets — it holds inference state only for the active utterance. The plugin accumulates events into the journal as a side-effect of the existing event-handling path. Plugin ownership is forced by: (a) anchor spans and user-wins latches (D-014) are pure plugin state; (b) note-as-context assembly needs `vault.read()`, only available in the plugin; (c) session lifecycle is plugin-driven (D-013); (d) crash recovery requires persistence that survives sidecar restart, which is impossible if state lives in the sidecar.
- Data structure: `Map<UtteranceId, Transcript>` holding the latest revision per utterance, plus an ordered `Vec<UtteranceId>` for traversal in dictation order. A sibling `Map<UtteranceId, Vec<Transcript>>` retains older revisions for debug and replay; default-on, can be disabled if memory pressure shows up.
- Read API:
  - `latestForUtterance(id) -> Transcript`
  - `allUtterancesInOrder() -> Iterable<Transcript>`
  - `revisionHistoryFor(id) -> Vec<Transcript>` (when history retention is enabled)
  - `subscribe(callback)` for live UI updates
  Sidecar reads (e.g., for note-as-context input) happen through a wire-protocol context request; the journal does not span the IPC boundary as shared memory.
- Concurrency: one writer per utteranceId at a time. Pipeline stages run sequentially per utterance per D-015, so concurrent updates to the same utterance do not occur. Different utterances may have concurrent stage progression, but each utterance's revision sequence is strictly serial.
- Note projection state: per-utterance anchor spans and user-wins latch state live in `NoteSurface` as a sibling structure to the journal, also keyed by `utteranceId`. The journal answers "what was said"; NoteSurface state answers "what's currently visible in the note." Neither subsumes the other.
- Crash recovery: the journal serializes to a vault-adjacent temp file (`.obsidian/local-transcript/recovery-<sessionId>.json`) on each utterance finalization (after the last post-process stage emits, or on engine `is_final = true` if no post-process stages are configured). On plugin load, presence of a recovery file triggers a Notice offering to export the recovered journal as markdown alongside the original locked note. The recovery file is deleted on graceful session end.
- LLM rewrite artifacts: `SessionRewrite` objects (D-015) are stored as siblings to the journal, indexed by `(sessionId, llmRunId)`. They reference the source revisions but do not appear in the journal's per-utterance map.
- Session lifetime: a session ends on graceful stop or note close/delete per D-013. At session end, the journal is finalized (frozen, no further writes), the recovery file is deleted, and the journal is retained in plugin memory until the plugin is unloaded or a new session begins. There is no in-process multi-session history.
- Why: Future features (note-as-context for the engine, LLM session-wide context, history export, debug timelines) all require "everything said in this session" as a queryable artifact. Recomputing that from the editor is impossible once revisions and user edits enter the picture. Plugin ownership keeps the journal close to the state machines (lock, anchor spans, latches) that coordinate with it, and avoids inverting the sidecar's currently-unidirectional event flow.

### D-017: Context Window Is An Explicit Plugin-Assembled Artifact

- Decision: Context passed to engines and quality stages is represented as a `ContextWindow` assembled by the plugin, not as ad hoc strings or direct sidecar access to the journal. The first implementation contains finalized session utterances only. Future sources such as surrounding note text, selected headings, user dictionary snippets, and note metadata must be added as explicit `ContextWindow` source entries with budgets and ordering rules.
- Ownership: the plugin assembles context because it owns the session journal (D-016), Obsidian vault/editor access, note lock state, and user-wins projection state. The sidecar consumes a resolved context payload and may downgrade it to `initialPrompt` for engines that support prompt conditioning.
- Source precedence: initial context uses journal truth, not note projection text. Manual user edits in the note do not rewrite what the user said in the journal. When note-derived context is added later, it is a separate source entry so stages can distinguish "dictated session history" from "current note text."
- Budget policy: context assembly selects the newest finalized utterances that fit the requested budget, then emits them in chronological order. If the newest utterance must be truncated, truncation happens at a word boundary. First utterance returns `null` / no context rather than an empty string.
- Privacy boundary: context never leaves the local plugin/sidecar process boundary. There is no cloud expansion of context and no telemetry of context payloads.
- Protocol: sidecar context reads happen through a request/response pair with camelCase fields (`context_request` / `context_response`, `correlationId`, `budgetChars`). The request is bounded by a short timeout; timeout or `null` context proceeds without prompt conditioning. Correlation state is cleared on response, timeout, session stop, or replacement.
- Why: The intelligent engine vision depends on session memory, but unstructured prompt strings would quickly become a hidden second source of truth. A typed context artifact lets us add sources safely while preserving the separation between dictated truth, note projection, and engine-specific prompt capabilities.
