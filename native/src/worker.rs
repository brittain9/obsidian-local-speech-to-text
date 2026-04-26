use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Instant;

use uuid::Uuid;

use crate::engine::capabilities::{ModelFamilyId, RequestWarning, RuntimeId};
use crate::engine::registry::{EngineRegistry, apply_capability_gates, missing_adapter_error};
use crate::engine::traits::LoadedModel;
use crate::protocol::{ContextWindow, StageId, StageOutcome, StageStatus};
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
    pub session_id: String,
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

fn extract_panic_message(payload: &Box<dyn std::any::Any + Send>, prefix: &str) -> String {
    match payload.downcast_ref::<&str>() {
        Some(s) => format!("{prefix}: {s}"),
        None => match payload.downcast_ref::<String>() {
            Some(s) => format!("{prefix}: {s}"),
            None => format!("{prefix}."),
        },
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
                        let message =
                            extract_panic_message(&payload, "Worker thread panicked loading model");
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
                        let transcript =
                            assemble_transcript(utterance_id, engine_output, engine_duration_ms);
                        let _ = event_tx.send(WorkerEvent::TranscriptReady {
                            processing_duration_ms: started_at.elapsed().as_millis() as u64,
                            session_id,
                            transcript,
                            utterance_duration_ms: duration_ms,
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
                        let message = extract_panic_message(
                            &payload,
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

/// Wrap raw engine output into a canonical `Transcript` with the post-engine
/// stage pipeline. PR4 emits one final revision per utterance with engine
/// status `ok` plus three skipped stubs (hallucination_filter, punctuation,
/// user_rules) so consumers can rely on stage history shape now and the stages
/// can be implemented later without changing the transcript contract.
///
/// The engine stage's payload carries `isFinal` per D-015 — this is the
/// canonical record of whether a revision is a finalized engine pass. Today
/// every assembled transcript is final; speculative-partial support will set
/// the same field to `false` without touching the wire shape.
///
/// Revision numbering uses a single mutable counter that future stages bump
/// on success and leave alone on skip/fail. PR4 emits revision 0 from the
/// engine stage and skips the rest, so the final transcript revision stays at
/// 0; once a post-engine stage actually rewrites segments it should push its
/// `StageOutcome` and then bump the counter so subsequent stages observe the
/// new revision.
fn assemble_transcript(
    utterance_id: Uuid,
    engine_output: EngineTranscriptOutput,
    engine_duration_ms: u64,
) -> Transcript {
    let current_revision: u32 = 0;
    let mut stage_history: Vec<StageOutcome> = Vec::with_capacity(4);

    stage_history.push(StageOutcome {
        duration_ms: engine_duration_ms,
        payload: Some(serde_json::json!({ "isFinal": true })),
        revision_in: current_revision,
        revision_out: Some(current_revision),
        stage_id: StageId::Engine,
        status: StageStatus::Ok,
    });

    for stage_id in [
        StageId::HallucinationFilter,
        StageId::Punctuation,
        StageId::UserRules,
    ] {
        stage_history.push(skipped_stage(
            stage_id,
            current_revision,
            "stage not yet implemented",
        ));
    }

    Transcript {
        utterance_id,
        revision: current_revision,
        segments: engine_output.segments,
        stage_history,
    }
}

fn skipped_stage(stage_id: StageId, revision: u32, reason: &str) -> StageOutcome {
    StageOutcome {
        duration_ms: 0,
        payload: None,
        revision_in: revision,
        revision_out: None,
        stage_id,
        status: StageStatus::Skipped {
            reason: reason.to_string(),
        },
    }
}
