use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::protocol::{ContextWindow, StageOutcome, TranscriptSegment};

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
    /// Structured context window (per D-017) the plugin assembled for this
    /// utterance. Adapters that support prompt conditioning extract `text`;
    /// adapters that do not are gated upstream by `apply_capability_gates`,
    /// which clears this field and emits a `RequestWarning`. Sources are
    /// preserved so future stages (e.g. summarisation, source-attribution
    /// telemetry) can inspect them without a second wire round-trip.
    pub context: Option<ContextWindow>,
}

/// What an adapter returns from `transcribe`. Adapters own only the engine
/// inference output; revisioning, stage history, and identity are added by
/// the worker as it wraps this into the canonical `Transcript`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineTranscriptOutput {
    pub segments: Vec<TranscriptSegment>,
}

/// Canonical transcript revision. Segments are the source of truth; joined
/// plaintext is derived via `joined_text()`. `stage_history` is append-only
/// across the post-engine pipeline (engine + post-engine stages).
#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub utterance_id: Uuid,
    pub revision: u32,
    pub segments: Vec<TranscriptSegment>,
    pub stage_history: Vec<StageOutcome>,
}

impl Transcript {
    /// Derive plaintext from segments. Trims each segment, drops empties, and
    /// joins with single spaces. Idempotent with respect to leading/trailing
    /// whitespace inside any individual segment.
    pub fn joined_text(&self) -> String {
        let mut pieces = Vec::with_capacity(self.segments.len());
        for segment in &self.segments {
            let trimmed = segment.text.trim();
            if !trimmed.is_empty() {
                pieces.push(trimmed);
            }
        }
        pieces.join(" ")
    }

    /// Read the engine stage's `isFinal` flag. Per D-015 the engine stage's
    /// payload is the canonical record of whether a revision is a finalized
    /// engine pass (`true`) or a speculative partial (`false`). Returns
    /// `false` if the engine stage or flag is absent — that is a contract
    /// violation by the producer, but treating it as a partial is the safer
    /// default than auto-finalizing into the journal.
    pub fn is_final(&self) -> bool {
        self.stage_history
            .first()
            .and_then(|stage| stage.payload.as_ref())
            .and_then(|payload| payload.get("isFinal"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }
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

    use uuid::Uuid;

    use super::{Transcript, validate_audio_samples, validate_language, validate_model_path};
    use crate::protocol::TranscriptSegment;

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

    #[test]
    fn joined_text_joins_trimmed_segments_with_single_spaces() {
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![
                TranscriptSegment {
                    end_ms: 0,
                    start_ms: 0,
                    text: " Hello".to_string(),
                },
                TranscriptSegment {
                    end_ms: 0,
                    start_ms: 0,
                    text: "world ".to_string(),
                },
            ],
            stage_history: Vec::new(),
        };

        assert_eq!(transcript.joined_text(), "Hello world");
    }

    #[test]
    fn joined_text_skips_empty_segments() {
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: vec![
                TranscriptSegment {
                    end_ms: 0,
                    start_ms: 0,
                    text: "Hello".to_string(),
                },
                TranscriptSegment {
                    end_ms: 0,
                    start_ms: 0,
                    text: "   ".to_string(),
                },
                TranscriptSegment {
                    end_ms: 0,
                    start_ms: 0,
                    text: "world".to_string(),
                },
            ],
            stage_history: Vec::new(),
        };

        assert_eq!(transcript.joined_text(), "Hello world");
    }

    #[test]
    fn joined_text_returns_empty_string_when_no_segments() {
        let transcript = Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments: Vec::new(),
            stage_history: Vec::new(),
        };

        assert_eq!(transcript.joined_text(), "");
    }
}
