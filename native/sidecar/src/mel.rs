//! Mel-spectrogram feature extraction for the Cohere Transcribe ONNX encoder.
//!
//! Implements the `CohereAsrFeatureExtractor` pipeline: dither, preemphasis,
//! STFT, mel filterbank, log, and per-feature normalization.  Parameters are
//! taken from the HuggingFace `preprocessor_config.json`.

use ndarray::{Array2, Array3, Axis};
use realfft::RealFftPlanner;

// Preprocessor config from HuggingFace `preprocessor_config.json`.
const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 512;
const WIN_LENGTH: usize = 400;
const HOP_LENGTH: usize = 160;
const N_MELS: usize = 128;
const PREEMPHASIS_COEFF: f32 = 0.97;
const DITHER_MAGNITUDE: f32 = 1e-5;
const LOG_FLOOR: f32 = 5.960_464_5e-8; // 2^-24, matches official LOG_ZERO_GUARD_VALUE
const NORM_EPSILON: f32 = 1e-5;

/// Number of frequency bins in the one-sided power spectrum: `N_FFT / 2 + 1`.
const N_FREQ_BINS: usize = N_FFT / 2 + 1; // 257

/// Precomputed mel filterbank and FFT planner.  Construct once at model-load
/// time; reuse across all transcription requests.
pub struct MelFeatureExtractor {
    filterbank: Array2<f32>, // [N_FREQ_BINS, N_MELS]
    window: Vec<f32>,        // Hann, length WIN_LENGTH
    fft_planner: RealFftPlanner<f32>,
}

/// Result of feature extraction.
pub struct MelFeatures {
    /// Shape: `[1, time_steps, N_MELS]`.
    pub features: Array3<f32>,
}

impl Default for MelFeatureExtractor {
    fn default() -> Self {
        Self::new()
    }
}

impl MelFeatureExtractor {
    pub fn new() -> Self {
        Self {
            filterbank: build_mel_filterbank(),
            window: build_hann_window(),
            fft_planner: RealFftPlanner::new(),
        }
    }

    /// Extract log-mel spectrogram features from normalised f32 PCM samples
    /// (range `[-1, 1]`, mono, 16 kHz).
    pub fn extract(&mut self, audio: &[f32]) -> MelFeatures {
        let mut signal = audio.to_vec();

        dither(&mut signal);
        let signal = preemphasis(&signal);
        let power = self.stft(&signal);
        let mut mel = power.dot(&self.filterbank); // [frames, N_MELS]
        log_mel(&mut mel);
        normalize_per_feature(&mut mel);

        let frames = mel.nrows();
        let (flat, _offset) = mel.into_raw_vec_and_offset();
        let features =
            Array3::from_shape_vec((1, frames, N_MELS), flat).expect("mel reshape infallible");

        MelFeatures { features }
    }

    /// Short-Time Fourier Transform → power spectrum `[frames, N_FREQ_BINS]`.
    fn stft(&mut self, signal: &[f32]) -> Array2<f32> {
        let n_frames = if signal.len() >= WIN_LENGTH {
            (signal.len() - WIN_LENGTH) / HOP_LENGTH + 1
        } else {
            1
        };

        let r2c = self.fft_planner.plan_fft_forward(N_FFT);
        let mut fft_input = vec![0.0_f32; N_FFT];
        let mut fft_output = r2c.make_output_vec(); // length N_FFT/2 + 1

        let mut power = Array2::<f32>::zeros((n_frames, N_FREQ_BINS));

        for frame_idx in 0..n_frames {
            let start = frame_idx * HOP_LENGTH;

            // Zero the buffer, then copy windowed samples.
            fft_input.iter_mut().for_each(|v| *v = 0.0);
            let copy_len = WIN_LENGTH.min(signal.len().saturating_sub(start));
            for i in 0..copy_len {
                fft_input[i] = signal[start + i] * self.window[i];
            }

            r2c.process(&mut fft_input, &mut fft_output)
                .expect("FFT length matches planned length");

            // Power spectrum: |X[k]|^2
            for (k, c) in fft_output.iter().enumerate() {
                power[[frame_idx, k]] = c.re * c.re + c.im * c.im;
            }
        }

        power
    }
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/// Add small deterministic noise for numerical stability.
fn dither(samples: &mut [f32]) {
    let mut rng = Xorshift64(0x5DEE_CE66_D1A4_F87D);
    for s in samples.iter_mut() {
        *s += rng.next_f32() * DITHER_MAGNITUDE;
    }
}

/// High-pass pre-emphasis filter: `y[n] = x[n] - coeff * x[n-1]`.
/// NeMo convention: `x[-1] = 0`, so `y[0] = x[0]`.
fn preemphasis(samples: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(samples.len());
    for i in 0..samples.len() {
        let prev = if i > 0 { samples[i - 1] } else { 0.0 };
        out.push(samples[i] - PREEMPHASIS_COEFF * prev);
    }
    out
}

/// In-place `ln(max(x, floor))`.
fn log_mel(mel: &mut Array2<f32>) {
    mel.mapv_inplace(|v| v.max(LOG_FLOOR).ln());
}

/// Per-feature (per-column) zero-mean, unit-variance normalisation.
fn normalize_per_feature(features: &mut Array2<f32>) {
    let n = features.nrows() as f32;
    if n < 2.0 {
        return;
    }
    for mut col in features.axis_iter_mut(Axis(1)) {
        let mean = col.sum() / n;
        col.mapv_inplace(|v| v - mean);
        let var = col.iter().map(|&v| v * v).sum::<f32>() / (n - 1.0);
        let std = var.sqrt() + NORM_EPSILON;
        col.mapv_inplace(|v| v / std);
    }
}

// ---------------------------------------------------------------------------
// Mel filterbank construction
// ---------------------------------------------------------------------------

/// Build a `[N_FREQ_BINS, N_MELS]` triangular mel filterbank (Slaney scale).
///
/// Uses Hz-domain comparison (matching librosa/NeMo convention): each FFT bin
/// is mapped to its centre frequency, and triangular weights are computed
/// against the mel filter edge frequencies in Hz.  Applies Slaney normalization
/// (`norm="slaney"` in librosa) so each filter has approximately constant energy.
fn build_mel_filterbank() -> Array2<f32> {
    let fmax = SAMPLE_RATE as f32 / 2.0;
    let mel_min = hz_to_mel(0.0);
    let mel_max = hz_to_mel(fmax);

    // N_MELS + 2 evenly spaced points in mel space → N_MELS triangular filters
    let n_points = N_MELS + 2;
    let mel_points: Vec<f32> = (0..n_points)
        .map(|i| mel_min + (mel_max - mel_min) * i as f32 / (n_points - 1) as f32)
        .collect();
    let hz_edges: Vec<f32> = mel_points.iter().map(|&m| mel_to_hz(m)).collect();

    // Centre frequency of each FFT bin.
    let fft_freqs: Vec<f32> = (0..N_FREQ_BINS)
        .map(|k| k as f32 * fmax / (N_FREQ_BINS - 1) as f32)
        .collect();

    let mut fb = Array2::<f32>::zeros((N_FREQ_BINS, N_MELS));

    for m in 0..N_MELS {
        let left = hz_edges[m];
        let center = hz_edges[m + 1];
        let right = hz_edges[m + 2];

        for k in 0..N_FREQ_BINS {
            let freq = fft_freqs[k];
            if freq >= left && freq <= center && center > left {
                fb[[k, m]] = (freq - left) / (center - left);
            } else if freq > center && freq <= right && right > center {
                fb[[k, m]] = (freq - right) / (center - right);
            }
        }
    }

    // Slaney normalization: divide each filter by its bandwidth in Hz
    // so that each filter has approximately constant energy.
    for m in 0..N_MELS {
        let bandwidth = hz_edges[m + 2] - hz_edges[m];
        if bandwidth > 0.0 {
            let enorm = 2.0 / bandwidth;
            for k in 0..N_FREQ_BINS {
                fb[[k, m]] *= enorm;
            }
        }
    }

    fb
}

/// Symmetric Hann window of length `WIN_LENGTH`
/// (matches `torch.hann_window(periodic=False)`).
fn build_hann_window() -> Vec<f32> {
    (0..WIN_LENGTH)
        .map(|n| {
            let phase = 2.0 * std::f32::consts::PI * n as f32 / (WIN_LENGTH - 1) as f32;
            0.5 * (1.0 - phase.cos())
        })
        .collect()
}

/// Slaney/O'Shaughnessy mel scale (matches `librosa.hz_to_mel(htk=False)`).
/// Linear below 1 kHz (15 mels per 1000 Hz), logarithmic above.
fn hz_to_mel(hz: f32) -> f32 {
    const MIN_LOG_HZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = 15.0; // = 1000 / (200/3)
    const LOGSTEP_INV: f32 = 27.0 / 1.856_297_8; // 27 / ln(6.4)

    if hz < MIN_LOG_HZ {
        3.0 * hz / 200.0
    } else {
        MIN_LOG_MEL + (hz / MIN_LOG_HZ).ln() * LOGSTEP_INV
    }
}

/// Inverse Slaney mel scale (matches `librosa.mel_to_hz(htk=False)`).
fn mel_to_hz(mel: f32) -> f32 {
    const MIN_LOG_MEL: f32 = 15.0;
    const LOGSTEP: f32 = 1.856_297_8 / 27.0; // ln(6.4) / 27

    if mel < MIN_LOG_MEL {
        200.0 * mel / 3.0
    } else {
        1000.0 * (LOGSTEP * (mel - MIN_LOG_MEL)).exp()
    }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (avoids `rand` dependency)
// ---------------------------------------------------------------------------

struct Xorshift64(u64);

impl Xorshift64 {
    /// Returns a value approximately in `[-1, 1]`.
    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        // Map full u64 range to approximately [-1, 1]
        (self.0 as i64 as f64 / i64::MAX as f64) as f32
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hann_window_shape_and_endpoints() {
        let w = build_hann_window();
        assert_eq!(w.len(), WIN_LENGTH);
        // Symmetric Hann: first and last samples are 0
        assert!((w[0]).abs() < 1e-6, "first sample should be ~0");
        assert!(
            (w[WIN_LENGTH - 1]).abs() < 1e-6,
            "last sample should be ~0 for symmetric window"
        );
        // Midpoint should be near 1
        let mid = w[WIN_LENGTH / 2];
        assert!(mid > 0.95, "midpoint should be near 1, got {mid}");
    }

    #[test]
    fn preemphasis_arithmetic() {
        let input = vec![1.0, 1.0, 1.0];
        let out = preemphasis(&input);
        // y[0] = 1.0 - 0.97 * 0.0 = 1.0
        assert!((out[0] - 1.0).abs() < 1e-6);
        // y[1] = 1.0 - 0.97 * 1.0 = 0.03
        assert!((out[1] - 0.03).abs() < 1e-6);
        // y[2] = 1.0 - 0.97 * 1.0 = 0.03
        assert!((out[2] - 0.03).abs() < 1e-6);
    }

    #[test]
    fn mel_filterbank_shape() {
        let fb = build_mel_filterbank();
        assert_eq!(fb.shape(), &[N_FREQ_BINS, N_MELS]);

        // All values non-negative
        assert!(fb.iter().all(|&v| v >= 0.0));

        // The lowest mel bins may be all-zeros when the mel filter triangle
        // falls entirely between FFT frequency bins (standard behaviour with
        // 128 mels and 512-point FFT).  The majority of bins should be active.
        let active_bins = (0..N_MELS)
            .filter(|&col| fb.column(col).sum() > 0.0)
            .count();
        assert!(
            active_bins > N_MELS * 9 / 10,
            "too few active mel bins: {active_bins}/{N_MELS}"
        );
    }

    #[test]
    fn extract_output_shape() {
        let mut extractor = MelFeatureExtractor::new();
        // 1 second of audio at 16 kHz
        let audio = vec![0.1_f32; SAMPLE_RATE];
        let mel = extractor.extract(&audio);

        assert_eq!(mel.features.shape()[0], 1, "batch dim");
        assert_eq!(mel.features.shape()[2], N_MELS, "mel bins");

        // Expected frames: (16000 - 400) / 160 + 1 = 98
        let expected_frames = (SAMPLE_RATE - WIN_LENGTH) / HOP_LENGTH + 1;
        assert_eq!(mel.features.shape()[1], expected_frames, "time steps");
    }

    #[test]
    fn extract_short_audio() {
        let mut extractor = MelFeatureExtractor::new();
        // Very short audio — less than one window
        let audio = vec![0.5_f32; 200];
        let mel = extractor.extract(&audio);

        assert_eq!(mel.features.shape()[0], 1);
        assert_eq!(
            mel.features.shape()[1],
            1,
            "should produce at least 1 frame"
        );
        assert_eq!(mel.features.shape()[2], N_MELS);
    }

    #[test]
    fn normalization_zero_mean() {
        let mut extractor = MelFeatureExtractor::new();
        // Generate a simple signal with some frequency content
        let audio: Vec<f32> = (0..SAMPLE_RATE * 2)
            .map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / SAMPLE_RATE as f32).sin())
            .collect();
        let mel = extractor.extract(&audio);

        // Mel bins with meaningful variance should have approximately zero mean
        // after per-feature normalization.  Bins with near-zero variance (those
        // far from the signal's frequency) produce numerically meaningless
        // normalization in float32 and are skipped.
        let n_frames = mel.features.shape()[1];
        let features_2d = mel
            .features
            .into_shape_with_order((n_frames, N_MELS))
            .unwrap();

        let n = n_frames as f32;
        let mut checked = 0;
        for col_idx in 0..N_MELS {
            let col = features_2d.column(col_idx);
            let col_mean: f32 = col.sum() / n;

            // Skip bins with near-constant pre-normalization values:
            // their normalized mean is dominated by float32 rounding.
            let var: f32 = col.iter().map(|&v| (v - col_mean).powi(2)).sum::<f32>() / n;
            if var < 0.01 {
                continue;
            }

            assert!(
                col_mean.abs() < 0.1,
                "mel bin {col_idx} mean = {col_mean}, expected ~0"
            );
            checked += 1;
        }
        assert!(checked > 0, "no mel bins had enough variance to check");
    }

    #[test]
    fn dither_is_deterministic() {
        let mut a = vec![0.0_f32; 100];
        let mut b = vec![0.0_f32; 100];
        dither(&mut a);
        dither(&mut b);
        assert_eq!(a, b);
    }

    #[test]
    fn mel_hz_roundtrip() {
        // Exercise both branches: linear (<1000) and log (>=1000)
        for &hz in &[0.0, 440.0, 999.0, 1000.0, 2000.0, 4000.0, 8000.0] {
            let mel = hz_to_mel(hz);
            let back = mel_to_hz(mel);
            assert!(
                (back - hz).abs() < 0.1,
                "roundtrip failed for {hz}: got {back}"
            );
        }
    }

    #[test]
    fn mel_scale_is_slaney() {
        // Linear region: 1000 Hz should map to exactly 15 mels
        let mel_1k = hz_to_mel(1000.0);
        assert!(
            (mel_1k - 15.0).abs() < 1e-4,
            "1000 Hz should be ~15 mels, got {mel_1k}"
        );

        // Log region: 6400 Hz should map to 42 mels (15 + 27)
        let mel_6400 = hz_to_mel(6400.0);
        assert!(
            (mel_6400 - 42.0).abs() < 0.1,
            "6400 Hz should be ~42 mels, got {mel_6400}"
        );
    }
}
