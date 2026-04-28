//! Post-engine stage pipeline runner (D-009 / D-015).
//!
//! Stages are pure functions of `(Transcript, StageContext) -> StageProcess`.
//! The runner ([`run_post_engine`]) walks a fixed-order set of processors,
//! appends a `StageOutcome` per processor, bumps `Transcript.revision` on
//! `Ok`, and isolates panics so a buggy processor cannot break the chain.
//!
//! `StageEnablement` lets the worker disable individual stages without
//! removing them from the registry — disabled stages emit a uniform
//! `Skipped { reason: "stage_disabled" }` outcome so the wire keeps a
//! complete history.

use std::panic::{self, AssertUnwindSafe};
use std::time::Instant;

use crate::engine::capabilities::ModelFamilyCapabilities;
use crate::panic_util::format_panic_message;
use crate::protocol::{StageId, StageOutcome, StageStatus, TranscriptSegment};
use crate::transcription::Transcript;

pub mod noop;

/// Runtime knobs supplied per session. Each stage owns the meaning of its
/// own flag; the runner only reads `is_enabled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageEnablement {
    pub hallucination_filter: bool,
    pub punctuation: bool,
}

impl Default for StageEnablement {
    fn default() -> Self {
        Self {
            hallucination_filter: true,
            punctuation: true,
        }
    }
}

impl StageEnablement {
    /// Whether the runner should invoke the processor for `stage_id`. Stages
    /// not represented here (`Engine`, `UserRules`) default to enabled —
    /// only PR-2/PR-3 ship with real toggles.
    pub fn is_enabled(&self, stage_id: StageId) -> bool {
        match stage_id {
            StageId::HallucinationFilter => self.hallucination_filter,
            StageId::Punctuation => self.punctuation,
            StageId::Engine | StageId::UserRules => true,
        }
    }
}

/// Inputs a stage may inspect alongside the transcript revision.
pub struct StageContext<'a> {
    pub utterance_duration_ms: u64,
    pub family_capabilities: &'a ModelFamilyCapabilities,
    pub stage_enabled: &'a StageEnablement,
}

/// Result of running a single stage. Mirrors `StageStatus` plus the
/// stage-private outputs (rewritten segments + a typed payload). The runner
/// promotes `payload` to `StageOutcome.payload` and `segments` to the next
/// transcript revision.
pub enum StageProcess {
    Ok {
        segments: Vec<TranscriptSegment>,
        payload: Option<serde_json::Value>,
    },
    Skipped {
        reason: String,
        payload: Option<serde_json::Value>,
    },
    Failed {
        error: String,
        payload: Option<serde_json::Value>,
    },
}

/// Post-engine stage processor. Implementations must be deterministic given
/// `(Transcript, StageContext)` — the runner gives them no other inputs.
pub trait StageProcessor: Send + Sync {
    fn id(&self) -> StageId;
    fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess;
}

/// Run the post-engine processor chain against `transcript`. Mutates
/// `transcript.revision`/`segments`/`stage_history` in place. Panics inside
/// a processor are caught and surfaced as `StageOutcome { Failed }` so the
/// rest of the chain still runs.
///
/// The engine stage is appended *outside* this function (in
/// `worker::assemble_transcript`) — `processors` only covers the post-engine
/// stages and `transcript.stage_history` is expected to already contain the
/// engine outcome.
pub fn run_post_engine(
    transcript: &mut Transcript,
    processors: &[Box<dyn StageProcessor>],
    ctx: &StageContext<'_>,
) {
    for processor in processors {
        let stage_id = processor.id();
        let revision_in = transcript.revision;

        if !ctx.stage_enabled.is_enabled(stage_id) {
            transcript.stage_history.push(StageOutcome {
                duration_ms: 0,
                payload: None,
                revision_in,
                revision_out: None,
                stage_id,
                status: StageStatus::Skipped {
                    reason: "stage_disabled".to_string(),
                },
            });
            continue;
        }

        let started_at = Instant::now();
        let result = panic::catch_unwind(AssertUnwindSafe(|| processor.process(transcript, ctx)));
        let duration_ms = started_at.elapsed().as_millis() as u64;

        let outcome = match result {
            Ok(StageProcess::Ok { segments, payload }) => {
                let revision_out = revision_in.saturating_add(1);
                transcript.revision = revision_out;
                transcript.segments = segments;
                StageOutcome {
                    duration_ms,
                    payload,
                    revision_in,
                    revision_out: Some(revision_out),
                    stage_id,
                    status: StageStatus::Ok,
                }
            }
            Ok(StageProcess::Skipped { reason, payload }) => StageOutcome {
                duration_ms,
                payload,
                revision_in,
                revision_out: None,
                stage_id,
                status: StageStatus::Skipped { reason },
            },
            Ok(StageProcess::Failed { error, payload }) => StageOutcome {
                duration_ms,
                payload,
                revision_in,
                revision_out: None,
                stage_id,
                status: StageStatus::Failed { error },
            },
            Err(panic_payload) => StageOutcome {
                duration_ms,
                payload: None,
                revision_in,
                revision_out: None,
                stage_id,
                status: StageStatus::Failed {
                    error: format_panic_message(panic_payload.as_ref(), "stage processor panicked"),
                },
            },
        };

        transcript.stage_history.push(outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities};
    use crate::protocol::{EngineStagePayload, TranscriptSegment};
    use serde_json::json;
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

    fn fresh_transcript() -> Transcript {
        Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![TranscriptSegment {
                end_ms: 1_000,
                start_ms: 0,
                text: "hello".to_string(),
            }],
            stage_history: vec![StageOutcome {
                duration_ms: 0,
                payload: Some(serde_json::to_value(EngineStagePayload { is_final: true }).unwrap()),
                revision_in: 0,
                revision_out: Some(0),
                stage_id: StageId::Engine,
                status: StageStatus::Ok,
            }],
        }
    }

    struct RecordingProcessor {
        id: StageId,
        result: fn() -> StageProcess,
    }

    impl StageProcessor for RecordingProcessor {
        fn id(&self) -> StageId {
            self.id
        }
        fn process(&self, _transcript: &Transcript, _ctx: &StageContext<'_>) -> StageProcess {
            (self.result)()
        }
    }

    struct PanicProcessor;

    impl StageProcessor for PanicProcessor {
        fn id(&self) -> StageId {
            StageId::HallucinationFilter
        }
        fn process(&self, _transcript: &Transcript, _ctx: &StageContext<'_>) -> StageProcess {
            panic!("synthetic stage panic");
        }
    }

    fn run(
        transcript: &mut Transcript,
        processors: Vec<Box<dyn StageProcessor>>,
        enablement: StageEnablement,
    ) {
        let caps = whisper_caps();
        let ctx = StageContext {
            utterance_duration_ms: 1_000,
            family_capabilities: &caps,
            stage_enabled: &enablement,
        };
        run_post_engine(transcript, &processors, &ctx);
    }

    #[test]
    fn ok_bumps_revision_and_replaces_segments() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            result: || StageProcess::Ok {
                segments: vec![TranscriptSegment {
                    end_ms: 1_000,
                    start_ms: 0,
                    text: "filtered".to_string(),
                }],
                payload: Some(json!({ "rule": "test" })),
            },
        })];

        run(&mut transcript, processors, StageEnablement::default());

        assert_eq!(transcript.revision, 1);
        assert_eq!(transcript.segments[0].text, "filtered");
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.stage_id, StageId::HallucinationFilter);
        assert_eq!(outcome.status, StageStatus::Ok);
        assert_eq!(outcome.revision_in, 0);
        assert_eq!(outcome.revision_out, Some(1));
        assert_eq!(outcome.payload, Some(json!({ "rule": "test" })));
    }

    #[test]
    fn skipped_leaves_revision_and_segments_unchanged() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::Punctuation,
            result: || StageProcess::Skipped {
                reason: "no_action".to_string(),
                payload: None,
            },
        })];

        run(&mut transcript, processors, StageEnablement::default());

        assert_eq!(transcript.revision, 0);
        assert_eq!(transcript.segments[0].text, "hello");
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.stage_id, StageId::Punctuation);
        assert!(matches!(outcome.status, StageStatus::Skipped { .. }));
        assert_eq!(outcome.revision_out, None);
    }

    #[test]
    fn failed_leaves_revision_and_segments_unchanged() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::UserRules,
            result: || StageProcess::Failed {
                error: "boom".to_string(),
                payload: None,
            },
        })];

        run(&mut transcript, processors, StageEnablement::default());

        assert_eq!(transcript.revision, 0);
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.stage_id, StageId::UserRules);
        assert!(matches!(&outcome.status, StageStatus::Failed { error } if error == "boom"));
        assert_eq!(outcome.revision_out, None);
    }

    #[test]
    fn panicking_processor_is_caught_and_chain_continues() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![
            Box::new(PanicProcessor),
            Box::new(RecordingProcessor {
                id: StageId::Punctuation,
                result: || StageProcess::Skipped {
                    reason: "after_panic".to_string(),
                    payload: None,
                },
            }),
        ];

        run(&mut transcript, processors, StageEnablement::default());

        assert_eq!(transcript.stage_history.len(), 3);
        let panic_outcome = &transcript.stage_history[1];
        assert_eq!(panic_outcome.stage_id, StageId::HallucinationFilter);
        assert!(matches!(&panic_outcome.status, StageStatus::Failed { .. }));
        let next_outcome = &transcript.stage_history[2];
        assert_eq!(next_outcome.stage_id, StageId::Punctuation);
        assert!(
            matches!(&next_outcome.status, StageStatus::Skipped { reason } if reason == "after_panic")
        );
    }

    #[test]
    fn disabled_stage_emits_skipped_without_invoking_processor() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            // If this ran it would panic, proving the runner skipped it.
            result: || panic!("disabled stage must not be invoked"),
        })];

        run(
            &mut transcript,
            processors,
            StageEnablement {
                hallucination_filter: false,
                punctuation: true,
            },
        );

        assert_eq!(transcript.revision, 0);
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.stage_id, StageId::HallucinationFilter);
        assert!(
            matches!(&outcome.status, StageStatus::Skipped { reason } if reason == "stage_disabled")
        );
    }

    #[test]
    fn processors_run_in_input_order() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![
            Box::new(RecordingProcessor {
                id: StageId::HallucinationFilter,
                result: || StageProcess::Skipped {
                    reason: "first".to_string(),
                    payload: None,
                },
            }),
            Box::new(RecordingProcessor {
                id: StageId::Punctuation,
                result: || StageProcess::Skipped {
                    reason: "second".to_string(),
                    payload: None,
                },
            }),
            Box::new(RecordingProcessor {
                id: StageId::UserRules,
                result: || StageProcess::Skipped {
                    reason: "third".to_string(),
                    payload: None,
                },
            }),
        ];

        run(&mut transcript, processors, StageEnablement::default());

        let post = &transcript.stage_history[1..];
        assert_eq!(post.len(), 3);
        assert_eq!(post[0].stage_id, StageId::HallucinationFilter);
        assert_eq!(post[1].stage_id, StageId::Punctuation);
        assert_eq!(post[2].stage_id, StageId::UserRules);
    }
}
