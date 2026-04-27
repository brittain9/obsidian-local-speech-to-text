use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::catalog::ModelCatalog;
use crate::engine::capabilities::{AcceleratorId, ModelFamilyId, RuntimeId};
use crate::engine::registry::EngineRegistry;
use crate::installer::{InstallRequest, ModelInstallManager, ModelProbe};
use crate::model_store::{
    remove_installed_model, resolve_catalog_model_runtime_path, resolve_model_store_info,
    scan_installed_models,
};
use crate::protocol::{
    AccelerationPreference, Command, CompiledAdapterInfo, CompiledRuntimeInfo, ContextWindow,
    Event, HealthStatus, ListeningMode, ModelInstallState, ModelProbeStatus, SelectedModel,
    SessionState, SessionStopReason, system_info_string,
};
use crate::session::{
    FinalizedUtterance, ListeningSession, SessionAction, SessionBaseState, SessionConfig,
    SessionInitError,
};
use crate::transcription::GpuConfig;
use crate::worker::{SessionMetadata, TranscriptionWorker, WorkerCommand, WorkerEvent};

const MAX_QUEUED_UTTERANCES: usize = 1;
// Whisper's `initial_prompt` is hard-capped at 224 tokens (silently truncated
// to the final 224 — see OpenAI's Whisper Prompting Guide). 384 chars of
// glossary content (mostly short identifiers) lands comfortably under that
// cap with headroom for tokenizer variance, while still fitting roughly
// 30-60 distinct terms.
const CONTEXT_BUDGET_CHARS: u32 = 384;
const CONTEXT_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
type SessionFactory = fn(SessionConfig) -> Result<ListeningSession, SessionInitError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFlow {
    Continue,
    Shutdown,
}

/// Top-level sidecar state machine. Owns the worker channel, model
/// registry, and pending-context queue.
///
/// Hosts must drive this on a loop: handle each incoming command/audio
/// frame, then call `drain_pending_outputs` to flush worker events and
/// any expired context-request dispatches before blocking on the next
/// read.
pub struct AppState {
    active_session: Option<ActiveSession>,
    catalog: Arc<ModelCatalog>,
    install_manager: ModelInstallManager,
    registry: Arc<EngineRegistry>,
    session_factory: SessionFactory,
    sidecar_version: String,
    transcription_worker: TranscriptionWorker,
}

struct ActiveSession {
    draining: bool,
    last_reported_state: Option<SessionState>,
    pause_while_processing: bool,
    pending_context_requests: Vec<PendingContextRequest>,
    queued_utterances: usize,
    session: ListeningSession,
    transcription_active: bool,
}

struct PendingContextRequest {
    correlation_id: Uuid,
    deadline: Instant,
    duration_ms: u64,
    samples: Vec<i16>,
    session_id: String,
    utterance_id: Uuid,
}

struct ResolvedModelSelection {
    display_name: String,
    runtime_id: RuntimeId,
    family_id: ModelFamilyId,
    installed: bool,
    model_id: Option<String>,
    resolved_path: PathBuf,
    selection: SelectedModel,
    size_bytes: u64,
}

#[derive(Default)]
struct ProbeErrorFields {
    details: Option<String>,
    display_name: Option<String>,
    installed: bool,
    model_id: Option<String>,
    resolved_path: Option<String>,
}

impl AppState {
    pub fn new(sidecar_version: impl Into<String>, catalog: ModelCatalog) -> Self {
        let registry = Arc::new(EngineRegistry::build());
        Self::with_registry(sidecar_version, catalog, registry, ListeningSession::new)
    }

    fn with_registry(
        sidecar_version: impl Into<String>,
        catalog: ModelCatalog,
        registry: Arc<EngineRegistry>,
        session_factory: SessionFactory,
    ) -> Self {
        let model_probe: Arc<ModelProbe> = {
            let registry = Arc::clone(&registry);
            Arc::new(move |runtime_id, family_id, path| {
                registry.probe_model(runtime_id, family_id, path)
            })
        };

        Self {
            active_session: None,
            catalog: Arc::new(catalog),
            install_manager: ModelInstallManager::new(model_probe),
            registry: Arc::clone(&registry),
            session_factory,
            sidecar_version: sidecar_version.into(),
            transcription_worker: TranscriptionWorker::spawn(Arc::clone(&registry)),
        }
    }

    /// Drain all pending outputs the host should write before its next
    /// blocking read: queued worker events plus any context-request
    /// dispatches whose deadline has elapsed. Hosts driving `AppState`
    /// MUST call this each iteration of their main loop — context-request
    /// timeouts only fire from here, and skipping a tick will eventually
    /// wedge the worker queue.
    pub fn drain_pending_outputs(&mut self) -> Vec<Event> {
        let mut events = self.drain_worker_events();
        events.extend(self.tick());
        events
    }

    pub(crate) fn drain_worker_events(&mut self) -> Vec<Event> {
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
        if self.active_session.as_ref().is_some_and(|s| s.draining) {
            return events;
        }

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
                active_session.pause_while_processing && active_session.transcription_active
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
                    status: HealthStatus::Ready,
                });

                (ControlFlow::Continue, events)
            }
            Command::ContextResponse {
                correlation_id,
                context,
            } => {
                self.handle_context_response(correlation_id, context, &mut events);
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
                    runtimes: self.catalog.runtimes.clone(),
                    families: self.catalog.families.clone(),
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
                runtime_id,
                family_id,
                model_id,
                model_store_path_override,
            } => {
                match resolve_model_store_info(model_store_path_override.as_deref()).and_then(
                    |info| remove_installed_model(&info.path, runtime_id, family_id, &model_id),
                ) {
                    Ok(removed) => events.push(Event::ModelRemoved {
                        runtime_id,
                        family_id,
                        model_id,
                        removed,
                    }),
                    Err(_error) => events.push(Event::ModelRemoved {
                        runtime_id,
                        family_id,
                        model_id,
                        removed: false,
                    }),
                }

                (ControlFlow::Continue, events)
            }
            Command::InstallModel {
                runtime_id,
                family_id,
                install_id,
                model_id,
                model_store_path_override,
            } => {
                match self
                    .catalog
                    .find_model(runtime_id, family_id, &model_id)
                    .cloned()
                {
                    None => events.push(Event::ModelInstallUpdate {
                        details: None,
                        downloaded_bytes: None,
                        runtime_id,
                        family_id,
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
                                    catalog: Arc::clone(&self.catalog),
                                    runtime_id,
                                    family_id,
                                    install_id,
                                    model,
                                    model_id,
                                    store_root: info.path,
                                }))
                            }
                            Err(error) => events.push(Event::ModelInstallUpdate {
                                details: Some(format!("{error:#}")),
                                downloaded_bytes: None,
                                runtime_id,
                                family_id,
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
                events.push(self.build_system_info_event());

                (ControlFlow::Continue, events)
            }
            Command::StartSession {
                acceleration_preference,
                language,
                mode,
                model_selection,
                model_store_path_override,
                pause_while_processing,
                session_id,
                speaking_style,
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
                        let use_gpu = resolve_use_gpu(
                            resolved_model.runtime_id,
                            acceleration_preference,
                            self.registry.as_ref(),
                        );
                        let config = SessionConfig {
                            mode,
                            session_id: session_id.clone(),
                            style: speaking_style,
                        };
                        let session = match (self.session_factory)(config) {
                            Ok(session) => session,
                            Err(SessionInitError::VadLoad(details)) => {
                                events.push(Event::Error {
                                    code: "vad_init_failed".to_string(),
                                    details: Some(details),
                                    message: "Failed to initialize the bundled Silero VAD."
                                        .to_string(),
                                    session_id: None,
                                });

                                return (ControlFlow::Continue, events);
                            }
                        };

                        if self
                            .transcription_worker
                            .send(WorkerCommand::BeginSession(SessionMetadata {
                                runtime_id: resolved_model.runtime_id,
                                family_id: resolved_model.family_id,
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

                        self.active_session = Some(ActiveSession {
                            draining: false,
                            last_reported_state: None,
                            pause_while_processing,
                            pending_context_requests: Vec::new(),
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

    fn build_system_info_event(&self) -> Event {
        let compiled_runtimes: Vec<CompiledRuntimeInfo> = self
            .registry
            .runtimes()
            .map(|runtime| CompiledRuntimeInfo {
                runtime_id: runtime.id(),
                display_name: runtime.id().display_name().to_string(),
                runtime_capabilities: runtime.capabilities().clone(),
            })
            .collect();

        let compiled_adapters: Vec<CompiledAdapterInfo> = self
            .registry
            .adapters()
            .map(|adapter| CompiledAdapterInfo {
                runtime_id: adapter.runtime_id(),
                family_id: adapter.family_id(),
                display_name: adapter.family_id().display_name().to_string(),
                family_capabilities: adapter.capabilities().clone(),
            })
            .collect();

        Event::SystemInfo {
            sidecar_version: self.sidecar_version.clone(),
            compiled_runtimes,
            compiled_adapters,
            system_info: system_info_string(),
        }
    }

    fn build_probe_event(
        &self,
        selection: SelectedModel,
        model_store_path_override: Option<&str>,
    ) -> Event {
        match self.resolve_selected_model(&selection, model_store_path_override) {
            Ok(resolved_model) => {
                let merged_capabilities = self
                    .registry
                    .merged_capabilities(resolved_model.runtime_id, resolved_model.family_id);
                Event::ModelProbeResult {
                    available: true,
                    details: None,
                    display_name: Some(resolved_model.display_name),
                    runtime_id: resolved_model.runtime_id,
                    family_id: resolved_model.family_id,
                    installed: resolved_model.installed,
                    merged_capabilities,
                    message: "Model selection is ready.".to_string(),
                    model_id: resolved_model.model_id,
                    resolved_path: Some(resolved_model.resolved_path.display().to_string()),
                    selection: resolved_model.selection,
                    size_bytes: Some(resolved_model.size_bytes),
                    status: ModelProbeStatus::Ready,
                }
            }
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
            active_session.pause_while_processing,
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
        if reason == SessionStopReason::UserStop {
            return self.graceful_stop();
        }

        let active_session = self.active_session.take()?;
        let session_id = active_session.session.config().session_id.clone();
        let _ = self.transcription_worker.send(WorkerCommand::EndSession {
            session_id: session_id.clone(),
        });

        Some(vec![Event::SessionStopped { reason, session_id }])
    }

    fn graceful_stop(&mut self) -> Option<Vec<Event>> {
        let active_session = self.active_session.as_mut()?;
        let mut events = Vec::new();

        let final_utterance = active_session.session.maybe_finalize_utterance();
        active_session.session.clear_activity();

        if let Some(utterance) = final_utterance {
            self.enqueue_utterance(utterance, &mut events);
        }

        let active_session = self.active_session.as_mut()?;
        if !active_session.transcription_active {
            let session_id = active_session.session.config().session_id.clone();
            self.active_session = None;
            let _ = self.transcription_worker.send(WorkerCommand::EndSession {
                session_id: session_id.clone(),
            });
            events.push(Event::SessionStopped {
                reason: SessionStopReason::UserStop,
                session_id,
            });
            return Some(events);
        }

        // Transcription is still in flight; defer SessionStopped until the last
        // TranscriptReady drains through the worker.
        active_session.draining = true;
        self.emit_state_if_changed(&mut events);
        Some(events)
    }

    /// If the session is draining and no transcription work remains, tear it
    /// down and emit `SessionStopped`. Returns `true` when the drain completed.
    fn maybe_complete_drain(&mut self, session_id: &str, events: &mut Vec<Event>) -> bool {
        let Some(active_session) = self.active_session.as_ref() else {
            return false;
        };

        if !active_session.draining || active_session.transcription_active {
            return false;
        }

        self.active_session = None;
        let _ = self.transcription_worker.send(WorkerCommand::EndSession {
            session_id: session_id.to_owned(),
        });
        events.push(Event::SessionStopped {
            reason: SessionStopReason::UserStop,
            session_id: session_id.to_owned(),
        });
        true
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
                utterance_id: _,
            } => {
                {
                    let Some(active_session) = self.active_session.as_mut() else {
                        return;
                    };

                    if active_session.session.config().session_id != session_id {
                        return;
                    }

                    advance_transcription_queue(active_session);
                }

                events.push(Event::Error {
                    code,
                    details,
                    message,
                    session_id: Some(session_id.clone()),
                });

                if self.maybe_complete_drain(&session_id, events) {
                    return;
                }

                self.emit_state_if_changed(events);
            }
            WorkerEvent::TranscriptReady {
                processing_duration_ms,
                session_id,
                transcript,
                utterance_duration_ms,
                warnings,
            } => {
                {
                    let Some(active_session) = self.active_session.as_mut() else {
                        return;
                    };

                    if active_session.session.config().session_id != session_id {
                        return;
                    }

                    advance_transcription_queue(active_session);
                }

                let is_final = transcript.is_final();
                let text = transcript.joined_text();
                events.push(Event::TranscriptReady {
                    is_final,
                    processing_duration_ms,
                    revision: transcript.revision,
                    segments: transcript.segments,
                    session_id: session_id.clone(),
                    stage_results: transcript.stage_history,
                    text,
                    utterance_duration_ms,
                    utterance_id: transcript.utterance_id,
                    warnings,
                });

                if self.maybe_complete_drain(&session_id, events) {
                    return;
                }

                let should_stop = self
                    .active_session
                    .as_ref()
                    .is_some_and(|s| s.session.config().mode == ListeningMode::OneSentence);

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
        let Some(active_session) = self.active_session.as_mut() else {
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

        let utterance_id = Uuid::new_v4();
        let correlation_id = Uuid::new_v4();
        let deadline = Instant::now() + CONTEXT_REQUEST_TIMEOUT;

        if was_transcribing {
            active_session.queued_utterances += 1;
        } else {
            active_session.transcription_active = true;
        }

        active_session
            .pending_context_requests
            .push(PendingContextRequest {
                correlation_id,
                deadline,
                duration_ms: utterance.duration_ms,
                samples: utterance.samples,
                session_id: session_id.clone(),
                utterance_id,
            });

        events.push(Event::ContextRequest {
            budget_chars: CONTEXT_BUDGET_CHARS,
            correlation_id,
            session_id,
            utterance_id,
        });
    }

    fn handle_context_response(
        &mut self,
        correlation_id: Uuid,
        context: Option<ContextWindow>,
        events: &mut Vec<Event>,
    ) {
        let Some(active_session) = self.active_session.as_mut() else {
            return;
        };

        let Some(index) = active_session
            .pending_context_requests
            .iter()
            .position(|pending| pending.correlation_id == correlation_id)
        else {
            return;
        };

        let pending = active_session.pending_context_requests.remove(index);
        self.dispatch_pending(pending, context, events);
    }

    /// Dispatch any pending context requests whose deadline has elapsed.
    pub(crate) fn tick(&mut self) -> Vec<Event> {
        let Some(active_session) = self.active_session.as_mut() else {
            return Vec::new();
        };
        if active_session.pending_context_requests.is_empty() {
            return Vec::new();
        }

        let now = Instant::now();
        let expired: Vec<PendingContextRequest> = active_session
            .pending_context_requests
            .extract_if(.., |pending| pending.deadline <= now)
            .collect();

        let mut events = Vec::new();
        for pending in expired {
            self.dispatch_pending(pending, None, &mut events);
        }
        events
    }

    fn dispatch_pending(
        &mut self,
        pending: PendingContextRequest,
        context: Option<ContextWindow>,
        events: &mut Vec<Event>,
    ) {
        let send_result = self
            .transcription_worker
            .send(WorkerCommand::TranscribeUtterance {
                context,
                duration_ms: pending.duration_ms,
                samples: pending.samples,
                session_id: pending.session_id.clone(),
                utterance_id: pending.utterance_id,
            });

        if send_result.is_err() {
            events.push(Event::Error {
                code: "internal_error".to_string(),
                details: None,
                message: "Failed to queue audio for local transcription.".to_string(),
                session_id: Some(pending.session_id),
            });

            if let Some(active_session) = self.active_session.as_mut() {
                advance_transcription_queue(active_session);
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
                    // A successful probe never reaches this branch: the Err
                    // path only carries Missing or Invalid statuses. Treating
                    // Ready as Invalid keeps the dispatch exhaustive without
                    // falsely signalling success.
                    code: match status {
                        ModelProbeStatus::Missing => "missing_model_file".to_string(),
                        ModelProbeStatus::Invalid | ModelProbeStatus::Ready => {
                            "invalid_model_file".to_string()
                        }
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
        let runtime_id = selection.runtime_id();
        let family_id = selection.family_id();
        let probe_error = |status, message: &str, fields: ProbeErrorFields| {
            Box::new(Event::ModelProbeResult {
                available: false,
                size_bytes: None,
                runtime_id,
                family_id,
                selection: selection.clone(),
                status,
                message: message.to_string(),
                details: fields.details,
                display_name: fields.display_name,
                installed: fields.installed,
                merged_capabilities: None,
                model_id: fields.model_id,
                resolved_path: fields.resolved_path,
            })
        };

        match selection {
            SelectedModel::CatalogModel { model_id, .. } => {
                let model = self
                    .catalog
                    .find_model(runtime_id, family_id, model_id)
                    .cloned()
                    .ok_or_else(|| {
                        probe_error(
                            ModelProbeStatus::Invalid,
                            "The selected managed model does not exist in the bundled catalog.",
                            ProbeErrorFields {
                                model_id: Some(model_id.clone()),
                                ..Default::default()
                            },
                        )
                    })?;
                let store_info =
                    resolve_model_store_info(model_store_path_override).map_err(|error| {
                        probe_error(
                            ModelProbeStatus::Invalid,
                            "The model store path is invalid.",
                            ProbeErrorFields {
                                details: Some(format!("{error:#}")),
                                display_name: Some(model.display_name.clone()),
                                model_id: Some(model_id.clone()),
                                ..Default::default()
                            },
                        )
                    })?;
                let resolved_path = resolve_catalog_model_runtime_path(
                    &self.catalog,
                    &store_info.path,
                    runtime_id,
                    family_id,
                    model_id,
                )
                .map_err(|error| {
                    probe_error(
                        ModelProbeStatus::Missing,
                        "The selected managed model is not installed or is incomplete.",
                        ProbeErrorFields {
                            details: Some(format!("{error:#}")),
                            display_name: Some(model.display_name.clone()),
                            model_id: Some(model_id.clone()),
                            ..Default::default()
                        },
                    )
                })?;
                self.registry
                    .probe_model(runtime_id, family_id, &resolved_path)
                    .map_err(|error| {
                        probe_error(
                            ModelProbeStatus::Invalid,
                            error.message,
                            ProbeErrorFields {
                                details: error.details,
                                display_name: Some(model.display_name.clone()),
                                installed: true,
                                model_id: Some(model_id.clone()),
                                resolved_path: Some(resolved_path.display().to_string()),
                            },
                        )
                    })?;
                let size_bytes = file_size(&resolved_path);

                Ok(ResolvedModelSelection {
                    display_name: model.display_name,
                    runtime_id,
                    family_id,
                    installed: true,
                    model_id: Some(model_id.clone()),
                    resolved_path,
                    selection: selection.clone(),
                    size_bytes,
                })
            }
            SelectedModel::ExternalFile { file_path, .. } => {
                let trimmed_path = file_path.trim();

                if trimmed_path.is_empty() {
                    return Err(probe_error(
                        ModelProbeStatus::Invalid,
                        "External model file path is not configured.",
                        ProbeErrorFields::default(),
                    ));
                }

                let model_path = Path::new(trimmed_path);

                if !model_path.is_absolute() {
                    return Err(probe_error(
                        ModelProbeStatus::Invalid,
                        "External model file path must be absolute.",
                        ProbeErrorFields {
                            details: Some(trimmed_path.to_string()),
                            display_name: Some(file_name_or_path(model_path)),
                            ..Default::default()
                        },
                    ));
                }

                self.registry
                    .probe_model(runtime_id, family_id, model_path)
                    .map_err(|error| {
                        let status = if error.code == "missing_model_file" {
                            ModelProbeStatus::Missing
                        } else {
                            ModelProbeStatus::Invalid
                        };
                        probe_error(
                            status,
                            error.message,
                            ProbeErrorFields {
                                details: error.details,
                                display_name: Some(file_name_or_path(model_path)),
                                resolved_path: Some(model_path.display().to_string()),
                                ..Default::default()
                            },
                        )
                    })?;
                let size_bytes = file_size(model_path);

                Ok(ResolvedModelSelection {
                    display_name: file_name_or_path(model_path),
                    runtime_id,
                    family_id,
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
    pause_while_processing: bool,
    session: &ListeningSession,
) -> SessionState {
    let base_state = session.base_state();

    if base_state == SessionBaseState::SpeechDetected {
        return SessionState::SpeechDetected;
    }

    if base_state == SessionBaseState::SpeechEnding {
        return SessionState::SpeechEnding;
    }

    if transcription_active {
        if pause_while_processing {
            return SessionState::Paused;
        }

        return SessionState::Transcribing;
    }

    if queued_utterances > 0 {
        return SessionState::Transcribing;
    }

    match base_state {
        SessionBaseState::Listening => SessionState::Listening,
        SessionBaseState::SpeechDetected | SessionBaseState::SpeechEnding => {
            unreachable!("handled above")
        }
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

fn resolve_use_gpu(
    runtime_id: RuntimeId,
    acceleration_preference: AccelerationPreference,
    registry: &EngineRegistry,
) -> bool {
    match acceleration_preference {
        AccelerationPreference::CpuOnly => false,
        AccelerationPreference::Auto => match registry.runtime(runtime_id) {
            Some(runtime) => runtime
                .capabilities()
                .available_accelerators
                .iter()
                .any(|accelerator| *accelerator != AcceleratorId::Cpu),
            None => {
                // Reaching here means dispatch picked a runtime the registry
                // did not register — a registration bug, not a runtime state.
                // Crash loudly in debug builds so regressions surface during
                // development while release builds stay on CPU rather than
                // panicking on a user's machine.
                debug_assert!(
                    false,
                    "resolve_use_gpu called with unregistered runtime {runtime_id:?}"
                );
                false
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::env::temp_dir;
    use std::fs::{create_dir_all, write};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use std::time::{Duration, Instant};

    use uuid::Uuid;

    use super::{AppState, ControlFlow};
    use crate::catalog::{
        ArtifactRole, CatalogModel, ModelArtifact, ModelCatalog, ModelCollection,
        ModelFamilyDescriptor, ModelRuntimeDescriptor,
    };
    use crate::engine::capabilities::{
        AcceleratorAvailability, AcceleratorId, LanguageSupport, ModelFamilyCapabilities,
        ModelFamilyId, ModelFormat, RuntimeCapabilities, RuntimeId,
    };
    use crate::engine::registry::EngineRegistry;
    use crate::engine::traits::{LoadedModel, ModelFamilyAdapter, Runtime};
    use crate::protocol::{
        AccelerationPreference, Command, ContextWindow, ContextWindowSource, Event, HealthStatus,
        ListeningMode, ModelProbeStatus, SelectedModel, SessionState, SessionStopReason,
    };
    use crate::session::{FinalizedUtterance, ListeningSession, SessionInitError, SpeakingStyle};
    use crate::transcription::{
        EngineTranscriptOutput, GpuConfig, TranscriptionError, TranscriptionRequest,
        validate_model_path,
    };

    struct FakeRuntime {
        capabilities: RuntimeCapabilities,
    }

    impl FakeRuntime {
        fn cpu_only() -> Self {
            let mut accelerator_details = std::collections::HashMap::new();
            accelerator_details.insert(
                AcceleratorId::Cpu,
                AcceleratorAvailability {
                    available: true,
                    unavailable_reason: None,
                },
            );
            Self {
                capabilities: RuntimeCapabilities {
                    available_accelerators: vec![AcceleratorId::Cpu],
                    accelerator_details,
                    supported_model_formats: vec![ModelFormat::Ggml, ModelFormat::Gguf],
                },
            }
        }

        fn with_cuda() -> Self {
            let mut accelerator_details = std::collections::HashMap::new();
            accelerator_details.insert(
                AcceleratorId::Cpu,
                AcceleratorAvailability {
                    available: true,
                    unavailable_reason: None,
                },
            );
            accelerator_details.insert(
                AcceleratorId::Cuda,
                AcceleratorAvailability {
                    available: true,
                    unavailable_reason: None,
                },
            );
            Self {
                capabilities: RuntimeCapabilities {
                    available_accelerators: vec![AcceleratorId::Cpu, AcceleratorId::Cuda],
                    accelerator_details,
                    supported_model_formats: vec![ModelFormat::Ggml, ModelFormat::Gguf],
                },
            }
        }
    }

    impl Runtime for FakeRuntime {
        fn id(&self) -> RuntimeId {
            RuntimeId::WhisperCpp
        }

        fn capabilities(&self) -> &RuntimeCapabilities {
            &self.capabilities
        }
    }

    struct FakeAdapter {
        capabilities: ModelFamilyCapabilities,
    }

    impl FakeAdapter {
        fn new() -> Self {
            Self {
                capabilities: ModelFamilyCapabilities {
                    supports_timed_segments: true,
                    supports_initial_prompt: true,
                    supports_language_selection: false,
                    supported_languages: LanguageSupport::EnglishOnly,
                    max_audio_duration_secs: None,
                    produces_punctuation: true,
                },
            }
        }
    }

    struct FakeLoadedModel;

    impl LoadedModel for FakeLoadedModel {
        fn transcribe(
            &mut self,
            _request: &TranscriptionRequest,
        ) -> Result<EngineTranscriptOutput, TranscriptionError> {
            Ok(EngineTranscriptOutput {
                segments: Vec::new(),
            })
        }
    }

    impl ModelFamilyAdapter for FakeAdapter {
        fn runtime_id(&self) -> RuntimeId {
            RuntimeId::WhisperCpp
        }

        fn family_id(&self) -> ModelFamilyId {
            ModelFamilyId::Whisper
        }

        fn capabilities(&self) -> &ModelFamilyCapabilities {
            &self.capabilities
        }

        fn probe_model(&self, path: &std::path::Path) -> Result<(), TranscriptionError> {
            validate_model_path(path)
        }

        fn load(
            &self,
            _path: &std::path::Path,
            _gpu: GpuConfig,
        ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
            Ok(Box::new(FakeLoadedModel))
        }
    }

    fn fake_registry() -> Arc<EngineRegistry> {
        let mut registry = EngineRegistry::default();
        registry.register_runtime(Box::new(FakeRuntime::cpu_only()));
        registry.register_adapter(Box::new(FakeAdapter::new()));
        Arc::new(registry)
    }

    fn fake_registry_with_cuda() -> Arc<EngineRegistry> {
        let mut registry = EngineRegistry::default();
        registry.register_runtime(Box::new(FakeRuntime::with_cuda()));
        registry.register_adapter(Box::new(FakeAdapter::new()));
        Arc::new(registry)
    }

    fn test_app() -> AppState {
        AppState::with_registry(
            "0.1.0",
            sample_catalog(),
            fake_registry(),
            ListeningSession::new,
        )
    }

    #[test]
    fn health_returns_ready_event() {
        let (control_flow, events) = test_app().handle_command(Command::Health);

        assert_eq!(control_flow, ControlFlow::Continue);
        assert_eq!(
            events,
            vec![Event::HealthOk {
                sidecar_version: "0.1.0".to_string(),
                status: HealthStatus::Ready,
            }]
        );
    }

    #[test]
    fn get_system_info_returns_compiled_runtimes_and_adapters() {
        let (control_flow, events) = test_app().handle_command(Command::GetSystemInfo);

        assert_eq!(control_flow, ControlFlow::Continue);
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::SystemInfo {
                sidecar_version,
                compiled_runtimes,
                compiled_adapters,
                system_info: _,
            } => {
                assert_eq!(sidecar_version, "0.1.0");
                assert!(
                    compiled_runtimes
                        .iter()
                        .any(|runtime| runtime.runtime_id == RuntimeId::WhisperCpp)
                );
                assert!(compiled_adapters.iter().any(|adapter| {
                    adapter.runtime_id == RuntimeId::WhisperCpp
                        && adapter.family_id == ModelFamilyId::Whisper
                }));
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
        let missing = temp_dir().join("definitely-missing-model.bin");
        let (_, events) = test_app().handle_command(start_session_command("session-1", &missing));

        assert!(
            matches!(events.first(), Some(Event::Error { code, .. }) if code == "missing_model_file")
        );
    }

    #[test]
    fn probe_model_selection_reports_missing_managed_model() {
        let (_, events) = test_app().handle_command(Command::ProbeModelSelection {
            model_selection: SelectedModel::CatalogModel {
                runtime_id: RuntimeId::WhisperCpp,
                family_id: ModelFamilyId::Whisper,
                model_id: "small".to_string(),
            },
            model_store_path_override: Some(
                temp_dir().join("missing-model-store").display().to_string(),
            ),
        });

        match events.first() {
            Some(Event::ModelProbeResult {
                status,
                merged_capabilities,
                ..
            }) => {
                assert_eq!(*status, ModelProbeStatus::Missing);
                assert!(
                    merged_capabilities.is_none(),
                    "missing probes must not carry merged capabilities"
                );
            }
            other => panic!("expected missing ModelProbeResult, got {other:?}"),
        }
    }

    #[test]
    fn probe_model_selection_reports_ready_with_merged_capabilities() {
        let model_file_path = create_model_file();
        let (_, events) = test_app().handle_command(Command::ProbeModelSelection {
            model_selection: SelectedModel::ExternalFile {
                runtime_id: RuntimeId::WhisperCpp,
                family_id: ModelFamilyId::Whisper,
                file_path: model_file_path.display().to_string(),
            },
            model_store_path_override: None,
        });

        match events.first() {
            Some(Event::ModelProbeResult {
                status,
                merged_capabilities,
                ..
            }) => {
                assert_eq!(*status, ModelProbeStatus::Ready);
                let caps = merged_capabilities
                    .as_ref()
                    .expect("ready probes must carry merged capabilities");
                assert_eq!(caps.runtime_id, RuntimeId::WhisperCpp);
                assert_eq!(caps.family_id, ModelFamilyId::Whisper);
                assert!(caps.family.supports_initial_prompt);
                assert!(
                    caps.runtime
                        .available_accelerators
                        .contains(&AcceleratorId::Cpu)
                );
            }
            other => panic!("expected ready ModelProbeResult, got {other:?}"),
        }
    }

    #[test]
    fn probe_model_selection_reports_invalid_without_capabilities() {
        let (_, events) = test_app().handle_command(Command::ProbeModelSelection {
            model_selection: SelectedModel::ExternalFile {
                runtime_id: RuntimeId::WhisperCpp,
                family_id: ModelFamilyId::Whisper,
                file_path: "relative/path.bin".to_string(),
            },
            model_store_path_override: None,
        });

        match events.first() {
            Some(Event::ModelProbeResult {
                status,
                merged_capabilities,
                ..
            }) => {
                assert_eq!(*status, ModelProbeStatus::Invalid);
                assert!(
                    merged_capabilities.is_none(),
                    "invalid probes must not carry merged capabilities"
                );
            }
            other => panic!("expected invalid ModelProbeResult, got {other:?}"),
        }
    }

    #[test]
    fn auto_acceleration_uses_available_gpu_accelerator() {
        assert!(super::resolve_use_gpu(
            RuntimeId::WhisperCpp,
            AccelerationPreference::Auto,
            fake_registry_with_cuda().as_ref(),
        ));
    }

    #[test]
    fn auto_acceleration_skips_when_only_cpu_available() {
        assert!(!super::resolve_use_gpu(
            RuntimeId::WhisperCpp,
            AccelerationPreference::Auto,
            fake_registry().as_ref(),
        ));
    }

    #[test]
    fn cpu_only_acceleration_disables_gpu_even_when_available() {
        assert!(!super::resolve_use_gpu(
            RuntimeId::WhisperCpp,
            AccelerationPreference::CpuOnly,
            fake_registry_with_cuda().as_ref(),
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

    #[test]
    fn start_session_surfaces_vad_initialization_failure() {
        let model_file_path = create_model_file();
        let mut app = AppState::with_registry("0.1.0", sample_catalog(), fake_registry(), |_| {
            Err(SessionInitError::VadLoad(
                "model bootstrap failed".to_string(),
            ))
        });

        let (_, events) = app.handle_command(start_session_command("session-1", &model_file_path));

        assert_eq!(
            events,
            vec![Event::Error {
                code: "vad_init_failed".to_string(),
                details: Some("model bootstrap failed".to_string()),
                message: "Failed to initialize the bundled Silero VAD.".to_string(),
                session_id: None,
            }]
        );
    }

    #[test]
    fn enqueue_utterance_emits_context_request_and_records_pending_entry() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let mut events = Vec::new();
        app.enqueue_utterance(fake_utterance(), &mut events);

        assert_eq!(events.len(), 1, "expected exactly one ContextRequest event");
        let (correlation_id, utterance_id) = match &events[0] {
            Event::ContextRequest {
                budget_chars,
                correlation_id,
                session_id,
                utterance_id,
            } => {
                assert_eq!(*budget_chars, 384);
                assert_eq!(session_id, "session-1");
                (*correlation_id, *utterance_id)
            }
            other => panic!("expected ContextRequest, got {other:?}"),
        };

        let active = app
            .active_session
            .as_ref()
            .expect("active session should still be present after enqueue");
        assert_eq!(active.pending_context_requests.len(), 1);
        let pending = &active.pending_context_requests[0];
        assert_eq!(pending.correlation_id, correlation_id);
        assert_eq!(pending.utterance_id, utterance_id);
        assert_eq!(pending.session_id, "session-1");
        assert_eq!(pending.duration_ms, 1000);
        assert!(active.transcription_active);
    }

    #[test]
    fn context_response_with_window_clears_pending_request() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let mut events = Vec::new();
        app.enqueue_utterance(fake_utterance(), &mut events);
        let correlation_id = match &events[0] {
            Event::ContextRequest { correlation_id, .. } => *correlation_id,
            other => panic!("expected ContextRequest, got {other:?}"),
        };

        let context_window = ContextWindow {
            budget_chars: 384,
            sources: vec![ContextWindowSource::SessionUtterance {
                end_revision: 0,
                text: "previous note text".to_string(),
                truncated: false,
                utterance_id: Uuid::new_v4(),
            }],
            text: "previous note text".to_string(),
            truncated: false,
        };
        let (control_flow, response_events) = app.handle_command(Command::ContextResponse {
            correlation_id,
            context: Some(context_window),
        });

        assert_eq!(control_flow, ControlFlow::Continue);
        assert!(
            response_events.is_empty(),
            "ContextResponse should dispatch silently on success: {response_events:?}"
        );
        let active = app.active_session.as_ref().expect("active session");
        assert!(active.pending_context_requests.is_empty());
    }

    #[test]
    fn context_response_with_null_window_clears_pending_request() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let mut events = Vec::new();
        app.enqueue_utterance(fake_utterance(), &mut events);
        let correlation_id = match &events[0] {
            Event::ContextRequest { correlation_id, .. } => *correlation_id,
            other => panic!("expected ContextRequest, got {other:?}"),
        };

        let (control_flow, response_events) = app.handle_command(Command::ContextResponse {
            correlation_id,
            context: None,
        });

        assert_eq!(control_flow, ControlFlow::Continue);
        assert!(response_events.is_empty());
        let active = app.active_session.as_ref().expect("active session");
        assert!(active.pending_context_requests.is_empty());
    }

    #[test]
    fn context_response_with_unknown_correlation_id_is_a_no_op() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let mut events = Vec::new();
        app.enqueue_utterance(fake_utterance(), &mut events);

        let (control_flow, response_events) = app.handle_command(Command::ContextResponse {
            correlation_id: Uuid::new_v4(),
            context: None,
        });

        assert_eq!(control_flow, ControlFlow::Continue);
        assert!(response_events.is_empty());
        let active = app.active_session.as_ref().expect("active session");
        assert_eq!(active.pending_context_requests.len(), 1);
    }

    #[test]
    fn tick_dispatches_pending_requests_past_their_deadline() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let mut events = Vec::new();
        app.enqueue_utterance(fake_utterance(), &mut events);

        if let Some(active) = app.active_session.as_mut() {
            for pending in active.pending_context_requests.iter_mut() {
                pending.deadline = Instant::now() - Duration::from_millis(1);
            }
        }

        let tick_events = app.tick();
        assert!(
            tick_events.is_empty(),
            "tick should dispatch silently on the timeout path: {tick_events:?}"
        );
        let active = app.active_session.as_ref().expect("active session");
        assert!(active.pending_context_requests.is_empty());
    }

    #[test]
    fn tick_leaves_pending_requests_in_place_before_their_deadline() {
        let model_file_path = create_model_file();
        let mut app = test_app();
        let _ = app.handle_command(start_session_command("session-1", &model_file_path));

        let mut events = Vec::new();
        app.enqueue_utterance(fake_utterance(), &mut events);

        let tick_events = app.tick();
        assert!(tick_events.is_empty());
        let active = app.active_session.as_ref().expect("active session");
        assert_eq!(active.pending_context_requests.len(), 1);
    }

    fn start_session_command(session_id: &str, model_file_path: &std::path::Path) -> Command {
        Command::StartSession {
            acceleration_preference: AccelerationPreference::Auto,
            language: "en".to_string(),
            mode: ListeningMode::AlwaysOn,
            model_selection: SelectedModel::ExternalFile {
                runtime_id: RuntimeId::WhisperCpp,
                family_id: ModelFamilyId::Whisper,
                file_path: model_file_path.display().to_string(),
            },
            model_store_path_override: None,
            pause_while_processing: true,
            session_id: session_id.to_string(),
            speaking_style: SpeakingStyle::Balanced,
        }
    }

    fn create_model_file() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should move forward")
            .as_nanos();
        let directory = temp_dir().join(format!("local-transcript-sidecar-tests-{unique}"));
        create_dir_all(&directory).expect("temp dir should create");
        let path = directory.join("model.bin");
        write(&path, b"model").expect("model file should write");
        path
    }

    fn fake_utterance() -> FinalizedUtterance {
        FinalizedUtterance {
            duration_ms: 1000,
            samples: vec![0i16; 16000],
        }
    }

    fn sample_catalog() -> ModelCatalog {
        ModelCatalog {
            catalog_version: 2,
            collections: vec![ModelCollection {
                collection_id: "english".to_string(),
                display_name: "English".to_string(),
                summary: "summary".to_string(),
            }],
            runtimes: vec![ModelRuntimeDescriptor {
                runtime_id: RuntimeId::WhisperCpp,
                display_name: "whisper.cpp".to_string(),
                summary: "summary".to_string(),
            }],
            families: vec![ModelFamilyDescriptor {
                family_id: ModelFamilyId::Whisper,
                runtime_id: RuntimeId::WhisperCpp,
                display_name: "Whisper".to_string(),
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
                collection_id: "english".to_string(),
                display_name: "Model".to_string(),
                runtime_id: RuntimeId::WhisperCpp,
                family_id: ModelFamilyId::Whisper,
                language_tags: vec!["en".to_string()],
                license_label: "MIT".to_string(),
                license_url: "https://example.com/license".to_string(),
                model_card_url: None,
                model_id: "small".to_string(),
                notes: vec![],
                source_url: "https://example.com".to_string(),
                summary: "summary".to_string(),
                ux_tags: vec![],
            }],
        }
    }
}
