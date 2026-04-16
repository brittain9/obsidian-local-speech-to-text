use std::fmt;

use ndarray::{Array0, Array3};
use ort::session::Session;
use ort::value::TensorRef;

use crate::session::{VoiceActivityDetector, VoiceActivityError};

const SILERO_CONTEXT_SAMPLES: usize = 64;
const SILERO_INPUT_SAMPLES: usize = SILERO_CONTEXT_SAMPLES + SILERO_WINDOW_SAMPLES;
const SILERO_SAMPLE_RATE: i64 = 16_000;
const SILERO_WINDOW_SAMPLES: usize = 512;
const MODEL_BYTES: &[u8] = include_bytes!("../models/silero_vad.onnx");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SileroVadLoadError(String);

impl fmt::Display for SileroVadLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct SileroVadDetector {
    context: Vec<f32>,
    input_scratch: Vec<f32>,
    last_probability: f32,
    sample_buffer: Vec<f32>,
    session: Session,
    sr: Array0<i64>,
    state: Array3<f32>,
}

impl SileroVadDetector {
    pub fn new() -> Result<Self, SileroVadLoadError> {
        let session = Session::builder()
            .map_err(|e| SileroVadLoadError(format!("failed to create ONNX session builder: {e}")))?
            .commit_from_memory(MODEL_BYTES)
            .map_err(|e| SileroVadLoadError(format!("failed to load Silero VAD model: {e}")))?;

        Ok(Self {
            context: vec![0.0; SILERO_CONTEXT_SAMPLES],
            input_scratch: vec![0.0; SILERO_INPUT_SAMPLES],
            last_probability: 0.0,
            sample_buffer: Vec::with_capacity(SILERO_WINDOW_SAMPLES * 2),
            session,
            sr: Array0::from_elem((), SILERO_SAMPLE_RATE),
            state: Array3::<f32>::zeros((2, 1, 128)),
        })
    }

    fn run_inference(&mut self) -> Result<f32, VoiceActivityError> {
        let window = &self.sample_buffer[..SILERO_WINDOW_SAMPLES];
        self.input_scratch[..SILERO_CONTEXT_SAMPLES].copy_from_slice(&self.context);
        self.input_scratch[SILERO_CONTEXT_SAMPLES..].copy_from_slice(window);
        self.context
            .copy_from_slice(&window[SILERO_WINDOW_SAMPLES - SILERO_CONTEXT_SAMPLES..]);

        let input = TensorRef::from_array_view((
            [1_i64, SILERO_INPUT_SAMPLES as i64],
            &self.input_scratch[..],
        ))
        .map_err(|_| VoiceActivityError)?;
        let state =
            TensorRef::from_array_view(self.state.view()).map_err(|_| VoiceActivityError)?;
        let sr = TensorRef::from_array_view(self.sr.view()).map_err(|_| VoiceActivityError)?;

        let outputs = self
            .session
            .run(ort::inputs![
                "input" => input,
                "state" => state,
                "sr" => sr
            ])
            .map_err(|_| VoiceActivityError)?;

        let (_, prob_data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|_| VoiceActivityError)?;
        let probability = prob_data.first().copied().ok_or(VoiceActivityError)?;

        let (_, state_data) = outputs[1]
            .try_extract_tensor::<f32>()
            .map_err(|_| VoiceActivityError)?;
        let state_slice = self.state.as_slice_mut().ok_or(VoiceActivityError)?;
        if state_data.len() != state_slice.len() {
            return Err(VoiceActivityError);
        }
        state_slice.copy_from_slice(state_data);
        drop(outputs);

        self.sample_buffer.drain(..SILERO_WINDOW_SAMPLES);

        Ok(probability)
    }
}

impl VoiceActivityDetector for SileroVadDetector {
    fn speech_probability(&mut self, frame: &[i16]) -> Result<f32, VoiceActivityError> {
        self.sample_buffer
            .extend(frame.iter().map(|&sample| sample as f32 / 32768.0));

        while self.sample_buffer.len() >= SILERO_WINDOW_SAMPLES {
            self.last_probability = self.run_inference()?;
        }

        Ok(self.last_probability)
    }

    fn reset(&mut self) {
        self.context.fill(0.0);
        self.last_probability = 0.0;
        self.sample_buffer.clear();
        self.state.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    use super::*;

    const MODEL_PROVENANCE_JSON: &str = include_str!("../models/silero_vad.provenance.json");

    #[derive(Debug, Deserialize)]
    struct SileroVadProvenance {
        artifact: ArtifactProvenance,
        source: SourceProvenance,
    }

    #[derive(Debug, Deserialize)]
    struct ArtifactProvenance {
        artifact_path_in_package: String,
        filename: String,
        sha256: String,
        size_bytes: usize,
    }

    #[derive(Debug, Deserialize)]
    struct SourceProvenance {
        package_filename: String,
        package_registry_url: String,
        package_sha256: String,
        package_version: String,
    }

    #[test]
    fn bundled_model_matches_provenance_manifest() {
        let manifest: SileroVadProvenance =
            serde_json::from_str(MODEL_PROVENANCE_JSON).expect("manifest should parse");
        let digest = Sha256::digest(MODEL_BYTES);
        let digest_hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        assert_eq!(manifest.artifact.filename, "silero_vad.onnx");
        assert_eq!(
            manifest.artifact.artifact_path_in_package,
            "silero_vad/data/silero_vad.onnx"
        );
        assert_eq!(manifest.artifact.size_bytes, MODEL_BYTES.len());
        assert_eq!(manifest.artifact.sha256, digest_hex);
        assert_eq!(manifest.source.package_version, "6.2.1");
        assert_eq!(
            manifest.source.package_filename,
            "silero_vad-6.2.1-py3-none-any.whl"
        );
        assert_eq!(
            manifest.source.package_sha256,
            "09de93c4d874bb19c53e62a47dd38be5f163cedad2b5599583231f2a84ef79cb"
        );
        assert_eq!(
            manifest.source.package_registry_url,
            "https://pypi.org/project/silero-vad/6.2.1/"
        );
    }

    #[test]
    fn silence_produces_low_probability() {
        let mut detector = SileroVadDetector::new().expect("model should load");
        let silence_frame = vec![0_i16; 320];

        let mut probability = 0.0;
        for _ in 0..6 {
            probability = detector
                .speech_probability(&silence_frame)
                .expect("inference should succeed");
        }

        assert!(
            probability < 0.2,
            "silence must score well below the speech threshold, got {probability}"
        );
    }

    #[test]
    fn reset_clears_state() {
        let mut detector = SileroVadDetector::new().expect("model should load");
        let frame = vec![0_i16; 320];

        let _ = detector.speech_probability(&frame);
        let _ = detector.speech_probability(&frame);

        detector.reset();
        assert_eq!(detector.last_probability, 0.0);
        assert_eq!(detector.context, vec![0.0; SILERO_CONTEXT_SAMPLES]);
        assert!(detector.sample_buffer.is_empty());
    }

    #[test]
    fn reset_restores_deterministic_probabilities_for_the_same_audio() {
        let mut detector = SileroVadDetector::new().expect("model should load");

        let mut speech = Vec::with_capacity(320);
        for i in 0..320 {
            let sample = if (i / 8) % 2 == 0 {
                20_000_i16
            } else {
                -20_000
            };
            speech.push(sample);
        }

        let mut first_run_probability = 0.0;
        for _ in 0..4 {
            first_run_probability = detector
                .speech_probability(&speech)
                .expect("inference should succeed");
        }

        detector.reset();

        let mut second_run_probability = 0.0;
        for _ in 0..4 {
            second_run_probability = detector
                .speech_probability(&speech)
                .expect("inference should succeed");
        }

        assert!(
            (0.0..=1.0).contains(&first_run_probability),
            "probability should be in [0, 1], got {first_run_probability}"
        );
        assert!(
            (first_run_probability - second_run_probability).abs() < f32::EPSILON,
            "reset should restore deterministic state ({first_run_probability} vs {second_run_probability})"
        );
    }
}
