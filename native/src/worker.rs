use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Instant;

use uuid::Uuid;

use crate::engine::capabilities::{
    ModelFamilyCapabilities, ModelFamilyId, RequestWarning, RuntimeId,
};
use crate::engine::registry::{EngineRegistry, apply_capability_gates, missing_adapter_error};
use crate::engine::traits::LoadedModel;
use crate::panic_util::format_panic_message;
use crate::protocol::{ContextWindow, EngineStagePayload, StageId, StageOutcome, StageStatus};
use crate::session::FinalizedUtterance;
use crate::stages::{
    StageContext, StageEnablement, StageProcessor, post_engine_processors, run_post_engine,
};
use crate::transcription::{
    EngineTranscriptOutput, GpuConfig, Transcript, TranscriptionError, TranscriptionRequest,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetadata {
    pub runtime_id: RuntimeId,
    pub family_id: ModelFamilyId,
    pub gpu_config: GpuConfig,
    pub language: String,
    pub model_file_path: PathBuf,
    pub session_start_unix_ms: u64,
    pub session_id: String,
    pub stage_enablement: StageEnablement,
}

#[derive(Debug)]
pub enum WorkerCommand {
    BeginSession(SessionMetadata),
    EndSession {
        session_id: String,
    },
    Shutdown,
    TranscribeUtterance {
        context: Option<ContextWindow>,
        session_id: String,
        utterance: FinalizedUtterance,
        utterance_id: Uuid,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerEvent {
    SessionError {
        code: String,
        details: Option<String>,
        message: String,
        session_id: String,
        utterance_id: Option<Uuid>,
    },
    TranscriptReady {
        pause_ms_before_utterance: Option<u64>,
        processing_duration_ms: u64,
        session_id: String,
        transcript: Transcript,
        utterance_duration_ms: u64,
        utterance_end_ms_in_session: u64,
        utterance_index: u64,
        utterance_start_ms_in_session: u64,
        warnings: Vec<RequestWarning>,
    },
}

pub struct TranscriptionWorker {
    command_tx: Sender<WorkerCommand>,
    event_rx: Receiver<WorkerEvent>,
}

impl TranscriptionWorker {
    pub fn spawn(registry: Arc<EngineRegistry>) -> Self {
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();

        thread::spawn(move || worker_main(command_rx, event_tx, registry));

        Self {
            command_tx,
            event_rx,
        }
    }

    pub fn poll_event(&self) -> Option<WorkerEvent> {
        self.event_rx.try_recv().ok()
    }

    // SendError wraps the rejected command, which contains an audio buffer
    // and an optional ContextWindow. We never inspect the rejected value
    // (an Err here means the worker thread is gone — a fatal condition),
    // so the size warning does not represent a real cost.
    #[allow(clippy::result_large_err)]
    pub fn send(&self, command: WorkerCommand) -> Result<(), mpsc::SendError<WorkerCommand>> {
        self.command_tx.send(command)
    }
}

struct ActiveSession {
    metadata: SessionMetadata,
    loaded_model: Box<dyn LoadedModel>,
}

fn load_model_for_session(
    registry: &EngineRegistry,
    metadata: &SessionMetadata,
) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
    let adapter = registry
        .adapter(metadata.runtime_id, metadata.family_id)
        .ok_or_else(|| missing_adapter_error(metadata.runtime_id, metadata.family_id))?;
    adapter.load(&metadata.model_file_path, metadata.gpu_config)
}

fn worker_main(
    command_rx: Receiver<WorkerCommand>,
    event_tx: Sender<WorkerEvent>,
    registry: Arc<EngineRegistry>,
) {
    let mut active: Option<ActiveSession> = None;

    while let Ok(command) = command_rx.recv() {
        match command {
            WorkerCommand::BeginSession(metadata) => {
                let load_result = panic::catch_unwind(AssertUnwindSafe(|| {
                    load_model_for_session(registry.as_ref(), &metadata)
                }));

                match load_result {
                    Ok(Ok(loaded_model)) => {
                        active = Some(ActiveSession {
                            metadata,
                            loaded_model,
                        });
                    }
                    Ok(Err(error)) => {
                        let _ = event_tx.send(WorkerEvent::SessionError {
                            code: error.code.to_string(),
                            details: error.details,
                            message: error.message.to_string(),
                            session_id: metadata.session_id,
                            utterance_id: None,
                        });
                        active = None;
                    }
                    Err(payload) => {
                        let message = format_panic_message(
                            payload.as_ref(),
                            "Worker thread panicked loading model",
                        );
                        let _ = event_tx.send(WorkerEvent::SessionError {
                            code: "worker_panic".to_string(),
                            details: None,
                            message,
                            session_id: metadata.session_id,
                            utterance_id: None,
                        });
                        active = None;
                    }
                }
            }
            WorkerCommand::EndSession { session_id } => {
                if active
                    .as_ref()
                    .map(|session| session.metadata.session_id == session_id)
                    .unwrap_or(false)
                {
                    active = None;
                }
            }
            WorkerCommand::Shutdown => break,
            WorkerCommand::TranscribeUtterance {
                context,
                session_id,
                utterance,
                utterance_id,
            } => {
                let Some(session) = active.as_mut() else {
                    continue;
                };

                if session.metadata.session_id != session_id {
                    continue;
                }

                let utterance_duration_ms = utterance.duration_ms();
                let utterance_end_ms_in_session = utterance.utterance_end_ms_in_session();
                let utterance_start_ms_in_session = utterance.utterance_start_ms_in_session();
                let FinalizedUtterance {
                    pause_ms_before_utterance,
                    samples,
                    utterance_index,
                    vad_probabilities,
                    voice_activity,
                } = utterance;
                let audio_samples: Vec<f32> = samples
                    .iter()
                    .map(|&sample| sample as f32 / 32768.0)
                    .collect();

                let mut request = TranscriptionRequest {
                    audio_samples,
                    gpu_config: session.metadata.gpu_config,
                    language: session.metadata.language.clone(),
                    model_file_path: session.metadata.model_file_path.clone(),
                    context,
                };
                let stage_context = request.context.clone();

                let warnings = registry
                    .adapter(session.metadata.runtime_id, session.metadata.family_id)
                    .map(|adapter| apply_capability_gates(adapter.capabilities(), &mut request))
                    .unwrap_or_default();

                let started_at = Instant::now();
                let result = panic::catch_unwind(AssertUnwindSafe(|| {
                    session.loaded_model.transcribe(&request)
                }));
                let engine_duration_ms = started_at.elapsed().as_millis() as u64;

                match result {
                    Ok(Ok(engine_output)) => {
                        let family_capabilities = registry
                            .adapter(session.metadata.runtime_id, session.metadata.family_id)
                            .map(|adapter| adapter.capabilities().clone())
                            .unwrap_or_else(ModelFamilyCapabilities::unknown);
                        let transcript = assemble_transcript(TranscriptAssembly {
                            utterance_id,
                            engine_output,
                            engine_duration_ms,
                            is_final: true,
                            pause_ms_before_utterance,
                            vad_probabilities: &vad_probabilities,
                            voice_activity,
                            context: stage_context.as_ref(),
                            family_capabilities: &family_capabilities,
                            stage_enablement: &session.metadata.stage_enablement,
                            processors: &post_engine_processors(),
                        });
                        let _ = event_tx.send(WorkerEvent::TranscriptReady {
                            pause_ms_before_utterance,
                            processing_duration_ms: engine_duration_ms,
                            session_id,
                            transcript,
                            utterance_duration_ms,
                            utterance_end_ms_in_session,
                            utterance_index,
                            utterance_start_ms_in_session,
                            warnings,
                        });
                    }
                    Ok(Err(error)) => {
                        let _ = event_tx.send(WorkerEvent::SessionError {
                            code: error.code.to_string(),
                            details: error.details,
                            message: error.message.to_string(),
                            session_id,
                            utterance_id: Some(utterance_id),
                        });
                    }
                    Err(payload) => {
                        let message = format_panic_message(
                            payload.as_ref(),
                            "Worker thread panicked during transcription",
                        );
                        let _ = event_tx.send(WorkerEvent::SessionError {
                            code: "worker_panic".to_string(),
                            details: None,
                            message,
                            session_id,
                            utterance_id: Some(utterance_id),
                        });
                    }
                }
            }
        }
    }
}

struct TranscriptAssembly<'a> {
    utterance_id: Uuid,
    engine_output: EngineTranscriptOutput,
    engine_duration_ms: u64,
    is_final: bool,
    pause_ms_before_utterance: Option<u64>,
    vad_probabilities: &'a [f32],
    voice_activity: crate::audio_metadata::VoiceActivityEvidence,
    context: Option<&'a ContextWindow>,
    family_capabilities: &'a ModelFamilyCapabilities,
    stage_enablement: &'a StageEnablement,
    processors: &'a [Box<dyn StageProcessor>],
}

fn assemble_transcript(input: TranscriptAssembly<'_>) -> Transcript {
    let revision: u32 = 0;
    let mut stage_history: Vec<StageOutcome> = Vec::with_capacity(1 + input.processors.len());
    let EngineTranscriptOutput {
        segments,
        diagnostics,
    } = input.engine_output;

    stage_history.push(StageOutcome {
        duration_ms: input.engine_duration_ms,
        is_final: input.is_final,
        payload: Some(
            serde_json::to_value(EngineStagePayload {
                pause_ms_before_utterance: input.pause_ms_before_utterance,
                voice_activity: input.voice_activity,
            })
            .expect("EngineStagePayload serialization should not fail"),
        ),
        revision_in: revision,
        revision_out: Some(revision),
        stage_id: StageId::Engine,
        status: StageStatus::Ok,
    });

    let mut transcript = Transcript {
        utterance_id: input.utterance_id,
        revision,
        segments,
        stage_history,
    };

    let ctx = StageContext {
        context: input.context,
        family_capabilities: input.family_capabilities,
        stage_enabled: input.stage_enablement,
        is_final: input.is_final,
        pause_ms_before_utterance: input.pause_ms_before_utterance,
        segment_diagnostics: &diagnostics,
        vad_probabilities: input.vad_probabilities,
        voice_activity: &input.voice_activity,
    };
    run_post_engine(&mut transcript, input.processors, &ctx);

    transcript
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_metadata::voiced_fraction;
    use crate::engine::capabilities::LanguageSupport;
    use crate::protocol::{TimestampGranularity, TimestampSource, TranscriptSegment};
    use crate::stages::StageProcess;

    struct VoiceActivityReadingProcessor;

    impl StageProcessor for VoiceActivityReadingProcessor {
        fn id(&self) -> StageId {
            StageId::HallucinationFilter
        }

        fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
            StageProcess::Ok {
                segments: transcript.segments.clone(),
                payload: Some(serde_json::json!({
                    "audioStartMs": ctx.voice_activity.audio_start_ms,
                    "voicedMs": ctx.voice_activity.voiced_ms,
                })),
            }
        }
    }

    struct PauseReadingProcessor;

    impl StageProcessor for PauseReadingProcessor {
        fn id(&self) -> StageId {
            StageId::HallucinationFilter
        }

        fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
            StageProcess::Ok {
                segments: transcript.segments.clone(),
                payload: Some(serde_json::json!({
                    "pauseMsBeforeUtterance": ctx.pause_ms_before_utterance,
                })),
            }
        }
    }

    /// Synthesises the consumer pattern PR 3 (hallucination filter v2) will
    /// use: read the per-frame trace from `StageContext` and compute a
    /// per-segment voiced fraction. Segment timestamps are utterance-local.
    struct VoicedFractionProcessor;

    impl StageProcessor for VoicedFractionProcessor {
        fn id(&self) -> StageId {
            StageId::HallucinationFilter
        }

        fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
            let segment = &transcript.segments[0];
            let fraction = voiced_fraction(
                ctx.vad_probabilities,
                segment.start_ms,
                segment.end_ms,
                0.35,
            );
            StageProcess::Ok {
                segments: transcript.segments.clone(),
                payload: Some(serde_json::json!({ "voicedFraction": fraction })),
            }
        }
    }

    #[test]
    fn assemble_transcript_includes_voice_activity_in_engine_payload() {
        let voice_activity = voice_activity();
        let transcript = assemble_transcript(TranscriptAssembly {
            context: None,
            engine_duration_ms: 7,
            engine_output: engine_output(),
            family_capabilities: &whisper_caps(),
            is_final: true,
            pause_ms_before_utterance: None,
            processors: &[],
            stage_enablement: &StageEnablement::default(),
            utterance_id: Uuid::nil(),
            vad_probabilities: &[],
            voice_activity,
        });

        let payload = transcript.stage_history[0]
            .payload
            .as_ref()
            .expect("engine stage should carry payload")
            .clone();
        assert_eq!(
            serde_json::from_value::<EngineStagePayload>(payload).unwrap(),
            EngineStagePayload {
                pause_ms_before_utterance: None,
                voice_activity
            }
        );
        assert!(transcript.stage_history[0].is_final);
    }

    #[test]
    fn stage_context_exposes_voice_activity_to_processors() {
        let voice_activity = voice_activity();
        let processors: Vec<Box<dyn StageProcessor>> =
            vec![Box::new(VoiceActivityReadingProcessor)];
        let transcript = assemble_transcript(TranscriptAssembly {
            context: None,
            engine_duration_ms: 7,
            engine_output: engine_output(),
            family_capabilities: &whisper_caps(),
            is_final: true,
            pause_ms_before_utterance: None,
            processors: &processors,
            stage_enablement: &StageEnablement::default(),
            utterance_id: Uuid::nil(),
            vad_probabilities: &[],
            voice_activity,
        });

        assert_eq!(
            transcript.stage_history[1].payload,
            Some(serde_json::json!({
                "audioStartMs": voice_activity.audio_start_ms,
                "voicedMs": voice_activity.voiced_ms,
            }))
        );
    }

    #[test]
    fn assemble_transcript_threads_pause_into_engine_payload() {
        let voice_activity = voice_activity();
        let transcript = assemble_transcript(TranscriptAssembly {
            context: None,
            engine_duration_ms: 7,
            engine_output: engine_output(),
            family_capabilities: &whisper_caps(),
            is_final: true,
            pause_ms_before_utterance: Some(420),
            processors: &[],
            stage_enablement: &StageEnablement::default(),
            utterance_id: Uuid::nil(),
            vad_probabilities: &[],
            voice_activity,
        });

        let payload = transcript.stage_history[0]
            .payload
            .as_ref()
            .expect("engine stage should carry payload")
            .clone();
        assert_eq!(
            serde_json::from_value::<EngineStagePayload>(payload).unwrap(),
            EngineStagePayload {
                pause_ms_before_utterance: Some(420),
                voice_activity,
            }
        );
    }

    #[test]
    fn stage_context_exposes_pause_ms_before_utterance_to_processors() {
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(PauseReadingProcessor)];
        let transcript = assemble_transcript(TranscriptAssembly {
            context: None,
            engine_duration_ms: 7,
            engine_output: engine_output(),
            family_capabilities: &whisper_caps(),
            is_final: true,
            pause_ms_before_utterance: Some(150),
            processors: &processors,
            stage_enablement: &StageEnablement::default(),
            utterance_id: Uuid::nil(),
            vad_probabilities: &[],
            voice_activity: voice_activity(),
        });

        assert_eq!(
            transcript.stage_history[1].payload,
            Some(serde_json::json!({ "pauseMsBeforeUtterance": 150 }))
        );
    }

    #[test]
    fn stage_context_exposes_per_frame_trace_for_voiced_fraction() {
        // 50 frames (1 s) where the first 35 are voiced and the last 15
        // are silent. The single segment covers the full second.
        let mut trace = vec![1.0_f32; 35];
        trace.extend(std::iter::repeat_n(0.0_f32, 15));
        let processors: Vec<Box<dyn StageProcessor>> = vec![Box::new(VoicedFractionProcessor)];

        let voice_activity = voice_activity();
        let transcript = assemble_transcript(TranscriptAssembly {
            context: None,
            engine_duration_ms: 7,
            engine_output: engine_output(),
            family_capabilities: &whisper_caps(),
            is_final: true,
            pause_ms_before_utterance: None,
            processors: &processors,
            stage_enablement: &StageEnablement::default(),
            utterance_id: Uuid::nil(),
            vad_probabilities: &trace,
            voice_activity,
        });

        let payload = transcript.stage_history[1]
            .payload
            .as_ref()
            .expect("processor should emit payload")
            .clone();
        assert_eq!(payload, serde_json::json!({ "voicedFraction": 0.7_f32 }));
    }

    fn engine_output() -> EngineTranscriptOutput {
        EngineTranscriptOutput {
            diagnostics: Vec::new(),
            segments: vec![TranscriptSegment {
                start_ms: 0,
                end_ms: 1_000,
                text: "hello".to_string(),
                timestamp_granularity: TimestampGranularity::Segment,
                timestamp_source: TimestampSource::Engine,
            }],
        }
    }

    fn voice_activity() -> crate::audio_metadata::VoiceActivityEvidence {
        crate::audio_metadata::VoiceActivityEvidence {
            audio_start_ms: 2_000,
            audio_end_ms: 3_000,
            speech_start_ms: 2_100,
            speech_end_ms: 2_900,
            voiced_ms: 800,
            unvoiced_ms: 200,
            mean_probability: 0.75,
            max_probability: 0.95,
        }
    }

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
}
