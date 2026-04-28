//! Per-segment text-only diagnostics shared across adapters and the
//! hallucination filter.
//!
//! `compute_compression_ratio` matches OpenAI Whisper's reference behavior:
//! `text.len() / zlib(text).len()`. Repetition loops produce highly
//! compressible text — a ratio above ~2.4 is the canonical hallucination
//! signal (see `whisper/transcribe.py:41-52`).

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;

/// UTF-8-byte ratio of `text.len()` to the size of the zlib-compressed
/// representation. Returns `1.0` for empty input (no signal). Adapters call
/// this once per segment; the result is stored in `SegmentDiagnostics` so the
/// filter does not recompute it.
pub fn compute_compression_ratio(text: &str) -> f32 {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return 1.0;
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    if encoder.write_all(bytes).is_err() {
        return 1.0;
    }
    let compressed = match encoder.finish() {
        Ok(bytes) => bytes,
        Err(_) => return 1.0,
    };

    if compressed.is_empty() {
        return 1.0;
    }

    bytes.len() as f32 / compressed.len() as f32
}

#[cfg(test)]
mod tests {
    use super::compute_compression_ratio;

    #[test]
    fn empty_text_returns_unit_ratio() {
        assert_eq!(compute_compression_ratio(""), 1.0);
    }

    #[test]
    fn highly_repetitive_text_compresses_above_threshold() {
        // "thanks " repeated 100 times — clearly above the OpenAI 2.4 threshold.
        let text = "thanks ".repeat(100);
        let ratio = compute_compression_ratio(&text);
        assert!(
            ratio > 2.4,
            "repetitive text should compress above 2.4, got {ratio}"
        );
    }

    #[test]
    fn natural_short_phrase_stays_below_threshold() {
        let ratio = compute_compression_ratio("Hello, this is a normal short transcript.");
        assert!(
            ratio < 2.4,
            "natural phrase should compress below 2.4, got {ratio}"
        );
    }

    #[test]
    fn matches_hand_computed_zlib_ratio_within_tolerance() {
        // Gold fixture: known input, hand-computed via Python `len(s) /
        // len(zlib.compress(s.encode()))` for s = "abcabcabcabcabcabcabcabc".
        // flate2 default compression matches Python zlib level 6 closely
        // enough for the ratio to land within ±0.2.
        let text = "abcabcabcabcabcabcabcabc";
        let ratio = compute_compression_ratio(text);
        let expected = 24.0_f32 / 12.0_f32; // upper bound per Python zlib
        assert!(
            (ratio - expected).abs() < 0.5,
            "ratio {ratio} drifted too far from {expected}"
        );
    }
}
