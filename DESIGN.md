# Timestamp and Smart Paragraph Design

Draft design for PR 5 and PR 6. This document is product/UX guidance plus the
architectural stance needed to keep the implementation aligned.

## Goal

Local Transcript should produce readable Obsidian notes that feel closer to a
professional transcript than raw ASR output. This is not a feature for pinning
raw speech text into Obsidian. The user's speech should become structured,
readable notes.

The immediate feature pair is:

- Timestamp rendering: optional elapsed-time markers in the note.
- Smart separators: automatic paragraphing between dictated utterances.

These features must remain independent. A user should be able to use smart
paragraphing without timestamps, timestamps without smart paragraphing, or both
together. When both are enabled, they should compose into a TurboScribe-style
readable transcript: paragraphs with sparse inline timestamps.

The core product job is not captioning. It is preserving the structure of live
dictation inside an Obsidian note. Today, appending every utterance to the same
line loses the distinction between "I continued the same idea" and "I paused,
thought, then started a new idea." Smart paragraphs restore that structure.
Timestamps add rough elapsed-time landmarks so the user can see when an idea
happened in the session, including time spent silent.

The flagship default is designed for the primary user first: desktop, local,
Always On dictation, long-form thinking, and Obsidian notes. Low-performance PCs
still matter, but the product should not weaken the main experience by silently
discarding audio or hiding timing gaps. Queueing and backpressure are the honest
resource-control mechanism.

## Industry References

| Product | Relevant behavior | Source |
| --- | --- | --- |
| TurboScribe | Transcript view has a "Show Timestamps" control that hides or shows timestamps in the transcript document. Clicking transcript text can play the audio from that point. Basic export includes TXT, DOCX, and SRT; Advanced Export is the path for timestamps and more formats. The reference screenshot shows inline timestamps at paragraph/section starts, not caption-style blocks. | https://turboscribe.ai/blog/getting-started-with-turboscribe |
| Rev | Editor timestamps appear at the top of paragraphs and are clickable. Downloads can include no timestamps, inline timestamps, paragraph timestamps, or both. Rev says downloaded timestamps are visible at every speaker change or every 30 seconds. | https://support.rev.com/hc/en-us/articles/29824992702989-Transcription-Editor and https://support.rev.com/hc/en-us/articles/18896072561805-Transcription-Add-On-Services |
| Descript | Transcript export has timecode settings for interval frequency, paragraph-break timecodes, speaker-label timecodes, markers, and offset. This reinforces that timestamp density is an export/rendering concern, not canonical transcript text. | https://help.descript.com/hc/en-us/articles/10255753048589-Export-your-transcript-as-a-text-file |
| Trint | Timecodes are built into the transcript model, but visible timecodes are tied to paragraph starts. Creating new paragraphs causes timecodes to appear at paragraph starts when the setting is enabled. Users can disable "Show time at start of paragraph" for future exports. | https://info.trint.com/knowledge/can-i-adjust-a-timecode and https://info.trint.com/knowledge/exporting-trint-help-center |
| Otter | Export options include Show timestamps, Show speaker names, Combine paragraphs of the same speaker, and Combine all paragraphs. Otter groups speech into segments using speaker characteristics and timestamps. | https://help.otter.ai/hc/en-us/articles/360047733634-Export-conversations and https://help.otter.ai/hc/en-us/articles/360048322493-Transcription-processing-time-FAQ |
| Sonix | Sonix keeps word-level timestamps internally, lets users click words for playback, and exports timestamps at word, sentence, or paragraph level. Speaker changes are separated into paragraphs. Its style guidance recommends paragraph breaks where natural, often when a new speaker begins. | https://sonix.ai/faq, https://sonix.ai/features/automated-transcription, and https://help.sonix.ai/en/articles/1915853-do-you-have-a-style-guide |
| Happy Scribe | Transcript exports can include timecodes, timecode frequency, speaker labels, and label frequency when the selected export format supports those style preferences. | https://help.happyscribe.com/en/articles/8545201-transcript-editor-101 |
| Deepgram | Smart Format explicitly includes punctuation and paragraphs as readability improvements. | https://developers.deepgram.com/docs/smart-format |
| AssemblyAI | Its paragraphs endpoint creates transcript paragraphs using heuristics including speaking time, text length, and pauses. | https://support.assemblyai.com/articles/6346330423-how-are-paragraphs-created-for-the-%2Fparagraphs-endpoint |

The consistent pattern is: keep detailed timing internally, render readable prose
externally, and expose timestamps as a display/export choice.

This design should stay industry-aligned enough to be recognizable to users of
professional transcript tools, but it should not import every export-oriented
timestamp option into the live Obsidian writing surface.

## Product Position

This plugin is an Obsidian writing surface first. It should not make normal
notes look like caption files.

The default experience should feel like a professional note-taking transcript:
independent thoughts become paragraphs, continuous speech remains continuous
prose, and optional timestamps add elapsed-time context. Users can still choose
plain continuous text, but that is no longer the product's default posture.

Readable transcript output should be prose:

```text
(0:28) Goldman Sachs has rolled out a suite of downside protection ETFs as market volatility picks up. And as you can imagine, the market doesn't like this news. It creates uncertainty.

(0:39) Uncertainty with businesses, uncertainty with the economy, uncertainty with partnerships, and so on. And if there's one thing the market hates more than anything, it's the unknown.
```

Caption output is a separate future export concern:

```text
00:00:28,000 --> 00:00:34,000
Goldman Sachs has rolled out a suite of downside protection ETFs...
```

Do not let SRT/VTT conventions leak into the note-writing UX.

The intended live-note experience is:

- Smart paragraphs tell the user: these are separate thoughts.
- Timestamps tell the user: this thought happened around this point in the
  recording session.

A long pause should not render as an explicit pause annotation. It should create
a new paragraph, and if timestamps are enabled, the elapsed-time gap between
paragraph timestamps makes the pause understandable:

```text
(0:18) This is the first idea I was working through.

(2:41) This is where I came back after pausing and started a new idea.
```

That keeps the output useful as a note instead of turning it into system
telemetry.

## Timing Source

The first implementation should use VAD and session timing only. Do not use
Whisper segment timing, Whisper word timing, or any engine-specific timing path
for PR 5 or PR 6.

This keeps the behavior universal across Whisper, Cohere, and future engines.
The renderer should treat session-relative utterance timing as the stable source
of truth for note-facing timestamps:

- `utteranceStartMsInSession` anchors the rendered timestamp.
- `pauseMsBeforeUtterance` classifies the boundary before the utterance.
- Silence counts because timestamps represent elapsed session time, not only
  active speech time.

Engine-level segment and word timestamps remain future capabilities. They may
later support clickable playback, export formats, word confidence, or denser
alignment, but they are not needed for professional Obsidian notes in this
pass.

## Defaults

### Smart Paragraphing

Smart paragraphing should be on by default.

The default smart separator should emit only:

- A space for normal continuation.
- A blank-line paragraph break for a meaningful pause.

It should not emit a single newline by default. Single newlines make Markdown
look like broken captions and are weaker than either normal prose or real
paragraphs.

Keep fixed legacy separator modes available:

- Space
- New line
- New paragraph

But the shipped default should be Smart Paragraphs.

The user-facing setting should move away from "Phrase separator" language.
Prefer a product-level name such as `Transcript formatting`, with Smart
Paragraphs as the default option and fixed modes as explicit alternatives.

### Timestamps

Timestamps should be optional. The default for general Obsidian dictation should
remain clean prose without timestamps.

The first user-facing setting should be a single `Show timestamps` toggle. When
enabled, it uses the product default described below. Do not add density,
placement, or format controls in the first pass.

When enabled, timestamps should use one fixed format:

- `(M:SS)` below one hour, for example `(0:28)` or `(12:04)`.
- `(H:MM:SS)` at one hour or above, for example `(1:02:03)`.

Timestamps should be inline prefixes. Do not add settings for suffix placement,
own-line placement, bracket style, leading-zero variants, or milliseconds.

Timestamps should be session elapsed time, measured from the start of the active
recording or Always On session. Silence counts. This is important because one of
the timestamp's jobs is to make long pauses visible by showing the time gap
between separated ideas.

The timestamp toggle should add information, not change the underlying note
structure. Turning timestamps off should leave the same smart paragraphs without
the inline time markers.

## Timestamp Density

The best default is sparse timestamps:

- Always timestamp the first rendered transcript text.
- Timestamp every smart paragraph start.
- If a paragraph runs for a long time without a paragraph break, emit another
  inline timestamp at the next utterance boundary after roughly 30 seconds.

This matches the industry pattern:

- Rev uses speaker changes or every 30 seconds.
- Descript lets users choose interval timecodes and paragraph-break timecodes.
- Trint anchors visible timecodes to paragraph starts.
- Sonix supports paragraph-level timestamp exports despite retaining word-level
  timing internally.

Do not timestamp every utterance by default. That creates noisy notes and makes
the output feel like raw ASR chunks.

Do not expose timestamp density controls in PR 5. The default should be the
opinionated product behavior: sparse enough for notes, present enough to recover
rough timing. If real usage later shows a need for more control, the natural
extension is a small density setting such as:

- Paragraph starts only
- Paragraph starts plus 30-second landmarks
- Dense utterance landmarks

That future option should be a rendering policy layered over the same canonical
timing data, not a change to the transcript model.

## Smart Paragraph Rules

Use pause metadata as the primary signal for PR 6. Start conservative.

Recommended initial behavior:

- Pause below threshold: join with a space.
- Pause at or above threshold: start a new paragraph.
- Initial threshold: 2.5 to 3.0 seconds.

The first implementation does not need semantic topic detection. Later, once
there is punctuation and stronger text-stage context, the paragraphing logic can
consider sentence boundaries, speaker labels, and transcript length. For now,
pause duration is the high-signal local input.

Avoid adding a user-facing threshold setting until real usage shows that one
threshold is not viable.

## Session Modes and Backpressure

Always On is the flagship mode for this feature set. It is the mode where smart
paragraphing and sparse timestamps create the most value because the session
contains multiple utterances, pauses, and resumed thoughts.

One Sentence mode remains valid and should continue to work. It is mostly
orthogonal: it captures one utterance, transcribes it, then stops or times out
without speech. Smart paragraphing has little visible effect there because there
is usually no second utterance to separate.

There should be no pause-while-processing mode. Dropping audio while inference
is active conflicts with transcript quality and corrupts the mental model for
elapsed timestamps. If a machine falls behind, the application should queue,
surface backpressure, and eventually stop at saturation with a clear error
instead of silently losing speech.

## Interaction Between Features

Smart separators and timestamps are independent features, but they should share
the same boundary classification when both are active.

Conceptually:

- Smart separator decides whether the next utterance continues the current
  paragraph or starts a new paragraph.
- Timestamp rendering decides whether the next rendered text should carry a
  timestamp.
- When Smart Paragraphs starts a paragraph and timestamps are enabled, that
  paragraph starts with a timestamp.

This keeps the output coherent without coupling the settings.

Examples:

Smart paragraphing on, timestamps off:

```text
The market opened lower this morning after new tariff news. Banks moved first, and consumer names followed throughout the session.

Apple held up better than the rest of the group. Google bounced slightly after last week's sell-off.
```

Smart paragraphing on, timestamps on:

```text
(0:15) The market opened lower this morning after new tariff news. Banks moved first, and consumer names followed throughout the session.

(1:10) Apple held up better than the rest of the group. Google bounced slightly after last week's sell-off.
```

Fixed space separator, timestamps on:

```text
(0:15) The market opened lower this morning after new tariff news. Banks moved first, and consumer names followed throughout the session. (0:45) Investors are still watching volatility.
```

The fixed-space case is allowed, but it should not be the premium transcript
experience. The premium experience is Smart Paragraphs plus sparse timestamps.

## Rendering Architecture Direction

Rendered timestamp text is projection output, not canonical transcript text. The
canonical transcript should retain text, utterance timing, pause metadata,
segment metadata, and provenance. Note-facing formatting belongs in a renderer.

The renderer should work from a simple per-utterance policy:

```text
boundary prefix + optional timestamp prefix + utterance text
```

This direction matters because the pause metadata needed to choose the boundary
arrives with the next utterance. A trailing-separator model is a poor fit for
Smart Paragraphs and timestamps, because it tries to decide the previous
utterance's suffix before knowing how long the next pause was.

The implementation may refactor the existing insertion path to make this clean.
Do not preserve the old shape if it forces compensating conditionals or duplicate
boundary rules.

## PR Shape

### PR 5: Timestamp Rendering

Keep PR 5 narrow:

- Add a single timestamp rendering setting such as `showTimestamps`.
- Render timestamp text as projection output only.
- Use VAD/session timing only.
- Use fixed inline-prefix formatting.
- Emit timestamps for first text, long-pause boundaries, and roughly 30-second
  intervals.
- Measure timestamps as elapsed session time, including silence.
- Do not add timestamp format or placement settings.
- Do not add timestamp density settings.
- Do not expose word-level timestamp UI.
- Do not add engine-specific timing branches.

If PR 5 lands before Smart Paragraphs, it can still use the same long-pause
boundary rule that PR 6 will later use for paragraphing.

### PR 6: Smart Paragraphs

Keep PR 6 narrow:

- Add `smart` as the default separator mode.
- Use `pause_ms_before_utterance` to choose space or blank-line paragraph break.
- Keep old fixed separator modes.
- Avoid single-newline output in smart mode.
- Reuse the same long-pause boundary rule used by timestamp rendering.
- Do not add text-semantic paragraphing yet.

The DRY point matters: timestamp emission and smart paragraphing should not grow
separate copies of the pause threshold logic.

## Non-Goals

- No suffix timestamps.
- No own-line timestamp placement.
- No timestamp format dropdown.
- No timestamp density dropdown in the first pass.
- No millisecond display in notes.
- No per-word timestamp UI.
- No SRT/VTT-style note rendering.
- No explicit pause-duration annotations in notes.
- No user-facing pause-threshold control in the first pass.
- No LLM rewrite dependency for paragraphing.

## Open Questions

- Should the 30-second fallback interval be exactly 30 seconds to match Rev, or
  slightly longer for note-taking, such as 60 seconds?
- If users later ask for timestamp density control, should the first option be a
  simple density dropdown or a transcript/export mode separate from live notes?
- Once diarization exists, speaker changes should become paragraph boundaries
  and timestamp opportunities. That is future work, not part of PR 5 or PR 6.
