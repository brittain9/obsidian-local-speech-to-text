# Transcript Pipeline Architecture

## Current Pipeline

```
Sidecar Engine (Whisper / Cohere)
    |
    v
TranscriptReadyEvent { segments[], text, processingDurationMs, utteranceDurationMs }
    |
    v
normalizeTranscriptText()       -- trim text, fall back to joining segment texts
    |
    v
EditorService.insertTranscript() -- dispatch by InsertionMode (cursor / new line / new paragraph)
```

The current pipeline is direct: engine output is normalized to a string and inserted. There is no formatting step, no text processing, and no context-aware insertion. Cohere returns empty segments; only Whisper produces timing metadata.

## Target Pipeline

```
Sidecar Engine (Whisper / Cohere)
    |
    v
Transcript { segments[], text }  -- both engines produce segments with timing
    |
    v
TranscriptFormatter              -- selects output format: plain text, inline timestamps
    |
    v
TextProcessor[]                  -- composable text transforms (filtering, rules, capitalization)
    |
    v
Smart Insertion                  -- context-aware spacing and capitalization at cursor
```

### Why the Formatter Layer

The formatter converts a structured transcript into a formatted string based on user preference. It separates *what the engine produced* from *how the user wants to see it*. This is where timestamp formatting, subtitle output, and future format options live without touching engine or insertion code.

### Why the Processor Pipeline

The processor is a composable chain of text transforms that run after formatting. Each transform is a pure function: `string -> string`. This is where hallucination filtering, user-defined find/replace rules, and capitalization cleanup live. Transforms are independently testable and can be enabled/disabled without affecting each other.

### Why Input Chunking Matters

Listening mode and speech segmentation happen upstream of transcription. How audio is chunked affects transcription quality: cutting mid-phrase can produce worse results than waiting for a natural pause. VAD thresholds and sentence detection are upstream quality concerns that feed into this pipeline.

## Implementation Slices

| Slice | Branch | Dependency | Scope |
|---|---|---|---|
| 1. Cohere synthetic segments | `feat/cohere-segments` | none | Rust sidecar |
| 2. TranscriptFormatter layer | `feat/transcript-formatter` | none | TypeScript plugin |
| 3. TextProcessor pipeline | `feat/text-processor-pipeline` | Slice 2 | TypeScript plugin |
| 4. Smart cursor insertion | `feat/smart-insertion` | none | TypeScript plugin |
| 5. Inline timestamps | `feat/inline-timestamps` | Slices 1, 2 | TypeScript plugin |
| 6. Hallucination filtering | `feat/hallucination-filter` | Slice 3 | TypeScript plugin |
| 7. User text rules | `feat/user-text-rules` | Slice 3 | TypeScript plugin + settings UI |

## Out of Scope

- Speaker diarization (requires Python subprocess, far future)
- TTS / text-to-speech
- Mobile support
- Punctuation restoration via ML model (heavy dependency, evaluate later)
- SubRip/SRT subtitle export (niche, evaluate if requested)

## Key Files

| File | Role |
|---|---|
| `src/dictation/dictation-session-controller.ts` | Transcript handling, insertion point for formatter/processor |
| `src/editor/editor-service.ts` | Insertion dispatch |
| `src/editor/transcript-placement.ts` | Append placement calculations |
| `src/settings/plugin-settings.ts` | Settings interface and defaults |
| `native/src/cohere.rs` | Cohere backend (Slice 1 target) |
| `native/src/transcription.rs` | Transcript struct and TranscriptionBackend trait |
| `src/sidecar/protocol.ts` | TranscriptSegment and TranscriptReadyEvent types |
