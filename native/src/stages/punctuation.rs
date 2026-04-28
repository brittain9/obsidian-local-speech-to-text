//! Capability-gated punctuation stage (D-015 stage `punctuation`).
//!
//! Today every active adapter reports `produces_punctuation = true`, so this
//! stage trusts the engine's inline punctuation and casing. Its only
//! intervention is an end-cap rule: when an utterance is long enough to be
//! a real thought (`utterance_duration_ms >= 1500`) and the joined text
//! does not terminate, append `.` to the last non-empty segment. This
//! addresses a Whisper-specific failure mode where short utterances drop
//! their trailing period.
//!
//! When the active family does not produce punctuation, this stage emits
//! `Skipped { reason: "no_engine_requires_pnc" }`. The full rule-based pass
//! (capitalize, filler-strip, spoken commands) lands when a non-PnC engine
//! is wired up.

use serde_json::json;

use crate::protocol::{StageId, TranscriptSegment};
use crate::transcription::Transcript;

use super::{StageContext, StageProcess, StageProcessor};

const END_CAP_MIN_DURATION_MS: u64 = 1_500;

#[derive(Default)]
pub struct PunctuationStage;

impl PunctuationStage {
    pub fn new() -> Self {
        Self
    }
}

impl StageProcessor for PunctuationStage {
    fn id(&self) -> StageId {
        StageId::Punctuation
    }

    fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
        if !ctx.family_capabilities.produces_punctuation {
            return StageProcess::Skipped {
                reason: "no_engine_requires_pnc".to_string(),
                payload: None,
            };
        }

        let joined = transcript.joined_text();
        if joined.is_empty()
            || ends_with_terminal(&joined)
            || ctx.utterance_duration_ms < END_CAP_MIN_DURATION_MS
        {
            return StageProcess::Skipped {
                reason: "engine_produces_pnc".to_string(),
                payload: None,
            };
        }

        let Some(segments) = append_end_cap(&transcript.segments) else {
            return StageProcess::Skipped {
                reason: "engine_produces_pnc".to_string(),
                payload: None,
            };
        };

        StageProcess::Ok {
            segments,
            payload: Some(json!({ "rule": "end_cap" })),
        }
    }
}

/// Whether `text` already terminates a sentence. Closing quotes and
/// brackets are stripped before the check so `He said "yes."` still counts
/// as terminated.
fn ends_with_terminal(text: &str) -> bool {
    let trimmed = text.trim_end_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | ')' | ']' | '}' | '\u{201C}' | '\u{201D}' | '\u{2018}' | '\u{2019}'
        )
    });
    matches!(trimmed.chars().last(), Some('.' | '!' | '?' | '\u{2026}'))
}

/// Clone `segments` and append `.` to the last non-empty segment. Returns
/// `None` only if every segment is empty — the caller already checks
/// `joined_text().is_empty()`, so this is defensive.
fn append_end_cap(segments: &[TranscriptSegment]) -> Option<Vec<TranscriptSegment>> {
    let last_idx = segments
        .iter()
        .rposition(|seg| !seg.text.trim().is_empty())?;

    let mut out: Vec<TranscriptSegment> = segments.to_vec();
    let target = &mut out[last_idx];
    target.text = format!("{}.", target.text.trim_end());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities};
    use crate::protocol::{EngineStagePayload, StageOutcome, StageStatus};
    use crate::stages::StageEnablement;
    use uuid::Uuid;

    fn whisper_caps() -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_timed_segments: true,
            supports_initial_prompt: true,
            supports_language_selection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: None,
            produces_punctuation: true,
        }
    }

    fn cohere_caps() -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_timed_segments: false,
            supports_initial_prompt: false,
            supports_language_selection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: Some(35.0),
            produces_punctuation: true,
        }
    }

    fn no_pnc_caps() -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_timed_segments: true,
            supports_initial_prompt: false,
            supports_language_selection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: None,
            produces_punctuation: false,
        }
    }

    fn segment(text: &str) -> TranscriptSegment {
        TranscriptSegment {
            end_ms: 1_000,
            start_ms: 0,
            text: text.to_string(),
        }
    }

    fn run_stage(
        segments: Vec<TranscriptSegment>,
        utterance_duration_ms: u64,
        caps: &ModelFamilyCapabilities,
    ) -> (Transcript, StageProcess) {
        let payload = serde_json::to_value(EngineStagePayload {
            is_final: true,
            segment_diagnostics: None,
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
        let enablement = StageEnablement::default();
        let ctx = StageContext {
            utterance_duration_ms,
            family_capabilities: caps,
            stage_enabled: &enablement,
        };
        let result = PunctuationStage::new().process(&transcript, &ctx);
        (transcript, result)
    }

    #[test]
    fn whisper_long_utterance_missing_terminal_gets_end_cap() {
        let (_, result) = run_stage(vec![segment("Just a quick note")], 2_000, &whisper_caps());
        let StageProcess::Ok { segments, payload } = result else {
            panic!("expected Ok with end-cap, got non-Ok");
        };
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Just a quick note.");
        assert_eq!(payload, Some(json!({ "rule": "end_cap" })));
    }

    #[test]
    fn whisper_utterance_terminated_with_question_mark_skips() {
        let (_, result) = run_stage(vec![segment("Are you ready?")], 2_000, &whisper_caps());
        let StageProcess::Skipped { reason, .. } = result else {
            panic!("expected Skipped for already-terminated text");
        };
        assert_eq!(reason, "engine_produces_pnc");
    }

    #[test]
    fn cohere_long_utterance_missing_terminal_gets_end_cap() {
        let (_, result) = run_stage(
            vec![segment("This was a Cohere transcription with no period")],
            3_000,
            &cohere_caps(),
        );
        let StageProcess::Ok { segments, payload } = result else {
            panic!("expected Ok with end-cap on Cohere path");
        };
        assert_eq!(
            segments[0].text,
            "This was a Cohere transcription with no period."
        );
        assert_eq!(payload, Some(json!({ "rule": "end_cap" })));
    }

    #[test]
    fn short_utterance_skips_even_when_missing_terminal() {
        let (_, result) = run_stage(vec![segment("hello there")], 1_200, &whisper_caps());
        let StageProcess::Skipped { reason, .. } = result else {
            panic!("expected Skipped for sub-1500ms utterance");
        };
        assert_eq!(reason, "engine_produces_pnc");
    }

    #[test]
    fn empty_segments_skip() {
        let (_, result) = run_stage(vec![], 2_000, &whisper_caps());
        let StageProcess::Skipped { reason, .. } = result else {
            panic!("expected Skipped for empty segments");
        };
        assert_eq!(reason, "engine_produces_pnc");

        let (_, only_whitespace) = run_stage(vec![segment("   ")], 2_000, &whisper_caps());
        assert!(matches!(only_whitespace, StageProcess::Skipped { .. }));
    }

    #[test]
    fn ellipsis_counts_as_terminal() {
        let (_, result) = run_stage(
            vec![segment("trailing off\u{2026}")],
            2_000,
            &whisper_caps(),
        );
        assert!(matches!(result, StageProcess::Skipped { .. }));
    }

    #[test]
    fn closing_quote_after_period_counts_as_terminal() {
        let (_, result) = run_stage(
            vec![segment("She said \u{201C}done.\u{201D}")],
            2_000,
            &whisper_caps(),
        );
        assert!(matches!(result, StageProcess::Skipped { .. }));
    }

    #[test]
    fn end_cap_appends_to_last_non_empty_segment_across_multiple_segments() {
        let (_, result) = run_stage(
            vec![
                segment("First clause"),
                segment("second clause"),
                segment("   "),
            ],
            2_500,
            &whisper_caps(),
        );
        let StageProcess::Ok { segments, .. } = result else {
            panic!("expected Ok with end-cap");
        };
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].text, "First clause");
        assert_eq!(segments[1].text, "second clause.");
        assert_eq!(segments[2].text, "   ");
    }

    #[test]
    fn non_pnc_family_skips_with_deferred_reason() {
        let (_, result) = run_stage(vec![segment("hello there")], 2_000, &no_pnc_caps());
        let StageProcess::Skipped { reason, .. } = result else {
            panic!("expected Skipped for non-PnC family");
        };
        assert_eq!(reason, "no_engine_requires_pnc");
    }
}
