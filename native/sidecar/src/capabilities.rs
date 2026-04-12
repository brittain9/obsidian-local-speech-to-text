#[cfg(feature = "gpu-cuda")]
use std::path::Path;

use crate::protocol::RuntimeCapability;

pub fn probe_runtime_capabilities() -> Vec<RuntimeCapability> {
    let mut capabilities = vec![RuntimeCapability {
        available: true,
        backend: "cpu".to_string(),
        engine: "whisper_cpp".to_string(),
        reason: None,
    }];

    #[cfg(all(feature = "gpu-metal", target_os = "macos"))]
    capabilities.push(probe_whisper_metal());

    #[cfg(feature = "gpu-cuda")]
    capabilities.push(probe_whisper_cuda());

    #[cfg(feature = "engine-cohere")]
    capabilities.push(RuntimeCapability {
        available: true,
        backend: "cpu".to_string(),
        engine: "cohere_onnx".to_string(),
        reason: None,
    });

    #[cfg(all(feature = "engine-cohere", feature = "gpu-ort-cuda"))]
    capabilities.push(probe_cohere_cuda());

    capabilities
}

#[cfg(all(feature = "gpu-metal", target_os = "macos"))]
fn probe_whisper_metal() -> RuntimeCapability {
    RuntimeCapability {
        available: true,
        backend: "metal".to_string(),
        engine: "whisper_cpp".to_string(),
        reason: None,
    }
}

#[cfg(feature = "gpu-cuda")]
fn probe_whisper_cuda() -> RuntimeCapability {
    #[cfg(target_os = "linux")]
    let available = ["/dev/nvidiactl", "/dev/nvidia0"]
        .iter()
        .any(|path| Path::new(path).exists());

    #[cfg(not(target_os = "linux"))]
    let available = true;

    RuntimeCapability {
        available,
        backend: "cuda".to_string(),
        engine: "whisper_cpp".to_string(),
        reason: if available {
            None
        } else {
            Some("NVIDIA device nodes were not found.".to_string())
        },
    }
}

#[cfg(all(feature = "engine-cohere", feature = "gpu-ort-cuda"))]
fn probe_cohere_cuda() -> RuntimeCapability {
    let (available, reason) = match crate::cohere::probe_cuda_execution_provider() {
        Ok(()) => (true, None),
        Err(msg) => (false, Some(msg)),
    };

    RuntimeCapability {
        available,
        backend: "cuda".to_string(),
        engine: "cohere_onnx".to_string(),
        reason,
    }
}
