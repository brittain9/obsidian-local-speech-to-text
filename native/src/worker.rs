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
        duration_ms: u64,
        samples: Vec<i16>,
        session_id: String,
        utterance_id: Uuid,
        utterance_end_ms_in_session: u64,
        utterance_index: u64,
        utterance_start_ms_in_session: u64,
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
                duration_ms,
                samples,
                session_id,
                utterance_id,
                utterance_end_ms_in_session,
                utterance_index,
                utterance_start_ms_in_session,
            } => {
                let Some(session) = active.as_mut() else {
                    continue;
                };

                if session.metadata.session_id != session_id {
                    continue;
                }

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
                            utterance_duration_ms: duration_ms,
                            context: stage_context.as_ref(),
                            family_capabilities: &family_capabilities,
                            stage_enablement: &session.metadata.stage_enablement,
                            processors: &post_engine_processors(),
                        });
                        let _ = event_tx.send(WorkerEvent::TranscriptReady {
                            processing_duration_ms: engine_duration_ms,
                            session_id,
                            transcript,
                            utterance_duration_ms: duration_ms,
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
    utterance_duration_ms: u64,
    context: Option<&'a ContextWindow>,
    family_capabilities: &'a ModelFamilyCapabilities,
    stage_enablement: &'a StageEnablement,
    processors: &'a [Box<dyn StageProcessor>],
}

fn assemble_transcript(input: TranscriptAssembly<'_>) -> Transcript {
    let revision: u32 = 0;
    let mut stage_history: Vec<StageOutcome> = Vec::with_capacity(1 + input.processors.len());

    stage_history.push(StageOutcome {
        duration_ms: input.engine_duration_ms,
        payload: Some(
            serde_json::to_value(EngineStagePayload {
                is_final: input.is_final,
            })
            .expect("EngineStagePayload serialization is infallible"),
        ),
        revision_in: revision,
        revision_out: Some(revision),
        stage_id: StageId::Engine,
        status: StageStatus::Ok,
    });

    let mut transcript = Transcript {
        utterance_id: input.utterance_id,
        revision,
        segments: input.engine_output.segments,
        stage_history,
    };

    let ctx = StageContext {
        context: input.context,
        utterance_duration_ms: input.utterance_duration_ms,
        family_capabilities: input.family_capabilities,
        stage_enabled: input.stage_enablement,
        is_final: input.is_final,
    };
    run_post_engine(&mut transcript, input.processors, &ctx);

    transcript
}
