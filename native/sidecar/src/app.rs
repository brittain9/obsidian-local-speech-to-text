use std::path::Path;

use crate::protocol::{Command, Event, ListeningMode, SessionState, SessionStopReason};
use crate::session::{
    FinalizedUtterance, ListeningSession, SessionAction, SessionBaseState, SessionConfig,
};
use crate::worker::{SessionMetadata, TranscriptionWorker, WorkerCommand, WorkerEvent};

const MAX_QUEUED_UTTERANCES: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFlow {
    Continue,
    Shutdown,
}

pub struct AppState {
    active_session: Option<ActiveSession>,
    sidecar_version: String,
    transcription_worker: TranscriptionWorker,
}

struct ActiveSession {
    last_reported_state: Option<SessionState>,
    queued_utterances: usize,
    session: ListeningSession,
    transcription_active: bool,
}

impl AppState {
    pub fn new(sidecar_version: impl Into<String>) -> Self {
        Self {
            active_session: None,
            sidecar_version: sidecar_version.into(),
            transcription_worker: TranscriptionWorker::spawn(),
        }
    }

    pub fn drain_worker_events(&mut self) -> Vec<Event> {
        let mut events = Vec::new();

        while let Some(worker_event) = self.transcription_worker.poll_event() {
            self.handle_worker_event(worker_event, &mut events);
        }

        events
    }

    pub fn handle_audio_frame(&mut self, frame_bytes: Vec<u8>) -> Vec<Event> {
        let mut events = Vec::new();
        if self.active_session.is_none() {
            events.push(Event::Warning {
                code: "audio_without_active_session".to_string(),
                details: None,
                message: "Received audio without an active listening session.".to_string(),
                session_id: None,
            });
            return events;
        }

        let should_pause = self
            .active_session
            .as_ref()
            .map(|active_session| {
                active_session.session.config().pause_while_processing
                    && active_session.transcription_active
                    && active_session.session.base_state() != SessionBaseState::Idle
            })
            .unwrap_or(false);

        if should_pause {
            if let Some(active_session) = self.active_session.as_mut() {
                active_session.session.clear_activity();
            }
            self.emit_state_if_changed(&mut events);
            return events;
        }

        let result = {
            let active_session = self
                .active_session
                .as_mut()
                .expect("active session should exist after early return");
            active_session
                .session
                .ingest_audio_frame(&frame_bytes)
                .map_err(|error| (active_session.session.config().session_id.clone(), error))
        };

        match result {
            Ok(actions) => {
                for action in actions {
                    self.handle_session_action(action, &mut events);
                }

                self.emit_state_if_changed(&mut events);
            }
            Err((session_id, error)) => {
                events.push(Event::Error {
                    code: error.code.to_string(),
                    details: error.details,
                    message: error.message.to_string(),
                    session_id: Some(session_id),
                });
            }
        }

        events
    }

    pub fn handle_command(&mut self, command: Command) -> (ControlFlow, Vec<Event>) {
        let mut events = Vec::new();

        match command {
            Command::Health => {
                events.push(Event::HealthOk {
                    sidecar_version: self.sidecar_version.clone(),
                    status: "ready".to_string(),
                });

                (ControlFlow::Continue, events)
            }
            Command::StartSession {
                language,
                mode,
                model_file_path,
                pause_while_processing,
                session_id,
            } => {
                if let Some(replaced_events) =
                    self.finish_active_session(SessionStopReason::SessionReplaced)
                {
                    events.extend(replaced_events);
                }

                match validate_start_session(&language, &model_file_path) {
                    Ok(()) => {
                        let config = SessionConfig {
                            language: language.clone(),
                            mode,
                            model_file_path: model_file_path.clone().into(),
                            pause_while_processing,
                            session_id: session_id.clone(),
                        };

                        if self
                            .transcription_worker
                            .send(WorkerCommand::BeginSession(SessionMetadata {
                                language,
                                model_file_path: model_file_path.into(),
                                session_id: session_id.clone(),
                            }))
                            .is_err()
                        {
                            events.push(Event::Error {
                                code: "internal_error".to_string(),
                                details: None,
                                message: "Failed to start the transcription worker session."
                                    .to_string(),
                                session_id: Some(session_id),
                            });

                            return (ControlFlow::Continue, events);
                        }

                        let session = ListeningSession::new(config);

                        self.active_session = Some(ActiveSession {
                            last_reported_state: None,
                            queued_utterances: 0,
                            session,
                            transcription_active: false,
                        });

                        events.push(Event::SessionStarted { mode, session_id });
                        self.emit_state_if_changed(&mut events);
                    }
                    Err(error_event) => events.push(error_event),
                }

                (ControlFlow::Continue, events)
            }
            Command::SetGate { open } => {
                match self.active_session.as_ref() {
                    None => events.push(invalid_gate_warning(
                        None,
                        "Cannot change the gate without an active session.",
                    )),
                    Some(active_session) => {
                        if active_session.session.config().mode != ListeningMode::PressAndHold {
                            events.push(invalid_gate_warning(
                                Some(active_session.session.config().session_id.clone()),
                                "Gate control is only valid in press-and-hold mode.",
                            ));
                        } else if open == active_session.session.gate_open() {
                            events.push(invalid_gate_warning(
                                Some(active_session.session.config().session_id.clone()),
                                if open {
                                    "The press-and-hold gate is already open."
                                } else {
                                    "The press-and-hold gate is already closed."
                                },
                            ));
                        } else if open {
                            if let Some(active_session) = self.active_session.as_mut() {
                                active_session.session.open_gate();
                            }
                            self.emit_state_if_changed(&mut events);
                        } else {
                            let action = self
                                .active_session
                                .as_mut()
                                .and_then(|active_session| active_session.session.close_gate());

                            if let Some(action) = action {
                                self.handle_session_action(action, &mut events);
                            }

                            self.emit_state_if_changed(&mut events);
                        }
                    }
                }

                (ControlFlow::Continue, events)
            }
            Command::StopSession => {
                if let Some(stop_events) = self.finish_active_session(SessionStopReason::UserStop) {
                    events.extend(stop_events);
                } else {
                    events.push(Event::Warning {
                        code: "no_active_session".to_string(),
                        details: None,
                        message: "Stop session was requested without an active session."
                            .to_string(),
                        session_id: None,
                    });
                }

                (ControlFlow::Continue, events)
            }
            Command::CancelSession => {
                if let Some(stop_events) = self.finish_active_session(SessionStopReason::UserCancel)
                {
                    events.extend(stop_events);
                } else {
                    events.push(Event::Warning {
                        code: "no_active_session".to_string(),
                        details: None,
                        message: "Cancel session was requested without an active session."
                            .to_string(),
                        session_id: None,
                    });
                }

                (ControlFlow::Continue, events)
            }
            Command::Shutdown => {
                let _ = self.transcription_worker.send(WorkerCommand::Shutdown);
                self.active_session = None;

                (ControlFlow::Shutdown, events)
            }
        }
    }

    fn emit_state_if_changed(&mut self, events: &mut Vec<Event>) {
        let Some(active_session) = self.active_session.as_mut() else {
            return;
        };
        let next_state = derive_session_state(
            active_session.transcription_active,
            active_session.queued_utterances,
            &active_session.session,
        );

        if active_session.last_reported_state != Some(next_state) {
            active_session.last_reported_state = Some(next_state);
            events.push(Event::SessionStateChanged {
                session_id: active_session.session.config().session_id.clone(),
                state: next_state,
            });
        }
    }

    fn finish_active_session(&mut self, reason: SessionStopReason) -> Option<Vec<Event>> {
        let active_session = self.active_session.take()?;
        let session_id = active_session.session.config().session_id.clone();
        let _ = self.transcription_worker.send(WorkerCommand::EndSession {
            session_id: session_id.clone(),
        });

        Some(vec![Event::SessionStopped { reason, session_id }])
    }

    fn handle_session_action(&mut self, action: SessionAction, events: &mut Vec<Event>) {
        match action {
            SessionAction::FinalizeUtterance(utterance) => {
                self.enqueue_utterance(utterance, events);
            }
            SessionAction::Stop(reason) => {
                if let Some(stop_events) = self.finish_active_session(reason) {
                    events.extend(stop_events);
                }
            }
        }
    }

    fn handle_worker_event(&mut self, worker_event: WorkerEvent, events: &mut Vec<Event>) {
        match worker_event {
            WorkerEvent::SessionError {
                code,
                details,
                message,
                session_id,
            } => {
                let Some(active_session) = self.active_session.as_mut() else {
                    return;
                };

                if active_session.session.config().session_id != session_id {
                    return;
                }

                advance_transcription_queue(active_session);
                events.push(Event::Error {
                    code,
                    details,
                    message,
                    session_id: Some(session_id),
                });
                self.emit_state_if_changed(events);
            }
            WorkerEvent::TranscriptReady {
                processing_duration_ms,
                session_id,
                transcript,
                utterance_duration_ms,
            } => {
                let Some(active_session) = self.active_session.as_mut() else {
                    return;
                };

                if active_session.session.config().session_id != session_id {
                    return;
                }

                advance_transcription_queue(active_session);
                events.push(Event::TranscriptReady {
                    processing_duration_ms,
                    segments: transcript.segments,
                    session_id: session_id.clone(),
                    text: transcript.text,
                    utterance_duration_ms,
                });

                let should_stop =
                    active_session.session.config().mode == ListeningMode::OneSentence;

                if should_stop {
                    if let Some(stop_events) =
                        self.finish_active_session(SessionStopReason::SentenceComplete)
                    {
                        events.extend(stop_events);
                    }
                    return;
                }

                self.emit_state_if_changed(events);
            }
        }
    }

    fn enqueue_utterance(&mut self, utterance: FinalizedUtterance, events: &mut Vec<Event>) {
        let Some(active_session) = self.active_session.as_ref() else {
            return;
        };

        let session_id = active_session.session.config().session_id.clone();
        let was_transcribing = active_session.transcription_active;
        let queued_utterances = active_session.queued_utterances;

        if was_transcribing && queued_utterances >= MAX_QUEUED_UTTERANCES {
            events.push(Event::Warning {
                code: "utterance_queue_overload".to_string(),
                details: Some(format!(
                    "queue depth is capped at {MAX_QUEUED_UTTERANCES}"
                )),
                message: "Dropped a newly finalized utterance because transcription is already backlogged."
                    .to_string(),
                session_id: Some(session_id),
            });
            return;
        }

        if self
            .transcription_worker
            .send(WorkerCommand::TranscribeUtterance {
                duration_ms: utterance.duration_ms,
                samples: utterance.samples,
                session_id: session_id.clone(),
            })
            .is_err()
        {
            events.push(Event::Error {
                code: "internal_error".to_string(),
                details: None,
                message: "Failed to queue audio for local transcription.".to_string(),
                session_id: Some(session_id),
            });
            return;
        }

        if let Some(active_session) = self.active_session.as_mut() {
            if active_session.session.config().session_id != session_id {
                return;
            }

            if was_transcribing {
                active_session.queued_utterances += 1;
            } else {
                active_session.transcription_active = true;
            }
        }
    }
}

fn advance_transcription_queue(active_session: &mut ActiveSession) {
    if active_session.queued_utterances > 0 {
        active_session.queued_utterances -= 1;
        active_session.transcription_active = true;
    } else {
        active_session.transcription_active = false;
    }
}

fn derive_session_state(
    transcription_active: bool,
    queued_utterances: usize,
    session: &ListeningSession,
) -> SessionState {
    let base_state = session.base_state();

    if base_state == SessionBaseState::SpeechDetected {
        return SessionState::SpeechDetected;
    }

    if transcription_active {
        if session.config().pause_while_processing && base_state != SessionBaseState::Idle {
            return SessionState::Paused;
        }

        return SessionState::Transcribing;
    }

    if queued_utterances > 0 {
        return SessionState::Transcribing;
    }

    match base_state {
        SessionBaseState::Idle => SessionState::Idle,
        SessionBaseState::Listening => SessionState::Listening,
        SessionBaseState::SpeechDetected => SessionState::SpeechDetected,
    }
}

fn invalid_gate_warning(session_id: Option<String>, message: &'static str) -> Event {
    Event::Warning {
        code: "invalid_gate_transition".to_string(),
        details: None,
        message: message.to_string(),
        session_id,
    }
}

fn validate_start_session(language: &str, model_file_path: &str) -> Result<(), Event> {
    if language != "en" {
        return Err(Event::Error {
            code: "unsupported_language".to_string(),
            details: Some(language.to_string()),
            message: "Only English dictation is supported in this build.".to_string(),
            session_id: None,
        });
    }

    if model_file_path.trim().is_empty() {
        return Err(Event::Error {
            code: "invalid_start_session".to_string(),
            details: None,
            message: "Start session requires a model file path.".to_string(),
            session_id: None,
        });
    }

    let model_path = Path::new(model_file_path);

    if !model_path.is_file() {
        return Err(Event::Error {
            code: "missing_model_file".to_string(),
            details: Some(model_file_path.to_string()),
            message: "Model file does not exist or is not a regular file.".to_string(),
            session_id: None,
        });
    }

    if let Err(error) = std::fs::File::open(model_path) {
        return Err(Event::Error {
            code: "invalid_model_file".to_string(),
            details: Some(error.to_string()),
            message: "Model file is missing, unreadable, or unsupported.".to_string(),
            session_id: None,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::env::temp_dir;
    use std::fs::create_dir_all;
    use std::fs::write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{AppState, ControlFlow};
    use crate::protocol::{Command, Event, ListeningMode, SessionState, SessionStopReason};

    #[test]
    fn health_returns_ready_event() {
        let (control_flow, events) = AppState::new("0.1.0").handle_command(Command::Health);

        assert_eq!(control_flow, ControlFlow::Continue);
        assert_eq!(
            events,
            vec![Event::HealthOk {
                sidecar_version: "0.1.0".to_string(),
                status: "ready".to_string(),
            }]
        );
    }

    #[test]
    fn start_session_returns_started_and_state_events() {
        let model_file_path = create_model_file();
        let (_, events) = AppState::new("0.1.0").handle_command(Command::StartSession {
            language: "en".to_string(),
            mode: ListeningMode::AlwaysOn,
            model_file_path: model_file_path.display().to_string(),
            pause_while_processing: true,
            session_id: "session-1".to_string(),
        });

        assert_eq!(
            events,
            vec![
                Event::SessionStarted {
                    mode: ListeningMode::AlwaysOn,
                    session_id: "session-1".to_string(),
                },
                Event::SessionStateChanged {
                    session_id: "session-1".to_string(),
                    state: SessionState::Listening,
                },
            ]
        );
    }

    #[test]
    fn start_session_rejects_missing_model() {
        let (_, events) = AppState::new("0.1.0").handle_command(Command::StartSession {
            language: "en".to_string(),
            mode: ListeningMode::AlwaysOn,
            model_file_path: "/tmp/definitely-missing-model.bin".to_string(),
            pause_while_processing: true,
            session_id: "session-1".to_string(),
        });

        assert!(
            matches!(events.first(), Some(Event::Error { code, .. }) if code == "missing_model_file")
        );
    }

    #[test]
    fn replacing_a_session_emits_session_replaced_stop() {
        let model_file_path = create_model_file();
        let mut app = AppState::new("0.1.0");
        let _ = app.handle_command(Command::StartSession {
            language: "en".to_string(),
            mode: ListeningMode::AlwaysOn,
            model_file_path: model_file_path.display().to_string(),
            pause_while_processing: true,
            session_id: "session-1".to_string(),
        });

        let (_, events) = app.handle_command(Command::StartSession {
            language: "en".to_string(),
            mode: ListeningMode::OneSentence,
            model_file_path: model_file_path.display().to_string(),
            pause_while_processing: true,
            session_id: "session-2".to_string(),
        });

        assert!(events.contains(&Event::SessionStopped {
            reason: SessionStopReason::SessionReplaced,
            session_id: "session-1".to_string(),
        }));
    }

    #[test]
    fn stop_session_emits_stopped_event() {
        let model_file_path = create_model_file();
        let mut app = AppState::new("0.1.0");
        let _ = app.handle_command(Command::StartSession {
            language: "en".to_string(),
            mode: ListeningMode::AlwaysOn,
            model_file_path: model_file_path.display().to_string(),
            pause_while_processing: true,
            session_id: "session-1".to_string(),
        });

        let (_, events) = app.handle_command(Command::StopSession);

        assert_eq!(
            events,
            vec![Event::SessionStopped {
                reason: SessionStopReason::UserStop,
                session_id: "session-1".to_string(),
            }]
        );
    }

    fn create_model_file() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should move forward")
            .as_nanos();
        let directory = temp_dir().join(format!("obsidian-local-stt-sidecar-tests-{unique}"));
        create_dir_all(&directory).expect("temp dir should create");
        let path = directory.join("model.bin");
        write(&path, b"model").expect("model file should write");
        path
    }
}
