use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Instant;

use crate::engine::capabilities::{ModelFamilyId, RequestWarning, RuntimeId};
use crate::engine::registry::{EngineRegistry, apply_capability_gates, missing_adapter_error};
use crate::engine::traits::LoadedModel;
use crate::transcription::{GpuConfig, Transcript, TranscriptionError, TranscriptionRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetadata {
    pub runtime_id: RuntimeId,
    pub family_id: ModelFamilyId,
    pub gpu_config: GpuConfig,
    pub initial_prompt: Option<String>,
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
        duration_ms: u64,
        samples: Vec<i16>,
        session_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerEvent {
    SessionError {
        code: String,
        details: Option<String>,
        message: String,
        session_id: String,
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
    adapter.probe_model(&metadata.model_file_path)?;
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
                duration_ms,
                samples,
                session_id,
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
                    initial_prompt: session.metadata.initial_prompt.clone(),
                };

                let adapter_capabilities = registry
                    .adapter(session.metadata.runtime_id, session.metadata.family_id)
                    .map(|adapter| adapter.capabilities().clone());

                let warnings = match adapter_capabilities.as_ref() {
                    Some(capabilities) => apply_capability_gates(capabilities, &mut request),
                    None => Vec::new(),
                };

                let started_at = Instant::now();
                let result = panic::catch_unwind(AssertUnwindSafe(|| {
                    session.loaded_model.transcribe(&request)
                }));

                match result {
                    Ok(Ok(transcript)) => {
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
                        });
                    }
                }
            }
        }
    }
}
