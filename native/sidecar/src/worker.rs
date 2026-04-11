use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Instant;

use whisper_rs::convert_integer_to_float_audio;

use crate::transcription::{Transcript, TranscriptionEngine, TranscriptionRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetadata {
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

fn worker_main(command_rx: Receiver<WorkerCommand>, event_tx: Sender<WorkerEvent>) {
    let mut engine = TranscriptionEngine::default();
    let mut active_session: Option<SessionMetadata> = None;

    while let Ok(command) = command_rx.recv() {
        match command {
            WorkerCommand::BeginSession(metadata) => {
                engine.reset_model();
                active_session = Some(metadata);
            }
            WorkerCommand::EndSession { session_id } => {
                if active_session
                    .as_ref()
                    .map(|metadata| metadata.session_id == session_id)
                    .unwrap_or(false)
                {
                    engine.reset_model();
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

                let mut audio_samples = vec![0.0_f32; samples.len()];

                if let Err(error) = convert_integer_to_float_audio(&samples, &mut audio_samples) {
                    let _ = event_tx.send(WorkerEvent::SessionError {
                        code: "invalid_audio_buffer".to_string(),
                        details: Some(error.to_string()),
                        message: "Failed to convert PCM audio into whisper input.".to_string(),
                        session_id,
                    });
                    continue;
                }

                let started_at = Instant::now();
                let result = engine.transcribe(&TranscriptionRequest {
                    audio_samples,
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
