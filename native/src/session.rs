use std::collections::VecDeque;
use std::path::PathBuf;

use webrtc_vad::{SampleRate, Vad, VadMode};

use crate::protocol::{
    ListeningMode, PCM_BYTES_PER_FRAME, PCM_FRAME_DURATION_MS, PCM_SAMPLES_PER_FRAME,
    SessionStopReason,
};

const PRE_ROLL_FRAMES: usize = 10;
const SPEECH_START_THRESHOLD_FRAMES: usize = 10;
const SPEECH_END_THRESHOLD_FRAMES: usize = 75;
const SPEECH_PAUSE_THRESHOLD_FRAMES: usize = 25;
const SILENCE_GAP_MIN_FRAMES: usize = 5;
const ADAPTIVE_PATIENCE_CAP_FRAMES: usize = 25;
const BOUNDARY_STALENESS_CAP_FRAMES: usize = 250;
const FRAMES_PER_SECOND: usize = 1_000 / PCM_FRAME_DURATION_MS;
const ONE_SENTENCE_TIMEOUT_FRAMES: usize = 500;
const MAX_UTTERANCE_FRAMES: usize = 1_500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionConfig {
    pub language: String,
    pub mode: ListeningMode,
    pub model_file_path: PathBuf,
    pub pause_while_processing: bool,
    pub session_id: String,
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

pub trait VoiceActivityDetector {
    fn is_voice_segment(&mut self, frame: &[i16]) -> Result<bool, VoiceActivityError>;
}

pub struct WebRtcVadDetector {
    vad: Vad,
}

pub struct ListeningSession<TVad: VoiceActivityDetector = WebRtcVadDetector> {
    config: SessionConfig,
    elapsed_frames: usize,
    last_silence_boundary: Option<usize>,
    pre_roll_frames: VecDeque<Vec<i16>>,
    speech_started: bool,
    trailing_silence_frames: usize,
    utterance_frames: Vec<Vec<i16>>,
    vad: TVad,
    voiced_run_frames: usize,
}

impl ListeningSession<WebRtcVadDetector> {
    pub fn new(config: SessionConfig) -> Self {
        Self::with_vad(config, WebRtcVadDetector::default())
    }
}

impl<TVad: VoiceActivityDetector> ListeningSession<TVad> {
    pub fn with_vad(config: SessionConfig, vad: TVad) -> Self {
        Self {
            config,
            elapsed_frames: 0,
            last_silence_boundary: None,
            pre_roll_frames: VecDeque::with_capacity(PRE_ROLL_FRAMES),
            speech_started: false,
            trailing_silence_frames: 0,
            utterance_frames: Vec::new(),
            vad,
            voiced_run_frames: 0,
        }
    }

    pub fn base_state(&self) -> SessionBaseState {
        if self.speech_started {
            if self.trailing_silence_frames >= SPEECH_PAUSE_THRESHOLD_FRAMES {
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
        self.last_silence_boundary = None;
        self.pre_roll_frames.clear();
        self.speech_started = false;
        self.trailing_silence_frames = 0;
        self.utterance_frames.clear();
        self.voiced_run_frames = 0;
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
        let is_voiced = self
            .vad
            .is_voice_segment(&frame)
            .map_err(|_| SessionError {
                code: "invalid_audio_frame",
                details: Some(format!(
                    "webrtc-vad rejected a frame with {} samples",
                    frame.len()
                )),
                message: "Audio frame size does not match a valid VAD frame length.",
            })?;

        self.elapsed_frames += 1;
        self.push_pre_roll_frame(frame.clone());

        if !self.speech_started {
            if is_voiced {
                self.voiced_run_frames += 1;
            } else {
                self.voiced_run_frames = 0;
            }

            if self.voiced_run_frames >= SPEECH_START_THRESHOLD_FRAMES {
                self.speech_started = true;
                self.trailing_silence_frames = 0;
                self.utterance_frames.extend(self.pre_roll_frames.drain(..));
            }
        } else {
            self.utterance_frames.push(frame);

            if is_voiced {
                self.trailing_silence_frames = 0;
            } else {
                self.trailing_silence_frames += 1;
            }

            if self.trailing_silence_frames >= SILENCE_GAP_MIN_FRAMES {
                self.last_silence_boundary = Some(self.utterance_frames.len());
            }

            if self.utterance_frames.len() >= MAX_UTTERANCE_FRAMES {
                return Ok(self.split_at_boundary());
            }

            if self.trailing_silence_frames >= self.effective_end_threshold() {
                return Ok(self.finalize_and_continue());
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

    fn effective_end_threshold(&self) -> usize {
        let speech_seconds = self.utterance_frames.len() / FRAMES_PER_SECOND;
        let bonus = speech_seconds.min(ADAPTIVE_PATIENCE_CAP_FRAMES);
        SPEECH_END_THRESHOLD_FRAMES + bonus
    }

    fn split_at_boundary(&mut self) -> Vec<SessionAction> {
        let len = self.utterance_frames.len();
        let usable_boundary = self
            .last_silence_boundary
            .filter(|&idx| len - idx < BOUNDARY_STALENESS_CAP_FRAMES);

        let Some(idx) = usable_boundary else {
            return self.finalize_and_continue();
        };

        if idx == 0 {
            return self.finalize_and_continue();
        }

        let finalized = flatten_frames(&self.utterance_frames[..idx]);

        // Drain the prefix, leaving carry-forward frames in place
        self.utterance_frames.drain(..idx);
        self.trailing_silence_frames = 0;
        self.voiced_run_frames = 0;
        self.last_silence_boundary = None;

        vec![SessionAction::FinalizeUtterance(finalized)]
    }

    fn finalize_and_continue(&mut self) -> Vec<SessionAction> {
        let finalized = self.maybe_finalize_utterance();
        self.clear_activity();

        finalized
            .map(SessionAction::FinalizeUtterance)
            .into_iter()
            .collect()
    }

    pub fn maybe_finalize_utterance(&mut self) -> Option<FinalizedUtterance> {
        if !self.speech_started || self.utterance_frames.is_empty() {
            return None;
        }

        let frames_to_trim = self
            .trailing_silence_frames
            .min(self.utterance_frames.len().saturating_sub(1));
        let retained_frames = self.utterance_frames.len().saturating_sub(frames_to_trim);

        if retained_frames == 0 {
            return None;
        }

        Some(flatten_frames(&self.utterance_frames[..retained_frames]))
    }

    fn push_pre_roll_frame(&mut self, frame: Vec<i16>) {
        if self.speech_started {
            return;
        }

        if self.pre_roll_frames.len() == PRE_ROLL_FRAMES {
            self.pre_roll_frames.pop_front();
        }

        self.pre_roll_frames.push_back(frame);
    }
}

impl Default for WebRtcVadDetector {
    fn default() -> Self {
        Self {
            vad: Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, VadMode::Aggressive),
        }
    }
}

impl VoiceActivityDetector for WebRtcVadDetector {
    fn is_voice_segment(&mut self, frame: &[i16]) -> Result<bool, VoiceActivityError> {
        self.vad
            .is_voice_segment(frame)
            .map_err(|_| VoiceActivityError)
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
    use std::path::PathBuf;

    use super::{
        ListeningSession, SessionAction, SessionBaseState, SessionConfig, SessionStopReason,
        VoiceActivityDetector,
    };
    use crate::protocol::{
        ListeningMode, PCM_BYTES_PER_FRAME, PCM_FRAME_DURATION_MS, PCM_SAMPLES_PER_FRAME,
    };

    #[derive(Debug)]
    struct FakeVad {
        decisions: VecDeque<bool>,
    }

    impl FakeVad {
        fn with_decisions(decisions: impl IntoIterator<Item = bool>) -> Self {
            Self {
                decisions: decisions.into_iter().collect(),
            }
        }
    }

    impl VoiceActivityDetector for FakeVad {
        fn is_voice_segment(&mut self, _frame: &[i16]) -> Result<bool, super::VoiceActivityError> {
            Ok(self.decisions.pop_front().unwrap_or(false))
        }
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
    fn finalizes_single_utterance_after_trailing_silence() {
        // 10 voiced + N silence: utterance_frames = 10+N, speech_seconds = (10+N)/50.
        // At N=76: speech_seconds=1, threshold=76, 76>=76 → finalize.
        let decisions = std::iter::repeat_n(true, 10).chain(std::iter::repeat_n(false, 76));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;

        for _ in 0..86 {
            let actions = session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");

            if let Some(SessionAction::FinalizeUtterance(utterance)) = actions.into_iter().next() {
                finalized = Some(utterance);
                break;
            }
        }

        let finalized = finalized.expect("utterance should finalize");

        assert_eq!(finalized.duration_ms, 10 * PCM_FRAME_DURATION_MS as u64);
        assert_eq!(finalized.samples.len(), 10 * PCM_SAMPLES_PER_FRAME);
        assert_eq!(session.base_state(), SessionBaseState::Listening);
    }

    #[test]
    fn one_sentence_mode_times_out_without_speech() {
        let decisions = std::iter::repeat_n(false, 500);
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
        // Each utterance: 10 voiced + 76 silence → finalize (see threshold reasoning above).
        let decisions = std::iter::repeat_n(true, 10)
            .chain(std::iter::repeat_n(false, 76))
            .chain(std::iter::repeat_n(true, 10))
            .chain(std::iter::repeat_n(false, 76));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized_count = 0;

        for _ in 0..172 {
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
    fn adaptive_threshold_increases_with_speech_duration() {
        // 250 voiced + N silence: utterance_frames = 250+N, speech_seconds = (250+N)/50.
        // At N=81: speech_seconds=6, threshold=81, 81>=81 → finalize.
        let decisions = std::iter::repeat_n(true, 250).chain(std::iter::repeat_n(false, 81));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));
        let mut finalized = None;
        let mut finalized_at_frame = 0;

        for i in 0..331 {
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
        // Finalized after 250 voiced + 81 silence = frame 331
        assert_eq!(finalized_at_frame, 331);
        assert_eq!(finalized.duration_ms, 250 * PCM_FRAME_DURATION_MS as u64);
    }

    #[test]
    fn speech_paused_state_during_brief_silence() {
        // 10 voiced frames to start speech, then 25 silence frames → SpeechPaused
        let decisions = std::iter::repeat_n(true, 10).chain(std::iter::repeat_n(false, 25));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..35 {
            session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");
        }

        assert_eq!(session.base_state(), SessionBaseState::SpeechPaused);
    }

    #[test]
    fn speech_detected_before_pause_threshold() {
        // 10 voiced + 24 silence → still SpeechDetected (under SPEECH_PAUSE_THRESHOLD_FRAMES)
        let decisions = std::iter::repeat_n(true, 10).chain(std::iter::repeat_n(false, 24));
        let mut session =
            create_session(ListeningMode::AlwaysOn, FakeVad::with_decisions(decisions));

        for _ in 0..34 {
            session
                .ingest_audio_frame(&speech_frame_bytes())
                .expect("frame should succeed");
        }

        assert_eq!(session.base_state(), SessionBaseState::SpeechDetected);
    }

    #[test]
    fn boundary_aware_split_carries_forward_at_cap() {
        // Fill to just under cap with speech, insert a silence gap, then more speech to hit cap.
        // Expect split at the silence boundary with carry-forward.
        let gap_start = 1400;
        let gap_len = 10; // > SILENCE_GAP_MIN_FRAMES
        let after_gap = super::MAX_UTTERANCE_FRAMES - gap_start - gap_len;

        let decisions = std::iter::repeat_n(true, 10) // trigger speech start
            .chain(std::iter::repeat_n(true, gap_start - 10)) // speech up to gap
            .chain(std::iter::repeat_n(false, gap_len)) // silence gap
            .chain(std::iter::repeat_n(true, after_gap)); // speech to fill cap
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
        // Split at boundary = frame index where silence gap ended (gap_start + gap_len)
        let expected_boundary = gap_start + gap_len;
        assert_eq!(
            first_duration_ms,
            (expected_boundary * PCM_FRAME_DURATION_MS) as u64
        );
        // Session still has carry-forward frames and speech is still active
        assert!(session.speech_started);
    }

    #[test]
    fn hard_cut_fallback_when_no_boundary() {
        // All voiced frames up to cap — no silence gap recorded, so falls back to hard cut
        let decisions = std::iter::repeat_n(true, super::MAX_UTTERANCE_FRAMES);
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
        // Hard cut resets everything
        assert_eq!(session.base_state(), SessionBaseState::Listening);
    }

    fn create_session<TVad: VoiceActivityDetector>(
        mode: ListeningMode,
        vad: TVad,
    ) -> ListeningSession<TVad> {
        ListeningSession::with_vad(
            SessionConfig {
                language: "en".to_string(),
                mode,
                model_file_path: PathBuf::from("/tmp/model.bin"),
                pause_while_processing: true,
                session_id: "session-1".to_string(),
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
