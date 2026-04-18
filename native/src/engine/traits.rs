use std::path::Path;

use crate::engine::capabilities::{
    ModelFamilyCapabilities, ModelFamilyId, RuntimeCapabilities, RuntimeId,
};
use crate::transcription::{GpuConfig, Transcript, TranscriptionError, TranscriptionRequest};

/// Execution-framework layer. Owns accelerator registration/probe and the
/// model-file formats it understands.
pub trait Runtime: Send + Sync {
    fn id(&self) -> RuntimeId;
    fn capabilities(&self) -> &RuntimeCapabilities;
}

/// Model-family layer. Owns graph I/O names, tokenizer, prompt tokens,
/// audio limits, and per-model probe rules.
pub trait ModelFamilyAdapter: Send + Sync {
    fn runtime_id(&self) -> RuntimeId;
    fn family_id(&self) -> ModelFamilyId;
    fn capabilities(&self) -> &ModelFamilyCapabilities;

    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError>;
    fn load(&self, path: &Path, gpu: GpuConfig)
    -> Result<Box<dyn LoadedModel>, TranscriptionError>;
}

/// Per-session inference state. Holds session/context/tokenizer whatever the
/// adapter needs; only `transcribe` is contract.
pub trait LoadedModel: Send {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, TranscriptionError>;
}
