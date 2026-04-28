# Decisions

Short reference list. One paragraph each. Spec-grade detail lives in code or `docs/system-architecture.md`, not here.

## D-005 — UI is Obsidian-native

Plugin UI uses Obsidian's built-in primitives (Setting, Modal, Notice, toggles, dropdowns). Custom CSS extends those patterns; it does not replace them. Custom UI accumulates bugs disproportionate to its value.

## D-008 — Engine abstraction is a three-layer registry

Inference dispatch is layered as runtime / model family / model. `EngineRegistry::build()` is the single registration site. Selections use the triple `(runtimeId, familyId, modelId)`. Capability flags surface on `model_probe_result.mergedCapabilities`; UI gates from those flags rather than from a TypeScript mirror.

## D-009 — Post-transcript enrichment runs in the sidecar

Quality stages that improve an utterance while preserving its identity (hallucination filter, punctuation, user rules, future LLM cleanup) run in the Rust sidecar. The plugin receives revisions plus a joined-text projection. Diarization runs in the audio pipeline alongside VAD. Whole-session LLM rewrite is a separate experimental artifact, not a transcript stage.

## D-011 — No Python in the sidecar

Inference and post-processing run in Rust against native libraries (whisper.cpp, ONNX, llama.cpp). One binary per platform. No embedded Python, no virtualenvs, no subprocess shims.

## D-012 — No cloud, no telemetry, no accounts

After model setup, the plugin operates fully offline. The only sanctioned outbound traffic is user-initiated model downloads from HuggingFace. Privacy is the product.

## D-013 — Session is locked to a single note by file identity

A dictation session locks to one `TFile` at start. Writes follow rename or move. Switching the active tab does not redirect writes. Closing the locked note ends the session via graceful stop. Deleting it cancels immediately. No resume across plugin reload, ever.

## D-014 — NoteSurface owns all editor writes; user-wins latch is absolute

A single `NoteSurface` is the only code permitted to edit the editor. Every write declares one of four capabilities (`record`, `append`, `replace_anchor`, `rewrite_region`). Once a user edit intersects an utterance's span, that span is latched and never receives plugin writes again — the journal continues to accumulate revisions, but they do not flow to the note.

## D-015 — Canonical transcript is immutable and revision-versioned

Transcripts are identified by `(utterance_id, revision)`. Each stage produces a new revision or records a Skipped/Failed outcome. Segments are the unit of truth; joined text is a projection. Speculative partials and the final engine result are revisions of the same utterance, distinguished by `is_final`. Post-engine stages run only on `is_final = true`. LLM whole-session rewrite is a separate `SessionRewrite` artifact.

## D-016 — Plugin owns the session journal

The session journal lives in the plugin: `Map<UtteranceId, Transcript>` plus an ordered traversal list. The sidecar emits revision events and forgets. The journal answers "what was dictated"; NoteSurface state answers "what's currently in the note." Crash recovery is a vault-adjacent temp file finalized per utterance.

## D-017 — Context is a typed plugin-assembled artifact

Engine and stage context is a `ContextWindow` assembled by the plugin, never an ad-hoc string. Sources have explicit budgets and ordering. Whisper prompts are built as `Glossary: term1, term2, …`, sized well under 224 tokens. Context never leaves the local process.
