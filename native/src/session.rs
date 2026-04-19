use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::protocol::{
    ListeningMode, PCM_BYTES_PER_FRAME, PCM_FRAME_DURATION_MS, PCM_SAMPLES_PER_FRAME,
    SessionStopReason,
};
use crate::vad::{SileroVadDetector, SileroVadLoadError};

const BOUNDARY_STALENESS_CAP_FRAMES: usize = 250;
const MAX_UTTERANCE_FRAMES: usize = 1_500;
const NEGATIVE_THRESHOLD_DELTA: f32 = 0.15;
const NEGATIVE_THRESHOLD_FLOOR: f32 = 0.05;
const ONE_SENTENCE_TIMEOUT_FRAMES: usize = 500;

const fn derive_negative_threshold(speech_threshold: f32) -> f32 {
    let candidate = speech_threshold - NEGATIVE_THRESHOLD_DELTA;
    if candidate > NEGATIVE_THRESHOLD_FLOOR {
        candidate
    } else {
        NEGATIVE_THRESHOLD_FLOOR
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakingStyle {
    Responsive,
    #[default]
    Balanced,
    Patient,
}

#[derive(Debug, Clone, Copy)]
struct VadTuning {
    speech_threshold: f32,
    negative_threshold: f32,
    silence_end_frames: usize,
    min_speech_frames: usize,
    pre_speech_pad_frames: usize,
    post_speech_pad_frames: usize,
    silence_gap_min_frames: usize,
}

impl VadTuning {
    const fn new(
        speech_threshold: f32,
        silence_end_frames: usize,
        min_speech_frames: usize,
        pre_speech_pad_frames: usize,
        post_speech_pad_frames: usize,
        silence_gap_min_frames: usize,
    ) -> Self {
        Self {
            speech_threshold,
            negative_threshold: derive_negative_threshold(speech_threshold),
            silence_end_frames,
            min_speech_frames,
            pre_speech_pad_frames,
            post_speech_pad_frames,
            silence_gap_min_frames,
        }
    }
}

impl SpeakingStyle {
    fn tuning(self) -> VadTuning {
        match self {
            Self::Responsive => VadTuning::new(0.40, 20, 3, 2, 2, 6),
            Self::Balanced => VadTuning::new(0.50, 50, 5, 2, 2, 16),
            Self::Patient => VadTuning::new(0.55, 100, 6, 2, 2, 33),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionConfig {
    pub mode: ListeningMode,
    pub session_id: String,
    pub style: SpeakingStyle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizedUtterance {
    pub duration_ms: u64,
    pub samples: Vec<i16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionAction {
    FinalizeUtterance(FinalizedUtterance),
    Stop(SessionStopReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionBaseState {
    Listening,
    SpeechDetected,
    SpeechEnding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionError {
    pub code: &'static str,
    pub details: Option<String>,
    pub message: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceActivityError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionInitError {
    VadLoad(String),
}

pub trait VoiceActivityDetector {
    fn speech_probability(&mut self, frame: &[i16]) -> Result<f32, VoiceActivityError>;
    fn reset(&mut self);
}

pub struct ListeningSession<TVad: VoiceActivityDetector = SileroVadDetector> {
    config: SessionConfig,
    consecutive_above_threshold: usize,
    elapsed_frames: usize,
    frames_since_confident_speech: usize,
    last_silence_boundary: Option<usize>,
    pending_end_start: Option<usize>,
    pre_speech_frames: VecDeque<Vec<i16>>,
    speech_started: bool,
    tuning: VadTuning,
    utterance_frames: Vec<Vec<i16>>,
    vad: TVad,
}

impl ListeningSession<SileroVadDetector> {
    pub fn new(config: SessionConfig) -> Result<Self, SessionInitError> {
        let vad = SileroVadDetector::new()
            .map_err(|error: SileroVadLoadError| SessionInitError::VadLoad(error.to_string()))?;
        Ok(Self::with_vad(config, vad))
    }
}

impl<TVad: VoiceActivityDetector> ListeningSession<TVad> {
    pub fn with_vad(config: SessionConfig, vad: TVad) -> Self {
        let tuning = config.style.tuning();
        Self {
            config,
            consecutive_above_threshold: 0,
            elapsed_frames: 0,
            frames_since_confident_speech: 0,
            last_silence_boundary: None,
            pending_end_start: None,
            pre_speech_frames: VecDeque::with_capacity(tuning.pre_speech_pad_frames),
            speech_started: false,
            tuning,
            utterance_frames: Vec::new(),
            vad,
        }
    }

    pub fn base_state(&self) -> SessionBaseState {
        if self.speech_started {
            if self.frames_since_confident_speech >= self.tuning.silence_end_frames {
                SessionBaseState::SpeechEnding
            } else {
                SessionBaseState::SpeechDetected
            }
        } else {
            SessionBaseState::Listening
        }
    }

    pub fn clear_activity(&mut self) {
        self.consecutive_above_threshold = 0;
        self.elapsed_frames = 0;
        self.frames_since_confident_speech = 0;
        self.last_silence_boundary = None;
        self.pending_end_start = None;
        self.pre_speech_frames.clear();
        self.speech_started = false;
        self.utterance_frames.clear();
        self.vad.reset();
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    pub fn ingest_audio_frame(
        &mut self,
        frame_bytes: &[u8],
    ) -> Result<Vec<SessionAction>, SessionError> {
        if frame_bytes.len() != PCM_BYTES_PER_FRAME {
            return Err(SessionError {
                code: "invalid_audio_frame",
                details: Some(format!(
                    "expected {PCM_BYTES_PER_FRAME} bytes, received {}",
                    frame_bytes.len()
                )),
                message: "Audio frame size does not match the configured 20 ms PCM format.",
            });
        }

        let frame = decode_pcm_frame(frame_bytes);
        let probability = self
            .vad
            .speech_probability(&frame)
            .map_err(|_| SessionError {
                code: "vad_error",
                details: Some(format!(
                    "VAD failed to process a frame with {} samples",
                    frame.len()
                )),
                message: "Voice activity detection failed on an audio frame.",
            })?;

        self.elapsed_frames += 1;

        if !self.speech_started {
            if probability >= self.tuning.speech_threshold {
                self.consecutive_above_threshold += 1;
                if self.consecutive_above_threshold >= self.tuning.min_speech_frames {
                    self.speech_started = true;
                    self.consecutive_above_threshold = 0;
                    self.frames_since_confident_speech = 0;
                    self.pending_end_start = None;
                    self.utterance_frames
                        .extend(self.pre_speech_frames.drain(..));
                    self.utterance_frames.push(frame);
                } else {
                    self.push_pre_speech_frame(frame);
                }
            } else {
                self.consecutive_above_threshold = 0;
                self.push_pre_speech_frame(frame);
            }
        } else {
            self.utterance_frames.push(frame);

            if probability >= self.tuning.speech_threshold {
                self.frames_since_confident_speech = 0;
                self.pending_end_start = None;
            } else {
                self.frames_since_confident_speech += 1;

                if probability < self.tuning.negative_threshold && self.pending_end_start.is_none()
                {
                    self.pending_end_start = Some(self.utterance_frames.len() - 1);
                }
            }

            if self.frames_since_confident_speech >= self.tuning.silence_gap_min_frames {
                self.last_silence_boundary = Some(self.utterance_frames.len());
            }

            if let Some(pending_end_start) = self.pending_end_start
                && self.utterance_frames.len() - pending_end_start >= self.tuning.silence_end_frames
            {
                return Ok(self.finalize_and_continue_from(pending_end_start));
            }

            if self.utterance_frames.len() >= MAX_UTTERANCE_FRAMES {
                return Ok(self.split_at_boundary());
            }
        }

        if self.config.mode == ListeningMode::OneSentence
            && !self.speech_started
            && self.elapsed_frames >= ONE_SENTENCE_TIMEOUT_FRAMES
        {
            return Ok(vec![SessionAction::Stop(SessionStopReason::Timeout)]);
        }

        Ok(Vec::new())
    }

    fn split_at_boundary(&mut self) -> Vec<SessionAction> {
        let len = self.utterance_frames.len();
        let usable_boundary = self
            .last_silence_boundary
            .filter(|&idx| len - idx < BOUNDARY_STALENESS_CAP_FRAMES);

        let Some(idx) = usable_boundary.filter(|&idx| idx > 0) else {
            return self.finalize_and_continue_from(len);
        };

        let finalized = flatten_frames(&self.utterance_frames[..idx]);

        self.utterance_frames.drain(..idx);
        if self.utterance_frames.is_empty() {
            self.clear_activity();
        } else {
            self.frames_since_confident_speech = 0;
            self.last_silence_boundary = None;
            self.pending_end_start = None;
        }

        vec![SessionAction::FinalizeUtterance(finalized)]
    }

    fn finalize_and_continue_from(&mut self, pending_end_start: usize) -> Vec<SessionAction> {
        let finalized = self.finalize_utterance_at(Some(pending_end_start));
        self.clear_activity();

        finalized
            .map(SessionAction::FinalizeUtterance)
            .into_iter()
            .collect()
    }

    pub fn maybe_finalize_utterance(&self) -> Option<FinalizedUtterance> {
        self.finalize_utterance_at(self.pending_end_start)
    }

    fn finalize_utterance_at(
        &self,
        pending_end_start: Option<usize>,
    ) -> Option<FinalizedUtterance> {
        if !self.speech_started || self.utterance_frames.is_empty() {
            return None;
        }

        let retained_frames = pending_end_start
            .map(|idx| (idx + self.tuning.post_speech_pad_frames).min(self.utterance_frames.len()))
            .unwrap_or(self.utterance_frames.len());

        if retained_frames == 0 {
            return None;
        }

        Some(flatten_frames(&self.utterance_frames[..retained_frames]))
    }

    fn push_pre_speech_frame(&mut self, frame: Vec<i16>) {
        if self.speech_started {
            return;
        }

        if self.pre_speech_frames.len() == self.tuning.pre_speech_pad_frames {
            self.pre_speech_frames.pop_front();
        }

        self.pre_speech_frames.push_back(frame);
    }
}

fn flatten_frames(frames: &[Vec<i16>]) -> FinalizedUtterance {
    let mut samples = Vec::with_capacity(frames.len() * PCM_SAMPLES_PER_FRAME);
    for frame in frames {
        samples.extend_from_slice(frame);
    }
    FinalizedUtterance {
        duration_ms: (frames.len() * PCM_FRAME_DURATION_MS) as u64,
        samples,
    }
}

fn decode_pcm_frame(frame_bytes: &[u8]) -> Vec<i16> {
    frame_bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::{
        ListeningSession, SessionAction, SessionBaseState, SessionConfig, SessionStopReason,
        SpeakingStyle, VoiceActivityDetector,
    };
    use crate::protocol::{
        ListeningMode, PCM_BYTES_PER_FRAME, PCM_FRAME_DURATION_MS, PCM_SAMPLES_PER_FRAME,
    };

    #[derive(Debug)]
    struct FakeVad {
        decisions: VecDeque<f32>,
    }

    impl FakeVad {
        fn with_decisions(decisions: impl IntoIterator<Item = f32>) -> Self {
            Self {
                decisions: decisions.into_iter().collect(),
            }
        }
    }

    impl VoiceActivityDetector for FakeVad {
        fn speech_probability(&mut self, _frame: &[i16]) -> Result<f32, super::VoiceActivityError> {
            Ok(self.decisions.pop_front().unwrap_or(0.0))
        }

        fn reset(&mut self) {}
    }

    #[test]
    fn rejects_mis_sized_frame() {
        let mut session = create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions([]));
        let error = session
            .ingest_audio_frame(&vec![0_u8; PCM_BYTES_PER_FRAME - 2])
            .expect_err("frame should fail");

        assert_eq!(error.code, "invalid_audio_frame");
    }

    #[test]
    fn finalizes_after_silence_end_frames_below_negative_threshold() {
        // Balanced preset: 5 speech frames trigger speech_started,
        // then 50 silence frames must pass before finalization fires.
        let decisions = std::iter::repeat_n(1.0_f32, 5).chain(std::iter::repeat_n(0.0_f32, 50));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..55 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize");

        // Retained = pending_end_start (3) + post_speech_pad_frames (2) = 5.
        assert_eq!(finalized.duration_ms, 5 * PCM_FRAME_DURATION_MS as u64);
        assert_eq!(finalized.samples.len(), 5 * PCM_SAMPLES_PER_FRAME);
        assert_eq!(session.base_state(), SessionBaseState::Listening);
    }

    #[test]
    fn start_and_end_apply_two_frames_of_padding_when_available() {
        // 2 silence lead-in + 5 speech (min_speech gate) + 50 silence (silence_end gate).
        let decisions = std::iter::repeat_n(0.0_f32, 2)
            .chain(std::iter::repeat_n(1.0_f32, 5))
            .chain(std::iter::repeat_n(0.0_f32, 50));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..57 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize");
        // 2 pre-pad frames + 1 frame that triggered speech + 2 post-pad frames.
        assert_eq!(finalized.duration_ms, 5 * PCM_FRAME_DURATION_MS as u64);
        assert_eq!(finalized.samples.len(), 5 * PCM_SAMPLES_PER_FRAME);
    }

    #[test]
    fn one_sentence_mode_times_out_without_speech() {
        let decisions = std::iter::repeat_n(0.0_f32, 500);
        let mut session = create_session(
            ListeningMode::OneSentence,
            FakeVad::with_decisions(decisions),
        );
        let mut stop_reason = None;

        for _ in 0..500 {
            let actions = session
                .ingest_audio_frame(&silence_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::Stop(reason)) = actions.into_iter().next() {
                stop_reason = Some(reason);
                break;
            }
        }

        assert_eq!(stop_reason, Some(SessionStopReason::Timeout));
    }

    #[test]
    fn can_finalize_two_utterances_separated_by_silence() {
        // Two back-to-back 5-speech / 50-silence cycles under Balanced.
        let decisions = std::iter::repeat_n(1.0_f32, 5)
            .chain(std::iter::repeat_n(0.0_f32, 50))
            .chain(std::iter::repeat_n(1.0_f32, 5))
            .chain(std::iter::repeat_n(0.0_f32, 50));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized_count = 0;

        for _ in 0..110 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            finalized_count += actions
                .into_iter()
                .filter(|action| matches!(action, SessionAction::FinalizeUtterance(_)))
                .count();
        }

        assert_eq!(finalized_count, 2);
    }

    #[test]
    fn intermediate_probabilities_do_not_cancel_a_pending_end() {
        // 5 speech frames, 1 silence frame (arms pending_end_start),
        // then 49 frames at 0.4 (above negative_threshold=0.35 but below
        // speech_threshold=0.5) — intermediate prob must not reset pending_end.
        let decisions = std::iter::repeat_n(1.0_f32, 5)
            .chain([0.0_f32])
            .chain(std::iter::repeat_n(0.4_f32, 49));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;
        let mut finalized_at_frame = 0;

        for i in 0..55 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                finalized_at_frame = i + 1;
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize");
        assert_eq!(finalized_at_frame, 55);
        assert_eq!(finalized.duration_ms, 5 * PCM_FRAME_DURATION_MS as u64);
    }

    #[test]
    fn strong_speech_resets_a_pending_end() {
        // 5 speech frames + 1 silence (arms pending_end) + 1 strong speech (clears it)
        // + 50 silence (fresh silence_end countdown).
        let decisions = std::iter::repeat_n(1.0_f32, 5)
            .chain([0.0_f32, 1.0_f32])
            .chain(std::iter::repeat_n(0.0_f32, 50));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized_at_frame = None;

        for i in 0..57 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if actions
                .into_iter()
                .any(|action| matches!(action, SessionAction::FinalizeUtterance(_)))
            {
                finalized_at_frame = Some(i + 1);
                break;
            }
        }

        assert_eq!(finalized_at_frame, Some(57));
    }

    #[test]
    fn speech_ending_state_during_brief_silence() {
        // 5 speech frames start speech, then 50 frames at 0.4 (below 0.5 threshold but
        // above 0.35 negative_threshold) push frames_since_confident_speech to the
        // silence_end_frames threshold, transitioning to SpeechEnding.
        let decisions = std::iter::repeat_n(1.0_f32, 5).chain(std::iter::repeat_n(0.4_f32, 50));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..55 {
            session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");
        }

        assert_eq!(session.base_state(), SessionBaseState::SpeechEnding);
    }

    #[test]
    fn speech_detected_before_pause_threshold() {
        // 49 quiet-but-not-silent frames keep frames_since_confident_speech just
        // below silence_end_frames, so the state stays in SpeechDetected.
        let decisions = std::iter::repeat_n(1.0_f32, 5).chain(std::iter::repeat_n(0.4_f32, 49));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..54 {
            session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");
        }

        assert_eq!(session.base_state(), SessionBaseState::SpeechDetected);
    }

    #[test]
    fn boundary_aware_split_carries_forward_at_cap() {
        // Balanced preset: the min_speech gate fires on frame 5 with pre-pad 2,
        // so utterance_frames.len() = frame_count - FRAME_OFFSET from that point on.
        const FRAME_OFFSET: usize = 2;
        let gap_start = 1400;
        let gap_len = 20;
        let total_frames = super::MAX_UTTERANCE_FRAMES + FRAME_OFFSET;
        let after_gap = total_frames - gap_start - gap_len;

        let decisions = std::iter::repeat_n(1.0_f32, gap_start)
            .chain(std::iter::repeat_n(0.4_f32, gap_len))
            .chain(std::iter::repeat_n(1.0_f32, after_gap));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        let mut finalized_count = 0;
        let mut first_duration_ms = 0;

        for _ in 0..total_frames {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            for action in actions {
                if let SessionAction::FinalizeUtterance(utterance) = action {
                    finalized_count += 1;
                    if finalized_count == 1 {
                        first_duration_ms = utterance.duration_ms;
                    }
                }
            }
        }

        assert_eq!(finalized_count, 1);
        // last_silence_boundary is updated through the end of the gap to
        // utterance_frames.len() at that moment = (gap_start + gap_len) - FRAME_OFFSET.
        let expected_boundary = gap_start + gap_len - FRAME_OFFSET;
        assert_eq!(
            first_duration_ms,
            (expected_boundary * PCM_FRAME_DURATION_MS) as u64
        );
        assert!(session.speech_started);
    }

    #[test]
    fn hard_cut_fallback_when_no_boundary() {
        const FRAME_OFFSET: usize = 2;
        let total_frames = super::MAX_UTTERANCE_FRAMES + FRAME_OFFSET;
        let decisions = std::iter::repeat_n(1.0_f32, total_frames);
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..total_frames {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize at cap");
        assert_eq!(
            finalized.duration_ms,
            (super::MAX_UTTERANCE_FRAMES * PCM_FRAME_DURATION_MS) as u64
        );
        assert_eq!(session.base_state(), SessionBaseState::Listening);
    }

    #[test]
    fn min_speech_gate_suppresses_brief_spike() {
        // A 2-frame burst of high probability (40 ms) is below the Balanced
        // min_speech_frames=5 gate, so speech must never start and no utterance
        // can be finalized.
        let decisions = std::iter::repeat_n(1.0_f32, 2).chain(std::iter::repeat_n(0.0_f32, 20));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..22 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            assert!(
                actions
                    .iter()
                    .all(|action| !matches!(action, SessionAction::FinalizeUtterance(_))),
                "brief spike must not produce a finalization"
            );
            assert!(
                !session.speech_started,
                "brief spike below min_speech_frames must not start speech"
            );
        }
    }

    fn create_session<TVad: VoiceActivityDetector>(
        mode: ListeningMode,
        vad: TVad,
    ) -> ListeningSession<TVad> {
        ListeningSession::with_vad(
            SessionConfig {
                mode,
                session_id: "session-1".to_string(),
                style: SpeakingStyle::Balanced,
            },
            vad,
        )
    }

    fn silence_frame_bytes() -> Vec<u8> {
        frame_bytes_from_sample(0)
    }

    fn speech_frame_bytes() -> Vec<u8> {
        frame_bytes_from_sample(1)
    }

    fn frame_bytes_from_sample(sample: i16) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(PCM_BYTES_PER_FRAME);

        for _ in 0..PCM_SAMPLES_PER_FRAME {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        bytes
    }
}
