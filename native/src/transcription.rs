use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use crate::protocol::TranscriptSegment;

pub(crate) const SUPPORTED_LANGUAGE: &str = "en";

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
    /// Optional context string fed to adapters that support prompt
    /// conditioning. Worker drops this field (with a `RequestWarning`) when the
    /// target adapter's capabilities set `supports_initial_prompt = false`.
    pub initial_prompt: Option<String>,
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
// Shared validation helpers
// ---------------------------------------------------------------------------

pub fn validate_audio_samples(audio_samples: &[f32]) -> Result<(), TranscriptionError> {
    if audio_samples.is_empty() {
        return Err(TranscriptionError {
            code: "invalid_audio_buffer",
            message: "Audio buffer was empty when transcription started.",
            details: None,
        });
    }

    Ok(())
}

pub fn validate_model_path(model_file_path: &Path) -> Result<(), TranscriptionError> {
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

pub fn validate_language(language: &str) -> Result<(), TranscriptionError> {
    if language == SUPPORTED_LANGUAGE {
        return Ok(());
    }

    Err(TranscriptionError {
        code: "unsupported_language",
        message: "Only English dictation is supported in this build.",
        details: Some(language.to_string()),
    })
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

    pub fn unsupported_engine(details: String) -> Self {
        Self {
            code: "unsupported_engine",
            message: "The requested engine is not available in this build.",
            details: Some(details),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{validate_audio_samples, validate_language, validate_model_path};

    #[test]
    fn validate_language_rejects_non_english() {
        let error = validate_language("fr").expect_err("non-en language must be rejected");
        assert_eq!(error.code, "unsupported_language");
    }

    #[test]
    fn validate_audio_samples_rejects_empty() {
        let error = validate_audio_samples(&[]).expect_err("empty buffer must be rejected");
        assert_eq!(error.code, "invalid_audio_buffer");
    }

    #[test]
    fn validate_model_path_rejects_missing_file() {
        let error = validate_model_path(Path::new("/tmp/definitely-missing-model.bin"))
            .expect_err("missing file must be rejected");
        assert_eq!(error.code, "missing_model_file");
    }
}
