use std::collections::HashMap;
use std::path::Path;

use crate::engine::capabilities::{
    EngineCapabilities, ModelFamilyCapabilities, ModelFamilyId, RequestWarning, RuntimeId,
};
use crate::engine::traits::{ModelFamilyAdapter, Runtime};
use crate::transcription::TranscriptionRequest;

/// Registered runtimes and family adapters. Entries missing from this map are
/// feature-gated off at compile time; callers surface "unsupported_engine" so
/// UIs can distinguish that from "model file broken".
#[derive(Default)]
pub struct EngineRegistry {
    runtimes: HashMap<RuntimeId, Box<dyn Runtime>>,
    adapters: HashMap<(RuntimeId, ModelFamilyId), Box<dyn ModelFamilyAdapter>>,
}

impl EngineRegistry {
    pub fn build() -> Self {
        #[allow(unused_mut)]
        let mut registry = Self::default();

        #[cfg(feature = "engine-whisper")]
        {
            registry.register_runtime(Box::new(
                crate::runtimes::whisper_cpp::WhisperCppRuntime::probe(),
            ));
            registry.register_adapter(Box::new(crate::adapters::whisper::WhisperAdapter::new()));
        }

        // OnnxRuntime is registered inside the Cohere gate because Cohere is the
        // only ONNX family today. When a second ONNX family lands, lift the
        // runtime registration to `#[cfg(any(engine-cohere-transcribe, engine-<new>))]`
        // so it registers once regardless of which ONNX families are enabled.
        #[cfg(feature = "engine-cohere-transcribe")]
        {
            registry.register_runtime(Box::new(crate::runtimes::onnx::OnnxRuntime::probe()));
            registry.register_adapter(Box::new(
                crate::adapters::cohere_transcribe::CohereTranscribeAdapter::new(),
            ));
        }

        registry
    }

    pub fn register_runtime(&mut self, runtime: Box<dyn Runtime>) {
        self.runtimes.insert(runtime.id(), runtime);
    }

    pub fn register_adapter(&mut self, adapter: Box<dyn ModelFamilyAdapter>) {
        self.adapters
            .insert((adapter.runtime_id(), adapter.family_id()), adapter);
    }

    pub fn runtimes(&self) -> impl Iterator<Item = &dyn Runtime> {
        self.runtimes.values().map(|runtime| runtime.as_ref())
    }

    pub fn adapters(&self) -> impl Iterator<Item = &dyn ModelFamilyAdapter> {
        self.adapters.values().map(|adapter| adapter.as_ref())
    }

    pub fn runtime(&self, id: RuntimeId) -> Option<&dyn Runtime> {
        self.runtimes.get(&id).map(|r| r.as_ref())
    }

    pub fn adapter(
        &self,
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
    ) -> Option<&dyn ModelFamilyAdapter> {
        self.adapters
            .get(&(runtime_id, family_id))
            .map(|a| a.as_ref())
    }

    /// Merge runtime + family capabilities into an over-the-wire struct.
    /// Falls back to `ModelFamilyCapabilities::unknown()` when the family
    /// adapter is not registered (external-file selections fitting a compiled
    /// runtime whose family we can't verify). Returns `None` only when the
    /// runtime itself is not registered.
    pub fn merged_capabilities(
        &self,
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
    ) -> Option<EngineCapabilities> {
        let runtime = self.runtime(runtime_id)?;
        let family = self
            .adapter(runtime_id, family_id)
            .map(|adapter| adapter.capabilities().clone())
            .unwrap_or_else(ModelFamilyCapabilities::unknown);

        Some(EngineCapabilities {
            runtime_id,
            family_id,
            runtime: runtime.capabilities().clone(),
            family,
        })
    }

    pub fn probe_model(
        &self,
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        path: &Path,
    ) -> Result<(), crate::transcription::TranscriptionError> {
        match self.adapter(runtime_id, family_id) {
            Some(adapter) => adapter.probe_model(path),
            None => Err(missing_adapter_error(runtime_id, family_id)),
        }
    }
}

pub fn missing_adapter_error(
    runtime_id: RuntimeId,
    family_id: ModelFamilyId,
) -> crate::transcription::TranscriptionError {
    crate::transcription::TranscriptionError::unsupported_engine(format!(
        "no adapter registered for ({}, {})",
        runtime_id.as_str(),
        family_id.as_str()
    ))
}

/// Strip request fields the adapter can't honor and return one warning per
/// dropped field. Zeroing in place keeps the adapter contract simple: adapters
/// assume any field still set is one they declared support for.
pub fn apply_capability_gates(
    adapter_capabilities: &ModelFamilyCapabilities,
    request: &mut TranscriptionRequest,
) -> Vec<RequestWarning> {
    let mut warnings = Vec::new();

    if request.initial_prompt.is_some() && !adapter_capabilities.supports_initial_prompt {
        warnings.push(RequestWarning {
            field: "initial_prompt".to_string(),
            reason: "adapter does not support initial-prompt conditioning".to_string(),
        });
        request.initial_prompt = None;
    }

    warnings
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    use super::{EngineRegistry, RequestWarning, apply_capability_gates, missing_adapter_error};
    use crate::engine::capabilities::{
        AcceleratorAvailability, AcceleratorId, LanguageSupport, ModelFamilyCapabilities,
        ModelFamilyId, ModelFormat, RuntimeCapabilities, RuntimeId,
    };
    use crate::engine::traits::{LoadedModel, ModelFamilyAdapter, Runtime};
    use crate::transcription::{GpuConfig, TranscriptionError, TranscriptionRequest};

    struct FakeRuntime {
        id: RuntimeId,
        capabilities: RuntimeCapabilities,
    }

    impl Runtime for FakeRuntime {
        fn id(&self) -> RuntimeId {
            self.id
        }

        fn capabilities(&self) -> &RuntimeCapabilities {
            &self.capabilities
        }
    }

    struct FakeAdapter {
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        capabilities: ModelFamilyCapabilities,
    }

    impl ModelFamilyAdapter for FakeAdapter {
        fn runtime_id(&self) -> RuntimeId {
            self.runtime_id
        }

        fn family_id(&self) -> ModelFamilyId {
            self.family_id
        }

        fn capabilities(&self) -> &ModelFamilyCapabilities {
            &self.capabilities
        }

        fn probe_model(&self, _path: &Path) -> Result<(), TranscriptionError> {
            Ok(())
        }

        fn load(
            &self,
            _path: &Path,
            _gpu: GpuConfig,
        ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
            Err(TranscriptionError::unsupported_engine(
                "fake adapter cannot load".to_string(),
            ))
        }
    }

    fn runtime_caps() -> RuntimeCapabilities {
        let mut accelerator_details = HashMap::new();
        accelerator_details.insert(
            AcceleratorId::Cpu,
            AcceleratorAvailability {
                available: true,
                unavailable_reason: None,
            },
        );
        RuntimeCapabilities {
            available_accelerators: vec![AcceleratorId::Cpu],
            accelerator_details,
            supported_model_formats: vec![ModelFormat::Ggml],
        }
    }

    fn whisper_family_caps() -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_timed_segments: true,
            supports_initial_prompt: true,
            supports_language_selection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: None,
            produces_punctuation: true,
        }
    }

    fn build_registry_with_whisper() -> EngineRegistry {
        let mut registry = EngineRegistry::default();
        registry.register_runtime(Box::new(FakeRuntime {
            id: RuntimeId::WhisperCpp,
            capabilities: runtime_caps(),
        }));
        registry.register_adapter(Box::new(FakeAdapter {
            runtime_id: RuntimeId::WhisperCpp,
            family_id: ModelFamilyId::Whisper,
            capabilities: whisper_family_caps(),
        }));
        registry
    }

    #[test]
    fn adapter_lookup_returns_registered_pair() {
        let registry = build_registry_with_whisper();

        let adapter = registry
            .adapter(RuntimeId::WhisperCpp, ModelFamilyId::Whisper)
            .expect("whisper adapter registered");
        assert_eq!(adapter.runtime_id(), RuntimeId::WhisperCpp);
        assert_eq!(adapter.family_id(), ModelFamilyId::Whisper);
    }

    #[test]
    fn adapter_lookup_returns_none_for_unregistered_pair() {
        let registry = build_registry_with_whisper();

        assert!(
            registry
                .adapter(RuntimeId::OnnxRuntime, ModelFamilyId::CohereTranscribe)
                .is_none()
        );
        assert!(
            registry
                .adapter(RuntimeId::WhisperCpp, ModelFamilyId::CohereTranscribe)
                .is_none()
        );
    }

    #[test]
    fn merged_capabilities_composes_runtime_and_family_for_registered_pair() {
        let registry = build_registry_with_whisper();

        let merged = registry
            .merged_capabilities(RuntimeId::WhisperCpp, ModelFamilyId::Whisper)
            .expect("merged capabilities present");
        assert_eq!(merged.runtime_id, RuntimeId::WhisperCpp);
        assert_eq!(merged.family_id, ModelFamilyId::Whisper);
        assert_eq!(merged.runtime, runtime_caps());
        assert_eq!(merged.family, whisper_family_caps());
    }

    #[test]
    fn merged_capabilities_returns_none_when_runtime_missing() {
        let registry = build_registry_with_whisper();

        assert!(
            registry
                .merged_capabilities(RuntimeId::OnnxRuntime, ModelFamilyId::CohereTranscribe)
                .is_none()
        );
    }

    #[test]
    fn merged_capabilities_falls_back_to_unknown_when_family_adapter_missing() {
        let mut registry = EngineRegistry::default();
        registry.register_runtime(Box::new(FakeRuntime {
            id: RuntimeId::WhisperCpp,
            capabilities: runtime_caps(),
        }));

        let merged = registry
            .merged_capabilities(RuntimeId::WhisperCpp, ModelFamilyId::Whisper)
            .expect("runtime registered so merge succeeds");
        assert_eq!(merged.family, ModelFamilyCapabilities::unknown());
    }

    #[test]
    fn probe_model_returns_missing_adapter_error_for_unregistered_pair() {
        let registry = build_registry_with_whisper();

        let err = registry
            .probe_model(
                RuntimeId::OnnxRuntime,
                ModelFamilyId::CohereTranscribe,
                Path::new("/tmp/missing.bin"),
            )
            .expect_err("unregistered pair should error");
        assert_eq!(err.code, "unsupported_engine");
        assert!(err.details.unwrap_or_default().contains("onnx_runtime"));
    }

    #[test]
    fn missing_adapter_error_formats_triple_pair() {
        let err = missing_adapter_error(RuntimeId::OnnxRuntime, ModelFamilyId::Whisper);

        assert_eq!(err.code, "unsupported_engine");
        let details = err.details.expect("details set");
        assert!(details.contains("onnx_runtime"));
        assert!(details.contains("whisper"));
    }

    fn capabilities(supports_initial_prompt: bool) -> ModelFamilyCapabilities {
        ModelFamilyCapabilities {
            supports_timed_segments: true,
            supports_initial_prompt,
            supports_language_selection: true,
            supported_languages: LanguageSupport::All,
            max_audio_duration_secs: None,
            produces_punctuation: true,
        }
    }

    fn request_with_prompt(prompt: Option<&str>) -> TranscriptionRequest {
        TranscriptionRequest {
            audio_samples: vec![0.0; 16_000],
            gpu_config: GpuConfig::default(),
            language: "en".to_string(),
            model_file_path: PathBuf::from("/tmp/model.bin"),
            initial_prompt: prompt.map(str::to_string),
        }
    }

    #[test]
    fn drops_initial_prompt_and_emits_warning_when_adapter_does_not_support_it() {
        let caps = capabilities(false);
        let mut request = request_with_prompt(Some("lorem ipsum"));

        let warnings = apply_capability_gates(&caps, &mut request);

        assert!(request.initial_prompt.is_none());
        assert_eq!(
            warnings,
            vec![RequestWarning {
                field: "initial_prompt".to_string(),
                reason: "adapter does not support initial-prompt conditioning".to_string(),
            }]
        );
    }

    #[test]
    fn preserves_initial_prompt_when_adapter_supports_it() {
        let caps = capabilities(true);
        let mut request = request_with_prompt(Some("lorem ipsum"));

        let warnings = apply_capability_gates(&caps, &mut request);

        assert_eq!(request.initial_prompt.as_deref(), Some("lorem ipsum"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn emits_no_warning_when_no_initial_prompt_is_set() {
        let caps = capabilities(false);
        let mut request = request_with_prompt(None);

        let warnings = apply_capability_gates(&caps, &mut request);

        assert!(request.initial_prompt.is_none());
        assert!(warnings.is_empty());
    }
}
