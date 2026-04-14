# Rust-First Transcript Pipeline Architecture

## Context

The current architecture processes transcripts correctly but flattens segment structure too early (in TypeScript), losing timing metadata before any formatting could use it. The user wants to:

1. Move transcript processing logic into Rust so the engine becomes a reusable core independent of Obsidian
2. Enable advanced features: timestamps, punctuation/capitalization, hallucination filtering, ITN
3. Support future hosts (VS Code, Cursor, standalone app) without duplicating transcript logic
4. Preserve segment structure until late formatting

This plan defines the architecture and the first implementation step.

---

## A. Current State in This Repo

### Current Transcription Flow

```
Audio (stdin binary frames, PCM16 mono 16kHz 20ms)
    |
main.rs:run_stdio() -> AppState::handle_audio_frame()
    |
session.rs:ListeningSession::ingest_audio_frame() [VAD]
    |
worker.rs:WorkerCommand::TranscribeUtterance
    |
transcription.rs:engine.transcribe() -> Transcript { segments[], text }
    |
protocol.rs:Event::TranscriptReady { segments, text, ... }
    | [IPC stdout]
sidecar-connection.ts:handleStdoutChunk() -> dispatchEvent()
    |
dictation-session-controller.ts:handleTranscriptReady()
    |
normalizeTranscriptText() <- FLATTENING HAPPENS HERE
    |
EditorService.insertTranscript(text, insertionMode)
```

### Where Flattening Happens

**`src/dictation/dictation-session-controller.ts:440-457`**
```typescript
function normalizeTranscriptText(event: TranscriptReadyEvent): string {
  const text = event.text.trim();
  if (text.length > 0) return text;
  return event.segments.map((s) => s.text.trim()).join(' ').trim();
}
```

Segments are reduced to a single string. Timing metadata is discarded.

### Where Segment Metadata Is Lost

1. **Whisper backend** (`transcription.rs:134-141`) — Extracts only `start_timestamp()`, `end_timestamp()`, `to_string()`. Discards: word-level timing, confidence scores, `no_speech_prob`.

2. **Cohere backend** (`cohere.rs:91-94`) — Returns `segments: Vec::new()`. No timing at all.

3. **TypeScript** (`normalizeTranscriptText`) — Joins segment text, discards timing entirely.

### Settings Currently in TypeScript

| Setting | Location | Flows to Rust? |
|---------|----------|----------------|
| `listeningMode` | plugin-settings.ts | Yes (StartSession) |
| `pauseWhileProcessing` | plugin-settings.ts | Yes (StartSession) |
| `accelerationPreference` | plugin-settings.ts | Yes (StartSession) |
| `selectedModel` | plugin-settings.ts | Yes (StartSession) |
| `insertionMode` | plugin-settings.ts | No (host-only) |
| `modelStorePathOverride` | plugin-settings.ts | Yes (StartSession) |

### Logic Currently in Wrong Layer

| Logic | Current Location | Should Be |
|-------|------------------|-----------|
| Segment flattening | TS (normalizeTranscriptText) | Rust (Formatter) |
| Text trimming | TS | Rust |
| Segment fallback join | TS | Rust |
| *Future:* punctuation | Would be TS | Rust |
| *Future:* timestamps | Would be TS | Rust |

---

## B. Existing Sidecar Contract

### Request Types

**StartSession command** (`protocol.rs:148-161`):
```rust
Command::StartSession {
    acceleration_preference: AccelerationPreference,
    language: String,
    mode: ListeningMode,
    model_selection: SelectedModel,
    model_store_path_override: Option<String>,
    pause_while_processing: bool,
    session_id: String,
}
```

No processing config. No output format option.

### Response Types

**TranscriptReady event** (`protocol.rs:306-315`):
```rust
Event::TranscriptReady {
    processing_duration_ms: u64,
    segments: Vec<TranscriptSegment>,
    session_id: String,
    text: String,
    utterance_duration_ms: u64,
}
```

**TranscriptSegment** (`protocol.rs:118-125`):
```rust
pub struct TranscriptSegment {
    pub end_ms: u64,
    pub start_ms: u64,
    pub text: String,
}
```

### What Metadata Is Present

- Segment timing: `start_ms`, `end_ms` (Whisper only, Cohere returns empty)
- Processing duration: `processing_duration_ms`
- Utterance duration: `utterance_duration_ms`

### What Metadata Is Missing

- **Confidence/probability**: whisper-rs exposes this but we don't capture it
- **Word-level timing**: whisper-rs supports `word_timestamps=True` but not captured
- **`no_speech_prob`**: available from whisper but not captured
- **Provider metadata**: no engine-specific context flows through
- **Processing config**: no way to request timestamp format, filtering, etc.
- **Output format**: always returns `text` + `segments[]`, no format options

### Protocol Constraints / Technical Debt

1. **Cohere has no segments** — Intentional for now (no aligned timing), but limits features
2. **No processing pipeline** — Raw transcription only
3. **Tight coupling** — `text` field duplicates segment content; either should be derivable from the other
4. **No extensibility** — Adding new metadata requires protocol version bump

---

## C. Recommended Target Design

### Engine vs Host Responsibilities

| Responsibility | Owner | Rationale |
|----------------|-------|-----------|
| Audio decoding | Engine | Protocol-level |
| VAD / speech detection | Engine | Already there |
| Inference | Engine | Already there |
| Segment preservation | Engine | Core semantic |
| Provider metadata extraction | Engine | Engine-specific |
| Segment-level filtering | Engine | Needs metadata |
| Text normalization (punct, caps, ITN) | Engine | Cross-platform consistency |
| Formatting (timestamps, plain text) | Engine | Core semantic |
| Final text output | Engine | Single source of truth |
| Settings UI | Host | Platform-specific |
| Settings persistence | Host | Platform-specific |
| Constructing request payloads | Host | Adapter layer |
| Inserting transcript into editor | Host | Platform-specific |

### Request/Response Contract

**Extended StartSession command:**
```
StartSession {
    // existing fields...
    processing: ProcessingConfig,  // NEW
    output_format: OutputFormat,   // NEW
}
```

**Extended TranscriptReady event:**
```
TranscriptReady {
    // existing fields...
    formatted_text: String,        // NEW: replaces `text` as primary output
    segments: Vec<Segment>,        // EXTENDED: optional metadata
    provider_context: Option<...>, // NEW: engine-specific metadata
}
```

### Transcript / Segment Data Model

```
Segment {
    start_ms: u64,
    end_ms: u64,
    text: String,
    // Optional extended metadata (filled when available):
    confidence: Option<f32>,
    no_speech_prob: Option<f32>,
    words: Option<Vec<WordTiming>>,
    flags: SegmentFlags,  // filtered, hallucination, etc.
}

WordTiming {
    start_ms: u64,
    end_ms: u64,
    word: String,
    probability: Option<f32>,
}
```

### Provider Metadata Model

```
ProviderContext {
    engine_id: EngineId,
    model_id: String,
    // Engine-specific metadata that processors might use:
    whisper: Option<WhisperContext>,
    cohere: Option<CohereContext>,
}

WhisperContext {
    language_detected: Option<String>,
    language_probability: Option<f32>,
}
```

### Processing Config Model

```
ProcessingConfig {
    // Phase 1: Segment-level
    hallucination_filter: HallucinationFilterConfig,
    silence_filter: SilenceFilterConfig,
    repetition_filter: RepetitionFilterConfig,
    
    // Phase 2: Text transforms
    punctuation: PunctuationConfig,
    capitalization: CapitalizationConfig,
    inverse_text_normalization: ItnConfig,
    whitespace: WhitespaceConfig,
    
    // Custom rules (future)
    user_rules: Vec<UserRule>,
}

HallucinationFilterConfig {
    enabled: bool,
    no_speech_threshold: Option<f32>,  // tunable, not canonical
    chars_per_second_max: Option<f32>, // tunable heuristic
}
```

### Formatter / Output Model

```
OutputFormat {
    format: FormatKind,
    timestamp_style: Option<TimestampStyle>,
}

FormatKind {
    PlainText,
    InlineTimestamps,
    SegmentsJson,
    // Future: Srt, Vtt
}

TimestampStyle {
    pattern: String,  // e.g., "[MM:SS]" or "[HH:MM:SS.mmm]"
    placement: TimestampPlacement,  // prefix, suffix, both
}
```

### Error Model

Extend existing `TranscriptionError` with processing-specific codes:
```
TranscriptionError {
    code: &'static str,  // "hallucination_detected", "processing_failed", etc.
    message: &'static str,
    details: Option<String>,
    recoverable: bool,  // NEW: can pipeline continue?
}
```

---

## D. Concrete Rust Type/Interface Sketch

### Core Types

```rust
// --- Processing Config (from host) ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProcessingConfig {
    #[serde(default)]
    pub segment_filters: SegmentFilterConfig,
    #[serde(default)]
    pub text_transforms: TextTransformConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SegmentFilterConfig {
    #[serde(default)]
    pub hallucination: HallucinationFilterSettings,
    #[serde(default)]
    pub repetition: RepetitionFilterSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HallucinationFilterSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_speech_prob_threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars_per_second: Option<f32>,
}

impl Default for HallucinationFilterSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            no_speech_prob_threshold: None,
            max_chars_per_second: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextTransformConfig {
    #[serde(default)]
    pub whitespace_normalize: bool,
    #[serde(default)]
    pub trim_segments: bool,
    // Future: punctuation, capitalization, ITN
}

// --- Output Format ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    #[default]
    PlainText,
    InlineTimestamps {
        pattern: String,
    },
    SegmentsJson,
}

// --- Extended Segment (internal) ---

#[derive(Debug, Clone)]
pub struct ProcessedSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub confidence: Option<f32>,
    pub no_speech_prob: Option<f32>,
    pub words: Option<Vec<WordTiming>>,
    pub flags: SegmentFlags,
}

#[derive(Debug, Clone, Default)]
pub struct SegmentFlags {
    pub filtered: bool,
    pub hallucination_suspected: bool,
    pub repetition_detected: bool,
}

#[derive(Debug, Clone)]
pub struct WordTiming {
    pub start_ms: u64,
    pub end_ms: u64,
    pub word: String,
    pub probability: Option<f32>,
}

// --- Provider Context ---

#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    pub engine_id: EngineId,
    pub whisper: Option<WhisperProviderContext>,
}

#[derive(Debug, Clone)]
pub struct WhisperProviderContext {
    pub language_detected: Option<String>,
    pub language_probability: Option<f32>,
}

// --- Processing Pipeline ---

pub trait SegmentProcessor: Send + Sync {
    fn process(
        &self,
        segments: Vec<ProcessedSegment>,
        context: &ProviderContext,
    ) -> Vec<ProcessedSegment>;
}

pub trait TextProcessor: Send + Sync {
    fn process(&self, text: &str) -> String;
}

pub trait Formatter: Send + Sync {
    fn format(&self, segments: &[ProcessedSegment]) -> String;
}

// --- Pipeline Orchestrator ---

pub struct TranscriptPipeline {
    segment_processors: Vec<Box<dyn SegmentProcessor>>,
    text_processors: Vec<Box<dyn TextProcessor>>,
    formatter: Box<dyn Formatter>,
}

impl TranscriptPipeline {
    pub fn from_config(config: &ProcessingConfig, format: &OutputFormat) -> Self {
        // Build processor chain from config
        todo!()
    }
    
    pub fn process(
        &self,
        segments: Vec<ProcessedSegment>,
        context: &ProviderContext,
    ) -> String {
        // Phase 1: segment-level
        let mut segments = segments;
        for processor in &self.segment_processors {
            segments = processor.process(segments, context);
        }
        
        // Format to text
        let mut text = self.formatter.format(&segments);
        
        // Phase 2: text transforms
        for processor in &self.text_processors {
            text = processor.process(&text);
        }
        
        text
    }
}
```

### Protocol Extension

```rust
// Extended StartSession command
Command::StartSession {
    // ... existing fields ...
    #[serde(default)]
    processing: ProcessingConfig,
    #[serde(default)]
    output_format: OutputFormat,
}

// Extended TranscriptReady event
Event::TranscriptReady {
    // ... existing fields ...
    formatted_text: String,  // Primary output, replaces `text` usage
    // `text` retained for backward compatibility
    // `segments` now includes extended metadata when available
}
```

---

## E. Migration Plan

### Smallest Safe Incremental Path

1. **PR 1: Protocol Types Only (design-only, no behavior change)**
   - Add `ProcessingConfig` and `OutputFormat` types to `protocol.rs`
   - Add optional fields to `StartSession` command (defaulting to current behavior)
   - Add `formatted_text` to `TranscriptReady` (initially = `text`)
   - Update TS protocol types to match
   - **No logic change** — just wire up the types
   - **Does NOT include**: internal types, traits, pipeline orchestrator, segment metadata fields
   - **Explicitly deferred**: `TranscriptSegment` metadata (`confidence`, `avg_logprob`, `no_speech_prob`) — add in PR 2+ when hallucination filter needs them

2. **PR 2: Internal Segment Model + Pipeline Traits**
   - Add `ProcessedSegment`, `ProviderContext` internal types
   - Add `SegmentProcessor`, `TextProcessor`, `Formatter` traits
   - Add `TranscriptPipeline` orchestrator (pass-through, no processors)
   - Add `PlainTextFormatter` (current behavior)
   - Modify `WhisperBackend::transcribe()` to populate extended metadata when available
   - Wire pipeline into worker thread (no processors enabled yet)
   - Verify no behavior change

3. **PR 3: First Processor (whitespace/trim) + TS Migration**
   - Add `WhitespaceProcessor` (existing `text.trim()` logic)
   - Enable by default via `TextTransformConfig::whitespace_normalize`
   - Move trim logic from TS to Rust
   - Update TS: use `formatted_text` when present, fall back to `text`

4. **PR 4+: Additional Features**
   - Hallucination filter
   - Inline timestamps formatter
   - etc.

### What Should Remain in TypeScript

- `insertionMode` handling (cursor/append/paragraph) — purely host UI
- Settings persistence to Obsidian `data.json`
- Editor manipulation (`replaceSelection`, cursor positioning)
- Status bar UI updates
- Session lifecycle UI (start/stop buttons)

### Where Adapters/Shims Are Acceptable

- **Protocol backward compat**: `text` field in `TranscriptReady` remains for old hosts
- **TS fallback**: If `formatted_text` is missing, fall back to `text` (transition period)
- **Cohere segments**: Empty until Slice 1 (synthetic segments) ships

---

## F. PR 1 Implementation Specification

### Scope

Protocol-facing types only. Zero behavior change. The narrowest safe contract that enables future PRs.

**Semantic contract established:**
- `formatted_text` = primary output (what hosts should insert into editors)
- `text` = legacy field for backward compatibility ONLY
- In PR 1: `formatted_text == text.clone()` (zero behavior change)

### Files to Touch

| File | Changes |
|------|---------|
| `native/sidecar/src/protocol.rs` | Add `ProcessingConfig`, `SegmentFilterConfig`, `TextTransformConfig`, `OutputFormat` types. Extend `Command::StartSession` with two new fields. Extend `Event::TranscriptReady` with `formatted_text`. Add 3 tests. |
| `native/sidecar/src/app.rs` | Wire `formatted_text` in `Event::TranscriptReady` emission (set to `transcript.text.clone()`). |
| `src/sidecar/protocol.ts` | Add TS interfaces for new config types. Extend `StartSessionCommand` and `TranscriptReadyEvent`. Update `parseEventFrame` for `transcript_ready` case to read `formattedText`. |
| `test/protocol.test.ts` | Add 3 tests for new fields. |

**Does NOT touch:**
- `transcription.rs` — Internal types come in PR 2
- `TranscriptSegment` — No metadata fields added (deferred)
- Any processing logic

### Rust Type Definitions

Add to `protocol.rs`:

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessingConfig {
    #[serde(default, rename = "segmentFilters")]
    pub segment_filters: SegmentFilterConfig,
    #[serde(default, rename = "textTransforms")]
    pub text_transforms: TextTransformConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentFilterConfig {
    // Empty for PR 1 - fields added in future PRs
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextTransformConfig {
    #[serde(default, rename = "whitespaceNormalize")]
    pub whitespace_normalize: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    #[default]
    PlainText,
}
```

### Command::StartSession Extension

Add two fields with `#[serde(default)]` for backward compatibility:

```rust
StartSession {
    // ... existing fields ...
    #[serde(rename = "outputFormat", default)]
    output_format: OutputFormat,
    #[serde(default)]
    processing: ProcessingConfig,
    // ... existing fields ...
},
```

### Event::TranscriptReady Extension

Add `formatted_text` field:

```rust
TranscriptReady {
    #[serde(rename = "formattedText")]
    formatted_text: String,
    // ... existing fields unchanged ...
},
```

Wire in `app.rs`:
```rust
events.push(Event::TranscriptReady {
    formatted_text: transcript.text.clone(),  // NEW
    processing_duration_ms,
    segments: transcript.segments,
    session_id: session_id.clone(),
    text: transcript.text,
    utterance_duration_ms,
});
```

### TranscriptSegment: No Changes

**Decision: Keep `TranscriptSegment` unchanged in PR 1.**

Rationale:
- `confidence` is too vague for cross-provider use
- `no_speech_prob` is provider-specific (Whisper only)
- Adding `Option<f32>` fields that are always `None` adds protocol noise without benefit
- Add `avg_logprob: Option<f32>` in PR 2 when hallucination filter actually needs it

### TypeScript Interface Changes

Add to `protocol.ts`:

```typescript
export interface ProcessingConfig {
  segmentFilters?: SegmentFilterConfig;
  textTransforms?: TextTransformConfig;
}

export interface SegmentFilterConfig {
  // Empty for PR 1
}

export interface TextTransformConfig {
  whitespaceNormalize?: boolean;
}

export type OutputFormat = 'plain_text';
```

Extend `StartSessionCommand`:
```typescript
export interface StartSessionCommand extends EnvelopeBase<'start_session'> {
  // ... existing fields ...
  outputFormat?: OutputFormat;
  processing?: ProcessingConfig;
}
```

Extend `TranscriptReadyEvent`:
```typescript
export interface TranscriptReadyEvent extends EnvelopeBase<'transcript_ready'> {
  formattedText: string;  // NEW - required
  // ... existing fields unchanged ...
}
```

Update `parseEventFrame` for `transcript_ready` case to read `formattedText`.

### Test Cases

**Rust (`protocol.rs`):**
1. `start_session_with_processing_config_round_trip` — New fields serialize/deserialize
2. `start_session_without_processing_config_uses_defaults` — Backward compat
3. `transcript_ready_event_includes_formatted_text` — New field in output

**TypeScript (`test/protocol.test.ts`):**
1. Parse `transcript_ready` with `formattedText`
2. Reject `transcript_ready` missing `formattedText`
3. Serialize `start_session` with processing config

### Verification

```bash
# Rust
cargo build --manifest-path native/sidecar/Cargo.toml
cargo test --manifest-path native/sidecar/Cargo.toml

# TypeScript
npm run typecheck
npm test

# Integration (manual)
# Start plugin, verify dictation still works identically
```

---

## G. Explicitly Deferred Items

| Item | Reason | Target PR |
|------|--------|-----------|
| `TranscriptSegment` metadata (`confidence`, `avg_logprob`, `no_speech_prob`) | Too vague/provider-specific without concrete use | PR 2 when hallucination filter needs it |
| Internal types: `ProcessedSegment`, `ProviderContext`, `WordTiming`, `SegmentFlags` | Internal implementation, not protocol | PR 2 |
| Traits: `SegmentProcessor`, `TextProcessor`, `Formatter` | Internal implementation | PR 2 |
| `TranscriptPipeline` orchestrator | Internal implementation | PR 2 |
| Whisper metadata extraction | Requires modifying `transcription.rs` | PR 2 |
| Additional `OutputFormat` variants | Protocol defines enum, implementation deferred | PR 4+ |
| Settings UI in TypeScript | No pipeline to configure yet | PR 3+ |
| Using `formattedText` in TS dictation controller | Requires TS consumer code change | PR 3 |
| Cohere synthetic segments | Separate backlog item (Slice 1) | Future |

---

## Assumptions

1. **Protocol v3 can be extended** — Adding optional fields with `#[serde(default)]` and `skip_serializing_if` is backward compatible
2. **Cohere segments remain empty** — Synthetic segments (backlog Slice 1) is separate work
3. **Performance is acceptable** — Pipeline overhead is minimal; profile if needed
4. **whisper-rs metadata extraction is feasible** — `no_speech_prob` and token logprobs are available via FFI, to be extracted in PR 2

## Decisions Made

1. **PR 1 scope**: Protocol types only. No segment metadata fields. Internal types come in PR 2.
2. **Metadata fields deferred**: `confidence` dropped as too vague. Use `avg_logprob: Option<f32>` when needed.
3. **Semantic clarity**: `formatted_text` is authoritative output; `text` is legacy compatibility only.
4. **TS migration**: PR 3 switches to `formatted_text` with fallback to `text`.
5. **Trait boundaries**: Defined in PR 2, may evolve based on first processor implementation.
