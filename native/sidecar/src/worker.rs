use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Instant;

use crate::protocol::EngineId;
use crate::transcription::{
    GpuConfig, Transcript, TranscriptionBackend, TranscriptionRequest, WhisperBackend,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetadata {
    pub engine_id: EngineId,
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
    },
}

pub struct TranscriptionWorker {
    command_tx: Sender<WorkerCommand>,
    event_rx: Receiver<WorkerEvent>,
}

impl TranscriptionWorker {
    pub fn spawn() -> Self {
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();

        thread::spawn(move || worker_main(command_rx, event_tx));

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

fn create_backend(engine_id: EngineId) -> Box<dyn TranscriptionBackend> {
    match engine_id {
        EngineId::WhisperCpp => Box::new(WhisperBackend::default()),
        EngineId::CohereOnnx => {
            #[cfg(feature = "engine-cohere")]
            {
                Box::new(crate::cohere::CohereBackend::default())
            }
            #[cfg(not(feature = "engine-cohere"))]
            {
                panic!(
                    "CohereOnnx engine requested but engine-cohere feature is not compiled in. \
                     This is a bug — probe_model_for_engine should have rejected this upstream."
                );
            }
        }
    }
}

fn worker_main(command_rx: Receiver<WorkerCommand>, event_tx: Sender<WorkerEvent>) {
    let mut engine: Box<dyn TranscriptionBackend> = Box::new(WhisperBackend::default());
    let mut active_engine_id = EngineId::WhisperCpp;
    let mut active_session: Option<SessionMetadata> = None;

    while let Ok(command) = command_rx.recv() {
        match command {
            WorkerCommand::BeginSession(metadata) => {
                if metadata.engine_id != active_engine_id {
                    engine = create_backend(metadata.engine_id);
                    active_engine_id = metadata.engine_id;
                }
                active_session = Some(metadata);
            }
            WorkerCommand::EndSession { session_id } => {
                if active_session
                    .as_ref()
                    .map(|metadata| metadata.session_id == session_id)
                    .unwrap_or(false)
                {
                    active_session = None;
                }
            }
            WorkerCommand::Shutdown => break,
            WorkerCommand::TranscribeUtterance {
                duration_ms,
                samples,
                session_id,
            } => {
                let Some(metadata) = active_session.as_ref() else {
                    continue;
                };

                if metadata.session_id != session_id {
                    continue;
                }

                let audio_samples: Vec<f32> = samples
                    .iter()
                    .map(|&sample| sample as f32 / 32768.0)
                    .collect();

                let started_at = Instant::now();
                let result = engine.transcribe(&TranscriptionRequest {
                    audio_samples,
                    gpu_config: metadata.gpu_config,
                    language: metadata.language.clone(),
                    model_file_path: metadata.model_file_path.clone(),
                });

                match result {
                    Ok(transcript) => {
                        let _ = event_tx.send(WorkerEvent::TranscriptReady {
                            processing_duration_ms: started_at.elapsed().as_millis() as u64,
                            session_id,
                            transcript,
                            utterance_duration_ms: duration_ms,
                        });
                    }
                    Err(error) => {
                        let _ = event_tx.send(WorkerEvent::SessionError {
                            code: error.code.to_string(),
                            details: error.details,
                            message: error.message.to_string(),
                            session_id,
                        });
                    }
                }
            }
        }
    }
}
