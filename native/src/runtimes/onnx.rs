use std::collections::HashMap;
use std::path::Path;
#[cfg(feature = "gpu-ort-cuda")]
use std::sync::OnceLock;

#[cfg(feature = "gpu-ort-cuda")]
use ort::ep::{
    CUDA, ExecutionProvider,
    cuda::{CUDA_DYLIBS, CUDNN_DYLIBS},
};
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
        ensure_cuda_execution_provider_ready()
            .map_err(|e| TranscriptionError::transcription_failure("CUDA dependency check", &e))?;

        builder = builder
            .with_execution_providers([CUDA::default().build().error_on_failure()])
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
    ensure_cuda_execution_provider_ready()
}

#[cfg(feature = "gpu-ort-cuda")]
fn ensure_cuda_execution_provider_ready() -> Result<(), String> {
    static CUDA_PRECHECK: OnceLock<Result<(), String>> = OnceLock::new();

    CUDA_PRECHECK.get_or_init(run_cuda_precheck).clone()
}

#[cfg(feature = "gpu-ort-cuda")]
fn run_cuda_precheck() -> Result<(), String> {
    let execution_provider = CUDA::default();
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

    preload_cuda_dependencies()?;

    Session::builder()
        .map_err(|error| format!("Failed to create an ONNX Runtime session builder: {error}"))?
        .with_execution_providers([execution_provider.build().error_on_failure()])
        .map(|_| ())
        .map_err(|error| format!("CUDA execution provider registration failed: {error}"))
}

#[cfg(feature = "gpu-ort-cuda")]
fn preload_cuda_dependencies() -> Result<(), String> {
    // ORT can register the CUDA EP before delay-loaded CUDA/cuDNN DLLs are
    // actually resolved. Preload them so missing runtime files become a CPU
    // fallback reason instead of a fail-fast during the first encoder run.
    let sidecar_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));

    for library_name in CUDA_DYLIBS {
        preload_required_dylib(library_name, sidecar_dir.as_deref(), "CUDA runtime")?;
    }

    for library_name in CUDNN_DYLIBS {
        preload_required_dylib(library_name, sidecar_dir.as_deref(), "cuDNN runtime")?;
    }

    Ok(())
}

#[cfg(feature = "gpu-ort-cuda")]
fn preload_required_dylib(
    library_name: &str,
    sidecar_dir: Option<&Path>,
    dependency_group: &str,
) -> Result<(), String> {
    if let Some(candidate) = sidecar_dir
        .map(|dir| dir.join(library_name))
        .filter(|candidate| candidate.is_file())
    {
        return ort::util::preload_dylib(&candidate).map_err(|error| {
            format!(
                "{dependency_group} library {} failed to load from {}: {error}",
                library_name,
                candidate.display()
            )
        });
    }

    ort::util::preload_dylib(Path::new(library_name)).map_err(|error| {
        format!(
            "{dependency_group} library {library_name} is not available from the sidecar \
             directory or the system library search path: {error}"
        )
    })
}
