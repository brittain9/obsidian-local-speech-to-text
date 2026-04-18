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

        accelerator_details.insert(AcceleratorId::Cpu, AcceleratorAvailability::available());

        #[cfg(feature = "gpu-metal")]
        accelerator_details.insert(AcceleratorId::Metal, AcceleratorAvailability::available());

        #[cfg(feature = "gpu-cuda")]
        accelerator_details.insert(AcceleratorId::Cuda, AcceleratorAvailability::available());

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
