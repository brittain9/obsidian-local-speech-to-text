use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::protocol::TranscriptSegment;

const SUPPORTED_LANGUAGE: &str = "en";

#[derive(Debug, Default)]
pub struct TranscriptionEngine {
    loaded_model: Option<LoadedModel>,
}

#[derive(Debug)]
struct LoadedModel {
    context: WhisperContext,
    model_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptionRequest {
    pub audio_samples: Vec<f32>,
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

impl TranscriptionEngine {
    pub fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, TranscriptionError> {
        validate_language(&request.language)?;
        validate_audio_samples(&request.audio_samples)?;

        let context = self.load_or_reuse_model(&request.model_file_path)?;
        let mut state = context.create_state().map_err(|error| {
            TranscriptionError::transcription_failure("failed to create whisper state", error)
        })?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 0 });

        params.set_n_threads(recommended_thread_count());
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

    pub fn reset_model(&mut self) {
        self.loaded_model = None;
    }

    fn load_or_reuse_model(
        &mut self,
        model_file_path: &Path,
    ) -> Result<&WhisperContext, TranscriptionError> {
        validate_model_path(model_file_path)?;

        let should_reload = self
            .loaded_model
            .as_ref()
            .map(|loaded_model| loaded_model.model_path != model_file_path)
            .unwrap_or(true);

        if should_reload {
            self.loaded_model = Some(LoadedModel {
                context: load_model_context(model_file_path)?,
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

pub fn probe_model_path(model_file_path: &Path) -> Result<u64, TranscriptionError> {
    validate_model_path(model_file_path)?;
    let _ = load_model_context(model_file_path)?;
    let size_bytes = std::fs::metadata(model_file_path)
        .map_err(|error| TranscriptionError::invalid_model_with_details(error.to_string()))?
        .len();

    Ok(size_bytes)
}

fn validate_audio_samples(audio_samples: &[f32]) -> Result<(), TranscriptionError> {
    if audio_samples.is_empty() {
        return Err(TranscriptionError {
            code: "invalid_audio_buffer",
            message: "Audio buffer was empty when transcription started.",
            details: None,
        });
    }

    Ok(())
}

fn validate_model_path(model_file_path: &Path) -> Result<(), TranscriptionError> {
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

fn load_model_context(model_file_path: &Path) -> Result<WhisperContext, TranscriptionError> {
    let model_path = model_file_path
        .to_str()
        .ok_or_else(|| TranscriptionError::invalid_model("model path must be valid UTF-8"))?;

    WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|error| TranscriptionError::invalid_model_with_details(error.to_string()))
}

fn validate_language(language: &str) -> Result<(), TranscriptionError> {
    if language == SUPPORTED_LANGUAGE {
        return Ok(());
    }

    Err(TranscriptionError {
        code: "unsupported_language",
        message: "Only English dictation is supported in this build.",
        details: Some(language.to_string()),
    })
}

fn recommended_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .min(8) as i32
}

fn whisper_timestamp_to_millis(timestamp: i64) -> u64 {
    timestamp.max(0) as u64 * 10
}

impl TranscriptionError {
    fn invalid_model(details: &'static str) -> Self {
        Self {
            code: "invalid_model_file",
            message: "Model file is missing, unreadable, or unsupported.",
            details: Some(details.to_string()),
        }
    }

    fn invalid_model_with_details(details: String) -> Self {
        Self {
            code: "invalid_model_file",
            message: "Model file is missing, unreadable, or unsupported.",
            details: Some(details),
        }
    }

    fn transcription_failure(details: &'static str, error: impl Display) -> Self {
        Self {
            code: "transcription_failure",
            message: "Local transcription failed.",
            details: Some(format!("{details}: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{TranscriptionEngine, TranscriptionRequest};

    #[test]
    fn transcribe_rejects_unsupported_language() {
        let mut engine = TranscriptionEngine::default();
        let error = engine
            .transcribe(&TranscriptionRequest {
                audio_samples: vec![0.0, 0.1],
                language: "fr".to_string(),
                model_file_path: PathBuf::from("/tmp/missing-model.bin"),
            })
            .expect_err("request should fail");

        assert_eq!(error.code, "unsupported_language");
    }

    #[test]
    fn transcribe_rejects_empty_audio() {
        let mut engine = TranscriptionEngine::default();
        let error = engine
            .transcribe(&TranscriptionRequest {
                audio_samples: Vec::new(),
                language: "en".to_string(),
                model_file_path: PathBuf::from("/tmp/missing-model.bin"),
            })
            .expect_err("request should fail");

        assert_eq!(error.code, "invalid_audio_buffer");
    }
}
