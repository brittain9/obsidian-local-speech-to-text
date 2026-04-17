use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, TensorElementType, Value, ValueType};

use crate::engine::capabilities::{
    LanguageSupport, ModelFamilyCapabilities, ModelFamilyId, RuntimeId,
};
use crate::engine::traits::{LoadedModel, ModelFamilyAdapter};
use crate::runtimes::onnx::build_session;
use crate::transcription::{
    GpuConfig, Transcript, TranscriptionError, TranscriptionRequest, validate_audio_samples,
    validate_language, validate_model_path,
};

const NUM_DECODER_LAYERS: usize = 8;
const NUM_HEADS: usize = 8;
const HEAD_DIM: usize = 128;
const MAX_SEQ_LEN: usize = 1024;
const MAX_AUDIO_DURATION_SECS: f32 = 35.0;
const SAMPLE_RATE: usize = 16_000;

// Special token IDs (verified against tokenizer.json added_tokens and
// processing_cohere_asr.py).  IDs 0-254 are special/control tokens;
// BPE text tokens start at 255.
const TOKEN_DECODER_START: i64 = 13764; // ▁ (decoder_start_token_id)
const TOKEN_START_OF_CONTEXT: i64 = 7; // <|startofcontext|>
const TOKEN_START_OF_TRANSCRIPT: i64 = 4; // <|startoftranscript|>
const TOKEN_END_OF_TRANSCRIPT: i64 = 3; // <|endoftext|>
const TOKEN_EMO_UNDEFINED: i64 = 16; // <|emo:undefined|>
const TOKEN_PNC_ON: i64 = 5; // <|pnc|>
const TOKEN_NO_ITN: i64 = 9; // <|noitn|>
const TOKEN_NO_TIMESTAMP: i64 = 11; // <|notimestamp|>
const TOKEN_NO_DIARIZE: i64 = 13; // <|nodiarize|>
const TOKEN_LANG_EN: i64 = 62; // <|en|>

/// Sibling filenames derived from the primary artifact path.
/// `tokens.txt` is retained as a candidate for backward compatibility with
/// manually converted tokenizer files. The HuggingFace-shipped format is
/// `tokenizer.json`, which the loader now handles natively.
const TOKENS_CANDIDATES: &[&str] = &["tokens.txt", "tokenizer.json"];

pub struct CohereTranscribeAdapter {
    capabilities: ModelFamilyCapabilities,
}

impl CohereTranscribeAdapter {
    pub fn new() -> Self {
        Self {
            capabilities: ModelFamilyCapabilities {
                supports_timed_segments: false,
                supports_initial_prompt: false,
                supports_language_selection: false,
                supported_languages: LanguageSupport::EnglishOnly,
                max_audio_duration_secs: Some(MAX_AUDIO_DURATION_SECS),
                produces_punctuation: true,
            },
        }
    }
}

impl Default for CohereTranscribeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelFamilyAdapter for CohereTranscribeAdapter {
    fn runtime_id(&self) -> RuntimeId {
        RuntimeId::OnnxRuntime
    }

    fn family_id(&self) -> ModelFamilyId {
        ModelFamilyId::CohereTranscribe
    }

    fn capabilities(&self) -> &ModelFamilyCapabilities {
        &self.capabilities
    }

    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError> {
        let model_dir = path.parent().ok_or_else(|| {
            TranscriptionError::invalid_model_with_details(
                "cannot determine model directory from artifact path".to_string(),
            )
        })?;

        validate_model_path(path)?;
        find_decoder_path(model_dir)?;
        find_tokens_path(model_dir)?;

        Ok(())
    }

    fn load(
        &self,
        path: &Path,
        gpu: GpuConfig,
    ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
        let model_dir = path.parent().ok_or_else(|| {
            TranscriptionError::invalid_model_with_details(
                "cannot determine model directory".to_string(),
            )
        })?;

        let loaded = load_cohere_model(model_dir, gpu)?;
        Ok(Box::new(loaded))
    }
}

struct LoadedCohereModel {
    decoder: Session,
    encoder: Session,
    mel_extractor: crate::mel::MelFeatureExtractor,
    vocab: HashMap<u32, String>,
}

impl LoadedModel for LoadedCohereModel {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, TranscriptionError> {
        validate_language(&request.language)?;
        validate_audio_samples(&request.audio_samples)?;
        validate_audio_duration(&request.audio_samples)?;

        // --- Feature extraction: raw audio → mel spectrogram [1, T, 128] ---
        let mel = self.mel_extractor.extract(&request.audio_samples);
        let features_value = Value::from_array(mel.features)
            .map_err(|e| TranscriptionError::transcription_failure("encoder features", &e))?;

        // --- Encoder: mel features → hidden states ---
        let encoder_outputs = self
            .encoder
            .run(ort::inputs!["input_features" => features_value])
            .map_err(|e| TranscriptionError::transcription_failure("encoder forward pass", &e))?;

        let (_, encoder_hidden) = encoder_outputs.into_iter().next().ok_or_else(|| {
            TranscriptionError::transcription_failure("encoder", "produced no output")
        })?;

        // --- Decoder: autoregressive token generation ---
        let text = autoregressive_decode(&mut self.decoder, &encoder_hidden, &self.vocab)?;

        Ok(Transcript {
            segments: Vec::new(),
            text: text.trim().to_string(),
        })
    }
}

fn load_cohere_model(
    model_dir: &Path,
    gpu_config: GpuConfig,
) -> Result<LoadedCohereModel, TranscriptionError> {
    let encoder_path = find_encoder_path(model_dir)?;
    let decoder_path = find_decoder_path(model_dir)?;
    let tokens_path = find_tokens_path(model_dir)?;

    let encoder = build_session(&encoder_path, gpu_config)?;
    // Decoder must run on CPU: ORT's CUDA GroupQueryAttention kernel does not
    // support attention_bias, which the Cohere decoder graph requires.
    let decoder = build_session(&decoder_path, GpuConfig { use_gpu: false })?;
    let vocab = load_vocab(&tokens_path)?;
    let mel_extractor = crate::mel::MelFeatureExtractor::new();

    Ok(LoadedCohereModel {
        decoder,
        encoder,
        mel_extractor,
        vocab,
    })
}

fn find_encoder_path(model_dir: &Path) -> Result<PathBuf, TranscriptionError> {
    let candidates = [
        "encoder_model_fp16.onnx",
        "encoder_model.onnx",
        "encoder_model_int8.onnx",
        "encoder_model_q4.onnx",
        "encoder_model_quantized.onnx",
    ];

    for name in &candidates {
        let path = model_dir.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(TranscriptionError::invalid_model_with_details(format!(
        "no encoder ONNX file found in {}",
        model_dir.display()
    )))
}

fn find_decoder_path(model_dir: &Path) -> Result<PathBuf, TranscriptionError> {
    let candidates = [
        "decoder_model_merged_fp16.onnx",
        "decoder_model_merged.onnx",
        "decoder_model_merged_int8.onnx",
        "decoder_model_merged_q4.onnx",
        "decoder_model_merged_quantized.onnx",
    ];

    for name in &candidates {
        let path = model_dir.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(TranscriptionError::invalid_model_with_details(format!(
        "decoder model missing: no decoder ONNX file found in {}",
        model_dir.display()
    )))
}

/// Search for a tokenizer file in the model directory and its parent.
/// HuggingFace repos place `tokenizer.json` at the repo root, which ends up
/// one level above the `onnx/` subdirectory that contains the ONNX models.
/// For external-file selections this parent-directory search can match tokenizer
/// files outside the model directory itself when the chosen model path lives in
/// an arbitrary user directory.
fn find_tokens_path(model_dir: &Path) -> Result<PathBuf, TranscriptionError> {
    let search_dirs: Vec<&Path> = if let Some(parent) = model_dir.parent() {
        vec![model_dir, parent]
    } else {
        vec![model_dir]
    };

    for dir in &search_dirs {
        for name in TOKENS_CANDIDATES {
            let path = dir.join(name);
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    Err(TranscriptionError::invalid_model_with_details(format!(
        "tokenizer file missing: no tokens.txt or tokenizer.json found in {}",
        model_dir.display()
    )))
}

fn load_vocab(path: &Path) -> Result<HashMap<u32, String>, TranscriptionError> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        TranscriptionError::invalid_model_with_details(format!(
            "failed to read tokenizer file {}: {e}",
            path.display()
        ))
    })?;

    let is_json = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));

    if is_json {
        load_vocab_from_json(&content)
    } else {
        load_vocab_from_tsv(&content)
    }
}

fn load_vocab_from_json(content: &str) -> Result<HashMap<u32, String>, TranscriptionError> {
    let root: serde_json::Value = serde_json::from_str(content).map_err(|e| {
        TranscriptionError::invalid_model_with_details(format!(
            "failed to parse tokenizer.json: {e}"
        ))
    })?;

    let vocab_obj = root
        .get("model")
        .and_then(|m| m.get("vocab"))
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            TranscriptionError::invalid_model_with_details(
                "tokenizer.json missing model.vocab object".to_string(),
            )
        })?;

    let mut vocab = HashMap::with_capacity(vocab_obj.len());
    for (token, id_val) in vocab_obj {
        if let Some(id) = id_val.as_u64() {
            vocab.insert(id as u32, token.clone());
        }
    }

    Ok(vocab)
}

fn load_vocab_from_tsv(content: &str) -> Result<HashMap<u32, String>, TranscriptionError> {
    let mut vocab = HashMap::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let (id_str, token) = line
            .split_once('\t')
            .or_else(|| line.split_once(' '))
            .ok_or_else(|| {
                TranscriptionError::invalid_model_with_details(format!(
                    "malformed tokens.txt line: {line}"
                ))
            })?;

        let id: u32 = id_str.parse().map_err(|_| {
            TranscriptionError::invalid_model_with_details(format!(
                "invalid token ID in tokens.txt: {id_str}"
            ))
        })?;

        vocab.insert(id, token.to_string());
    }

    Ok(vocab)
}

fn detokenize(token_ids: &[i64], vocab: &HashMap<u32, String>) -> String {
    let mut pieces: Vec<String> = Vec::new();

    for &id in token_ids {
        let id = id as u32;

        const SPECIAL_TOKEN_BOUNDARY: u32 = 255;
        if id < SPECIAL_TOKEN_BOUNDARY {
            continue;
        }

        if let Some(token) = vocab.get(&id) {
            pieces.push(token.clone());
        }
    }

    let joined = pieces.join("");
    decode_bpe_bytes(&joined)
}

fn decode_bpe_bytes(text: &str) -> String {
    let text = text.replace('\u{2581}', " ");
    let mut result = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'<'
            && i + 5 < bytes.len()
            && bytes[i + 1] == b'0'
            && bytes[i + 2] == b'x'
            && bytes[i + 5] == b'>'
        {
            let hex = &text[i + 3..i + 5];
            if let Ok(byte_val) = u8::from_str_radix(hex, 16) {
                result.push(byte_val);
                i += 6;
                continue;
            }
        }

        result.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&result).to_string()
}

type NamedInput<'v> = (Cow<'v, str>, SessionInputValue<'v>);

fn autoregressive_decode(
    decoder: &mut Session,
    encoder_hidden: &DynValue,
    vocab: &HashMap<u32, String>,
) -> Result<String, TranscriptionError> {
    let prompt = build_prompt_tokens();
    let mut generated_ids: Vec<i64> = Vec::new();
    let mut kv_cache: Option<Vec<DynValue>> = None;
    let mut past_seq_len: i64 = 0;

    let cache_names: Vec<String> = (0..NUM_DECODER_LAYERS)
        .flat_map(|layer| {
            ["decoder", "encoder"]
                .into_iter()
                .flat_map(move |attn_type| {
                    ["key", "value"]
                        .into_iter()
                        .map(move |kv| format!("past_key_values.{layer}.{attn_type}.{kv}"))
                })
        })
        .collect();

    for step in 0..MAX_SEQ_LEN {
        let input_ids: Vec<i64> = if step == 0 {
            prompt.clone()
        } else {
            vec![*generated_ids.last().unwrap()]
        };

        let seq_len = input_ids.len();

        let input_ids_arr = ndarray::Array2::from_shape_vec((1, seq_len), input_ids)
            .map_err(|e| TranscriptionError::transcription_failure("decoder input shape", &e))?;

        let positions: Vec<i64> = (past_seq_len..past_seq_len + seq_len as i64).collect();
        let position_ids_arr = ndarray::Array2::from_shape_vec((1, seq_len), positions)
            .map_err(|e| TranscriptionError::transcription_failure("decoder position_ids", &e))?;

        let total_len = past_seq_len as usize + seq_len;
        let attn_mask_arr = ndarray::Array2::from_elem((1, total_len), 1_i64);

        let num_logits_arr = ndarray::Array0::from_elem((), 1_i64);

        let input_ids_value = Value::from_array(input_ids_arr)
            .map_err(|e| TranscriptionError::transcription_failure("decoder input_ids", &e))?;
        let position_ids_value = Value::from_array(position_ids_arr)
            .map_err(|e| TranscriptionError::transcription_failure("decoder position_ids", &e))?;
        let attn_mask_value = Value::from_array(attn_mask_arr)
            .map_err(|e| TranscriptionError::transcription_failure("decoder attention_mask", &e))?;
        let num_logits_value = Value::from_array(num_logits_arr).map_err(|e| {
            TranscriptionError::transcription_failure("decoder num_logits_to_keep", &e)
        })?;

        let mut inputs: Vec<NamedInput<'_>> = Vec::with_capacity(5 + cache_names.len());
        inputs.push(("input_ids".into(), (&input_ids_value).into()));
        inputs.push(("attention_mask".into(), (&attn_mask_value).into()));
        inputs.push(("position_ids".into(), (&position_ids_value).into()));
        inputs.push(("num_logits_to_keep".into(), (&num_logits_value).into()));
        inputs.push((
            "encoder_hidden_states".into(),
            SessionInputValue::from(encoder_hidden),
        ));

        if let Some(ref cache_values) = kv_cache {
            for (idx, name) in cache_names.iter().enumerate() {
                inputs.push((
                    Cow::Borrowed(name.as_str()),
                    SessionInputValue::from(&cache_values[idx]),
                ));
            }
        } else {
            let use_fp16 = decoder
                .inputs()
                .iter()
                .find(|o| o.name().starts_with("past_key_values."))
                .is_some_and(|o| {
                    matches!(
                        o.dtype(),
                        ValueType::Tensor {
                            ty: TensorElementType::Float16,
                            ..
                        }
                    )
                });

            for name in &cache_names {
                if use_fp16 {
                    let cache = ndarray::Array4::<half::f16>::zeros((1, NUM_HEADS, 0, HEAD_DIM));
                    let cache_value = Value::from_array(cache).map_err(|e| {
                        TranscriptionError::transcription_failure("initial KV cache", &e)
                    })?;
                    inputs.push((Cow::Borrowed(name.as_str()), cache_value.into()));
                } else {
                    let cache = ndarray::Array4::<f32>::zeros((1, NUM_HEADS, 0, HEAD_DIM));
                    let cache_value = Value::from_array(cache).map_err(|e| {
                        TranscriptionError::transcription_failure("initial KV cache", &e)
                    })?;
                    inputs.push((Cow::Borrowed(name.as_str()), cache_value.into()));
                }
            }
        }

        let decoder_outputs = decoder
            .run(inputs)
            .map_err(|e| TranscriptionError::transcription_failure("decoder forward pass", &e))?;

        let mut output_iter = decoder_outputs.into_iter();

        let (_, logits_value) = output_iter.next().ok_or_else(|| {
            TranscriptionError::transcription_failure("decoder", "produced no output")
        })?;

        let best_id = greedy_argmax(&logits_value)?;

        if best_id == TOKEN_END_OF_TRANSCRIPT {
            break;
        }

        generated_ids.push(best_id);
        past_seq_len += seq_len as i64;

        let new_cache: Vec<DynValue> = output_iter.map(|(_, v)| v).collect();
        if new_cache.len() == cache_names.len() {
            kv_cache = Some(new_cache);
        }
    }

    Ok(detokenize(&generated_ids, vocab))
}

fn greedy_argmax(logits_value: &DynValue) -> Result<i64, TranscriptionError> {
    if let Ok((shape, data)) = logits_value.try_extract_tensor::<f32>() {
        return argmax_from_logits(shape, data);
    }
    let (shape, data_f16) = logits_value
        .try_extract_tensor::<half::f16>()
        .map_err(|e| TranscriptionError::transcription_failure("logits extraction", &e))?;
    let data_f32: Vec<f32> = data_f16.iter().map(|v| v.to_f32()).collect();
    argmax_from_logits(shape, &data_f32)
}

fn argmax_from_logits(dims: &[i64], logits_data: &[f32]) -> Result<i64, TranscriptionError> {
    if dims.len() != 3 || dims[0] != 1 {
        return Err(TranscriptionError::transcription_failure(
            "logits shape",
            format!("expected [1, seq, vocab], got {dims:?}"),
        ));
    }

    let seq_len = dims[1] as usize;
    let vocab_size = dims[2] as usize;
    if seq_len == 0 || vocab_size == 0 {
        return Err(TranscriptionError::transcription_failure(
            "logits shape",
            format!("degenerate: seq_len={seq_len}, vocab_size={vocab_size}"),
        ));
    }

    let last_pos = seq_len - 1;
    let logits_offset = last_pos * vocab_size;
    let mut best_id: i64 = 0;
    let mut best_score = f32::NEG_INFINITY;

    for v in 0..vocab_size {
        let score = logits_data[logits_offset + v];
        if score > best_score {
            best_score = score;
            best_id = v as i64;
        }
    }

    Ok(best_id)
}

fn build_prompt_tokens() -> Vec<i64> {
    vec![
        TOKEN_DECODER_START,
        TOKEN_START_OF_CONTEXT,
        TOKEN_START_OF_TRANSCRIPT,
        TOKEN_EMO_UNDEFINED,
        TOKEN_LANG_EN,
        TOKEN_LANG_EN,
        TOKEN_PNC_ON,
        TOKEN_NO_ITN,
        TOKEN_NO_TIMESTAMP,
        TOKEN_NO_DIARIZE,
    ]
}

fn validate_audio_duration(audio_samples: &[f32]) -> Result<(), TranscriptionError> {
    let duration_secs = audio_samples.len() as f32 / SAMPLE_RATE as f32;
    if duration_secs > MAX_AUDIO_DURATION_SECS {
        return Err(TranscriptionError {
            code: "audio_too_long",
            message: "Audio clip exceeds the maximum duration for this engine.",
            details: Some(format!(
                "duration {duration_secs:.1}s exceeds {MAX_AUDIO_DURATION_SECS}s limit"
            )),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::engine::traits::ModelFamilyAdapter;

    #[test]
    fn probe_rejects_missing_encoder() {
        let adapter = CohereTranscribeAdapter::new();
        let result = adapter.probe_model(Path::new("/tmp/nonexistent/encoder_model.onnx"));
        let error = result.expect_err("should fail");
        assert_eq!(error.code, "missing_model_file");
    }

    #[test]
    fn probe_rejects_missing_decoder() {
        let temp = temp_dir("probe-decoder");
        let encoder = temp.join("encoder_model_fp16.onnx");
        std::fs::write(&encoder, b"fake").unwrap();

        let adapter = CohereTranscribeAdapter::new();
        let error = adapter
            .probe_model(&encoder)
            .expect_err("should fail without decoder");
        assert!(error.details.unwrap().contains("decoder"));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_rejects_missing_tokens() {
        let temp = temp_dir("probe-tokens");
        std::fs::write(temp.join("encoder_model_fp16.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("decoder_model_merged_fp16.onnx"), b"fake").unwrap();

        let adapter = CohereTranscribeAdapter::new();
        let error = adapter
            .probe_model(&temp.join("encoder_model_fp16.onnx"))
            .expect_err("should fail without tokenizer");
        assert!(error.details.unwrap().contains("tokenizer"));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_succeeds_with_tokens_txt() {
        let temp = temp_dir("probe-ok-tsv");
        std::fs::write(temp.join("encoder_model_fp16.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("decoder_model_merged_fp16.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("tokens.txt"), b"0\thello").unwrap();

        let adapter = CohereTranscribeAdapter::new();
        assert!(
            adapter
                .probe_model(&temp.join("encoder_model_fp16.onnx"))
                .is_ok()
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_succeeds_with_quantized_decoder() {
        let temp = temp_dir("probe-ok-quant");
        std::fs::write(temp.join("encoder_model_quantized.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("decoder_model_merged_quantized.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("tokens.txt"), b"0\thello").unwrap();

        let adapter = CohereTranscribeAdapter::new();
        assert!(
            adapter
                .probe_model(&temp.join("encoder_model_quantized.onnx"))
                .is_ok()
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_succeeds_with_tokenizer_json_in_parent() {
        let temp = temp_dir("probe-ok-json");
        let onnx_dir = temp.join("onnx");
        std::fs::create_dir_all(&onnx_dir).unwrap();
        std::fs::write(onnx_dir.join("encoder_model_fp16.onnx"), b"fake").unwrap();
        std::fs::write(onnx_dir.join("decoder_model_merged_fp16.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("tokenizer.json"), b"{}").unwrap();

        let adapter = CohereTranscribeAdapter::new();
        assert!(
            adapter
                .probe_model(&onnx_dir.join("encoder_model_fp16.onnx"))
                .is_ok()
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn validate_audio_duration_rejects_long_audio() {
        let samples = vec![0.0_f32; SAMPLE_RATE * 36];
        let error = validate_audio_duration(&samples).expect_err("should reject");
        assert_eq!(error.code, "audio_too_long");
    }

    #[test]
    fn validate_audio_duration_accepts_short_audio() {
        let samples = vec![0.0_f32; SAMPLE_RATE * 30];
        assert!(validate_audio_duration(&samples).is_ok());
    }

    #[test]
    fn detokenize_handles_basic_tokens() {
        let mut vocab = HashMap::new();
        vocab.insert(300, "Hello".to_string());
        vocab.insert(301, " world".to_string());

        assert_eq!(detokenize(&[300, 301], &vocab), "Hello world");
    }

    #[test]
    fn detokenize_skips_special_tokens() {
        let mut vocab = HashMap::new();
        vocab.insert(300, "Hello".to_string());

        let result = detokenize(
            &[
                TOKEN_START_OF_CONTEXT,
                TOKEN_START_OF_TRANSCRIPT,
                300,
                TOKEN_END_OF_TRANSCRIPT,
            ],
            &vocab,
        );
        assert_eq!(result, "Hello");
    }

    #[test]
    fn decode_bpe_bytes_handles_byte_tokens() {
        assert_eq!(decode_bpe_bytes("<0xC3><0xA9>"), "é");
    }

    #[test]
    fn decode_bpe_bytes_handles_mixed_content() {
        assert_eq!(decode_bpe_bytes("Hello<0x21>"), "Hello!");
    }

    #[test]
    fn decode_bpe_bytes_preserves_plain_text() {
        assert_eq!(decode_bpe_bytes("Hello world"), "Hello world");
    }

    #[test]
    fn decode_bpe_bytes_converts_word_separator() {
        assert_eq!(
            decode_bpe_bytes("\u{2581}Hello\u{2581}world"),
            " Hello world"
        );
    }

    #[test]
    fn load_vocab_parses_tab_separated() {
        let temp = temp_dir("vocab-tab");
        let path = temp.join("tokens.txt");
        std::fs::write(&path, "0\thello\n1\t world\n").unwrap();

        let vocab = load_vocab(&path).expect("should parse");
        assert_eq!(vocab.get(&0), Some(&"hello".to_string()));
        assert_eq!(vocab.get(&1), Some(&" world".to_string()));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn load_vocab_parses_tokenizer_json() {
        let temp = temp_dir("vocab-json");
        let path = temp.join("tokenizer.json");
        std::fs::write(&path, r#"{"model":{"vocab":{"hello":0," world":1}}}"#).unwrap();

        let vocab = load_vocab(&path).expect("should parse");
        assert_eq!(vocab.get(&0), Some(&"hello".to_string()));
        assert_eq!(vocab.get(&1), Some(&" world".to_string()));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn build_prompt_tokens_matches_official_10_token_sequence() {
        let tokens = build_prompt_tokens();
        assert_eq!(
            tokens,
            vec![
                TOKEN_DECODER_START,
                TOKEN_START_OF_CONTEXT,
                TOKEN_START_OF_TRANSCRIPT,
                TOKEN_EMO_UNDEFINED,
                TOKEN_LANG_EN,
                TOKEN_LANG_EN,
                TOKEN_PNC_ON,
                TOKEN_NO_ITN,
                TOKEN_NO_TIMESTAMP,
                TOKEN_NO_DIARIZE,
            ]
        );
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cohere-test-{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
