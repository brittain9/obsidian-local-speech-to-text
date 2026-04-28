//! Drops silent-audio hallucinations and looped/junk segments before they
//! reach Obsidian (D-015 stage `hallucination_filter`).
//!
//! Rules (each segment is dropped if **any** rule matches):
//!   1. Blocklist — curated English phrases observed across whisper.cpp.
//!   2. Silence — `no_speech_prob > 0.6 AND avg_logprob < -1.0`.
//!   3. Compression — `compression_ratio > 2.4`.
//!   4. Repetition — any 3-gram repeated ≥ 3 times in the segment text.
//!
//! Rules 2 and 3 require the matching diagnostic to be present; without
//! diagnostics the filter falls back to text-only signals (1, 4, plus a
//! recomputed compression ratio).
//!
//! On `Ok`, payload carries `dropped_segments: [{ index, text, reason }]`
//! so dev tools can audit what the filter removed.

use serde::Serialize;
use serde_json::json;

use crate::protocol::{EngineStagePayload, SegmentDiagnostics, StageId, TranscriptSegment};
use crate::transcription::Transcript;

use super::consts::{
    AVG_LOGPROB_THRESHOLD, BARE_TOKEN_BLOCKLIST, COMPRESSION_RATIO_THRESHOLD,
    NGRAM_REPEAT_THRESHOLD, NGRAM_SIZE, NO_SPEECH_PROB_THRESHOLD, PHRASE_BLOCKLIST,
};
use super::diagnostics::compute_compression_ratio;
use super::{StageContext, StageProcess, StageProcessor};

#[derive(Default)]
pub struct HallucinationFilterStage;

impl HallucinationFilterStage {
    pub fn new() -> Self {
        Self
    }
}

impl StageProcessor for HallucinationFilterStage {
    fn id(&self) -> StageId {
        StageId::HallucinationFilter
    }

    fn process(&self, transcript: &Transcript, _ctx: &StageContext<'_>) -> StageProcess {
        let diagnostics = engine_segment_diagnostics(transcript);

        let mut kept: Vec<TranscriptSegment> = Vec::with_capacity(transcript.segments.len());
        let mut dropped: Vec<DroppedSegment> = Vec::new();

        for (index, segment) in transcript.segments.iter().enumerate() {
            let segment_diag = diagnostics.as_ref().and_then(|d| d.get(index));
            match classify_segment(segment, segment_diag) {
                Some(reason) => dropped.push(DroppedSegment {
                    index,
                    text: segment.text.clone(),
                    reason,
                }),
                None => kept.push(segment.clone()),
            }
        }

        if dropped.is_empty() {
            return StageProcess::Skipped {
                reason: "no_action".to_string(),
                payload: None,
            };
        }

        let payload = json!({ "droppedSegments": dropped });

        StageProcess::Ok {
            segments: kept,
            payload: Some(payload),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct DroppedSegment {
    index: usize,
    reason: DropReason,
    text: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum DropReason {
    Blocklist,
    Silence,
    Compression,
    Repetition,
}

fn classify_segment(
    segment: &TranscriptSegment,
    diagnostics: Option<&SegmentDiagnostics>,
) -> Option<DropReason> {
    let trimmed = segment.text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if matches_blocklist(trimmed) {
        return Some(DropReason::Blocklist);
    }

    if let Some(diag) = diagnostics
        && let (Some(no_speech_prob), Some(avg_logprob)) = (diag.no_speech_prob, diag.avg_logprob)
        && no_speech_prob > NO_SPEECH_PROB_THRESHOLD
        && avg_logprob < AVG_LOGPROB_THRESHOLD
    {
        return Some(DropReason::Silence);
    }

    let compression_ratio = diagnostics
        .map(|d| d.compression_ratio)
        .unwrap_or_else(|| compute_compression_ratio(trimmed));
    if compression_ratio > COMPRESSION_RATIO_THRESHOLD {
        return Some(DropReason::Compression);
    }

    if has_ngram_repetition(trimmed) {
        return Some(DropReason::Repetition);
    }

    None
}

fn matches_blocklist(trimmed: &str) -> bool {
    let lower = trimmed.to_lowercase();

    // Bare tokens require an exact post-trim match — bypass the
    // trailing-punctuation strip so "you." remains a legitimate utterance.
    if BARE_TOKEN_BLOCKLIST
        .iter()
        .any(|entry| lower == *entry || trimmed == *entry)
    {
        return true;
    }

    let stripped = lower.trim_end_matches(['.', '!', '?', '…']);
    PHRASE_BLOCKLIST.contains(&stripped)
}

fn has_ngram_repetition(trimmed: &str) -> bool {
    let tokens: Vec<String> = trimmed
        .split_whitespace()
        .map(|word| word.to_lowercase())
        .collect();

    if tokens.len() < NGRAM_SIZE {
        return false;
    }

    let mut counts: std::collections::HashMap<&[String], usize> = std::collections::HashMap::new();
    for window in tokens.windows(NGRAM_SIZE) {
        let entry = counts.entry(window).or_insert(0);
        *entry += 1;
        if *entry >= NGRAM_REPEAT_THRESHOLD {
            return true;
        }
    }

    false
}

fn engine_segment_diagnostics(transcript: &Transcript) -> Option<Vec<SegmentDiagnostics>> {
    let engine_stage = transcript.stage_history.first()?;
    if engine_stage.stage_id != StageId::Engine {
        return None;
    }
    let payload = engine_stage.payload.as_ref()?;
    let parsed: EngineStagePayload = serde_json::from_value(payload.clone()).ok()?;
    parsed.segment_diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities};
    use crate::protocol::{StageOutcome, StageStatus};
    use crate::stages::StageEnablement;
    use uuid::Uuid;

    fn caps() -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_timed_segments: true,
            supports_initial_prompt: true,
            supports_language_selection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: None,
            produces_punctuation: true,
        }
    }

    fn segment(text: &str) -> TranscriptSegment {
        TranscriptSegment {
            end_ms: 1_000,
            start_ms: 0,
            text: text.to_string(),
        }
    }

    fn diag(no_speech_prob: Option<f32>, avg_logprob: Option<f32>) -> SegmentDiagnostics {
        SegmentDiagnostics {
            avg_logprob,
            compression_ratio: 1.5,
            no_speech_prob,
            voiced_seconds: 1.0,
        }
    }

    fn run_filter(
        segments: Vec<TranscriptSegment>,
        diagnostics: Option<Vec<SegmentDiagnostics>>,
    ) -> (Transcript, StageProcess) {
        let payload = serde_json::to_value(EngineStagePayload {
            is_final: true,
            segment_diagnostics: diagnostics,
        })
        .unwrap();
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments,
            stage_history: vec![StageOutcome {
                duration_ms: 0,
                payload: Some(payload),
                revision_in: 0,
                revision_out: Some(0),
                stage_id: StageId::Engine,
                status: StageStatus::Ok,
            }],
        };
        let caps = caps();
        let enablement = StageEnablement::default();
        let ctx = StageContext {
            utterance_duration_ms: 1_000,
            family_capabilities: &caps,
            stage_enabled: &enablement,
        };
        let result = HallucinationFilterStage::new().process(&transcript, &ctx);
        (transcript, result)
    }

    #[test]
    fn blocklist_drops_phrase_segment() {
        let (_, result) = run_filter(vec![segment("Thanks for watching!")], None);
        let StageProcess::Ok { segments, payload } = result else {
            panic!("expected Ok, got non-Ok");
        };
        assert!(segments.is_empty());
        assert!(payload.unwrap().to_string().contains("blocklist"));
    }

    #[test]
    fn blocklist_match_is_case_insensitive_and_strips_trailing_punctuation() {
        let (_, result) = run_filter(vec![segment("THANK YOU...")], None);
        assert!(matches!(result, StageProcess::Ok { ref segments, .. } if segments.is_empty()));
    }

    #[test]
    fn bare_you_matches_only_when_entire_segment() {
        // "you" alone is hallucination-typical; "Are you sure?" is not.
        let (_, drop_result) = run_filter(vec![segment("you")], None);
        assert!(matches!(drop_result, StageProcess::Ok { .. }));

        let (_, keep_result) = run_filter(vec![segment("Are you sure?")], None);
        assert!(matches!(keep_result, StageProcess::Skipped { .. }));
    }

    #[test]
    fn silence_rule_requires_both_thresholds() {
        // no_speech_prob alone — must keep.
        let (_, only_no_speech) = run_filter(
            vec![segment("hello world")],
            Some(vec![diag(Some(0.95), Some(-0.5))]),
        );
        assert!(matches!(only_no_speech, StageProcess::Skipped { .. }));

        // avg_logprob alone — must keep.
        let (_, only_logprob) = run_filter(
            vec![segment("hello world")],
            Some(vec![diag(Some(0.4), Some(-1.5))]),
        );
        assert!(matches!(only_logprob, StageProcess::Skipped { .. }));

        // Both — drop.
        let (_, both) = run_filter(
            vec![segment("hello world")],
            Some(vec![diag(Some(0.95), Some(-1.5))]),
        );
        let StageProcess::Ok { segments, payload } = both else {
            panic!("both thresholds must trigger silence drop");
        };
        assert!(segments.is_empty());
        assert!(payload.unwrap().to_string().contains("silence"));
    }

    #[test]
    fn compression_rule_drops_loop_segments() {
        let loop_text = "ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha ha";
        let (_, result) = run_filter(vec![segment(loop_text)], None);
        let StageProcess::Ok { segments, payload } = result else {
            panic!("repetition loop should drop");
        };
        assert!(segments.is_empty());
        let body = payload.unwrap().to_string();
        // Either compression or repetition is acceptable — both are designed
        // to fire on this input and the wire just needs *some* dropped reason.
        assert!(body.contains("compression") || body.contains("repetition"));
    }

    #[test]
    fn repetition_rule_drops_three_repeated_3grams() {
        // Exactly 9 tokens forming three copies of the same 3-gram, but with
        // low compression ratio (varied surface text). Forces rule 4.
        let text = "alpha beta gamma alpha beta gamma alpha beta gamma";
        let (_, result) = run_filter(vec![segment(text)], None);
        assert!(matches!(result, StageProcess::Ok { ref segments, .. } if segments.is_empty()));
    }

    #[test]
    fn clean_segment_passes_through_unchanged() {
        let (_, result) = run_filter(
            vec![segment("This is a perfectly normal sentence.")],
            Some(vec![diag(Some(0.1), Some(-0.2))]),
        );
        let StageProcess::Skipped { reason, .. } = result else {
            panic!("clean segment must skip, got Ok");
        };
        assert_eq!(reason, "no_action");
    }

    #[test]
    fn multiple_rules_drop_multiple_segments_in_one_pass() {
        let (_, result) = run_filter(
            vec![
                segment("Thanks for watching!"),
                segment("This is fine."),
                segment("alpha beta gamma alpha beta gamma alpha beta gamma"),
            ],
            None,
        );
        let StageProcess::Ok { segments, payload } = result else {
            panic!("expected drops");
        };
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "This is fine.");
        let body = payload.unwrap().to_string();
        assert!(body.contains("blocklist"));
        assert!(body.contains("repetition"));
    }

    #[test]
    fn all_segments_dropped_emits_ok_with_empty_segments() {
        let (_, result) = run_filter(
            vec![segment("Thanks for watching!"), segment("Please subscribe")],
            None,
        );
        let StageProcess::Ok { segments, .. } = result else {
            panic!("expected Ok with empty segments");
        };
        assert!(segments.is_empty());
    }
}
