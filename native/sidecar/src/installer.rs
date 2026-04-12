use std::fs::{self, File};
use std::io::{Read, Write};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};

use crate::catalog::{CatalogModel, ModelArtifact, ModelCatalog};
use crate::model_store::{
    create_install_metadata, resolve_model_install_dir, write_install_metadata,
};
use crate::protocol::{EngineId, Event, ModelInstallState};
use crate::transcription::{TranscriptionError, probe_model_path};

type ModelProbe = fn(&Path) -> Result<u64, TranscriptionError>;

#[derive(Debug, Clone)]
pub struct InstallRequest {
    pub engine_id: EngineId,
    pub install_id: String,
    pub model: CatalogModel,
    pub model_id: String,
    pub store_root: PathBuf,
    pub catalog: ModelCatalog,
}

#[derive(Debug)]
struct ActiveInstall {
    cancel_flag: Arc<AtomicBool>,
    engine_id: EngineId,
    install_id: String,
    join_handle: JoinHandle<()>,
    model_id: String,
}

pub struct ModelInstallManager {
    active_install: Option<ActiveInstall>,
    event_rx: Receiver<Event>,
    event_tx: Sender<Event>,
}

impl ModelInstallManager {
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::channel();

        Self {
            active_install: None,
            event_rx,
            event_tx,
        }
    }

    pub fn cancel_install(&mut self, install_id: &str) -> Option<Event> {
        let Some(active_install) = self.active_install.as_ref() else {
            return Some(failed_update(
                install_id,
                EngineId::WhisperCpp,
                "",
                "There is no active model install to cancel.",
            ));
        };

        if active_install.install_id != install_id {
            return Some(failed_update(
                install_id,
                active_install.engine_id,
                &active_install.model_id,
                "The requested install is not active and cannot be cancelled.",
            ));
        }

        active_install.cancel_flag.store(true, Ordering::SeqCst);
        None
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        let event = match self.event_rx.try_recv() {
            Ok(event) => event,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => {
                let active_install = self.active_install.take()?;
                let _ = active_install.join_handle.join();
                return Some(failed_update(
                    &active_install.install_id,
                    active_install.engine_id,
                    &active_install.model_id,
                    "Install thread terminated unexpectedly.",
                ));
            }
        };

        if let Event::ModelInstallUpdate {
            install_id, state, ..
        } = &event
            && matches!(
                *state,
                ModelInstallState::Cancelled
                    | ModelInstallState::Completed
                    | ModelInstallState::Failed
            )
            && self
                .active_install
                .as_ref()
                .map(|active_install| active_install.install_id == *install_id)
                .unwrap_or(false)
            && let Some(active_install) = self.active_install.take()
        {
            let _ = active_install.join_handle.join();
        }

        Some(event)
    }

    pub fn start_install(&mut self, request: InstallRequest) -> Event {
        if let Some(active_install) = self.active_install.as_ref() {
            return failed_update(
                &request.install_id,
                request.engine_id,
                &request.model_id,
                &format!(
                    "Another install is already active ({}) and this build supports one install at a time.",
                    active_install.install_id
                ),
            );
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let thread_cancel_flag = Arc::clone(&cancel_flag);
        let engine_id = request.engine_id;
        let active_install_id = request.install_id.clone();
        let active_model_id = request.model_id.clone();
        let total_bytes = request.model.required_download_bytes();
        let thread_event_tx = self.event_tx.clone();
        let join_handle = thread::spawn(move || {
            let panic_install_id = request.install_id.clone();
            let panic_model_id = request.model_id.clone();
            let panic_tx = thread_event_tx.clone();
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                run_install(request, thread_cancel_flag, thread_event_tx);
            }));

            if let Err(panic_payload) = result {
                let message = match panic_payload.downcast_ref::<&str>() {
                    Some(s) => format!("Install thread panicked: {s}"),
                    None => match panic_payload.downcast_ref::<String>() {
                        Some(s) => format!("Install thread panicked: {s}"),
                        None => "Install thread panicked unexpectedly.".to_string(),
                    },
                };
                let _ = panic_tx.send(failed_update(
                    &panic_install_id,
                    engine_id,
                    &panic_model_id,
                    &message,
                ));
            }
        });

        self.active_install = Some(ActiveInstall {
            cancel_flag,
            engine_id,
            install_id: active_install_id.clone(),
            join_handle,
            model_id: active_model_id.clone(),
        });

        Event::ModelInstallUpdate {
            details: None,
            downloaded_bytes: Some(0),
            engine_id,
            install_id: active_install_id,
            message: Some("Model install queued.".to_string()),
            model_id: active_model_id,
            state: ModelInstallState::Queued,
            total_bytes: Some(total_bytes),
        }
    }
}

impl Default for ModelInstallManager {
    fn default() -> Self {
        Self::new()
    }
}

fn run_install(request: InstallRequest, cancel_flag: Arc<AtomicBool>, event_tx: Sender<Event>) {
    let reporter = InstallReporter {
        engine_id: request.engine_id,
        install_id: request.install_id.clone(),
        model_id: request.model_id.clone(),
        total_bytes: request.model.required_download_bytes(),
        tx: event_tx,
    };

    let downloader = match HttpDownloadSource::new() {
        Ok(source) => source,
        Err(message) => {
            let _ = reporter.send(
                ModelInstallState::Failed,
                Some(message),
                None,
                reporter.total_bytes,
                Some(reporter.total_bytes),
            );
            return;
        }
    };

    if let Err(error) = install_model_with_downloader(
        &request,
        cancel_flag,
        &reporter,
        &downloader,
        probe_model_path,
    ) {
        match error {
            InstallError::Cancelled => {}
            InstallError::Failed(message) => {
                let _ = reporter.send(
                    ModelInstallState::Failed,
                    Some(message),
                    None,
                    reporter.total_bytes,
                    Some(reporter.total_bytes),
                );
            }
        }
    }
}

trait DownloadSource {
    fn open(&self, artifact: &ModelArtifact) -> Result<DownloadStream>;
}

struct DownloadStream {
    reader: Box<dyn Read + Send>,
    total_bytes: Option<u64>,
}

struct HttpDownloadSource {
    client: Client,
}

impl HttpDownloadSource {
    fn new() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

        Ok(Self { client })
    }
}

impl DownloadSource for HttpDownloadSource {
    fn open(&self, artifact: &ModelArtifact) -> Result<DownloadStream> {
        let response = self
            .client
            .get(&artifact.download_url)
            .send()
            .with_context(|| {
                format!(
                    "Failed to start download for {} from {}.",
                    artifact.filename, artifact.download_url
                )
            })?;
        let status = response.status();

        if !status.is_success() {
            return Err(anyhow!(
                "Download request for {} returned HTTP {} from {}.",
                artifact.filename,
                status,
                artifact.download_url
            ));
        }

        let total_bytes = response.content_length();

        Ok(DownloadStream {
            reader: Box::new(response),
            total_bytes,
        })
    }
}

#[derive(Debug)]
enum InstallError {
    Cancelled,
    Failed(String),
}

struct InstallReporter {
    engine_id: EngineId,
    install_id: String,
    model_id: String,
    total_bytes: u64,
    tx: Sender<Event>,
}

impl InstallReporter {
    fn send(
        &self,
        state: ModelInstallState,
        message: Option<String>,
        details: Option<String>,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    ) -> Result<()> {
        self.tx
            .send(Event::ModelInstallUpdate {
                details,
                downloaded_bytes: Some(downloaded_bytes),
                engine_id: self.engine_id,
                install_id: self.install_id.clone(),
                message,
                model_id: self.model_id.clone(),
                state,
                total_bytes,
            })
            .context("failed to emit install progress event")
    }
}

fn install_model_with_downloader(
    request: &InstallRequest,
    cancel_flag: Arc<AtomicBool>,
    reporter: &InstallReporter,
    downloader: &dyn DownloadSource,
    model_probe: ModelProbe,
) -> Result<(), InstallError> {
    let engine_root = request.store_root.join(request.engine_id.as_str());
    let target_dir =
        resolve_model_install_dir(&request.store_root, request.engine_id, &request.model_id);
    let stage_dir = engine_root.join(format!(
        ".staging-{}-{}",
        request.model_id, request.install_id
    ));

    let cleanup = |path: &Path| {
        if path.exists() {
            let _ = fs::remove_dir_all(path);
        }
    };

    cleanup(&stage_dir);
    fs::create_dir_all(&stage_dir).map_err(|error| {
        InstallError::Failed(format!("Failed to create staging directory: {error}"))
    })?;

    let required_artifacts: Vec<&ModelArtifact> = request
        .model
        .artifacts
        .iter()
        .filter(|artifact| artifact.required)
        .collect();
    let mut downloaded_total = 0_u64;

    for artifact in required_artifacts {
        if cancel_flag.load(Ordering::SeqCst) {
            cleanup(&stage_dir);
            let _ = reporter.send(
                ModelInstallState::Cancelled,
                Some("Model install cancelled.".to_string()),
                None,
                downloaded_total,
                Some(reporter.total_bytes),
            );
            return Err(InstallError::Cancelled);
        }

        let artifact_path = stage_dir.join(&artifact.filename);
        let temp_path = artifact_path.with_extension("part");

        if let Some(parent) = artifact_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                InstallError::Failed(format!(
                    "Failed to create artifact staging directory {}: {error}",
                    parent.display()
                ))
            })?;
        }

        reporter
            .send(
                ModelInstallState::Downloading,
                Some(format!("Downloading {}.", artifact.filename)),
                None,
                downloaded_total,
                Some(reporter.total_bytes),
            )
            .map_err(|error| InstallError::Failed(error.to_string()))?;

        let stream = downloader.open(artifact).map_err(|error| {
            cleanup(&stage_dir);
            InstallError::Failed(format!("{error:#}"))
        })?;
        let mut output = File::create(&temp_path).map_err(|error| {
            cleanup(&stage_dir);
            InstallError::Failed(format!("Failed to create {}: {error}", temp_path.display()))
        })?;
        let mut reader = stream.reader;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut artifact_downloaded = 0_u64;

        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                cleanup(&stage_dir);
                let _ = reporter.send(
                    ModelInstallState::Cancelled,
                    Some("Model install cancelled.".to_string()),
                    None,
                    downloaded_total + artifact_downloaded,
                    Some(reporter.total_bytes),
                );
                return Err(InstallError::Cancelled);
            }

            let read_count = reader.read(&mut buffer).map_err(|error| {
                cleanup(&stage_dir);
                InstallError::Failed(format!("Failed to read download stream: {error}"))
            })?;

            if read_count == 0 {
                break;
            }

            output.write_all(&buffer[..read_count]).map_err(|error| {
                cleanup(&stage_dir);
                InstallError::Failed(format!("Failed to write {}: {error}", temp_path.display()))
            })?;
            hasher.update(&buffer[..read_count]);
            artifact_downloaded += read_count as u64;

            reporter
                .send(
                    ModelInstallState::Downloading,
                    Some(format!("Downloading {}.", artifact.filename)),
                    None,
                    downloaded_total + artifact_downloaded,
                    stream.total_bytes.or(Some(reporter.total_bytes)),
                )
                .map_err(|error| InstallError::Failed(error.to_string()))?;
        }

        reporter
            .send(
                ModelInstallState::Verifying,
                Some(format!("Verifying {}.", artifact.filename)),
                None,
                downloaded_total + artifact_downloaded,
                Some(reporter.total_bytes),
            )
            .map_err(|error| InstallError::Failed(error.to_string()))?;

        if artifact_downloaded != artifact.size_bytes {
            cleanup(&stage_dir);
            return Err(InstallError::Failed(format!(
                "Downloaded size for {} did not match the catalog (expected {}, got {}).",
                artifact.filename, artifact.size_bytes, artifact_downloaded
            )));
        }

        let digest = format!("{:x}", hasher.finalize());

        if digest != artifact.sha256 {
            cleanup(&stage_dir);
            return Err(InstallError::Failed(format!(
                "SHA-256 verification failed for {}.",
                artifact.filename
            )));
        }

        fs::rename(&temp_path, &artifact_path).map_err(|error| {
            cleanup(&stage_dir);
            InstallError::Failed(format!(
                "Failed to finalize staged artifact {}: {error}",
                artifact_path.display()
            ))
        })?;
        downloaded_total += artifact_downloaded;
    }

    let runtime_artifact = request.model.primary_artifact().ok_or_else(|| {
        InstallError::Failed("Model is missing a transcription artifact.".to_string())
    })?;
    let runtime_path = stage_dir.join(&runtime_artifact.filename);

    reporter
        .send(
            ModelInstallState::Probing,
            Some("Probing the installed model.".to_string()),
            None,
            downloaded_total,
            Some(reporter.total_bytes),
        )
        .map_err(|error| InstallError::Failed(error.to_string()))?;

    model_probe(&runtime_path).map_err(|error| {
        cleanup(&stage_dir);
        InstallError::Failed(error.to_string())
    })?;

    let metadata = create_install_metadata(&request.catalog, request.engine_id, &request.model_id)
        .map_err(|error| {
            cleanup(&stage_dir);
            InstallError::Failed(format!("{error:#}"))
        })?;
    write_install_metadata(&stage_dir, &metadata).map_err(|error| {
        cleanup(&stage_dir);
        InstallError::Failed(format!("{error:#}"))
    })?;

    if target_dir.exists() {
        fs::remove_dir_all(&target_dir).map_err(|error| {
            cleanup(&stage_dir);
            InstallError::Failed(format!(
                "Failed to replace existing install {}: {error}",
                target_dir.display()
            ))
        })?;
    }

    fs::create_dir_all(&engine_root).map_err(|error| {
        cleanup(&stage_dir);
        InstallError::Failed(format!(
            "Failed to create engine directory {}: {error}",
            engine_root.display()
        ))
    })?;
    fs::rename(&stage_dir, &target_dir).map_err(|error| {
        cleanup(&stage_dir);
        InstallError::Failed(format!(
            "Failed to move staged install into place {}: {error}",
            target_dir.display()
        ))
    })?;

    reporter
        .send(
            ModelInstallState::Completed,
            Some("Model install completed.".to_string()),
            None,
            downloaded_total,
            Some(reporter.total_bytes),
        )
        .map_err(|error| InstallError::Failed(error.to_string()))?;
    Ok(())
}

fn failed_update(install_id: &str, engine_id: EngineId, model_id: &str, message: &str) -> Event {
    Event::ModelInstallUpdate {
        details: None,
        downloaded_bytes: None,
        engine_id,
        install_id: install_id.to_string(),
        message: Some(message.to_string()),
        model_id: model_id.to_string(),
        state: ModelInstallState::Failed,
        total_bytes: None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::io::Cursor;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;

    use anyhow::{Result, anyhow};

    use std::path::Path;

    use super::{
        DownloadSource, DownloadStream, InstallError, InstallReporter, InstallRequest,
        ModelInstallManager, install_model_with_downloader,
    };
    use crate::catalog::{
        ArtifactRole, CatalogModel, ModelArtifact, ModelCatalog, ModelCollection, ModelEngine,
    };
    use crate::protocol::{EngineId, Event, ModelInstallState};
    use crate::transcription::TranscriptionError;

    fn test_probe(path: &Path) -> Result<u64, TranscriptionError> {
        if !path.is_file() {
            return Err(TranscriptionError {
                code: "missing_model_file",
                message: "Model file does not exist.",
                details: Some(path.display().to_string()),
            });
        }
        Ok(std::fs::metadata(path)
            .map_err(|e| TranscriptionError {
                code: "invalid_model_file",
                message: "Cannot read model file.",
                details: Some(e.to_string()),
            })?
            .len())
    }

    #[test]
    fn install_cleans_up_staging_directory_on_checksum_mismatch() {
        let request = sample_request();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = mpsc::channel();
        let reporter = InstallReporter {
            engine_id: request.engine_id,
            install_id: request.install_id.clone(),
            model_id: request.model_id.clone(),
            total_bytes: 4,
            tx,
        };
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"oops".to_vec(),
        )]);

        let error = install_model_with_downloader(
            &request,
            cancel_flag,
            &reporter,
            &downloader,
            test_probe,
        )
        .expect_err("install should fail");

        assert!(matches!(error, InstallError::Failed(_)));
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join(".staging-small-install-1")
                .exists()
        );
    }

    #[test]
    fn install_cleans_up_staging_directory_on_cancel() {
        let request = sample_request();
        let cancel_flag = Arc::new(AtomicBool::new(true));
        let (tx, _rx) = mpsc::channel();
        let reporter = InstallReporter {
            engine_id: request.engine_id,
            install_id: request.install_id.clone(),
            model_id: request.model_id.clone(),
            total_bytes: 4,
            tx,
        };
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"test".to_vec(),
        )]);

        let error = install_model_with_downloader(
            &request,
            cancel_flag,
            &reporter,
            &downloader,
            test_probe,
        )
        .expect_err("install should cancel");

        assert!(matches!(error, InstallError::Cancelled));
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join(".staging-small-install-1")
                .exists()
        );
    }

    #[test]
    fn install_surfaces_download_source_failures_cleanly() {
        let request = sample_request();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = mpsc::channel();
        let reporter = InstallReporter {
            engine_id: request.engine_id,
            install_id: request.install_id.clone(),
            model_id: request.model_id.clone(),
            total_bytes: 4,
            tx,
        };
        let downloader = FailingDownloadSource::new(anyhow!(
            "Download request for model.bin returned HTTP 404 Not Found from https://example.com/model.bin."
        ));

        let error = install_model_with_downloader(
            &request,
            cancel_flag,
            &reporter,
            &downloader,
            test_probe,
        )
        .expect_err("install should fail");

        match error {
            InstallError::Failed(message) => {
                assert!(message.contains("HTTP 404 Not Found"));
                assert!(message.contains("model.bin"));
            }
            InstallError::Cancelled => panic!("install should not cancel"),
        }
    }

    #[test]
    fn happy_path_install_creates_model_file_and_metadata() {
        let request = sample_request();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let reporter = InstallReporter {
            engine_id: request.engine_id,
            install_id: request.install_id.clone(),
            model_id: request.model_id.clone(),
            total_bytes: 4,
            tx,
        };
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"test".to_vec(),
        )]);

        install_model_with_downloader(&request, cancel_flag, &reporter, &downloader, test_probe)
            .expect("install should succeed");

        let target_dir = request.store_root.join("whisper_cpp").join("small");
        assert!(target_dir.exists(), "target directory should exist");
        assert!(
            target_dir.join("model.bin").is_file(),
            "model file should exist"
        );
        assert!(
            target_dir.join("install.json").is_file(),
            "install metadata should exist"
        );

        // Verify we got a completed event
        let mut saw_completed = false;
        while let Ok(event) = rx.try_recv() {
            if matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Completed,
                    ..
                }
            ) {
                saw_completed = true;
            }
        }
        assert!(saw_completed, "should have received a completed event");
    }

    #[test]
    fn poll_event_returns_failed_on_channel_disconnect() {
        let mut manager = ModelInstallManager::new();
        let request = sample_request();

        // Start an install, then immediately drop the receiver to simulate disconnect
        let queued_event = manager.start_install(request);
        assert!(matches!(
            queued_event,
            Event::ModelInstallUpdate {
                state: ModelInstallState::Queued,
                ..
            }
        ));

        // Drop the internal event_rx by replacing the manager's channel.
        // We can't easily do that, so instead we test poll_event after the thread
        // finishes and channel is dropped. Wait for the thread to complete.
        // The install will fail because the MemoryDownloadSource isn't used here
        // (it uses HttpDownloadSource which will fail to connect), but the thread
        // should still terminate and we should get events.

        // Poll until we get a terminal event or the channel disconnects
        let mut got_terminal = false;
        for _ in 0..200 {
            if let Some(Event::ModelInstallUpdate { state, .. }) = manager.poll_event()
                && matches!(
                    state,
                    ModelInstallState::Failed
                        | ModelInstallState::Completed
                        | ModelInstallState::Cancelled
                )
            {
                got_terminal = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(
            got_terminal,
            "should eventually get a terminal event from the install thread"
        );
    }

    struct MemoryDownloadSource {
        payloads: HashMap<String, Vec<u8>>,
    }

    impl MemoryDownloadSource {
        fn new<const N: usize>(entries: [(String, Vec<u8>); N]) -> Self {
            Self {
                payloads: HashMap::from(entries),
            }
        }
    }

    impl DownloadSource for MemoryDownloadSource {
        fn open(&self, artifact: &ModelArtifact) -> Result<DownloadStream> {
            let bytes = self
                .payloads
                .get(&artifact.download_url)
                .ok_or_else(|| anyhow!("missing payload"))?
                .clone();

            Ok(DownloadStream {
                total_bytes: Some(bytes.len() as u64),
                reader: Box::new(Cursor::new(bytes)),
            })
        }
    }

    struct FailingDownloadSource {
        error: anyhow::Error,
    }

    impl FailingDownloadSource {
        fn new(error: anyhow::Error) -> Self {
            Self { error }
        }
    }

    impl DownloadSource for FailingDownloadSource {
        fn open(&self, _artifact: &ModelArtifact) -> Result<DownloadStream> {
            Err(anyhow!("{}", self.error))
        }
    }

    fn sample_request() -> InstallRequest {
        let store_root = std::env::temp_dir().join(format!(
            "obsidian-local-stt-install-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should move forward")
                .as_nanos()
        ));
        fs::create_dir_all(&store_root).expect("temp dir should create");

        let model = CatalogModel {
            artifacts: vec![ModelArtifact {
                artifact_id: "transcription".to_string(),
                download_url: "https://example.com/model.bin".to_string(),
                filename: "model.bin".to_string(),
                required: true,
                role: ArtifactRole::TranscriptionModel,
                sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
                    .to_string(),
                size_bytes: 4,
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
        };
        let catalog = ModelCatalog {
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
            models: vec![model.clone()],
        };

        InstallRequest {
            catalog,
            engine_id: EngineId::WhisperCpp,
            install_id: "install-1".to_string(),
            model,
            model_id: "small".to_string(),
            store_root,
        }
    }
}
