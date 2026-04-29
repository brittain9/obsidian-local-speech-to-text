use std::path::Path;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::engine::capabilities::{
    LanguageSupport, ModelFamilyCapabilities, ModelFamilyId, RuntimeId,
};
use crate::engine::traits::{LoadedModel, ModelFamilyAdapter};
use crate::protocol::{TimestampGranularity, TimestampSource, TranscriptSegment};
use crate::transcription::{
    EngineTranscriptOutput, GpuConfig, SegmentDiagnostics, TranscriptionError,
    TranscriptionRequest, validate_audio_samples, validate_language, validate_model_path,
};

#[derive(Default)]
pub struct WhisperAdapter;

const CAPABILITIES: ModelFamilyCapabilities = ModelFamilyCapabilities {
    supports_segment_timestamps: true,
    supports_word_timestamps: false,
    supports_initial_prompt: true,
    supports_language_selection: false,
    supported_languages: LanguageSupport::EnglishOnly,
    max_audio_duration_secs: None,
    produces_punctuation: true,
};

impl ModelFamilyAdapter for WhisperAdapter {
    fn runtime_id(&self) -> RuntimeId {
        RuntimeId::WhisperCpp
    }

    fn family_id(&self) -> ModelFamilyId {
        ModelFamilyId::Whisper
    }

    fn capabilities(&self) -> &ModelFamilyCapabilities {
        &CAPABILITIES
    }

    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError> {
        validate_model_path(path)?;
        let _ = load_whisper_context(path, &GpuConfig { use_gpu: false })?;
        Ok(())
    }

    fn load(
        &self,
        path: &Path,
        gpu: GpuConfig,
    ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
        validate_model_path(path)?;
        let context = load_whisper_context(path, &gpu)?;
        Ok(Box::new(LoadedWhisperModel { context }))
    }
}

pub struct LoadedWhisperModel {
    context: WhisperContext,
}

impl LoadedModel for LoadedWhisperModel {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<EngineTranscriptOutput, TranscriptionError> {
        validate_language(&request.language)?;
        validate_audio_samples(&request.audio_samples)?;

        let mut state = self.context.create_state().map_err(|error| {
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

        if let Some(context) = request.context.as_ref() {
            params.set_initial_prompt(&context.text);
        }

        state
            .full(params, &request.audio_samples)
            .map_err(|error| {
                TranscriptionError::transcription_failure("failed to run whisper model", error)
            })?;

        let mut segments = Vec::new();
        let mut diagnostics = Vec::new();

        for segment in state.as_iter() {
            let segment_text = segment.to_string();
            diagnostics.push(whisper_segment_diagnostics(&segment));
            segments.push(TranscriptSegment {
                end_ms: whisper_timestamp_to_millis(segment.end_timestamp()),
                start_ms: whisper_timestamp_to_millis(segment.start_timestamp()),
                text: segment_text.trim().to_string(),
                timestamp_granularity: TimestampGranularity::Segment,
                timestamp_source: TimestampSource::Engine,
            });
        }

        Ok(EngineTranscriptOutput {
            segments,
            diagnostics,
        })
    }
}

fn whisper_segment_diagnostics(segment: &whisper_rs::WhisperSegment<'_>) -> SegmentDiagnostics {
    let token_count = segment.n_tokens().max(0) as u32;
    SegmentDiagnostics {
        avg_logprob: average_token_logprob(segment),
        decode_reached_eos: None,
        no_speech_prob: Some(segment.no_speech_probability()),
        token_count: Some(token_count),
    }
}

fn average_token_logprob(segment: &whisper_rs::WhisperSegment<'_>) -> Option<f32> {
    let mut count = 0_u32;
    let mut sum = 0.0_f32;

    for index in 0..segment.n_tokens() {
        let Some(token) = segment.get_token(index) else {
            continue;
        };
        if !token_has_visible_text(&token) {
            continue;
        }
        // Floor to 1e-9 so quantization noise can't drive the running sum to
        // -inf via ln(0); cap at 1.0 so a slightly-over-one probability does
        // not produce a positive logprob.
        sum += token.token_probability().clamp(1.0e-9, 1.0).ln();
        count += 1;
    }

    (count > 0).then_some(sum / count as f32)
}

fn token_has_visible_text(token: &whisper_rs::WhisperToken<'_, '_>) -> bool {
    // Borrow the raw bytes (no allocation) and skip tokens whose text is empty
    // or whitespace-only — that matches the prior `to_string().trim().is_empty()`
    // behavior without churning a String per token.
    match token.to_bytes() {
        Ok(bytes) => bytes.iter().any(|byte| !byte.is_ascii_whitespace()),
        Err(_) => false,
    }
}

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
