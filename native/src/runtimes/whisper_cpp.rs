use std::collections::HashMap;
#[cfg(feature = "gpu-cuda")]
use std::ffi::c_int;

#[cfg(feature = "gpu-cuda")]
use libloading::{Library, Symbol};

use crate::engine::capabilities::{
    AcceleratorAvailability, AcceleratorId, ModelFormat, RuntimeCapabilities, RuntimeId,
};
use crate::engine::traits::Runtime;

pub struct WhisperCppRuntime {
    capabilities: RuntimeCapabilities,
}

impl WhisperCppRuntime {
    pub fn probe() -> Self {
        let mut accelerator_details: HashMap<AcceleratorId, AcceleratorAvailability> =
            HashMap::new();

        accelerator_details.insert(AcceleratorId::Cpu, AcceleratorAvailability::available());

        #[cfg(feature = "gpu-metal")]
        accelerator_details.insert(AcceleratorId::Metal, AcceleratorAvailability::available());

        #[cfg(feature = "gpu-cuda")]
        accelerator_details.insert(
            AcceleratorId::Cuda,
            match probe_whisper_cuda() {
                Ok(()) => AcceleratorAvailability::available(),
                Err(reason) => AcceleratorAvailability::unavailable(reason),
            },
        );

        Self {
            capabilities: RuntimeCapabilities::from_details(
                accelerator_details,
                vec![ModelFormat::Ggml, ModelFormat::Gguf],
            ),
        }
    }
}

impl Runtime for WhisperCppRuntime {
    fn id(&self) -> RuntimeId {
        RuntimeId::WhisperCpp
    }

    fn capabilities(&self) -> &RuntimeCapabilities {
        &self.capabilities
    }
}

#[cfg(feature = "gpu-cuda")]
#[cfg(target_os = "linux")]
const CUDA_RUNTIME_LIBRARIES: &[&str] = &["libcudart.so.12", "libcudart.so"];

#[cfg(feature = "gpu-cuda")]
#[cfg(target_os = "windows")]
const CUDA_RUNTIME_LIBRARIES: &[&str] = &["cudart64_12.dll"];

#[cfg(feature = "gpu-cuda")]
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
const CUDA_RUNTIME_LIBRARIES: &[&str] = &[];

#[cfg(all(feature = "gpu-cuda", target_os = "windows"))]
type CudaGetDeviceCount = unsafe extern "system" fn(*mut c_int) -> c_int;

#[cfg(all(feature = "gpu-cuda", not(target_os = "windows")))]
type CudaGetDeviceCount = unsafe extern "C" fn(*mut c_int) -> c_int;

#[cfg(feature = "gpu-cuda")]
fn probe_whisper_cuda() -> Result<(), String> {
    if CUDA_RUNTIME_LIBRARIES.is_empty() {
        return Err("Whisper CUDA probing is unsupported on this platform.".to_string());
    }

    let mut last_discovery_error: Option<String> = None;

    for library_name in CUDA_RUNTIME_LIBRARIES {
        let library = match unsafe { Library::new(library_name) } {
            Ok(library) => library,
            Err(error) => {
                last_discovery_error = Some(format!(
                    "Failed to load CUDA runtime library `{library_name}`: {error}"
                ));
                continue;
            }
        };

        let cuda_get_device_count: Symbol<'_, CudaGetDeviceCount> = match unsafe {
            library.get(b"cudaGetDeviceCount")
        } {
            Ok(symbol) => symbol,
            Err(error) => {
                last_discovery_error = Some(format!(
                    "CUDA runtime library `{library_name}` does not export `cudaGetDeviceCount`: {error}"
                ));
                continue;
            }
        };

        let mut device_count: c_int = 0;
        let error_code = unsafe { cuda_get_device_count(&mut device_count) };
        if error_code != 0 {
            return Err(format!(
                "`cudaGetDeviceCount` via `{library_name}` returned error code {error_code}."
            ));
        }
        if device_count == 0 {
            return Err(format!(
                "CUDA runtime library `{library_name}` reported no CUDA devices."
            ));
        }
        return Ok(());
    }

    Err(last_discovery_error
        .unwrap_or_else(|| "Failed to probe Whisper CUDA availability.".to_string()))
}
