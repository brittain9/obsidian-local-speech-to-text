use serde::{Deserialize, Serialize};

use crate::protocol::PCM_FRAME_DURATION_MS;

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

/// Fixed threshold used to compute `voiced_ms` / `unvoiced_ms` and the
/// `speech_start_ms` / `speech_end_ms` bounds on `VoiceActivityEvidence`.
/// Holding this constant across sessions keeps voiced ratios comparable even
/// when `SpeakingStyle` changes the per-session VAD threshold.
pub const VOICED_THRESHOLD: f32 = 0.35;

/// Returns the fraction of the requested utterance-local window whose VAD
/// probability meets `threshold`. Coordinates are utterance-local
/// milliseconds; both Whisper and Cohere segment timestamps are already in
/// this frame, so callers do not need to subtract an audio offset.
pub fn voiced_fraction(
    probabilities: &[f32],
    range_start_ms: u64,
    range_end_ms: u64,
    threshold: f32,
) -> f32 {
    if probabilities.is_empty() || range_end_ms <= range_start_ms {
        return 0.0;
    }

    let frame_ms = PCM_FRAME_DURATION_MS as u64;
    let start_frame = (range_start_ms / frame_ms) as usize;
    let end_frame = range_end_ms.div_ceil(frame_ms) as usize;
    let start = start_frame.min(probabilities.len());
    let end = end_frame.min(probabilities.len());

    if end <= start {
        return 0.0;
    }

    let window = &probabilities[start..end];
    let voiced = window.iter().filter(|p| **p >= threshold).count();
    voiced as f32 / window.len() as f32
}

#[cfg(test)]
mod tests {
    use super::{VOICED_THRESHOLD, voiced_fraction};
    use crate::protocol::PCM_FRAME_DURATION_MS;

    fn frame_ms(frames: u64) -> u64 {
        frames * PCM_FRAME_DURATION_MS as u64
    }

    #[test]
    fn voiced_fraction_returns_zero_on_empty_trace() {
        assert_eq!(voiced_fraction(&[], 0, 1_000, VOICED_THRESHOLD), 0.0);
    }

    #[test]
    fn voiced_fraction_returns_zero_on_zero_length_range() {
        let trace = [1.0_f32; 10];
        assert_eq!(voiced_fraction(&trace, 100, 100, VOICED_THRESHOLD), 0.0);
    }

    #[test]
    fn voiced_fraction_returns_zero_when_range_is_after_trace() {
        let trace = [1.0_f32; 5];
        assert_eq!(
            voiced_fraction(&trace, frame_ms(10), frame_ms(20), VOICED_THRESHOLD),
            0.0
        );
    }

    #[test]
    fn voiced_fraction_counts_in_range_voiced_frames() {
        // 10 frames: first 4 voiced, last 6 silent.
        let mut trace = vec![0.9_f32; 4];
        trace.extend(std::iter::repeat_n(0.1_f32, 6));
        assert_eq!(
            voiced_fraction(&trace, 0, frame_ms(10), VOICED_THRESHOLD),
            0.4
        );
    }

    #[test]
    fn voiced_fraction_handles_partial_overlap_past_trace_end() {
        let trace = [0.9_f32; 5];
        // Asking for 0..200 ms but trace only covers first 100 ms (5 frames).
        assert_eq!(
            voiced_fraction(&trace, 0, frame_ms(10), VOICED_THRESHOLD),
            1.0
        );
    }

    #[test]
    fn voiced_fraction_clamps_start_to_trace_length() {
        let trace = [0.9_f32; 5];
        // Range starts past trace end.
        assert_eq!(
            voiced_fraction(&trace, frame_ms(6), frame_ms(8), VOICED_THRESHOLD),
            0.0
        );
    }

    #[test]
    fn voiced_fraction_threshold_is_inclusive_at_boundary() {
        let trace = [VOICED_THRESHOLD; 4];
        assert_eq!(
            voiced_fraction(&trace, 0, frame_ms(4), VOICED_THRESHOLD),
            1.0
        );
    }

    #[test]
    fn voiced_fraction_returns_zero_for_all_silent_trace() {
        let trace = [0.0_f32; 8];
        assert_eq!(
            voiced_fraction(&trace, 0, frame_ms(8), VOICED_THRESHOLD),
            0.0
        );
    }

    #[test]
    fn voiced_fraction_returns_one_for_all_voiced_trace() {
        let trace = [1.0_f32; 8];
        assert_eq!(
            voiced_fraction(&trace, 0, frame_ms(8), VOICED_THRESHOLD),
            1.0
        );
    }

    #[test]
    fn voiced_fraction_picks_up_partial_frame_via_div_ceil() {
        // Trace: frames 0..4 voiced, 4..8 silent.
        let mut trace = vec![1.0_f32; 4];
        trace.extend(std::iter::repeat_n(0.0_f32, 4));
        // 0..70 ms covers frames 0..3 fully and the first 10 ms of frame 3.
        // div_ceil rounds end up to frame index 4, so window is frames 0..4.
        assert_eq!(voiced_fraction(&trace, 0, 70, VOICED_THRESHOLD), 1.0);
    }
}
