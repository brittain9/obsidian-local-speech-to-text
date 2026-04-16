use std::collections::VecDeque;

use crate::protocol::{
    ListeningMode, PCM_BYTES_PER_FRAME, PCM_FRAME_DURATION_MS, PCM_SAMPLES_PER_FRAME,
    SessionStopReason,
};
use crate::vad::{SileroVadDetector, SileroVadLoadError};

const BOUNDARY_STALENESS_CAP_FRAMES: usize = 250;
const NEGATIVE_THRESHOLD_DELTA: f32 = 0.15;
const ONE_SENTENCE_TIMEOUT_FRAMES: usize = 500;
const POST_SPEECH_PAD_FRAMES: usize = 2;
const PRE_SPEECH_PAD_FRAMES: usize = 2;
const SILENCE_END_THRESHOLD_FRAMES: usize = 5;
const SPEECH_PAUSE_THRESHOLD_FRAMES: usize = 25;
const SILENCE_GAP_MIN_FRAMES: usize = 5;
const MAX_UTTERANCE_FRAMES: usize = 1_500;

#[derive(Debug, Clone, PartialEq)]
pub struct SessionConfig {
    pub mode: ListeningMode,
    pub session_id: String,
    pub speech_threshold: f32,
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
    SpeechPaused,
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
    elapsed_frames: usize,
    frames_since_confident_speech: usize,
    last_silence_boundary: Option<usize>,
    pending_end_start: Option<usize>,
    pre_speech_frames: VecDeque<Vec<i16>>,
    speech_started: bool,
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
        Self {
            config,
            elapsed_frames: 0,
            frames_since_confident_speech: 0,
            last_silence_boundary: None,
            pending_end_start: None,
            pre_speech_frames: VecDeque::with_capacity(PRE_SPEECH_PAD_FRAMES),
            speech_started: false,
            utterance_frames: Vec::new(),
            vad,
        }
    }

    pub fn base_state(&self) -> SessionBaseState {
        if self.speech_started {
            if self.frames_since_confident_speech >= SPEECH_PAUSE_THRESHOLD_FRAMES {
                SessionBaseState::SpeechPaused
            } else {
                SessionBaseState::SpeechDetected
            }
        } else {
            SessionBaseState::Listening
        }
    }

    pub fn clear_activity(&mut self) {
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
            if probability >= self.config.speech_threshold {
                self.speech_started = true;
                self.frames_since_confident_speech = 0;
                self.pending_end_start = None;
                self.utterance_frames
                    .extend(self.pre_speech_frames.drain(..));
                self.utterance_frames.push(frame);
            } else {
                self.push_pre_speech_frame(frame);
            }
        } else {
            self.utterance_frames.push(frame);

            if probability >= self.config.speech_threshold {
                self.frames_since_confident_speech = 0;
                self.pending_end_start = None;
            } else {
                self.frames_since_confident_speech += 1;

                if probability < self.negative_threshold() && self.pending_end_start.is_none() {
                    self.pending_end_start = Some(self.utterance_frames.len() - 1);
                }
            }

            if self.frames_since_confident_speech >= SILENCE_GAP_MIN_FRAMES {
                self.last_silence_boundary = Some(self.utterance_frames.len());
            }

            if let Some(pending_end_start) = self.pending_end_start
                && self.utterance_frames.len() - pending_end_start >= SILENCE_END_THRESHOLD_FRAMES
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

    fn negative_threshold(&self) -> f32 {
        (self.config.speech_threshold - NEGATIVE_THRESHOLD_DELTA).max(0.0)
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
            .map(|idx| (idx + POST_SPEECH_PAD_FRAMES).min(self.utterance_frames.len()))
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

        if self.pre_speech_frames.len() == PRE_SPEECH_PAD_FRAMES {
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
        VoiceActivityDetector,
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
    fn finalizes_after_five_frames_below_negative_threshold() {
        let decisions = std::iter::repeat_n(1.0_f32, 3).chain(std::iter::repeat_n(0.0_f32, 5));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..8 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize");

        assert_eq!(finalized.duration_ms, 5 * PCM_FRAME_DURATION_MS as u64);
        assert_eq!(finalized.samples.len(), 5 * PCM_SAMPLES_PER_FRAME);
        assert_eq!(session.base_state(), SessionBaseState::Listening);
    }

    #[test]
    fn start_and_end_apply_two_frames_of_padding_when_available() {
        let decisions = std::iter::repeat_n(0.0_f32, 2)
            .chain(std::iter::repeat_n(1.0_f32, 2))
            .chain(std::iter::repeat_n(0.0_f32, 5));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..9 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize");
        assert_eq!(finalized.duration_ms, 6 * PCM_FRAME_DURATION_MS as u64);
        assert_eq!(finalized.samples.len(), 6 * PCM_SAMPLES_PER_FRAME);
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
        let decisions = std::iter::repeat_n(1.0_f32, 3)
            .chain(std::iter::repeat_n(0.0_f32, 5))
            .chain(std::iter::repeat_n(1.0_f32, 3))
            .chain(std::iter::repeat_n(0.0_f32, 5));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized_count = 0;

        for _ in 0..16 {
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
        let decisions = std::iter::repeat_n(1.0_f32, 3)
            .chain([0.0_f32])
            .chain(std::iter::repeat_n(0.4_f32, 4));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;
        let mut finalized_at_frame = 0;

        for i in 0..8 {
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
        assert_eq!(finalized_at_frame, 8);
        assert_eq!(finalized.duration_ms, 5 * PCM_FRAME_DURATION_MS as u64);
    }

    #[test]
    fn strong_speech_resets_a_pending_end() {
        let decisions = std::iter::repeat_n(1.0_f32, 3)
            .chain([0.0_f32, 1.0_f32])
            .chain(std::iter::repeat_n(0.0_f32, 5));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized_at_frame = None;

        for i in 0..10 {
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

        assert_eq!(finalized_at_frame, Some(10));
    }

    #[test]
    fn speech_paused_state_during_brief_silence() {
        let decisions = std::iter::repeat_n(1.0_f32, 3).chain(std::iter::repeat_n(0.4_f32, 25));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..28 {
            session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");
        }

        assert_eq!(session.base_state(), SessionBaseState::SpeechPaused);
    }

    #[test]
    fn speech_detected_before_pause_threshold() {
        let decisions = std::iter::repeat_n(1.0_f32, 3).chain(std::iter::repeat_n(0.4_f32, 24));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..27 {
            session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");
        }

        assert_eq!(session.base_state(), SessionBaseState::SpeechDetected);
    }

    #[test]
    fn boundary_aware_split_carries_forward_at_cap() {
        let gap_start = 1400;
        let gap_len = 10;
        let after_gap = super::MAX_UTTERANCE_FRAMES - gap_start - gap_len;

        let decisions = std::iter::repeat_n(1.0_f32, 10)
            .chain(std::iter::repeat_n(1.0_f32, gap_start - 10))
            .chain(std::iter::repeat_n(0.4_f32, gap_len))
            .chain(std::iter::repeat_n(1.0_f32, after_gap));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        let mut finalized_count = 0;
        let mut first_duration_ms = 0;

        for _ in 0..super::MAX_UTTERANCE_FRAMES {
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
        let expected_boundary = gap_start + gap_len;
        assert_eq!(
            first_duration_ms,
            (expected_boundary * PCM_FRAME_DURATION_MS) as u64
        );
        assert!(session.speech_started);
    }

    #[test]
    fn hard_cut_fallback_when_no_boundary() {
        let decisions = std::iter::repeat_n(1.0_f32, super::MAX_UTTERANCE_FRAMES);
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..super::MAX_UTTERANCE_FRAMES {
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

    fn create_session<TVad: VoiceActivityDetector>(
        mode: ListeningMode,
        vad: TVad,
    ) -> ListeningSession<TVad> {
        ListeningSession::with_vad(
            SessionConfig {
                mode,
                session_id: "session-1".to_string(),
                speech_threshold: 0.5,
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
