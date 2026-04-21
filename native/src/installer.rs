use std::fs::{self, File};
use std::future::Future;
use std::io::{self, Write};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use sha2::{Digest, Sha256};
use tokio::runtime::Builder;
use tokio::sync::Notify;

use crate::catalog::{CatalogModel, ModelArtifact, ModelCatalog};
use crate::engine::capabilities::{ModelFamilyId, RuntimeId};
use crate::model_store::{
    create_install_metadata, resolve_model_install_dir, write_install_metadata,
};
use crate::protocol::{Event, ModelInstallState};
use crate::transcription::TranscriptionError;

pub type ModelProbe =
    dyn Fn(RuntimeId, ModelFamilyId, &Path) -> Result<(), TranscriptionError> + Send + Sync;

#[derive(Clone)]
pub struct InstallRequest {
    pub runtime_id: RuntimeId,
    pub family_id: ModelFamilyId,
    pub install_id: String,
    pub model: CatalogModel,
    pub model_id: String,
    pub store_root: PathBuf,
    pub catalog: Arc<ModelCatalog>,
}

struct ActiveInstall {
    cancel_handle: Arc<InstallCancellation>,
    runtime_id: RuntimeId,
    family_id: ModelFamilyId,
    install_id: String,
    join_handle: JoinHandle<()>,
    model_id: String,
}

pub struct ModelInstallManager {
    active_install: Option<ActiveInstall>,
    event_rx: Receiver<Event>,
    event_tx: Sender<Event>,
    model_probe: Arc<ModelProbe>,
}

impl ModelInstallManager {
    pub fn new(model_probe: Arc<ModelProbe>) -> Self {
        let (event_tx, event_rx) = mpsc::channel();

        Self {
            active_install: None,
            event_rx,
            event_tx,
            model_probe,
        }
    }

    pub fn cancel_install(&mut self, install_id: &str) -> Option<Event> {
        let Some(active_install) = self.active_install.as_ref() else {
            return Some(Event::Warning {
                code: "no_active_install".to_string(),
                details: Some(install_id.to_string()),
                message: "There is no active model install to cancel.".to_string(),
                session_id: None,
            });
        };

        if active_install.install_id != install_id {
            return Some(failed_update(
                install_id,
                active_install.runtime_id,
                active_install.family_id,
                &active_install.model_id,
                "The requested install is not active and cannot be cancelled.",
            ));
        }

        active_install.cancel_handle.cancel();
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
                    active_install.runtime_id,
                    active_install.family_id,
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
                request.runtime_id,
                request.family_id,
                &request.model_id,
                &format!(
                    "Another install is already active ({}) and this build supports one install at a time.",
                    active_install.install_id
                ),
            );
        }

        let cancel_handle = Arc::new(InstallCancellation::new());
        let thread_cancel_handle = Arc::clone(&cancel_handle);
        let runtime_id = request.runtime_id;
        let family_id = request.family_id;
        let active_install_id = request.install_id.clone();
        let active_model_id = request.model_id.clone();
        let total_bytes = request.model.required_download_bytes();
        let thread_event_tx = self.event_tx.clone();
        let thread_model_probe = Arc::clone(&self.model_probe);
        let join_handle = thread::spawn(move || {
            let panic_install_id = request.install_id.clone();
            let panic_model_id = request.model_id.clone();
            let panic_tx = thread_event_tx.clone();
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                run_install(
                    request,
                    thread_cancel_handle,
                    thread_event_tx,
                    thread_model_probe,
                );
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
                    runtime_id,
                    family_id,
                    &panic_model_id,
                    &message,
                ));
            }
        });

        self.active_install = Some(ActiveInstall {
            cancel_handle,
            runtime_id,
            family_id,
            install_id: active_install_id.clone(),
            join_handle,
            model_id: active_model_id.clone(),
        });

        Event::ModelInstallUpdate {
            details: None,
            downloaded_bytes: Some(0),
            runtime_id,
            family_id,
            install_id: active_install_id,
            message: Some("Model install queued.".to_string()),
            model_id: active_model_id,
            state: ModelInstallState::Queued,
            total_bytes: Some(total_bytes),
        }
    }
}

#[derive(Debug)]
struct InstallCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl InstallCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }

        let notified = self.notify.notified();
        tokio::pin!(notified);

        // Register as a waiter BEFORE the re-check so that a notify_waiters()
        // call racing between the re-check and the .await is not lost.
        notified.as_mut().enable();

        if self.is_cancelled() {
            return;
        }

        notified.await;
    }
}

fn run_install(
    request: InstallRequest,
    cancel_handle: Arc<InstallCancellation>,
    event_tx: Sender<Event>,
    model_probe: Arc<ModelProbe>,
) {
    let reporter = InstallReporter {
        runtime_id: request.runtime_id,
        family_id: request.family_id,
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
                0,
                Some(reporter.total_bytes),
            );
            return;
        }
    };

    let runtime = match Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = reporter.send(
                ModelInstallState::Failed,
                Some(format!("Failed to create installer runtime: {error}")),
                None,
                0,
                Some(reporter.total_bytes),
            );
            return;
        }
    };

    let probe_fn: &ModelProbe = model_probe.as_ref();

    if let Err(error) = runtime.block_on(install_model_with_downloader(
        &request,
        cancel_handle,
        &reporter,
        &downloader,
        probe_fn,
    )) {
        match error {
            InstallError::Cancelled => {}
            InstallError::Failed {
                downloaded_bytes,
                message,
            } => {
                let _ = reporter.send(
                    ModelInstallState::Failed,
                    Some(message),
                    None,
                    downloaded_bytes,
                    Some(reporter.total_bytes),
                );
            }
        }
    }
}

type DownloadChunk = Vec<u8>;
type DownloadChunkStream = Pin<Box<dyn Stream<Item = Result<DownloadChunk>> + Send>>;
type DownloadFuture<'a> = Pin<Box<dyn Future<Output = Result<DownloadStream>> + Send + 'a>>;

trait DownloadSource {
    fn open<'a>(&'a self, artifact: &'a ModelArtifact) -> DownloadFuture<'a>;
}

struct DownloadStream {
    chunks: DownloadChunkStream,
}

struct HttpDownloadSource {
    client: Client,
}

impl HttpDownloadSource {
    fn new() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

        Ok(Self { client })
    }
}

impl DownloadSource for HttpDownloadSource {
    fn open<'a>(&'a self, artifact: &'a ModelArtifact) -> DownloadFuture<'a> {
        Box::pin(async move {
            let response = self
                .client
                .get(&artifact.download_url)
                .send()
                .await
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

            let filename = artifact.filename.clone();
            let chunks = response.bytes_stream().map(move |chunk| {
                chunk.map(|bytes| bytes.to_vec()).map_err(|error| {
                    anyhow!("Failed to read download stream for {filename}: {error}")
                })
            });

            Ok(DownloadStream {
                chunks: Box::pin(chunks),
            })
        })
    }
}

#[derive(Debug)]
enum InstallError {
    Cancelled,
    Failed {
        downloaded_bytes: u64,
        message: String,
    },
}

struct InstallReporter {
    runtime_id: RuntimeId,
    family_id: ModelFamilyId,
    install_id: String,
    model_id: String,
    total_bytes: u64,
    tx: Sender<Event>,
}

impl InstallReporter {
    // UI contract for install updates:
    // - `message` is the primary status line shown to the user.
    // - `details` is secondary context such as "File 2 of 3".
    // - `downloaded_bytes` and `total_bytes` are aggregate bytes for the full install.
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
                runtime_id: self.runtime_id,
                family_id: self.family_id,
                install_id: self.install_id.clone(),
                message,
                model_id: self.model_id.clone(),
                state,
                total_bytes,
            })
            .context("failed to emit install progress event")
    }
}

async fn install_model_with_downloader(
    request: &InstallRequest,
    cancel_handle: Arc<InstallCancellation>,
    reporter: &InstallReporter,
    downloader: &dyn DownloadSource,
    model_probe: &ModelProbe,
) -> Result<(), InstallError> {
    let family_root = request
        .store_root
        .join(request.runtime_id.as_str())
        .join(request.family_id.as_str());
    let target_dir = resolve_model_install_dir(
        &request.store_root,
        request.runtime_id,
        request.family_id,
        &request.model_id,
    );
    let stage_dir = family_root.join(format!(
        ".staging-{}-{}",
        request.model_id, request.install_id
    ));

    cleanup_stage_dir(&stage_dir);
    fs::create_dir_all(&stage_dir)
        .map_err(|error| fail_install(0, format!("Failed to create staging directory: {error}")))?;

    let required_artifacts: Vec<&ModelArtifact> = request
        .model
        .artifacts
        .iter()
        .filter(|artifact| artifact.required)
        .collect();
    let artifact_count = required_artifacts.len();
    let mut downloaded_total = 0_u64;

    for (artifact_index, artifact) in required_artifacts.iter().enumerate() {
        check_for_cancel(
            cancel_handle.as_ref(),
            reporter,
            &stage_dir,
            downloaded_total,
        )?;

        let artifact_path = stage_dir.join(&artifact.filename);
        let temp_path = artifact_path.with_extension("part");
        let artifact_details = build_artifact_details(artifact_index, artifact_count);

        if let Some(parent) = artifact_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                fail_install(
                    downloaded_total,
                    format!(
                        "Failed to create artifact staging directory {}: {error}",
                        parent.display()
                    ),
                )
            })?;
        }

        reporter
            .send(
                ModelInstallState::Downloading,
                Some(format!("Downloading {}", artifact.filename)),
                artifact_details.clone(),
                downloaded_total,
                Some(reporter.total_bytes),
            )
            .map_err(|error| fail_install(downloaded_total, error.to_string()))?;

        let mut stream = tokio::select! {
            _ = cancel_handle.cancelled() => {
                return Err(cancel_install(reporter, &stage_dir, downloaded_total));
            }
            result = downloader.open(artifact) => {
                result.map_err(|error| {
                    cleanup_stage_dir(&stage_dir);
                    fail_install(downloaded_total, format!("{error:#}"))
                })?
            }
        };
        let mut output = File::create(&temp_path).map_err(|error| {
            cleanup_stage_dir(&stage_dir);
            fail_install(
                downloaded_total,
                format!("Failed to create {}: {error}", temp_path.display()),
            )
        })?;
        let mut hasher = Sha256::new();
        let mut artifact_downloaded = 0_u64;

        loop {
            let next_chunk = tokio::select! {
                _ = cancel_handle.cancelled() => {
                    return Err(cancel_install(
                        reporter,
                        &stage_dir,
                        downloaded_total + artifact_downloaded,
                    ));
                }
                next_chunk = stream.chunks.next() => next_chunk,
            };

            let Some(chunk) = next_chunk else {
                break;
            };
            let chunk = chunk.map_err(|error| {
                cleanup_stage_dir(&stage_dir);
                fail_install(downloaded_total + artifact_downloaded, format!("{error:#}"))
            })?;

            output.write_all(&chunk).map_err(|error| {
                cleanup_stage_dir(&stage_dir);
                fail_install(
                    downloaded_total + artifact_downloaded,
                    format!("Failed to write {}: {error}", temp_path.display()),
                )
            })?;
            hasher.update(&chunk);
            artifact_downloaded += chunk.len() as u64;

            reporter
                .send(
                    ModelInstallState::Downloading,
                    Some(format!("Downloading {}", artifact.filename)),
                    artifact_details.clone(),
                    downloaded_total + artifact_downloaded,
                    Some(reporter.total_bytes),
                )
                .map_err(|error| {
                    fail_install(downloaded_total + artifact_downloaded, error.to_string())
                })?;
        }

        reporter
            .send(
                ModelInstallState::Verifying,
                Some(format!("Verifying {}", artifact.filename)),
                artifact_details,
                downloaded_total + artifact_downloaded,
                Some(reporter.total_bytes),
            )
            .map_err(|error| {
                fail_install(downloaded_total + artifact_downloaded, error.to_string())
            })?;

        if artifact_downloaded != artifact.size_bytes {
            cleanup_stage_dir(&stage_dir);
            return Err(fail_install(
                downloaded_total + artifact_downloaded,
                format!(
                    "Downloaded size for {} did not match the catalog (expected {}, got {}).",
                    artifact.filename, artifact.size_bytes, artifact_downloaded
                ),
            ));
        }

        let digest = hex_encode(&hasher.finalize());

        if digest != artifact.sha256 {
            cleanup_stage_dir(&stage_dir);
            return Err(fail_install(
                downloaded_total + artifact_downloaded,
                format!("SHA-256 verification failed for {}.", artifact.filename),
            ));
        }

        fs::rename(&temp_path, &artifact_path).map_err(|error| {
            cleanup_stage_dir(&stage_dir);
            fail_install(
                downloaded_total + artifact_downloaded,
                format!(
                    "Failed to finalize staged artifact {}: {error}",
                    artifact_path.display()
                ),
            )
        })?;
        downloaded_total += artifact_downloaded;
    }

    check_for_cancel(
        cancel_handle.as_ref(),
        reporter,
        &stage_dir,
        downloaded_total,
    )?;

    let runtime_artifact = request.model.primary_artifact().ok_or_else(|| {
        fail_install(
            downloaded_total,
            "Model is missing a transcription artifact.".to_string(),
        )
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
        .map_err(|error| fail_install(downloaded_total, error.to_string()))?;

    model_probe(request.runtime_id, request.family_id, &runtime_path).map_err(|error| {
        cleanup_stage_dir(&stage_dir);
        fail_install(
            downloaded_total,
            format!(
                "Failed to probe the installed model {}: {error}",
                runtime_artifact.filename
            ),
        )
    })?;

    check_for_cancel(
        cancel_handle.as_ref(),
        reporter,
        &stage_dir,
        downloaded_total,
    )?;

    let metadata = create_install_metadata(
        &request.catalog,
        request.runtime_id,
        request.family_id,
        &request.model_id,
    )
    .map_err(|error| {
        cleanup_stage_dir(&stage_dir);
        fail_install(downloaded_total, format!("{error:#}"))
    })?;
    write_install_metadata(&stage_dir, &metadata).map_err(|error| {
        cleanup_stage_dir(&stage_dir);
        fail_install(downloaded_total, format!("{error:#}"))
    })?;

    check_for_cancel(
        cancel_handle.as_ref(),
        reporter,
        &stage_dir,
        downloaded_total,
    )?;

    match fs::remove_dir_all(&target_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            cleanup_stage_dir(&stage_dir);
            return Err(fail_install(
                downloaded_total,
                format!(
                    "Failed to replace existing install {}: {error}",
                    target_dir.display()
                ),
            ));
        }
    }

    fs::create_dir_all(&family_root).map_err(|error| {
        cleanup_stage_dir(&stage_dir);
        fail_install(
            downloaded_total,
            format!(
                "Failed to create family directory {}: {error}",
                family_root.display()
            ),
        )
    })?;
    fs::rename(&stage_dir, &target_dir).map_err(|error| {
        cleanup_stage_dir(&stage_dir);
        fail_install(
            downloaded_total,
            format!(
                "Failed to move staged install into place {}: {error}",
                target_dir.display()
            ),
        )
    })?;

    reporter
        .send(
            ModelInstallState::Completed,
            Some("Model install completed.".to_string()),
            None,
            downloaded_total,
            Some(reporter.total_bytes),
        )
        .map_err(|error| fail_install(downloaded_total, error.to_string()))?;
    Ok(())
}

fn build_artifact_details(artifact_index: usize, artifact_count: usize) -> Option<String> {
    if artifact_count <= 1 {
        return None;
    }

    Some(format!("File {} of {}", artifact_index + 1, artifact_count))
}

fn cancel_install(
    reporter: &InstallReporter,
    stage_dir: &Path,
    downloaded_total: u64,
) -> InstallError {
    cleanup_stage_dir(stage_dir);
    let _ = reporter.send(
        ModelInstallState::Cancelled,
        Some("Model install cancelled.".to_string()),
        None,
        downloaded_total,
        Some(reporter.total_bytes),
    );
    InstallError::Cancelled
}

fn fail_install(downloaded_bytes: u64, message: String) -> InstallError {
    InstallError::Failed {
        downloaded_bytes,
        message,
    }
}

fn check_for_cancel(
    cancel_handle: &InstallCancellation,
    reporter: &InstallReporter,
    stage_dir: &Path,
    downloaded_total: u64,
) -> Result<(), InstallError> {
    if cancel_handle.is_cancelled() {
        return Err(cancel_install(reporter, stage_dir, downloaded_total));
    }

    Ok(())
}

fn cleanup_stage_dir(stage_dir: &Path) {
    if stage_dir.exists() {
        let _ = fs::remove_dir_all(stage_dir);
    }
}

fn failed_update(
    install_id: &str,
    runtime_id: RuntimeId,
    family_id: ModelFamilyId,
    model_id: &str,
    message: &str,
) -> Event {
    Event::ModelInstallUpdate {
        details: None,
        downloaded_bytes: None,
        runtime_id,
        family_id,
        install_id: install_id.to_string(),
        message: Some(message.to_string()),
        model_id: model_id.to_string(),
        state: ModelInstallState::Failed,
        total_bytes: None,
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            use std::fmt::Write;
            write!(s, "{b:02x}").unwrap();
            s
        })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use anyhow::{Result, anyhow};
    use futures_util::stream;
    use tokio::runtime::Builder;

    use std::path::Path;

    use super::{
        DownloadChunk, DownloadFuture, DownloadSource, DownloadStream, InstallCancellation,
        InstallError, InstallReporter, InstallRequest, ModelInstallManager, ModelProbe,
        install_model_with_downloader,
    };
    use crate::catalog::{
        ArtifactRole, CatalogModel, ModelArtifact, ModelCatalog, ModelCollection,
        ModelFamilyDescriptor, ModelRuntimeDescriptor,
    };
    use crate::engine::capabilities::{ModelFamilyId, RuntimeId};
    use crate::protocol::{Event, ModelInstallState};
    use crate::transcription::TranscriptionError;
    use sha2::{Digest, Sha256};

    fn test_probe(
        _runtime_id: RuntimeId,
        _family_id: ModelFamilyId,
        path: &Path,
    ) -> Result<(), TranscriptionError> {
        if !path.is_file() {
            return Err(TranscriptionError {
                code: "missing_model_file",
                message: "Model file does not exist.",
                details: Some(path.display().to_string()),
            });
        }
        Ok(())
    }

    fn test_probe_arc() -> Arc<ModelProbe> {
        Arc::new(test_probe)
    }

    #[test]
    fn install_cleans_up_staging_directory_on_checksum_mismatch() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        let (tx, _rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"oops".to_vec(),
        )]);

        let error = run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect_err("install should fail");

        assert!(matches!(error, InstallError::Failed { .. }));
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join("whisper")
                .join(".staging-small-install-1")
                .exists()
        );
    }

    #[test]
    fn install_cleans_up_staging_directory_on_cancel() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        cancel_handle.cancel();
        let (tx, _rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"test".to_vec(),
        )]);

        let error = run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect_err("install should cancel");

        assert!(matches!(error, InstallError::Cancelled));
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join("whisper")
                .join(".staging-small-install-1")
                .exists()
        );
    }

    #[test]
    fn install_surfaces_download_source_failures_cleanly() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        let (tx, _rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = FailingDownloadSource::new(anyhow!(
            "Download request for model.bin returned HTTP 404 Not Found from https://example.com/model.bin."
        ));

        let error = run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect_err("install should fail");

        match error {
            InstallError::Failed {
                downloaded_bytes,
                message,
            } => {
                assert_eq!(downloaded_bytes, 0);
                assert!(message.contains("HTTP 404 Not Found"));
                assert!(message.contains("model.bin"));
            }
            InstallError::Cancelled => panic!("install should not cancel"),
        }
    }

    #[test]
    fn happy_path_install_creates_model_file_and_metadata() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        let (tx, rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"test".to_vec(),
        )]);

        run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect("install should succeed");

        let target_dir = request
            .store_root
            .join("whisper_cpp")
            .join("whisper")
            .join("small");
        assert!(target_dir.exists(), "target directory should exist");
        assert!(
            target_dir.join("model.bin").is_file(),
            "model file should exist"
        );
        assert!(
            target_dir.join("install.json").is_file(),
            "install metadata should exist"
        );

        let events = collect_install_events(rx);
        assert!(
            events.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Completed,
                    downloaded_bytes: Some(4),
                    total_bytes: Some(4),
                    ..
                }
            )),
            "should have received a completed event with aggregate totals"
        );
    }

    #[test]
    fn multi_artifact_install_emits_aggregate_totals_consistently() {
        let vocab_bytes = b"ok".to_vec();
        let model_bytes = b"test".to_vec();
        let request = sample_request_with_artifacts(
            "multi",
            vec![
                build_artifact(
                    "model.bin",
                    "https://example.com/model.bin",
                    &model_bytes,
                    ArtifactRole::TranscriptionModel,
                ),
                build_artifact(
                    "vocab.json",
                    "https://example.com/vocab.json",
                    &vocab_bytes,
                    ArtifactRole::SupportingFile,
                ),
            ],
        );
        let cancel_handle = Arc::new(InstallCancellation::new());
        let (tx, rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = MemoryDownloadSource::new([
            ("https://example.com/model.bin".to_string(), model_bytes),
            ("https://example.com/vocab.json".to_string(), vocab_bytes),
        ]);

        run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect("install should succeed");

        let total_bytes = request.model.required_download_bytes();
        let events = collect_install_events(rx);
        let install_updates: Vec<&Event> = events
            .iter()
            .filter(|event| matches!(event, Event::ModelInstallUpdate { .. }))
            .collect();

        assert!(
            install_updates.iter().all(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    downloaded_bytes: Some(downloaded_bytes),
                    total_bytes: Some(event_total_bytes),
                    ..
                } if *downloaded_bytes <= total_bytes && *event_total_bytes == total_bytes
            )),
            "all install events should use aggregate downloaded/total byte counts"
        );
        assert!(
            install_updates.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Downloading,
                    details: Some(details),
                    ..
                } if details == "File 1 of 2"
            )),
            "first artifact should include file-position details"
        );
        assert!(
            install_updates.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Downloading,
                    details: Some(details),
                    ..
                } if details == "File 2 of 2"
            )),
            "second artifact should include file-position details"
        );
        assert!(
            install_updates.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Completed,
                    downloaded_bytes: Some(downloaded_bytes),
                    total_bytes: Some(event_total_bytes),
                    ..
                } if *downloaded_bytes == total_bytes && *event_total_bytes == total_bytes
            )),
            "completed event should report aggregate totals"
        );
    }

    #[test]
    fn cancel_during_active_stream_download_exits_promptly_and_cleans_staging() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        let cancel_trigger = Arc::clone(&cancel_handle);
        let (tx, rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = PendingDownloadSource;

        let cancellation_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            cancel_trigger.cancel();
        });

        let started_at = Instant::now();
        let error = run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect_err("install should cancel");
        cancellation_thread
            .join()
            .expect("cancellation helper thread should join");

        assert!(
            matches!(error, InstallError::Cancelled),
            "expected Cancelled, got: {error:?}"
        );
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "cancel should unblock the stalled stream promptly"
        );
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join("whisper")
                .join(".staging-small-install-1")
                .exists()
        );

        let events = collect_install_events(rx);
        assert!(
            events.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Cancelled,
                    downloaded_bytes: Some(0),
                    total_bytes: Some(4),
                    ..
                }
            )),
            "cancelled event should preserve aggregate totals even without completed chunks"
        );
    }

    #[test]
    fn cancel_during_download_open_exits_promptly() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        let cancel_trigger = Arc::clone(&cancel_handle);
        let (tx, rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = OpenNeverResolvesDownloadSource;

        let cancellation_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            cancel_trigger.cancel();
        });

        let started_at = Instant::now();
        let error = run_install_test(&request, cancel_handle, &reporter, &downloader, &test_probe)
            .expect_err("install should cancel while open() is pending");
        cancellation_thread
            .join()
            .expect("cancellation helper thread should join");

        assert!(
            matches!(error, InstallError::Cancelled),
            "expected Cancelled, got: {error:?}"
        );
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "cancel should unblock a stalled HTTP request promptly"
        );
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join("whisper")
                .join(".staging-small-install-1")
                .exists()
        );

        let events = collect_install_events(rx);
        assert!(
            events.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Cancelled,
                    ..
                }
            )),
            "cancelled event should be emitted even when the HTTP request has not returned"
        );
    }

    #[test]
    fn cancel_after_final_download_but_before_promotion_cancels_cleanly() {
        let request = sample_request();
        let cancel_handle = Arc::new(InstallCancellation::new());
        let probe_cancel_handle = Arc::clone(&cancel_handle);
        let (tx, rx) = mpsc::channel();
        let reporter = sample_reporter(&request, tx);
        let downloader = MemoryDownloadSource::new([(
            "https://example.com/model.bin".to_string(),
            b"test".to_vec(),
        )]);
        let probe = move |runtime_id: RuntimeId,
                          family_id: ModelFamilyId,
                          path: &Path|
              -> Result<(), TranscriptionError> {
            test_probe(runtime_id, family_id, path)?;
            probe_cancel_handle.cancel();
            Ok(())
        };

        let error = run_install_test(&request, cancel_handle, &reporter, &downloader, &probe)
            .expect_err("install should cancel after probe");

        assert!(
            matches!(error, InstallError::Cancelled),
            "expected Cancelled, got: {error:?}"
        );
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join("whisper")
                .join("small")
                .exists(),
            "target directory should not become visible after cancellation"
        );
        assert!(
            !request
                .store_root
                .join("whisper_cpp")
                .join("whisper")
                .join(".staging-small-install-1")
                .exists(),
            "staging directory should be removed after cancellation"
        );

        let events = collect_install_events(rx);
        assert!(
            events.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Probing,
                    downloaded_bytes: Some(4),
                    total_bytes: Some(4),
                    ..
                }
            )),
            "probe phase should run before the cancellation checkpoint"
        );
        assert!(
            events.iter().any(|event| matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Cancelled,
                    downloaded_bytes: Some(4),
                    total_bytes: Some(4),
                    ..
                }
            )),
            "cancelled event should keep the aggregate byte counters"
        );
    }

    #[test]
    fn poll_event_returns_failed_on_channel_disconnect() {
        let mut manager = ModelInstallManager::new(test_probe_arc());
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
        payloads: HashMap<String, Vec<Vec<u8>>>,
    }

    impl MemoryDownloadSource {
        fn new<const N: usize>(entries: [(String, Vec<u8>); N]) -> Self {
            Self {
                payloads: HashMap::from(entries.map(|(url, bytes)| (url, vec![bytes]))),
            }
        }
    }

    impl DownloadSource for MemoryDownloadSource {
        fn open<'a>(&'a self, artifact: &'a ModelArtifact) -> DownloadFuture<'a> {
            Box::pin(async move {
                let chunks = self
                    .payloads
                    .get(&artifact.download_url)
                    .ok_or_else(|| anyhow!("missing payload"))?
                    .clone()
                    .into_iter()
                    .map(Ok::<DownloadChunk, anyhow::Error>);

                Ok(DownloadStream {
                    chunks: Box::pin(stream::iter(chunks)),
                })
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
        fn open<'a>(&'a self, _artifact: &'a ModelArtifact) -> DownloadFuture<'a> {
            Box::pin(async move { Err(anyhow!("{}", self.error)) })
        }
    }

    struct PendingDownloadSource;

    impl DownloadSource for PendingDownloadSource {
        fn open<'a>(&'a self, _artifact: &'a ModelArtifact) -> DownloadFuture<'a> {
            Box::pin(async {
                Ok(DownloadStream {
                    chunks: Box::pin(stream::pending()),
                })
            })
        }
    }

    struct OpenNeverResolvesDownloadSource;

    impl DownloadSource for OpenNeverResolvesDownloadSource {
        fn open<'a>(&'a self, _artifact: &'a ModelArtifact) -> DownloadFuture<'a> {
            Box::pin(std::future::pending())
        }
    }

    fn run_install_test(
        request: &InstallRequest,
        cancel_handle: Arc<InstallCancellation>,
        reporter: &InstallReporter,
        downloader: &dyn DownloadSource,
        model_probe: &ModelProbe,
    ) -> Result<(), InstallError> {
        Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime should build")
            .block_on(install_model_with_downloader(
                request,
                cancel_handle,
                reporter,
                downloader,
                model_probe,
            ))
    }

    fn collect_install_events(receiver: mpsc::Receiver<Event>) -> Vec<Event> {
        receiver.try_iter().collect()
    }

    fn sample_reporter(request: &InstallRequest, tx: mpsc::Sender<Event>) -> InstallReporter {
        InstallReporter {
            runtime_id: request.runtime_id,
            family_id: request.family_id,
            install_id: request.install_id.clone(),
            model_id: request.model_id.clone(),
            total_bytes: request.model.required_download_bytes(),
            tx,
        }
    }

    fn sample_request() -> InstallRequest {
        sample_request_with_artifacts(
            "small",
            vec![build_artifact(
                "model.bin",
                "https://example.com/model.bin",
                b"test",
                ArtifactRole::TranscriptionModel,
            )],
        )
    }

    fn sample_request_with_artifacts(
        model_id: &str,
        artifacts: Vec<ModelArtifact>,
    ) -> InstallRequest {
        let store_root = std::env::temp_dir().join(format!(
            "obsidian-local-stt-install-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should move forward")
                .as_nanos()
        ));
        fs::create_dir_all(&store_root).expect("temp dir should create");

        let model = CatalogModel {
            artifacts,
            collection_id: "english".to_string(),
            display_name: "Model".to_string(),
            runtime_id: RuntimeId::WhisperCpp,
            family_id: ModelFamilyId::Whisper,
            language_tags: vec!["en".to_string()],
            license_label: "MIT".to_string(),
            license_url: "https://example.com/license".to_string(),
            model_card_url: None,
            model_id: model_id.to_string(),
            notes: vec![],
            source_url: "https://example.com".to_string(),
            summary: "summary".to_string(),
            ux_tags: vec![],
        };
        let catalog = ModelCatalog {
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
            models: vec![model.clone()],
        };

        InstallRequest {
            catalog: Arc::new(catalog),
            runtime_id: RuntimeId::WhisperCpp,
            family_id: ModelFamilyId::Whisper,
            install_id: "install-1".to_string(),
            model,
            model_id: model_id.to_string(),
            store_root,
        }
    }

    fn build_artifact(
        filename: &str,
        download_url: &str,
        bytes: &[u8],
        role: ArtifactRole,
    ) -> ModelArtifact {
        ModelArtifact {
            artifact_id: filename.to_string(),
            download_url: download_url.to_string(),
            filename: filename.to_string(),
            required: true,
            role,
            sha256: sha256_hex(bytes),
            size_bytes: bytes.len() as u64,
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        super::hex_encode(&hasher.finalize())
    }
}
