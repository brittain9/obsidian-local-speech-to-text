use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::protocol::{EngineId, TranscriptSegment};

const SUPPORTED_LANGUAGE: &str = "en";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GpuConfig {
    pub use_gpu: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptionRequest {
    pub audio_samples: Vec<f32>,
    pub gpu_config: GpuConfig,
    pub language: String,
    pub model_file_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub segments: Vec<TranscriptSegment>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionError {
    pub code: &'static str,
    pub message: &'static str,
    pub details: Option<String>,
}

impl Display for TranscriptionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        if let Some(details) = &self.details {
            write!(f, "{} ({details})", self.message)
        } else {
            f.write_str(self.message)
        }
    }
}

impl std::error::Error for TranscriptionError {}

// ---------------------------------------------------------------------------
// Backend trait
// ---------------------------------------------------------------------------

pub trait TranscriptionBackend {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, TranscriptionError>;

    /// Validate that a model directory (identified by its primary artifact path)
    /// contains the files needed to run inference.
    fn probe_model(path: &Path) -> Result<(), TranscriptionError>
    where
        Self: Sized;
}

/// Probe a model's primary artifact path using the backend for `engine_id`.
pub fn probe_model_for_engine(engine_id: EngineId, path: &Path) -> Result<(), TranscriptionError> {
    match engine_id {
        EngineId::WhisperCpp => WhisperBackend::probe_model(path),
        EngineId::CohereOnnx => {
            #[cfg(feature = "engine-cohere")]
            {
                crate::cohere::CohereBackend::probe_model(path)
            }
            #[cfg(not(feature = "engine-cohere"))]
            {
                let _ = path;
                Err(TranscriptionError {
                    code: "unsupported_engine",
                    message: "The Cohere ONNX engine is not available in this build.",
                    details: None,
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Whisper backend
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct WhisperBackend {
    loaded_model: Option<LoadedWhisperModel>,
}

#[derive(Debug)]
struct LoadedWhisperModel {
    context: WhisperContext,
    gpu_config: GpuConfig,
    model_path: PathBuf,
}

impl TranscriptionBackend for WhisperBackend {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, TranscriptionError> {
        validate_language(&request.language)?;
        validate_audio_samples(&request.audio_samples)?;

        let context = self.load_or_reuse_model(&request.model_file_path, request.gpu_config)?;
        let mut state = context.create_state().map_err(|error| {
            TranscriptionError::transcription_failure("failed to create whisper state", error)
        })?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 0 });

        params.set_n_threads(recommended_thread_count(request.gpu_config.use_gpu));
        params.set_language(Some(&request.language));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state
            .full(params, &request.audio_samples)
            .map_err(|error| {
                TranscriptionError::transcription_failure("failed to run whisper model", error)
            })?;

        let mut text = String::new();
        let mut segments = Vec::new();

        for segment in state.as_iter() {
            let segment_text = segment.to_string();
            text.push_str(&segment_text);
            segments.push(TranscriptSegment {
                end_ms: whisper_timestamp_to_millis(segment.end_timestamp()),
                start_ms: whisper_timestamp_to_millis(segment.start_timestamp()),
                text: segment_text.trim().to_string(),
            });
        }

        Ok(Transcript {
            segments,
            text: text.trim().to_string(),
        })
    }

    fn probe_model(path: &Path) -> Result<(), TranscriptionError> {
        validate_model_path(path)?;
        let _ = load_whisper_context(path, &GpuConfig { use_gpu: false })?;
        Ok(())
    }
}

impl WhisperBackend {
    fn load_or_reuse_model(
        &mut self,
        model_file_path: &Path,
        gpu_config: GpuConfig,
    ) -> Result<&WhisperContext, TranscriptionError> {
        validate_model_path(model_file_path)?;

        let should_reload = self
            .loaded_model
            .as_ref()
            .map(|m| m.model_path != model_file_path || m.gpu_config != gpu_config)
            .unwrap_or(true);

        if should_reload {
            self.loaded_model = Some(LoadedWhisperModel {
                context: load_whisper_context(model_file_path, &gpu_config)?,
                gpu_config,
                model_path: model_file_path.to_path_buf(),
            });
        }

        Ok(&self
            .loaded_model
            .as_ref()
            .expect("loaded model must exist after load_or_reuse_model")
            .context)
    }
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

pub(crate) fn validate_audio_samples(audio_samples: &[f32]) -> Result<(), TranscriptionError> {
    if audio_samples.is_empty() {
        return Err(TranscriptionError {
            code: "invalid_audio_buffer",
            message: "Audio buffer was empty when transcription started.",
            details: None,
        });
    }

    Ok(())
}

pub(crate) fn validate_model_path(model_file_path: &Path) -> Result<(), TranscriptionError> {
    if !model_file_path.is_file() {
        return Err(TranscriptionError {
            code: "missing_model_file",
            message: "Model file does not exist or is not a regular file.",
            details: Some(model_file_path.display().to_string()),
        });
    }

    std::fs::File::open(model_file_path).map_err(|error| TranscriptionError {
        code: "invalid_model_file",
        message: "Model file is missing, unreadable, or unsupported.",
        details: Some(error.to_string()),
    })?;

    Ok(())
}

pub(crate) fn validate_language(language: &str) -> Result<(), TranscriptionError> {
    if language == SUPPORTED_LANGUAGE {
        return Ok(());
    }

    Err(TranscriptionError {
        code: "unsupported_language",
        message: "Only English dictation is supported in this build.",
        details: Some(language.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Whisper-specific helpers
// ---------------------------------------------------------------------------

fn load_whisper_context(
    model_file_path: &Path,
    gpu_config: &GpuConfig,
) -> Result<WhisperContext, TranscriptionError> {
    let model_path = model_file_path
        .to_str()
        .ok_or_else(|| TranscriptionError::invalid_model("model path must be valid UTF-8"))?;

    let mut params = WhisperContextParameters::default();
    params.use_gpu(gpu_config.use_gpu);
    params.flash_attn(gpu_config.use_gpu);

    WhisperContext::new_with_params(model_path, params)
        .map_err(|error| TranscriptionError::invalid_model_with_details(error.to_string()))
}

fn recommended_thread_count(gpu_active: bool) -> i32 {
    let max = if gpu_active { 4 } else { 8 };
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .min(max) as i32
}

fn whisper_timestamp_to_millis(timestamp: i64) -> u64 {
    timestamp.max(0) as u64 * 10
}

impl TranscriptionError {
    pub(crate) fn invalid_model(details: &'static str) -> Self {
        Self {
            code: "invalid_model_file",
            message: "Model file is missing, unreadable, or unsupported.",
            details: Some(details.to_string()),
        }
    }

    pub(crate) fn invalid_model_with_details(details: String) -> Self {
        Self {
            code: "invalid_model_file",
            message: "Model file is missing, unreadable, or unsupported.",
            details: Some(details),
        }
    }

    pub(crate) fn transcription_failure(context: &str, error: impl Display) -> Self {
        Self {
            code: "transcription_failure",
            message: "Local transcription failed.",
            details: Some(format!("{context}: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{GpuConfig, TranscriptionBackend, TranscriptionRequest, WhisperBackend};

    #[test]
    fn transcribe_rejects_unsupported_language() {
        let mut engine = WhisperBackend::default();
        let error = engine
            .transcribe(&TranscriptionRequest {
                audio_samples: vec![0.0, 0.1],
                gpu_config: GpuConfig::default(),
                language: "fr".to_string(),
                model_file_path: PathBuf::from("/tmp/missing-model.bin"),
            })
            .expect_err("request should fail");

        assert_eq!(error.code, "unsupported_language");
    }

    #[test]
    fn transcribe_rejects_empty_audio() {
        let mut engine = WhisperBackend::default();
        let error = engine
            .transcribe(&TranscriptionRequest {
                audio_samples: Vec::new(),
                gpu_config: GpuConfig::default(),
                language: "en".to_string(),
                model_file_path: PathBuf::from("/tmp/missing-model.bin"),
            })
            .expect_err("request should fail");

        assert_eq!(error.code, "invalid_audio_buffer");
    }
}
