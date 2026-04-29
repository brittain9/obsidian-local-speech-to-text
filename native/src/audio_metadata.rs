use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceActivityEvidence {
    pub audio_start_ms: u64,
    pub audio_end_ms: u64,
    pub speech_start_ms: u64,
    pub speech_end_ms: u64,
    pub voiced_ms: u64,
    pub unvoiced_ms: u64,
    pub mean_probability: f32,
    pub max_probability: f32,
}

impl VoiceActivityEvidence {
    pub fn duration_ms(&self) -> u64 {
        self.audio_end_ms.saturating_sub(self.audio_start_ms)
    }
}
