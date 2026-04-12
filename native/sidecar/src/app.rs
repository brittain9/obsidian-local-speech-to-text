use std::path::{Path, PathBuf};

use crate::catalog::ModelCatalog;
use crate::installer::{InstallRequest, ModelInstallManager};
use crate::model_store::{
    remove_installed_model, resolve_catalog_model_runtime_path, resolve_model_store_info,
    scan_installed_models,
};
use crate::protocol::{
    Command, EngineId, Event, ListeningMode, ModelInstallState, ModelProbeStatus, SelectedModel,
    SessionState, SessionStopReason, compiled_backends, compiled_engines, system_info_string,
};
use crate::session::{
    FinalizedUtterance, ListeningSession, SessionAction, SessionBaseState, SessionConfig,
};
use crate::transcription::{GpuConfig, TranscriptionError, probe_model_for_engine};
use crate::worker::{SessionMetadata, TranscriptionWorker, WorkerCommand, WorkerEvent};

const MAX_QUEUED_UTTERANCES: usize = 1;
type ModelPathProbe = fn(EngineId, &Path) -> Result<(), TranscriptionError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFlow {
    Continue,
    Shutdown,
}

pub struct AppState {
    active_session: Option<ActiveSession>,
    catalog: ModelCatalog,
    install_manager: ModelInstallManager,
    model_path_probe: ModelPathProbe,
    sidecar_version: String,
    transcription_worker: TranscriptionWorker,
}

struct ActiveSession {
    last_reported_state: Option<SessionState>,
    queued_utterances: usize,
    session: ListeningSession,
    transcription_active: bool,
}

struct ResolvedModelSelection {
    display_name: String,
    engine_id: EngineId,
    installed: bool,
    model_id: Option<String>,
    resolved_path: PathBuf,
    selection: SelectedModel,
    size_bytes: u64,
}

impl AppState {
    pub fn new(sidecar_version: impl Into<String>, catalog: ModelCatalog) -> Self {
        Self::with_model_path_probe(sidecar_version, catalog, probe_model_for_engine)
    }

    fn with_model_path_probe(
        sidecar_version: impl Into<String>,
        catalog: ModelCatalog,
        model_path_probe: ModelPathProbe,
    ) -> Self {
        Self {
            active_session: None,
            catalog,
            install_manager: ModelInstallManager::new(),
            model_path_probe,
            sidecar_version: sidecar_version.into(),
            transcription_worker: TranscriptionWorker::spawn(),
        }
    }

    pub fn drain_worker_events(&mut self) -> Vec<Event> {
        let mut events = Vec::new();

        while let Some(worker_event) = self.transcription_worker.poll_event() {
            self.handle_worker_event(worker_event, &mut events);
        }

        while let Some(install_event) = self.install_manager.poll_event() {
            events.push(install_event);
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
            Command::GetModelStore {
                model_store_path_override,
            } => {
                match resolve_model_store_info(model_store_path_override.as_deref()) {
                    Ok(info) => events.push(Event::ModelStore {
                        override_path: info.override_path.map(|path| path.display().to_string()),
                        path: info.path.display().to_string(),
                        using_default_path: info.using_default_path,
                    }),
                    Err(error) => events.push(internal_error_event(
                        "invalid_model_store",
                        "Failed to resolve the configured model store path.",
                        Some(format!("{error:#}")),
                    )),
                }

                (ControlFlow::Continue, events)
            }
            Command::ListModelCatalog => {
                events.push(Event::ModelCatalog {
                    catalog_version: self.catalog.catalog_version,
                    collections: self.catalog.collections.clone(),
                    engines: self.catalog.engines.clone(),
                    models: self.catalog.models.clone(),
                });

                (ControlFlow::Continue, events)
            }
            Command::ListInstalledModels {
                model_store_path_override,
            } => {
                match resolve_model_store_info(model_store_path_override.as_deref())
                    .and_then(|info| scan_installed_models(&self.catalog, &info.path))
                {
                    Ok(models) => events.push(Event::InstalledModels { models }),
                    Err(error) => events.push(internal_error_event(
                        "invalid_model_store",
                        "Failed to scan installed models.",
                        Some(format!("{error:#}")),
                    )),
                }

                (ControlFlow::Continue, events)
            }
            Command::ProbeModelSelection {
                model_selection,
                model_store_path_override,
            } => {
                events.push(
                    self.build_probe_event(model_selection, model_store_path_override.as_deref()),
                );
                (ControlFlow::Continue, events)
            }
            Command::RemoveModel {
                engine_id,
                model_id,
                model_store_path_override,
            } => {
                match resolve_model_store_info(model_store_path_override.as_deref())
                    .and_then(|info| remove_installed_model(&info.path, engine_id, &model_id))
                {
                    Ok(removed) => events.push(Event::ModelRemoved {
                        engine_id,
                        model_id,
                        removed,
                    }),
                    Err(_error) => events.push(Event::ModelRemoved {
                        engine_id,
                        model_id,
                        removed: false,
                    }),
                }

                (ControlFlow::Continue, events)
            }
            Command::InstallModel {
                engine_id,
                install_id,
                model_id,
                model_store_path_override,
            } => {
                match self.catalog.find_model(engine_id, &model_id).cloned() {
                    None => events.push(Event::ModelInstallUpdate {
                        details: None,
                        downloaded_bytes: None,
                        engine_id,
                        install_id,
                        message: Some(
                            "The requested model does not exist in the bundled catalog."
                                .to_string(),
                        ),
                        model_id,
                        state: ModelInstallState::Failed,
                        total_bytes: None,
                    }),
                    Some(model) => {
                        match resolve_model_store_info(model_store_path_override.as_deref()) {
                            Ok(info) => {
                                events.push(self.install_manager.start_install(InstallRequest {
                                    catalog: self.catalog.clone(),
                                    engine_id,
                                    install_id,
                                    model,
                                    model_id,
                                    store_root: info.path,
                                }))
                            }
                            Err(error) => events.push(Event::ModelInstallUpdate {
                                details: Some(format!("{error:#}")),
                                downloaded_bytes: None,
                                engine_id,
                                install_id,
                                message: Some("The model store path is invalid.".to_string()),
                                model_id,
                                state: ModelInstallState::Failed,
                                total_bytes: None,
                            }),
                        }
                    }
                }

                (ControlFlow::Continue, events)
            }
            Command::CancelModelInstall { install_id } => {
                if let Some(event) = self.install_manager.cancel_install(&install_id) {
                    events.push(event);
                }

                (ControlFlow::Continue, events)
            }
            Command::GetSystemInfo => {
                events.push(Event::SystemInfo {
                    compiled_backends: compiled_backends(),
                    compiled_engines: compiled_engines(),
                    system_info: system_info_string(),
                });

                (ControlFlow::Continue, events)
            }
            Command::StartSession {
                language,
                mode,
                model_selection,
                model_store_path_override,
                pause_while_processing,
                session_id,
                use_gpu,
            } => {
                if let Some(replaced_events) =
                    self.finish_active_session(SessionStopReason::SessionReplaced)
                {
                    events.extend(replaced_events);
                }

                match self.resolve_runtime_model_path(
                    &language,
                    &model_selection,
                    model_store_path_override.as_deref(),
                ) {
                    Ok(resolved_model) => {
                        let config = SessionConfig {
                            language: language.clone(),
                            mode,
                            model_file_path: resolved_model.resolved_path.clone(),
                            pause_while_processing,
                            session_id: session_id.clone(),
                        };

                        if self
                            .transcription_worker
                            .send(WorkerCommand::BeginSession(SessionMetadata {
                                engine_id: resolved_model.engine_id,
                                gpu_config: GpuConfig { use_gpu },
                                language,
                                model_file_path: resolved_model.resolved_path.clone(),
                                session_id: session_id.clone(),
                            }))
                            .is_err()
                        {
                            events.push(internal_error_event(
                                "internal_error",
                                "Failed to start the transcription worker session.",
                                None,
                            ));

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
                    Err(error_event) => events.push(*error_event),
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

    fn build_probe_event(
        &self,
        selection: SelectedModel,
        model_store_path_override: Option<&str>,
    ) -> Event {
        match self.resolve_selected_model(&selection, model_store_path_override) {
            Ok(resolved_model) => Event::ModelProbeResult {
                available: true,
                details: None,
                display_name: Some(resolved_model.display_name),
                engine_id: resolved_model.engine_id,
                installed: resolved_model.installed,
                message: "Model selection is ready.".to_string(),
                model_id: resolved_model.model_id,
                resolved_path: Some(resolved_model.resolved_path.display().to_string()),
                selection: resolved_model.selection,
                size_bytes: Some(resolved_model.size_bytes),
                status: ModelProbeStatus::Ready,
            },
            Err(event) => *event,
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

    fn resolve_runtime_model_path(
        &self,
        language: &str,
        selection: &SelectedModel,
        model_store_path_override: Option<&str>,
    ) -> Result<ResolvedModelSelection, Box<Event>> {
        if language != "en" {
            return Err(Box::new(Event::Error {
                code: "unsupported_language".to_string(),
                details: Some(language.to_string()),
                message: "Only English dictation is supported in this build.".to_string(),
                session_id: None,
            }));
        }

        self.resolve_selected_model(selection, model_store_path_override)
            .map_err(|event| match *event {
                Event::ModelProbeResult {
                    details,
                    message,
                    status,
                    ..
                } => Box::new(Event::Error {
                    code: match status {
                        ModelProbeStatus::Missing => "missing_model_file".to_string(),
                        ModelProbeStatus::Invalid => "invalid_model_file".to_string(),
                        ModelProbeStatus::Ready => "invalid_model_file".to_string(),
                    },
                    details,
                    message,
                    session_id: None,
                }),
                _ => Box::new(internal_error_event(
                    "internal_error",
                    "Failed to resolve the selected model.",
                    None,
                )),
            })
    }

    fn resolve_selected_model(
        &self,
        selection: &SelectedModel,
        model_store_path_override: Option<&str>,
    ) -> Result<ResolvedModelSelection, Box<Event>> {
        match selection {
            SelectedModel::CatalogModel {
                engine_id,
                model_id,
            } => {
                let model = self
                    .catalog
                    .find_model(*engine_id, model_id)
                    .cloned()
                    .ok_or_else(|| {
                        Box::new(Event::ModelProbeResult {
                            available: false,
                            details: None,
                            display_name: None,
                            engine_id: *engine_id,
                            installed: false,
                            message:
                                "The selected managed model does not exist in the bundled catalog."
                                    .to_string(),
                            model_id: Some(model_id.clone()),
                            resolved_path: None,
                            selection: selection.clone(),
                            size_bytes: None,
                            status: ModelProbeStatus::Invalid,
                        })
                    })?;
                let store_info =
                    resolve_model_store_info(model_store_path_override).map_err(|error| {
                        Box::new(Event::ModelProbeResult {
                            available: false,
                            details: Some(format!("{error:#}")),
                            display_name: Some(model.display_name.clone()),
                            engine_id: *engine_id,
                            installed: false,
                            message: "The model store path is invalid.".to_string(),
                            model_id: Some(model_id.clone()),
                            resolved_path: None,
                            selection: selection.clone(),
                            size_bytes: None,
                            status: ModelProbeStatus::Invalid,
                        })
                    })?;
                let resolved_path = resolve_catalog_model_runtime_path(
                    &self.catalog,
                    &store_info.path,
                    *engine_id,
                    model_id,
                )
                .map_err(|error| {
                    Box::new(Event::ModelProbeResult {
                        available: false,
                        details: Some(format!("{error:#}")),
                        display_name: Some(model.display_name.clone()),
                        engine_id: *engine_id,
                        installed: false,
                        message: "The selected managed model is not installed or is incomplete."
                            .to_string(),
                        model_id: Some(model_id.clone()),
                        resolved_path: None,
                        selection: selection.clone(),
                        size_bytes: None,
                        status: ModelProbeStatus::Missing,
                    })
                })?;
                (self.model_path_probe)(*engine_id, &resolved_path).map_err(|error| {
                    Box::new(Event::ModelProbeResult {
                        available: false,
                        details: error.details,
                        display_name: Some(model.display_name.clone()),
                        engine_id: *engine_id,
                        installed: true,
                        message: error.message.to_string(),
                        model_id: Some(model_id.clone()),
                        resolved_path: Some(resolved_path.display().to_string()),
                        selection: selection.clone(),
                        size_bytes: None,
                        status: ModelProbeStatus::Invalid,
                    })
                })?;
                let size_bytes = file_size(&resolved_path);

                Ok(ResolvedModelSelection {
                    display_name: model.display_name,
                    engine_id: *engine_id,
                    installed: true,
                    model_id: Some(model_id.clone()),
                    resolved_path,
                    selection: selection.clone(),
                    size_bytes,
                })
            }
            SelectedModel::ExternalFile {
                engine_id,
                file_path,
            } => {
                let trimmed_path = file_path.trim();

                if trimmed_path.is_empty() {
                    return Err(Box::new(Event::ModelProbeResult {
                        available: false,
                        details: None,
                        display_name: None,
                        engine_id: *engine_id,
                        installed: false,
                        message: "External model file path is not configured.".to_string(),
                        model_id: None,
                        resolved_path: None,
                        selection: selection.clone(),
                        size_bytes: None,
                        status: ModelProbeStatus::Invalid,
                    }));
                }

                let model_path = Path::new(trimmed_path);

                if !model_path.is_absolute() {
                    return Err(Box::new(Event::ModelProbeResult {
                        available: false,
                        details: Some(trimmed_path.to_string()),
                        display_name: Some(file_name_or_path(model_path)),
                        engine_id: *engine_id,
                        installed: false,
                        message: "External model file path must be absolute.".to_string(),
                        model_id: None,
                        resolved_path: None,
                        selection: selection.clone(),
                        size_bytes: None,
                        status: ModelProbeStatus::Invalid,
                    }));
                }

                (self.model_path_probe)(*engine_id, model_path).map_err(|error| {
                    Box::new(Event::ModelProbeResult {
                        available: false,
                        details: error.details,
                        display_name: Some(file_name_or_path(model_path)),
                        engine_id: *engine_id,
                        installed: false,
                        message: error.message.to_string(),
                        model_id: None,
                        resolved_path: Some(model_path.display().to_string()),
                        selection: selection.clone(),
                        size_bytes: None,
                        status: if error.code == "missing_model_file" {
                            ModelProbeStatus::Missing
                        } else {
                            ModelProbeStatus::Invalid
                        },
                    })
                })?;
                let size_bytes = file_size(model_path);

                Ok(ResolvedModelSelection {
                    display_name: file_name_or_path(model_path),
                    engine_id: *engine_id,
                    installed: false,
                    model_id: None,
                    resolved_path: model_path.to_path_buf(),
                    selection: selection.clone(),
                    size_bytes,
                })
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

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn file_name_or_path(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.display().to_string())
}

fn internal_error_event(code: &str, message: &str, details: Option<String>) -> Event {
    Event::Error {
        code: code.to_string(),
        details,
        message: message.to_string(),
        session_id: None,
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

#[cfg(test)]
mod tests {
    use std::env::temp_dir;
    use std::fs::{create_dir_all, write};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{AppState, ControlFlow};
    use crate::catalog::{
        ArtifactRole, CatalogModel, ModelArtifact, ModelCatalog, ModelCollection, ModelEngine,
    };
    use crate::protocol::{
        Command, EngineId, Event, ListeningMode, ModelProbeStatus, SelectedModel, SessionState,
        SessionStopReason,
    };
    use crate::transcription::TranscriptionError;

    #[test]
    fn health_returns_ready_event() {
        let (control_flow, events) =
            AppState::new("0.1.0", sample_catalog()).handle_command(Command::Health);

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
    fn get_system_info_returns_compiled_backends() {
        let (control_flow, events) =
            AppState::new("0.1.0", sample_catalog()).handle_command(Command::GetSystemInfo);

        assert_eq!(control_flow, ControlFlow::Continue);
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::SystemInfo {
                compiled_backends,
                compiled_engines,
                system_info,
            } => {
                assert!(compiled_backends.contains(&"cpu".to_string()));
                assert!(compiled_engines.contains(&"whisper_cpp".to_string()));
                assert!(!system_info.is_empty());
            }
            other => panic!("expected SystemInfo event, got {other:?}"),
        }
    }

    #[test]
    fn start_session_returns_started_and_state_events() {
        let model_file_path = create_model_file();
        let (_, events) =
            test_app().handle_command(start_session_command("session-1", &model_file_path));

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
        let (_, events) = AppState::new("0.1.0", sample_catalog()).handle_command(
            start_session_command("session-1", Path::new("/tmp/definitely-missing-model.bin")),
        );

        assert!(
            matches!(events.first(), Some(Event::Error { code, .. }) if code == "missing_model_file")
        );
    }

    #[test]
    fn probe_model_selection_reports_missing_managed_model() {
        let (_, events) =
            AppState::new("0.1.0", sample_catalog()).handle_command(Command::ProbeModelSelection {
                model_selection: SelectedModel::CatalogModel {
                    engine_id: EngineId::WhisperCpp,
                    model_id: "small".to_string(),
                },
                model_store_path_override: Some(
                    temp_dir().join("missing-model-store").display().to_string(),
                ),
            });

        assert!(matches!(
            events.first(),
            Some(Event::ModelProbeResult { status, .. }) if *status == ModelProbeStatus::Missing
        ));
    }

    #[test]
    fn replacing_a_session_emits_session_replaced_stop() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let (_, events) = app.handle_command(start_session_command("session-2", &model_file_path));

        assert!(events.contains(&Event::SessionStopped {
            reason: SessionStopReason::SessionReplaced,
            session_id: "session-1".to_string(),
        }));
    }

    #[test]
    fn stop_session_emits_stopped_event() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let (_, events) = app.handle_command(Command::StopSession);

        assert_eq!(
            events,
            vec![Event::SessionStopped {
                reason: SessionStopReason::UserStop,
                session_id: "session-1".to_string(),
            }]
        );
    }

    fn start_session_command(session_id: &str, model_file_path: &Path) -> Command {
        Command::StartSession {
            language: "en".to_string(),
            mode: ListeningMode::AlwaysOn,
            model_selection: SelectedModel::ExternalFile {
                engine_id: EngineId::WhisperCpp,
                file_path: model_file_path.display().to_string(),
            },
            model_store_path_override: None,
            pause_while_processing: true,
            session_id: session_id.to_string(),
            use_gpu: false,
        }
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

    fn test_app() -> AppState {
        AppState::with_model_path_probe("0.1.0", sample_catalog(), probe_test_model_path)
    }

    fn probe_test_model_path(
        _engine_id: EngineId,
        model_file_path: &Path,
    ) -> Result<(), TranscriptionError> {
        if !model_file_path.is_file() {
            return Err(TranscriptionError {
                code: "missing_model_file",
                message: "Model file does not exist or is not a regular file.",
                details: Some(model_file_path.display().to_string()),
            });
        }

        Ok(())
    }

    fn sample_catalog() -> ModelCatalog {
        ModelCatalog {
            catalog_version: 1,
            collections: vec![ModelCollection {
                collection_id: "english".to_string(),
                display_name: "English".to_string(),
                summary: "summary".to_string(),
            }],
            engines: vec![ModelEngine {
                display_name: "Whisper.cpp".to_string(),
                engine_id: EngineId::WhisperCpp,
                summary: "summary".to_string(),
            }],
            models: vec![CatalogModel {
                artifacts: vec![ModelArtifact {
                    artifact_id: "transcription".to_string(),
                    download_url: "https://example.com/model.bin".to_string(),
                    filename: "model.bin".to_string(),
                    required: true,
                    role: ArtifactRole::TranscriptionModel,
                    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .to_string(),
                    size_bytes: 10,
                }],
                capability_flags: vec![],
                collection_id: "english".to_string(),
                display_name: "Model".to_string(),
                engine_id: EngineId::WhisperCpp,
                language_tags: vec!["en".to_string()],
                license_label: "MIT".to_string(),
                license_url: "https://example.com/license".to_string(),
                model_card_url: None,
                model_id: "small".to_string(),
                notes: vec![],
                recommended: true,
                source_url: "https://example.com".to_string(),
                summary: "summary".to_string(),
                ux_tags: vec![],
            }],
        }
    }
}
