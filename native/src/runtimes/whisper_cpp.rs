use std::collections::HashMap;

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

        accelerator_details.insert(
            AcceleratorId::Cpu,
            AcceleratorAvailability {
                available: true,
                unavailable_reason: None,
            },
        );

        #[cfg(feature = "gpu-metal")]
        accelerator_details.insert(
            AcceleratorId::Metal,
            AcceleratorAvailability {
                available: true,
                unavailable_reason: None,
            },
        );

        #[cfg(feature = "gpu-cuda")]
        accelerator_details.insert(
            AcceleratorId::Cuda,
            AcceleratorAvailability {
                available: true,
                unavailable_reason: None,
            },
        );

        let available_accelerators: Vec<AcceleratorId> = accelerator_details
            .iter()
            .filter_map(|(id, details)| details.available.then_some(*id))
            .collect();

        let capabilities = RuntimeCapabilities {
            available_accelerators,
            accelerator_details,
            supported_model_formats: vec![ModelFormat::Ggml, ModelFormat::Gguf],
        };

        Self { capabilities }
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
