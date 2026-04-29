//! Post-engine stage pipeline runner.
//!
//! Stages are pure functions of `(Transcript, StageContext) -> StageProcess`.
//! The runner ([`run_post_engine`]) walks a fixed-order set of processors,
//! appends a `StageOutcome` per processor, bumps `Transcript.revision` on
//! `Ok`, and isolates panics so a buggy processor cannot break the chain.
//!
//! Final-only stages are skipped with reason `partial` on partial revisions;
//! a stage opts into running on partials by overriding
//! [`StageProcessor::runs_on_partials`].
//!
//! `StageEnablement` carries per-session toggles. It is currently empty —
//! the first real toggle lands with the first real post-engine stage.

use std::panic::{self, AssertUnwindSafe};
use std::time::Instant;

use crate::engine::capabilities::ModelFamilyCapabilities;
use crate::panic_util::format_panic_message;
use crate::protocol::{StageId, StageOutcome, StageStatus, TranscriptSegment};
use crate::transcription::Transcript;

/// Per-session stage toggles. Empty until the first real post-engine stage
/// ships; future stages add their own field and read it through the
/// `StageProcessor`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StageEnablement;

/// Inputs a stage may inspect alongside the transcript revision.
pub struct StageContext<'a> {
    pub context: Option<&'a crate::protocol::ContextWindow>,
    pub utterance_duration_ms: u64,
    pub family_capabilities: &'a ModelFamilyCapabilities,
    pub stage_enabled: &'a StageEnablement,
    /// Whether the engine revision is final. The runner skips processors
    /// that do not opt into partial revisions when this is `false`.
    pub is_final: bool,
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
    fn runs_on_partials(&self) -> bool {
        false
    }
    fn needs_context(&self) -> bool {
        false
    }
    fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess;
}

pub fn any_registered_stage_needs_context() -> bool {
    false
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

        if !ctx.is_final && !processor.runs_on_partials() {
            transcript.stage_history.push(StageOutcome {
                duration_ms: 0,
                payload: None,
                revision_in,
                revision_out: None,
                stage_id,
                status: StageStatus::Skipped {
                    reason: "partial".to_string(),
                },
            });
            continue;
        }

        let started_at = Instant::now();
        let result = panic::catch_unwind(AssertUnwindSafe(|| processor.process(transcript, ctx)));
        let duration_ms = started_at.elapsed().as_millis() as u64;

        let outcome = match result {
            Ok(StageProcess::Ok { segments, payload }) => match validate_stage_segments(
                &segments,
                &transcript.segments,
                ctx.utterance_duration_ms,
            ) {
                Ok(()) => {
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
                Err(error) => StageOutcome {
                    duration_ms,
                    payload,
                    revision_in,
                    revision_out: None,
                    stage_id,
                    status: StageStatus::Failed { error },
                },
            },
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

/// Verify a stage's `Ok` output before promoting it to a new revision. Text
/// stages may drop segments or rewrite text inside the existing timing
/// boundaries; they must not move boundaries, overlap, or run past the
/// utterance duration.
fn validate_stage_segments(
    new_segments: &[TranscriptSegment],
    prior_segments: &[TranscriptSegment],
    utterance_duration_ms: u64,
) -> Result<(), String> {
    for segment in new_segments {
        if segment.start_ms > segment.end_ms {
            return Err(format!(
                "segment {}-{} ms has start past end",
                segment.start_ms, segment.end_ms,
            ));
        }
        if segment.end_ms > utterance_duration_ms {
            return Err(format!(
                "segment {}-{} ms extends past utterance duration {} ms",
                segment.start_ms, segment.end_ms, utterance_duration_ms,
            ));
        }
    }

    for window in new_segments.windows(2) {
        let prev = &window[0];
        let next = &window[1];
        if next.start_ms < prev.end_ms {
            return Err(format!(
                "segments {}-{} ms and {}-{} ms overlap or are out of order",
                prev.start_ms, prev.end_ms, next.start_ms, next.end_ms,
            ));
        }
    }

    for segment in new_segments {
        let preserved = prior_segments
            .iter()
            .any(|prior| prior.start_ms == segment.start_ms && prior.end_ms == segment.end_ms);
        if !preserved {
            return Err(format!(
                "segment {}-{} ms introduces timing boundaries not in the prior revision",
                segment.start_ms, segment.end_ms,
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities};
    use crate::protocol::{
        EngineStagePayload, TimestampGranularity, TimestampSource, TranscriptSegment,
    };
    use serde_json::json;
    use uuid::Uuid;

    fn whisper_caps() -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_segment_timestamps: true,
            supports_word_timestamps: false,
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
                timestamp_granularity: TimestampGranularity::Segment,
                timestamp_source: TimestampSource::Engine,
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
        runs_on_partials: bool,
    }

    impl StageProcessor for RecordingProcessor {
        fn id(&self) -> StageId {
            self.id
        }
        fn runs_on_partials(&self) -> bool {
            self.runs_on_partials
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

    fn run(transcript: &mut Transcript, processors: Vec<Box<dyn StageProcessor>>) {
        let caps = whisper_caps();
        let enablement = StageEnablement;
        let ctx = StageContext {
            context: None,
            utterance_duration_ms: 1_000,
            family_capabilities: &caps,
            stage_enabled: &enablement,
            is_final: true,
        };
        run_post_engine(transcript, &processors, &ctx);
    }

    fn run_partial(transcript: &mut Transcript, processors: Vec<Box<dyn StageProcessor>>) {
        let caps = whisper_caps();
        let enablement = StageEnablement;
        let ctx = StageContext {
            context: None,
            utterance_duration_ms: 1_000,
            family_capabilities: &caps,
            stage_enabled: &enablement,
            is_final: false,
        };
        run_post_engine(transcript, &processors, &ctx);
    }

    #[test]
    fn empty_processor_chain_leaves_engine_history_only() {
        let mut transcript = fresh_transcript();

        run(&mut transcript, Vec::new());

        assert_eq!(transcript.stage_history.len(), 1);
        assert_eq!(transcript.stage_history[0].stage_id, StageId::Engine);
        assert_eq!(transcript.revision, 0);
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
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                }],
                payload: Some(json!({ "rule": "test" })),
            },
            runs_on_partials: false,
        })];

        run(&mut transcript, processors);

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
            runs_on_partials: false,
        })];

        run(&mut transcript, processors);

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
            runs_on_partials: false,
        })];

        run(&mut transcript, processors);

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
                runs_on_partials: false,
            }),
        ];

        run(&mut transcript, processors);

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
    fn processors_run_in_input_order() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![
            Box::new(RecordingProcessor {
                id: StageId::HallucinationFilter,
                result: || StageProcess::Skipped {
                    reason: "first".to_string(),
                    payload: None,
                },
                runs_on_partials: false,
            }),
            Box::new(RecordingProcessor {
                id: StageId::Punctuation,
                result: || StageProcess::Skipped {
                    reason: "second".to_string(),
                    payload: None,
                },
                runs_on_partials: false,
            }),
            Box::new(RecordingProcessor {
                id: StageId::UserRules,
                result: || StageProcess::Skipped {
                    reason: "third".to_string(),
                    payload: None,
                },
                runs_on_partials: false,
            }),
        ];

        run(&mut transcript, processors);

        let post = &transcript.stage_history[1..];
        assert_eq!(post.len(), 3);
        assert_eq!(post[0].stage_id, StageId::HallucinationFilter);
        assert_eq!(post[1].stage_id, StageId::Punctuation);
        assert_eq!(post[2].stage_id, StageId::UserRules);
    }

    #[test]
    fn final_only_processor_is_skipped_on_partial_revision() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            result: || panic!("final-only processor must not run on partials"),
            runs_on_partials: false,
        })];

        run_partial(&mut transcript, processors);

        assert_eq!(transcript.revision, 0);
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.stage_id, StageId::HallucinationFilter);
        assert!(matches!(&outcome.status, StageStatus::Skipped { reason } if reason == "partial"));
    }

    #[test]
    fn partial_safe_processor_runs_on_partial_revision() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            result: || StageProcess::Skipped {
                reason: "partial_safe".to_string(),
                payload: None,
            },
            runs_on_partials: true,
        })];

        run_partial(&mut transcript, processors);

        let outcome = transcript.stage_history.last().unwrap();
        assert!(
            matches!(&outcome.status, StageStatus::Skipped { reason } if reason == "partial_safe")
        );
    }

    #[test]
    fn partial_revision_with_empty_chain_leaves_engine_history_only() {
        let mut transcript = fresh_transcript();

        run_partial(&mut transcript, Vec::new());

        assert_eq!(transcript.stage_history.len(), 1);
        assert_eq!(transcript.stage_history[0].stage_id, StageId::Engine);
        assert_eq!(transcript.revision, 0);
    }

    #[test]
    fn out_of_bounds_segment_yields_failed_without_mutating_transcript() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            result: || StageProcess::Ok {
                segments: vec![TranscriptSegment {
                    end_ms: 5_000,
                    start_ms: 0,
                    text: "overrun".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                }],
                payload: Some(json!({ "tried": "overrun" })),
            },
            runs_on_partials: false,
        })];

        run(&mut transcript, processors);

        assert_eq!(transcript.revision, 0);
        assert_eq!(transcript.segments[0].text, "hello");
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.stage_id, StageId::HallucinationFilter);
        assert!(
            matches!(&outcome.status, StageStatus::Failed { error } if error.contains("utterance duration"))
        );
        assert_eq!(outcome.payload, Some(json!({ "tried": "overrun" })));
    }

    #[test]
    fn boundary_drift_yields_failed_without_mutating_transcript() {
        let mut transcript = fresh_transcript();
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            result: || StageProcess::Ok {
                segments: vec![TranscriptSegment {
                    end_ms: 800,
                    start_ms: 0,
                    text: "shrunk".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                }],
                payload: None,
            },
            runs_on_partials: false,
        })];

        run(&mut transcript, processors);

        assert_eq!(transcript.revision, 0);
        assert_eq!(transcript.segments[0].text, "hello");
        let outcome = transcript.stage_history.last().unwrap();
        assert!(
            matches!(&outcome.status, StageStatus::Failed { error } if error.contains("not in the prior revision"))
        );
    }

    #[test]
    fn dropping_segments_preserves_boundaries_and_succeeds() {
        let mut transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![
                TranscriptSegment {
                    end_ms: 500,
                    start_ms: 0,
                    text: "first".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                },
                TranscriptSegment {
                    end_ms: 1_000,
                    start_ms: 500,
                    text: "second".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                },
            ],
            stage_history: vec![StageOutcome {
                duration_ms: 0,
                payload: Some(serde_json::to_value(EngineStagePayload { is_final: true }).unwrap()),
                revision_in: 0,
                revision_out: Some(0),
                stage_id: StageId::Engine,
                status: StageStatus::Ok,
            }],
        };
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(RecordingProcessor {
            id: StageId::HallucinationFilter,
            result: || StageProcess::Ok {
                segments: vec![TranscriptSegment {
                    end_ms: 500,
                    start_ms: 0,
                    text: "first".to_string(),
                    timestamp_granularity: TimestampGranularity::Segment,
                    timestamp_source: TimestampSource::Engine,
                }],
                payload: None,
            },
            runs_on_partials: false,
        })];

        run(&mut transcript, processors);

        assert_eq!(transcript.revision, 1);
        assert_eq!(transcript.segments.len(), 1);
        assert_eq!(transcript.segments[0].text, "first");
        let outcome = transcript.stage_history.last().unwrap();
        assert_eq!(outcome.status, StageStatus::Ok);
    }
}
