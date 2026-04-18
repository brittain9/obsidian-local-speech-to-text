use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Runtime identifier — the execution framework that loads and runs model files.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeId {
    OnnxRuntime,
    WhisperCpp,
}

impl RuntimeId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnnxRuntime => "onnx_runtime",
            Self::WhisperCpp => "whisper_cpp",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::OnnxRuntime => "ONNX Runtime",
            Self::WhisperCpp => "whisper.cpp",
        }
    }
}

/// Model-family identifier — architecture + graph I/O convention + tokenizer.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFamilyId {
    CohereTranscribe,
    Whisper,
}

impl ModelFamilyId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CohereTranscribe => "cohere_transcribe",
            Self::Whisper => "whisper",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::CohereTranscribe => "Cohere Transcribe",
            Self::Whisper => "Whisper",
        }
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceleratorId {
    Cpu,
    Cuda,
    Metal,
    DirectMl,
}

impl AcceleratorId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::Metal => "metal",
            Self::DirectMl => "direct_ml",
        }
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFormat {
    Ggml,
    Gguf,
    Onnx,
}

/// Language support for a model family adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LanguageSupport {
    All,
    List { tags: Vec<String> },
    EnglishOnly,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceleratorAvailability {
    pub available: bool,
    #[serde(rename = "unavailableReason", skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

impl AcceleratorAvailability {
    pub const fn available() -> Self {
        Self {
            available: true,
            unavailable_reason: None,
        }
    }

    pub const fn unavailable(reason: String) -> Self {
        Self {
            available: false,
            unavailable_reason: Some(reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCapabilities {
    #[serde(rename = "availableAccelerators")]
    pub available_accelerators: Vec<AcceleratorId>,
    #[serde(rename = "acceleratorDetails")]
    pub accelerator_details: HashMap<AcceleratorId, AcceleratorAvailability>,
    #[serde(rename = "supportedModelFormats")]
    pub supported_model_formats: Vec<ModelFormat>,
}

impl RuntimeCapabilities {
    /// Build a capabilities struct from detail entries, deriving
    /// `available_accelerators` as the subset flagged `available`.
    pub fn from_details(
        accelerator_details: HashMap<AcceleratorId, AcceleratorAvailability>,
        supported_model_formats: Vec<ModelFormat>,
    ) -> Self {
        let available_accelerators = accelerator_details
            .iter()
            .filter_map(|(id, details)| details.available.then_some(*id))
            .collect();

        Self {
            available_accelerators,
            accelerator_details,
            supported_model_formats,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelFamilyCapabilities {
    #[serde(rename = "supportsTimedSegments")]
    pub supports_timed_segments: bool,
    #[serde(rename = "supportsInitialPrompt")]
    pub supports_initial_prompt: bool,
    #[serde(rename = "supportsLanguageSelection")]
    pub supports_language_selection: bool,
    #[serde(rename = "supportedLanguages")]
    pub supported_languages: LanguageSupport,
    #[serde(
        rename = "maxAudioDurationSecs",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_audio_duration_secs: Option<f32>,
    #[serde(rename = "producesPunctuation")]
    pub produces_punctuation: bool,
}

impl ModelFamilyCapabilities {
    /// Conservative fallback used when the family is unknown (external-file
    /// selections whose runtime is compiled in but whose graph shape isn't
    /// declared by any registered adapter).
    pub const fn unknown() -> Self {
        Self {
            supports_timed_segments: false,
            supports_initial_prompt: false,
            supports_language_selection: false,
            supported_languages: LanguageSupport::Unknown,
            max_audio_duration_secs: None,
            produces_punctuation: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_family_capabilities_are_conservative() {
        let unknown = ModelFamilyCapabilities::unknown();

        assert!(!unknown.supports_timed_segments);
        assert!(!unknown.supports_initial_prompt);
        assert!(!unknown.supports_language_selection);
        assert!(!unknown.produces_punctuation);
        assert!(unknown.max_audio_duration_secs.is_none());
        assert_eq!(unknown.supported_languages, LanguageSupport::Unknown);
    }
}

/// Merged capability view sent over the wire per selected model.
///
/// Today this is `RuntimeCapabilities ⊕ ModelFamilyCapabilities` — every model
/// in a family reports the same family caps. Per-model overrides are a planned
/// additive extension: a new optional field on this struct (e.g.
/// `modelOverrides`) that consumers default to merged family caps when absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineCapabilities {
    #[serde(rename = "runtimeId")]
    pub runtime_id: RuntimeId,
    #[serde(rename = "familyId")]
    pub family_id: ModelFamilyId,
    pub runtime: RuntimeCapabilities,
    pub family: ModelFamilyCapabilities,
}

/// Warning emitted when the worker drops a request field the adapter cannot
/// honor. Surfaces in the plugin dev console only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestWarning {
    pub field: String,
    pub reason: String,
}
