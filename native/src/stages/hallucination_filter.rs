use serde::Serialize;

use crate::audio_metadata::{VOICED_THRESHOLD, voiced_fraction};
use crate::protocol::{StageId, TranscriptSegment};
use crate::stages::{StageContext, StageProcess, StageProcessor};
use crate::transcription::{SegmentDiagnostics, Transcript};

const VERSION: u32 = 1;

// Strong corroborators — any one drops a SOFT phrase on a final revision and is
// the only path that drops a Normal-classified segment as silence. Tuned
// against PLANS.md "Runtime Signals" / "Classification Rules" — change these
// in lockstep with the plan.
const STRONG_NO_SPEECH_PROB: f32 = 0.60;
const STRONG_AVG_LOGPROB: f32 = -1.00;
const STRONG_VAD_VOICED_FRACTION: f32 = 0.10;
const STRONG_VAD_VOICED_MS: u64 = 200;

// Weak corroborators — ≥2 needed to drop a SOFT phrase, ≥1 needed for the
// repetition and prompt-leak rules. None of these alone may drop normal text.
const WEAK_VAD_VOICED_FRACTION: f32 = 0.35;
const WEAK_AVG_LOGPROB: f32 = -0.70;
const SHORT_VOICE_MS: u64 = 1_200;
const SHORT_VOICE_MIN_WORDS: usize = 3;

// Repetition / character-run thresholds.
const NGRAM_3_MIN_COUNT: usize = 3;
const NGRAM_5_MIN_COUNT: usize = 2;
const SUFFIX_MIN_REPEATS: usize = 3;
const PATHOLOGICAL_RUN: usize = 20;

// Prompt-leak window length, in words. Shorter spans are common in legitimate
// dictation and would otherwise cause false drops.
const PROMPT_LEAK_NGRAM: usize = 8;

pub struct HallucinationFilterStage;

impl StageProcessor for HallucinationFilterStage {
    fn id(&self) -> StageId {
        StageId::HallucinationFilter
    }

    fn runs_on_partials(&self) -> bool {
        true
    }

    fn needs_context(&self) -> bool {
        false
    }

    fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
        if !ctx.stage_enabled.hallucination_filter {
            return StageProcess::Skipped {
                reason: "disabled".to_string(),
                payload: None,
            };
        }

        // Normalize the prompt context once per revision; without this hoist
        // the prompt-leak rule would re-lowercase + re-split the same context
        // string for every segment.
        let normalized_context = ctx.context.map(|context| normalize_text(&context.text));

        let mut kept = Vec::with_capacity(transcript.segments.len());
        let mut dropped = Vec::new();

        for (index, segment) in transcript.segments.iter().enumerate() {
            let diagnostics = ctx.segment_diagnostics.get(index);
            let evidence = SegmentEvidence::from_segment(segment, diagnostics, ctx);
            if let Some(reason) = classify_drop(
                segment,
                &evidence,
                ctx.is_final,
                normalized_context.as_deref(),
            ) {
                dropped.push(DroppedSegment::from_segment(
                    index,
                    reason,
                    segment,
                    &evidence,
                    diagnostics,
                ));
            } else {
                kept.push(segment.clone());
            }
        }

        if dropped.is_empty() {
            StageProcess::Skipped {
                reason: "no_hallucinations".to_string(),
                payload: None,
            }
        } else {
            StageProcess::Ok {
                segments: kept,
                payload: Some(
                    serde_json::to_value(FilterPayload {
                        version: VERSION,
                        dropped_segments: dropped,
                    })
                    .expect("hallucination payload should serialize"),
                ),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DropReason {
    BlocklistHard,
    BlocklistSoftCorroborated,
    PromptLeakCorroborated,
    Repetition,
    Silence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextClass {
    Hard,
    Normal,
    Soft,
}

#[derive(Debug, Clone)]
struct SegmentEvidence {
    avg_logprob: Option<f32>,
    decode_reached_eos: Option<bool>,
    no_speech_prob: Option<f32>,
    normalized_text: String,
    repeated_ngram: bool,
    repeated_suffix: bool,
    character_run: bool,
    vad_available: bool,
    segment_voiced_fraction: f32,
    segment_voiced_ms: u64,
    word_count: usize,
}

impl SegmentEvidence {
    fn from_segment(
        segment: &TranscriptSegment,
        diagnostics: Option<&SegmentDiagnostics>,
        ctx: &StageContext<'_>,
    ) -> Self {
        let duration_ms = segment.end_ms.saturating_sub(segment.start_ms);
        let segment_voiced_fraction = voiced_fraction(
            ctx.vad_probabilities,
            segment.start_ms,
            segment.end_ms,
            VOICED_THRESHOLD,
        );
        let segment_voiced_ms = ((duration_ms as f32) * segment_voiced_fraction).round() as u64;
        let normalized_text = normalize_text(&segment.text);
        let words = words(&normalized_text);
        let repeated_ngram = repeated_ngram_dominates(&words);
        let repeated_suffix = repeated_suffix_dominates(&words);
        let word_count = words.len();

        Self {
            avg_logprob: diagnostics.and_then(|d| d.avg_logprob),
            decode_reached_eos: diagnostics.and_then(|d| d.decode_reached_eos),
            no_speech_prob: diagnostics.and_then(|d| d.no_speech_prob),
            normalized_text,
            repeated_ngram,
            repeated_suffix,
            character_run: has_pathological_character_run(&segment.text),
            vad_available: !ctx.vad_probabilities.is_empty(),
            segment_voiced_fraction,
            segment_voiced_ms,
            word_count,
        }
    }

    fn has_any_corroborator(&self) -> bool {
        self.strong_whisper_silence()
            || self.strong_vad_silence()
            || self.weak_corroborator_count() > 0
    }

    fn strong_whisper_silence(&self) -> bool {
        matches!(
            (self.no_speech_prob, self.avg_logprob),
            (Some(no_speech), Some(avg_logprob))
                if no_speech >= STRONG_NO_SPEECH_PROB && avg_logprob <= STRONG_AVG_LOGPROB
        )
    }

    fn strong_vad_silence(&self) -> bool {
        self.vad_available
            && self.segment_voiced_fraction <= STRONG_VAD_VOICED_FRACTION
            && self.segment_voiced_ms <= STRONG_VAD_VOICED_MS
    }

    fn weak_corroborator_count(&self) -> u8 {
        let mut count = 0;
        if self.vad_available && self.segment_voiced_fraction < WEAK_VAD_VOICED_FRACTION {
            count += 1;
        }
        if self
            .avg_logprob
            .is_some_and(|value| value <= WEAK_AVG_LOGPROB)
        {
            count += 1;
        }
        if self.vad_available
            && self.segment_voiced_ms < SHORT_VOICE_MS
            && self.word_count > SHORT_VOICE_MIN_WORDS
        {
            count += 1;
        }
        if self.decode_reached_eos == Some(false) {
            count += 1;
        }
        count
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilterPayload {
    version: u32,
    dropped_segments: Vec<DroppedSegment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedSegment {
    index: usize,
    reason: DropReason,
    text: String,
    start_ms: u64,
    end_ms: u64,
    timestamp_source: crate::protocol::TimestampSource,
    timestamp_granularity: crate::protocol::TimestampGranularity,
    signals: DroppedSignals,
}

impl DroppedSegment {
    fn from_segment(
        index: usize,
        reason: DropReason,
        segment: &TranscriptSegment,
        evidence: &SegmentEvidence,
        diagnostics: Option<&SegmentDiagnostics>,
    ) -> Self {
        Self {
            index,
            reason,
            text: segment.text.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            timestamp_source: segment.timestamp_source,
            timestamp_granularity: segment.timestamp_granularity,
            signals: DroppedSignals {
                avg_logprob: evidence.avg_logprob,
                decode_reached_eos: evidence.decode_reached_eos,
                no_speech_prob: evidence.no_speech_prob,
                segment_voiced_fraction: evidence.segment_voiced_fraction,
                segment_voiced_ms: evidence.segment_voiced_ms,
                token_count: diagnostics.and_then(|d| d.token_count),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedSignals {
    #[serde(skip_serializing_if = "Option::is_none")]
    avg_logprob: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decode_reached_eos: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_speech_prob: Option<f32>,
    segment_voiced_fraction: f32,
    segment_voiced_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_count: Option<u32>,
}

fn classify_drop(
    segment: &TranscriptSegment,
    evidence: &SegmentEvidence,
    is_final: bool,
    normalized_context: Option<&str>,
) -> Option<DropReason> {
    let class = classify_text(&evidence.normalized_text, &segment.text);
    if class == TextClass::Hard {
        return Some(DropReason::BlocklistHard);
    }

    // Partial revisions only run the HARD subset — every rule below requires
    // diagnostics that may still be in flux on a non-final revision.
    if !is_final {
        return None;
    }

    if class == TextClass::Soft {
        let strong = evidence.strong_whisper_silence() || evidence.strong_vad_silence();
        let two_weak = evidence.weak_corroborator_count() >= 2;
        if strong || two_weak {
            return Some(DropReason::BlocklistSoftCorroborated);
        }
        return None;
    }

    // TextClass::Normal — only drop on hard model+VAD silence agreement, on
    // pathological repetition with a corroborator, or on a clear prompt leak.
    if evidence.strong_whisper_silence() && evidence.strong_vad_silence() {
        return Some(DropReason::Silence);
    }

    if (evidence.repeated_ngram || evidence.repeated_suffix || evidence.character_run)
        && evidence.has_any_corroborator()
    {
        return Some(DropReason::Repetition);
    }

    if is_prompt_leak(evidence, normalized_context) && evidence.has_any_corroborator() {
        return Some(DropReason::PromptLeakCorroborated);
    }

    None
}

fn classify_text(normalized: &str, raw: &str) -> TextClass {
    if raw.trim().is_empty() || is_punctuation_only(raw) {
        return TextClass::Hard;
    }

    if is_hard_nonspeech_tag(normalized) || is_caption_attribution(normalized) {
        return TextClass::Hard;
    }

    if is_soft_artifact(normalized) || is_bare_domain(normalized) {
        return TextClass::Soft;
    }

    TextClass::Normal
}

fn normalize_text(text: &str) -> String {
    let collapsed = text
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    collapsed
        .trim_matches(|ch: char| ch.is_ascii_punctuation() || ch.is_whitespace())
        .to_string()
}

fn is_punctuation_only(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_punctuation() || ch.is_whitespace())
}

fn is_hard_nonspeech_tag(normalized: &str) -> bool {
    matches!(
        normalized,
        "music" | "applause" | "laughter" | "noise" | "silence" | "blank audio"
    )
}

fn is_caption_attribution(normalized: &str) -> bool {
    ["subtitles by", "captions by", "transcribed by", "sync by"]
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
}

fn is_soft_artifact(normalized: &str) -> bool {
    matches!(
        normalized,
        "thank you"
            | "thanks"
            | "thank you for watching"
            | "thanks for watching"
            | "thank you for listening"
            | "goodbye"
            | "bye"
            | "bye bye"
            | "see you next time"
            | "please subscribe"
            | "like and subscribe"
            | "let me know in the comments"
            | "you"
    )
}

fn is_bare_domain(normalized: &str) -> bool {
    let text = normalized
        .strip_prefix("https://")
        .or_else(|| normalized.strip_prefix("http://"))
        .unwrap_or(normalized);
    !text.contains(' ')
        && text.contains('.')
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '/' | '_' | '?'))
}

fn words(text: &str) -> Vec<&str> {
    text.split_whitespace().collect()
}

fn repeated_ngram_dominates(words: &[&str]) -> bool {
    ngram_dominates(words, 3, NGRAM_3_MIN_COUNT) || ngram_dominates(words, 5, NGRAM_5_MIN_COUNT)
}

fn ngram_dominates(words: &[&str], size: usize, min_count: usize) -> bool {
    if words.len() < size * min_count {
        return false;
    }
    for window in words.windows(size) {
        let count = words
            .windows(size)
            .filter(|candidate| *candidate == window)
            .count();
        if count >= min_count && count * size >= words.len().div_ceil(2) {
            return true;
        }
    }
    false
}

fn repeated_suffix_dominates(words: &[&str]) -> bool {
    for size in 1..=words.len() / SUFFIX_MIN_REPEATS {
        let suffix = &words[words.len() - size..];
        let mut count = 0;
        let mut offset = words.len();
        while offset >= size && &words[offset - size..offset] == suffix {
            count += 1;
            offset -= size;
        }
        if count >= SUFFIX_MIN_REPEATS {
            return true;
        }
    }
    false
}

fn has_pathological_character_run(text: &str) -> bool {
    let mut previous = None;
    let mut run = 0;
    for ch in text.chars() {
        if Some(ch) == previous {
            run += 1;
        } else {
            previous = Some(ch);
            run = 1;
        }
        if run >= PATHOLOGICAL_RUN && !ch.is_whitespace() {
            return true;
        }
    }
    false
}

fn is_prompt_leak(evidence: &SegmentEvidence, normalized_context: Option<&str>) -> bool {
    let Some(normalized_context) = normalized_context else {
        return false;
    };
    if evidence.normalized_text.starts_with("glossary:") {
        return true;
    }

    let context_words = words(normalized_context);
    let segment_words = words(&evidence.normalized_text);
    if context_words.len() < PROMPT_LEAK_NGRAM || segment_words.len() < PROMPT_LEAK_NGRAM {
        return false;
    }

    context_words.windows(PROMPT_LEAK_NGRAM).any(|span| {
        segment_words
            .windows(PROMPT_LEAK_NGRAM)
            .any(|candidate| candidate == span)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_metadata::VoiceActivityEvidence;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities};
    use crate::protocol::{ContextWindow, TimestampGranularity, TimestampSource};
    use crate::stages::StageEnablement;
    use uuid::Uuid;

    fn segment(text: &str) -> TranscriptSegment {
        TranscriptSegment {
            end_ms: 1_000,
            start_ms: 0,
            text: text.to_string(),
            timestamp_granularity: TimestampGranularity::Segment,
            timestamp_source: TimestampSource::Engine,
        }
    }

    fn transcript(text: &str) -> Transcript {
        Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![segment(text)],
            stage_history: Vec::new(),
        }
    }

    fn ctx<'a>(
        diagnostics: &'a [SegmentDiagnostics],
        vad_probabilities: &'a [f32],
        context: Option<&'a ContextWindow>,
        is_final: bool,
    ) -> StageContext<'a> {
        StageContext {
            context,
            family_capabilities: &CAPS,
            stage_enabled: &ENABLEMENT,
            is_final,
            segment_diagnostics: diagnostics,
            vad_probabilities,
            voice_activity: &VOICE,
        }
    }

    static CAPS: ModelFamilyCapabilities = ModelFamilyCapabilities {
        supports_segment_timestamps: true,
        supports_word_timestamps: false,
        supports_initial_prompt: true,
        supports_language_selection: false,
        supported_languages: LanguageSupport::EnglishOnly,
        max_audio_duration_secs: None,
        produces_punctuation: true,
    };
    static ENABLEMENT: StageEnablement = StageEnablement {
        hallucination_filter: true,
    };
    static VOICE: VoiceActivityEvidence = VoiceActivityEvidence {
        audio_start_ms: 0,
        audio_end_ms: 1_000,
        speech_start_ms: 0,
        speech_end_ms: 1_000,
        voiced_ms: 1_000,
        unvoiced_ms: 0,
        mean_probability: 0.9,
        max_probability: 1.0,
    };

    #[test]
    fn hard_drops_punctuation_and_sound_tags() {
        assert_eq!(classify_text("", " ... "), TextClass::Hard);
        assert_eq!(
            classify_text(&normalize_text("[music]"), "[music]"),
            TextClass::Hard
        );
        assert_eq!(
            classify_text(&normalize_text("[project x]"), "[project x]"),
            TextClass::Normal
        );
    }

    #[test]
    fn hard_drops_caption_attributions() {
        assert_eq!(
            classify_text(&normalize_text("Subtitles by Amara"), "Subtitles by Amara"),
            TextClass::Hard
        );
    }

    #[test]
    fn soft_phrases_do_not_drop_without_corroboration() {
        let result =
            HallucinationFilterStage.process(&transcript("Thank you."), &ctx(&[], &[], None, true));
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations")
        );
    }

    #[test]
    fn soft_phrase_drops_with_strong_whisper_silence() {
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-1.2),
            no_speech_prob: Some(0.72),
            token_count: Some(2),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage.process(
            &transcript("Thank you."),
            &ctx(&diagnostics, &[], None, true),
        );
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn partial_revisions_run_hard_rules_only() {
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-1.2),
            no_speech_prob: Some(0.72),
            token_count: Some(2),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage.process(
            &transcript("Thank you."),
            &ctx(&diagnostics, &[], None, false),
        );
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations")
        );

        let result =
            HallucinationFilterStage.process(&transcript("[noise]"), &ctx(&[], &[], None, false));
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn normal_text_with_low_vad_is_kept() {
        let result = HallucinationFilterStage.process(
            &transcript("Please subscribe to the newsletter"),
            &ctx(&[], &[0.0; 50], None, true),
        );
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations")
        );
    }

    #[test]
    fn repetition_drops_only_with_corroboration() {
        let text = "hello world again hello world again hello world again";
        let result =
            HallucinationFilterStage.process(&transcript(text), &ctx(&[], &[], None, true));
        assert!(matches!(result, StageProcess::Skipped { .. }));

        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-0.8),
            no_speech_prob: None,
            token_count: Some(9),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage
            .process(&transcript(text), &ctx(&diagnostics, &[], None, true));
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn prompt_leak_requires_context_and_corroboration() {
        let context = ContextWindow {
            budget_chars: 100,
            sources: Vec::new(),
            text: "Glossary: AlphaTerm, BetaTerm, GammaTerm, DeltaTerm".to_string(),
            truncated: false,
        };
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-0.8),
            no_speech_prob: None,
            token_count: Some(5),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage.process(
            &transcript("Glossary: AlphaTerm, BetaTerm"),
            &ctx(&diagnostics, &[], Some(&context), true),
        );
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn hard_drops_every_known_nonspeech_tag() {
        for tag in [
            "[music]",
            "[applause]",
            "[laughter]",
            "[noise]",
            "[silence]",
            "[blank audio]",
        ] {
            assert_eq!(
                classify_text(&normalize_text(tag), tag),
                TextClass::Hard,
                "{tag} should classify Hard",
            );
        }
    }

    #[test]
    fn bare_domain_classifies_soft_and_is_kept_without_corroboration() {
        assert_eq!(
            classify_text(&normalize_text("example.com"), "example.com"),
            TextClass::Soft,
        );
        // No corroborating diagnostics or VAD: a dictated URL stays.
        let result = HallucinationFilterStage
            .process(&transcript("example.com"), &ctx(&[], &[], None, true));
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations"),
        );
    }

    #[test]
    fn longer_sentence_containing_soft_phrase_is_normal() {
        assert_eq!(
            classify_text(
                &normalize_text("I said thank you after the call"),
                "I said thank you after the call",
            ),
            TextClass::Normal,
        );
    }

    #[test]
    fn bare_you_classifies_soft_and_is_kept_without_corroboration() {
        assert_eq!(
            classify_text(&normalize_text("you"), "you"),
            TextClass::Soft
        );
        let result =
            HallucinationFilterStage.process(&transcript("You."), &ctx(&[], &[], None, true));
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations"),
        );
    }

    #[test]
    fn soft_phrase_drops_with_strong_vad_silence() {
        // 50 frames at 10 ms each = 500 ms covered by VAD trace; all silent.
        let trace = [0.0_f32; 50];
        let result = HallucinationFilterStage
            .process(&transcript("Thank you."), &ctx(&[], &trace, None, true));
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn soft_phrase_drops_with_two_weak_corroborators() {
        // Weak corroborator 1: avg_logprob <= -0.70.
        // Weak corroborator 2: VAD voiced fraction < 0.35.
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-0.85),
            no_speech_prob: None,
            token_count: Some(2),
            decode_reached_eos: None,
        }];
        let trace = [0.0_f32; 50];
        let result = HallucinationFilterStage.process(
            &transcript("Thank you for watching."),
            &ctx(&diagnostics, &trace, None, true),
        );
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn soft_phrase_with_single_weak_corroborator_is_kept() {
        // Only one weak signal — avg_logprob below threshold, no VAD trace.
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-0.85),
            no_speech_prob: None,
            token_count: Some(2),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage.process(
            &transcript("Thank you."),
            &ctx(&diagnostics, &[], None, true),
        );
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations"),
        );
    }

    #[test]
    fn normal_text_drops_as_silence_only_when_both_strongs_agree() {
        let trace = [0.0_f32; 50];
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-1.5),
            no_speech_prob: Some(0.85),
            token_count: Some(6),
            decode_reached_eos: None,
        }];
        // Strong Whisper silence alone — kept (Normal class needs both).
        let result = HallucinationFilterStage.process(
            &transcript("the quick brown fox jumps"),
            &ctx(&diagnostics, &[], None, true),
        );
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations"),
        );

        // Both strongs — drops with reason `silence`.
        let result = HallucinationFilterStage.process(
            &transcript("the quick brown fox jumps"),
            &ctx(&diagnostics, &trace, None, true),
        );
        let StageProcess::Ok { payload, .. } = result else {
            panic!("expected Ok");
        };
        let dropped = payload
            .as_ref()
            .and_then(|p| p.get("droppedSegments"))
            .and_then(|v| v.as_array())
            .expect("payload has droppedSegments");
        assert_eq!(
            dropped[0].get("reason").and_then(|v| v.as_str()),
            Some("silence")
        );
    }

    #[test]
    fn five_gram_repetition_drops_with_corroboration() {
        let text = "alpha beta gamma delta epsilon alpha beta gamma delta epsilon \
                    alpha beta gamma delta epsilon";
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-0.85),
            no_speech_prob: None,
            token_count: Some(15),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage
            .process(&transcript(text), &ctx(&diagnostics, &[], None, true));
        assert!(matches!(result, StageProcess::Ok { .. }));
    }

    #[test]
    fn pathological_character_run_drops_with_corroboration() {
        let text = "a".repeat(40);
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-0.9),
            no_speech_prob: None,
            token_count: Some(1),
            decode_reached_eos: None,
        }];
        let result = HallucinationFilterStage
            .process(&transcript(&text), &ctx(&diagnostics, &[], None, true));
        assert!(matches!(result, StageProcess::Ok { .. }));

        // Without any corroborator the same pathological run is kept.
        let result =
            HallucinationFilterStage.process(&transcript(&text), &ctx(&[], &[], None, true));
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations"),
        );
    }

    #[test]
    fn disabled_filter_returns_skipped_disabled() {
        static OFF: StageEnablement = StageEnablement {
            hallucination_filter: false,
        };
        let ctx = StageContext {
            context: None,
            family_capabilities: &CAPS,
            stage_enabled: &OFF,
            is_final: true,
            segment_diagnostics: &[],
            vad_probabilities: &[],
            voice_activity: &VOICE,
        };
        let result = HallucinationFilterStage.process(&transcript("[music]"), &ctx);
        assert!(matches!(result, StageProcess::Skipped { reason, .. } if reason == "disabled"));
    }

    #[test]
    fn dropping_only_segment_returns_ok_with_empty_list() {
        let result =
            HallucinationFilterStage.process(&transcript("[music]"), &ctx(&[], &[], None, true));
        let StageProcess::Ok { segments, payload } = result else {
            panic!("expected Ok");
        };
        assert!(segments.is_empty());
        let dropped = payload
            .as_ref()
            .and_then(|p| p.get("droppedSegments"))
            .and_then(|v| v.as_array())
            .expect("payload has droppedSegments");
        assert_eq!(dropped.len(), 1);
    }

    #[test]
    fn payload_carries_reason_index_text_timing_and_signals() {
        let segment = TranscriptSegment {
            end_ms: 900,
            start_ms: 100,
            text: "Thank you for watching.".to_string(),
            timestamp_granularity: TimestampGranularity::Segment,
            timestamp_source: TimestampSource::Engine,
        };
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![segment],
            stage_history: Vec::new(),
        };
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-1.2),
            no_speech_prob: Some(0.72),
            token_count: Some(4),
            decode_reached_eos: Some(true),
        }];
        let result =
            HallucinationFilterStage.process(&transcript, &ctx(&diagnostics, &[], None, true));
        let StageProcess::Ok { payload, .. } = result else {
            panic!("expected Ok drop");
        };
        let payload = payload.expect("payload populated on drop");
        assert_eq!(payload.get("version").and_then(|v| v.as_u64()), Some(1));
        let dropped = payload
            .get("droppedSegments")
            .and_then(|v| v.as_array())
            .expect("droppedSegments");
        assert_eq!(dropped.len(), 1);
        let entry = &dropped[0];
        assert_eq!(entry.get("index").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(
            entry.get("reason").and_then(|v| v.as_str()),
            Some("blocklist_soft_corroborated"),
        );
        assert_eq!(
            entry.get("text").and_then(|v| v.as_str()),
            Some("Thank you for watching."),
        );
        assert_eq!(entry.get("startMs").and_then(|v| v.as_u64()), Some(100));
        assert_eq!(entry.get("endMs").and_then(|v| v.as_u64()), Some(900));
        assert_eq!(
            entry.get("timestampSource").and_then(|v| v.as_str()),
            Some("engine"),
        );
        assert_eq!(
            entry.get("timestampGranularity").and_then(|v| v.as_str()),
            Some("segment"),
        );
        let signals = entry.get("signals").expect("signals present");
        let no_speech = signals
            .get("noSpeechProb")
            .and_then(|v| v.as_f64())
            .expect("noSpeechProb populated");
        assert!((no_speech - 0.72).abs() < 1.0e-5, "got {no_speech}");
        assert_eq!(
            signals.get("decodeReachedEos").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(signals.get("tokenCount").and_then(|v| v.as_u64()), Some(4));
    }

    #[test]
    fn partial_revision_keeps_soft_phrase_even_with_strong_diagnostics() {
        let diagnostics = [SegmentDiagnostics {
            avg_logprob: Some(-1.4),
            no_speech_prob: Some(0.85),
            token_count: Some(2),
            decode_reached_eos: Some(false),
        }];
        let trace = [0.0_f32; 50];
        let result = HallucinationFilterStage.process(
            &transcript("Thank you."),
            &ctx(&diagnostics, &trace, None, false),
        );
        assert!(
            matches!(result, StageProcess::Skipped { reason, .. } if reason == "no_hallucinations"),
        );
    }

    #[test]
    fn dropping_first_segment_preserves_second_unchanged() {
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![
                TranscriptSegment {
                    end_ms: 500,
                    start_ms: 0,
                    text: "[music]".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                },
                TranscriptSegment {
                    end_ms: 1_000,
                    start_ms: 500,
                    text: "Hello world.".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                },
            ],
            stage_history: Vec::new(),
        };
        let result = HallucinationFilterStage.process(&transcript, &ctx(&[], &[], None, true));
        let StageProcess::Ok { segments, .. } = result else {
            panic!("expected Ok");
        };
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Hello world.");
        assert_eq!(segments[0].start_ms, 500);
        assert_eq!(segments[0].end_ms, 1_000);
    }
}
