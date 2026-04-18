use std::collections::HashMap;
use std::path::Path;

#[cfg(feature = "gpu-ort-cuda")]
use ort::ep::{CUDAExecutionProvider, ExecutionProvider};
use ort::session::Session;

use crate::engine::capabilities::{
    AcceleratorAvailability, AcceleratorId, ModelFormat, RuntimeCapabilities, RuntimeId,
};
use crate::engine::traits::Runtime;
use crate::transcription::{GpuConfig, TranscriptionError};

pub struct OnnxRuntime {
    capabilities: RuntimeCapabilities,
}

impl OnnxRuntime {
    pub fn probe() -> Self {
        let mut accelerator_details: HashMap<AcceleratorId, AcceleratorAvailability> =
            HashMap::new();

        accelerator_details.insert(AcceleratorId::Cpu, AcceleratorAvailability::available());

        #[cfg(feature = "gpu-ort-cuda")]
        accelerator_details.insert(
            AcceleratorId::Cuda,
            match probe_cuda_execution_provider() {
                Ok(()) => AcceleratorAvailability::available(),
                Err(reason) => AcceleratorAvailability::unavailable(reason),
            },
        );

        Self {
            capabilities: RuntimeCapabilities::from_details(
                accelerator_details,
                vec![ModelFormat::Onnx],
            ),
        }
    }
}

impl Runtime for OnnxRuntime {
    fn id(&self) -> RuntimeId {
        RuntimeId::OnnxRuntime
    }

    fn capabilities(&self) -> &RuntimeCapabilities {
        &self.capabilities
    }
}

/// Build an ORT session for `model_path`, optionally registering the CUDA EP
/// when `gpu_config.use_gpu` is set and the `gpu-ort-cuda` feature is compiled.
pub fn build_session(
    model_path: &Path,
    gpu_config: GpuConfig,
) -> Result<Session, TranscriptionError> {
    let mut builder = Session::builder()
        .map_err(|e| TranscriptionError::transcription_failure("session builder", &e))?;

    #[cfg(feature = "gpu-ort-cuda")]
    if gpu_config.use_gpu {
        builder = builder
            .with_execution_providers([CUDAExecutionProvider::default().build().error_on_failure()])
            .map_err(|e| TranscriptionError::transcription_failure("CUDA EP registration", &e))?;
    }

    #[cfg(not(feature = "gpu-ort-cuda"))]
    let _ = gpu_config;

    builder
        .commit_from_file(model_path)
        .map_err(|e| TranscriptionError::transcription_failure("model loading", &e))
}

#[cfg(feature = "gpu-ort-cuda")]
pub fn probe_cuda_execution_provider() -> Result<(), String> {
    let execution_provider = CUDAExecutionProvider::default();
    match execution_provider.is_available() {
        Ok(false) => {
            return Err("ONNX Runtime CUDA execution provider is unavailable.".to_string());
        }
        Err(error) => {
            return Err(format!(
                "Failed to query ONNX Runtime CUDA execution provider: {error}"
            ));
        }
        Ok(true) => {}
    }

    Session::builder()
        .map_err(|error| format!("Failed to create an ONNX Runtime session builder: {error}"))?
        .with_execution_providers([execution_provider.build().error_on_failure()])
        .map(|_| ())
        .map_err(|error| format!("CUDA execution provider registration failed: {error}"))
}
