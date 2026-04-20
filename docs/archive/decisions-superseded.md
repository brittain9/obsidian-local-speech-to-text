# Superseded Decisions

Decision entries kept here for "why not X" breadcrumb value. Active decisions live in `docs/decisions.md`.

---

## D-007: Transcript Pipeline Architecture

- Status: superseded by D-009
- Original decision: Insert a TranscriptFormatter and TextProcessor pipeline between engine output and editor insertion. Formatter selects output format (plain text, inline timestamps). Processor applies composable text transforms (filtering, user rules). Each layer ships in its own PR.
- Original rationale: The pipeline went directly from engine output to insertion with no formatting or processing step.
- Superseded because: the plugin/sidecar boundary is cleaner when the sidecar returns finished text rather than raw segments, and capability-gated fallbacks (e.g. VAD-derived timestamps when the model lacks word-level output) need access to data that only the sidecar has. See D-009 in `docs/decisions.md`.
