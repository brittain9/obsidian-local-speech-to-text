//! Placeholder processor used while the real post-engine stages are being
//! built (D-015). Always emits `Skipped { reason: "stage_not_implemented" }`
//! so the wire keeps a complete `stage_history` for the configured stage.

use crate::protocol::StageId;
use crate::transcription::Transcript;

use super::{StageContext, StageProcess, StageProcessor};

pub struct NoopProcessor {
    stage_id: StageId,
}

impl NoopProcessor {
    pub fn new(stage_id: StageId) -> Self {
        Self { stage_id }
    }
}

impl StageProcessor for NoopProcessor {
    fn id(&self) -> StageId {
        self.stage_id
    }

    fn process(&self, _transcript: &Transcript, _ctx: &StageContext<'_>) -> StageProcess {
        StageProcess::Skipped {
            reason: "stage_not_implemented".to_string(),
            payload: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities};
    use crate::protocol::{StageId, StageOutcome, StageStatus, TranscriptSegment};
    use crate::stages::StageEnablement;
    use uuid::Uuid;

    #[test]
    fn noop_processor_emits_skipped_stage_not_implemented() {
        let processor = NoopProcessor::new(StageId::HallucinationFilter);
        let caps = ModelFamilyCapabilities {
            supports_timed_segments: true,
            supports_initial_prompt: true,
            supports_language_selection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: None,
            produces_punctuation: true,
        };
        let enablement = StageEnablement::default();
        let ctx = StageContext {
            utterance_duration_ms: 0,
            family_capabilities: &caps,
            stage_enabled: &enablement,
        };
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![TranscriptSegment {
                end_ms: 0,
                start_ms: 0,
                text: String::new(),
            }],
            stage_history: vec![StageOutcome {
                duration_ms: 0,
                payload: None,
                revision_in: 0,
                revision_out: Some(0),
                stage_id: StageId::Engine,
                status: StageStatus::Ok,
            }],
        };

        let result = processor.process(&transcript, &ctx);
        assert_eq!(processor.id(), StageId::HallucinationFilter);
        match result {
            StageProcess::Skipped { reason, payload } => {
                assert_eq!(reason, "stage_not_implemented");
                assert!(payload.is_none());
            }
            other => panic!(
                "expected Skipped, got: {:?}",
                std::mem::discriminant(&other)
            ),
        }
    }
}
