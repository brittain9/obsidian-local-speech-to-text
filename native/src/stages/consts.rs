//! Calibrated constants for the hallucination filter. Values match the
//! OpenAI Whisper reference (`whisper/transcribe.py:41-218`,
//! faster-whisper, WhisperX). Centralised here so the filter and any
//! follow-up calibration tooling read one source of truth.

/// `no_speech_prob > NO_SPEECH_PROB_THRESHOLD` flags silence — but only
/// AND-combined with `avg_logprob < AVG_LOGPROB_THRESHOLD` (mirrors
/// OpenAI's `transcribe.py:215-218`).
pub const NO_SPEECH_PROB_THRESHOLD: f32 = 0.6;

/// `avg_logprob < AVG_LOGPROB_THRESHOLD` is the second half of the
/// silence AND-rule.
pub const AVG_LOGPROB_THRESHOLD: f32 = -1.0;

/// `compression_ratio > COMPRESSION_RATIO_THRESHOLD` flags repetition loops.
pub const COMPRESSION_RATIO_THRESHOLD: f32 = 2.4;

/// Width of the n-gram window used by the repetition rule.
pub const NGRAM_SIZE: usize = 3;

/// Drop a segment when any n-gram occurs at least this many times.
pub const NGRAM_REPEAT_THRESHOLD: usize = 3;

/// Hallucination phrases observed across whisper.cpp output. Compared
/// case-insensitively after trimming whitespace and stripping trailing
/// `.!?…` (see `BARE_TOKEN_BLOCKLIST` for entries that bypass the
/// trailing-punctuation strip and must match the entire trimmed segment).
pub const PHRASE_BLOCKLIST: &[&str] = &[
    "thank you",
    "thank you for watching",
    "thanks for watching",
    "thank you so much for watching",
    "thank you so much",
    "thank you very much",
    "thank you for your attention",
    "please subscribe to the channel",
    "please subscribe",
    "please like and subscribe",
    "don't forget to like and subscribe",
    "subscribe to the channel",
    "subscribe to my channel",
    "see you next time",
    "see you in the next video",
    "see you next video",
    "bye",
    "bye bye",
    "goodbye",
    "i'll see you next time",
    "let me know in the comments",
    "if you enjoyed this video, please like and subscribe",
    "subtitles by the amara.org community",
    "subtitles by amara.org",
    "subtitles by the community",
    "subtitles by",
    "subtitles",
    "captions by",
    "captioning by",
    "transcription by",
    "transcribed by",
    "translated by",
    "translation by",
    "www.mooji.org",
    "[blank_audio]",
    "[silence]",
    "(silence)",
    "(soft music)",
    "(music)",
    "[music]",
    "[music playing]",
    "[applause]",
];

/// Tokens that match only when they are the *entire* trimmed segment text.
/// These bypass the trailing-punctuation strip applied to `PHRASE_BLOCKLIST`
/// — `"you"` would otherwise swallow legitimate one-word utterances ending
/// in `.`, and `"."` is the explicit "single punctuation" hallucination.
pub const BARE_TOKEN_BLOCKLIST: &[&str] = &["you", "."];
