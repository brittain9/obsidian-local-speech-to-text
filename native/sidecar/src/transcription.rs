use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use anyhow::Context;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::protocol::{TranscribeFileResponsePayload, TranscriptSegment};

const SUPPORTED_LANGUAGE: &str = "en";
const SUPPORTED_CHANNEL_COUNT: u16 = 1;
const SUPPORTED_SAMPLE_RATE: u32 = 16_000;
const SUPPORTED_BITS_PER_SAMPLE: u16 = 16;

#[derive(Debug, Default)]
pub struct TranscriptionEngine {
    loaded_model: Option<LoadedModel>,
}

#[derive(Debug)]
struct LoadedModel {
    context: WhisperContext,
    model_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionRequest {
    pub audio_file_path: PathBuf,
    pub language: String,
    pub model_file_path: PathBuf,
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
    ) -> Result<TranscribeFileResponsePayload, TranscriptionError> {
        validate_language(&request.language)?;

        let audio = load_audio_file(&request.audio_file_path)?;
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

        state.full(params, &audio).map_err(|error| {
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

        Ok(TranscribeFileResponsePayload {
            segments,
            text: text.trim().to_string(),
        })
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
            let model_path = model_file_path.to_str().ok_or_else(|| {
                TranscriptionError::invalid_model("model path must be valid UTF-8")
            })?;
            let context =
                WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
                    .map_err(|error| {
                        TranscriptionError::invalid_model_with_details(error.to_string())
                    })?;

            self.loaded_model = Some(LoadedModel {
                context,
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

fn load_audio_file(audio_file_path: &Path) -> Result<Vec<f32>, TranscriptionError> {
    validate_audio_path(audio_file_path)?;

    let reader = hound::WavReader::open(audio_file_path).map_err(|error| {
        TranscriptionError::invalid_audio_with_details(format!("failed to open WAV file: {error}"))
    })?;
    let spec = reader.spec();

    if spec.channels != SUPPORTED_CHANNEL_COUNT {
        return Err(TranscriptionError::invalid_audio_with_details(format!(
            "expected mono WAV input, received {} channels",
            spec.channels
        )));
    }

    if spec.sample_rate != SUPPORTED_SAMPLE_RATE {
        return Err(TranscriptionError::invalid_audio_with_details(format!(
            "expected {} Hz WAV input, received {} Hz",
            SUPPORTED_SAMPLE_RATE, spec.sample_rate
        )));
    }

    if spec.bits_per_sample != SUPPORTED_BITS_PER_SAMPLE
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err(TranscriptionError::invalid_audio_with_details(
            "expected 16-bit PCM WAV input".to_string(),
        ));
    }

    let samples: Vec<i16> = reader
        .into_samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            TranscriptionError::invalid_audio_with_details(format!(
                "failed to decode PCM samples: {error}"
            ))
        })?;
    let mut audio = vec![0.0_f32; samples.len()];

    whisper_rs::convert_integer_to_float_audio(&samples, &mut audio).map_err(|error| {
        TranscriptionError::invalid_audio_with_details(format!(
            "failed to convert PCM audio to floats: {error}"
        ))
    })?;

    Ok(audio)
}

fn validate_audio_path(audio_file_path: &Path) -> Result<(), TranscriptionError> {
    validate_file_exists(audio_file_path, "audio file", "missing_audio_file")
}

fn validate_model_path(model_file_path: &Path) -> Result<(), TranscriptionError> {
    validate_file_exists(model_file_path, "model file", "missing_model_file")
}

fn validate_file_exists(
    path: &Path,
    label: &'static str,
    code: &'static str,
) -> Result<(), TranscriptionError> {
    if !path.is_file() {
        return Err(TranscriptionError {
            code,
            message: if label == "audio file" {
                "Audio file does not exist or is not a regular file."
            } else {
                "Model file does not exist or is not a regular file."
            },
            details: Some(path.display().to_string()),
        });
    }

    std::fs::File::open(path)
        .with_context(|| format!("failed to open {label}: {}", path.display()))
        .map_err(|error| {
            if label == "audio file" {
                TranscriptionError::invalid_audio_with_details(error.to_string())
            } else {
                TranscriptionError::invalid_model_with_details(error.to_string())
            }
        })?;

    Ok(())
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
    fn invalid_audio_with_details(details: String) -> Self {
        Self {
            code: "invalid_audio_file",
            message: "Audio file is missing, unreadable, or not in the required WAV format.",
            details: Some(details),
        }
    }

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

    fn transcription_failure(message: &'static str, error: impl Display) -> Self {
        Self {
            code: "transcription_failed",
            message: "Whisper transcription failed.",
            details: Some(format!("{message}: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{TranscriptionEngine, TranscriptionRequest, whisper_timestamp_to_millis};

    #[test]
    fn missing_model_file_returns_structured_error() {
        let mut engine = TranscriptionEngine::default();
        let error = engine
            .transcribe(&TranscriptionRequest {
                audio_file_path: PathBuf::from("/tmp/does-not-exist.wav"),
                language: "en".to_string(),
                model_file_path: PathBuf::from("/tmp/does-not-exist.bin"),
            })
            .expect_err("transcription should fail");

        assert_eq!(error.code, "missing_audio_file");
    }

    #[test]
    fn whisper_timestamp_converts_to_milliseconds() {
        assert_eq!(whisper_timestamp_to_millis(123), 1_230);
        assert_eq!(whisper_timestamp_to_millis(-1), 0);
    }
}
