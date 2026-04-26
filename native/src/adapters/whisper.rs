use std::path::Path;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::engine::capabilities::{
    LanguageSupport, ModelFamilyCapabilities, ModelFamilyId, RuntimeId,
};
use crate::engine::traits::{LoadedModel, ModelFamilyAdapter};
use crate::protocol::TranscriptSegment;
use crate::transcription::{
    EngineTranscriptOutput, GpuConfig, TranscriptionError, TranscriptionRequest,
    validate_audio_samples, validate_language, validate_model_path,
};

#[derive(Default)]
pub struct WhisperAdapter;

const CAPABILITIES: ModelFamilyCapabilities = ModelFamilyCapabilities {
    supports_timed_segments: true,
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

        if let Some(prompt) = request.initial_prompt.as_deref() {
            params.set_initial_prompt(prompt);
        }

        state
            .full(params, &request.audio_samples)
            .map_err(|error| {
                TranscriptionError::transcription_failure("failed to run whisper model", error)
            })?;

        let mut segments = Vec::new();

        for segment in state.as_iter() {
            let segment_text = segment.to_string();
            segments.push(TranscriptSegment {
                end_ms: whisper_timestamp_to_millis(segment.end_timestamp()),
                start_ms: whisper_timestamp_to_millis(segment.start_timestamp()),
                text: segment_text.trim().to_string(),
            });
        }

        Ok(EngineTranscriptOutput { segments })
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
