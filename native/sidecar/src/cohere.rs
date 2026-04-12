use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Value};

use crate::transcription::{
    GpuConfig, Transcript, TranscriptionBackend, TranscriptionError, TranscriptionRequest,
    validate_audio_samples, validate_language, validate_model_path,
};

const NUM_DECODER_LAYERS: usize = 8;
const NUM_HEADS: usize = 8;
const HEAD_DIM: usize = 128;
const MAX_SEQ_LEN: usize = 1024;
const MAX_AUDIO_DURATION_SECS: f32 = 35.0;
const SAMPLE_RATE: usize = 16_000;

// Special token IDs (from the Cohere Transcribe tokenizer).
const TOKEN_START_OF_CONTEXT: i64 = 16384;
const TOKEN_START_OF_TRANSCRIPT: i64 = 16385;
const TOKEN_END_OF_TRANSCRIPT: i64 = 16386;
const TOKEN_PNC_ON: i64 = 16389;
const TOKEN_ITN_ON: i64 = 16391;
const TOKEN_LANG_EN: i64 = 16393;

/// Sibling filenames derived from the primary artifact path.
/// `tokens.txt` is retained as a candidate for backward compatibility with
/// manually converted tokenizer files.  The HuggingFace-shipped format is
/// `tokenizer.json`, which the loader now handles natively.
const TOKENS_CANDIDATES: &[&str] = &["tokens.txt", "tokenizer.json"];

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct CohereBackend {
    loaded: Option<LoadedCohereModel>,
}

struct LoadedCohereModel {
    decoder: Session,
    encoder: Session,
    gpu_config: GpuConfig,
    model_dir: PathBuf,
    vocab: HashMap<u32, String>,
}

impl TranscriptionBackend for CohereBackend {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, TranscriptionError> {
        validate_language(&request.language)?;
        validate_audio_samples(&request.audio_samples)?;
        validate_audio_duration(&request.audio_samples)?;

        self.ensure_loaded(&request.model_file_path, request.gpu_config)?;
        let model = self.loaded.as_mut().unwrap();

        // --- Encoder: raw audio → hidden states ---
        let encoder_input = ndarray::Array2::from_shape_vec(
            (1, request.audio_samples.len()),
            request.audio_samples.clone(),
        )
        .map_err(|e| TranscriptionError::transcription_failure("encoder input shape", &e))?;

        let input_value = Value::from_array(encoder_input)
            .map_err(|e| TranscriptionError::transcription_failure("encoder input", &e))?;
        let encoder_outputs = model
            .encoder
            .run(ort::inputs![input_value])
            .map_err(|e| TranscriptionError::transcription_failure("encoder forward pass", &e))?;

        let (_, encoder_hidden) = encoder_outputs.into_iter().next().ok_or_else(|| {
            TranscriptionError::transcription_failure("encoder", "produced no output")
        })?;

        // --- Decoder: autoregressive token generation ---
        let text = autoregressive_decode(&mut model.decoder, &encoder_hidden, &model.vocab)?;

        Ok(Transcript {
            segments: Vec::new(),
            text: text.trim().to_string(),
        })
    }

    fn probe_model(path: &Path) -> Result<(), TranscriptionError> {
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
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

impl CohereBackend {
    fn ensure_loaded(
        &mut self,
        primary_artifact: &Path,
        gpu_config: GpuConfig,
    ) -> Result<(), TranscriptionError> {
        let model_dir = primary_artifact.parent().ok_or_else(|| {
            TranscriptionError::invalid_model_with_details(
                "cannot determine model directory".to_string(),
            )
        })?;

        let should_reload = self
            .loaded
            .as_ref()
            .map(|m| m.model_dir != model_dir || m.gpu_config != gpu_config)
            .unwrap_or(true);

        if should_reload {
            self.loaded = Some(load_cohere_model(model_dir, gpu_config)?);
        }

        Ok(())
    }
}

fn build_session(model_path: &Path, gpu_config: GpuConfig) -> Result<Session, TranscriptionError> {
    let mut builder = Session::builder()
        .map_err(|e| TranscriptionError::transcription_failure("session builder", &e))?;

    #[cfg(feature = "gpu-ort-cuda")]
    if gpu_config.use_gpu {
        builder = builder
            .with_execution_providers([
                ort::execution_providers::CUDAExecutionProvider::default().build()
            ])
            .map_err(|e| TranscriptionError::transcription_failure("CUDA EP registration", &e))?;
    }

    #[cfg(not(feature = "gpu-ort-cuda"))]
    let _ = gpu_config;

    builder
        .commit_from_file(model_path)
        .map_err(|e| TranscriptionError::transcription_failure("model loading", &e))
}

fn load_cohere_model(
    model_dir: &Path,
    gpu_config: GpuConfig,
) -> Result<LoadedCohereModel, TranscriptionError> {
    let encoder_path = find_encoder_path(model_dir)?;
    let decoder_path = find_decoder_path(model_dir)?;
    let tokens_path = find_tokens_path(model_dir)?;

    let encoder = build_session(&encoder_path, gpu_config)?;
    let decoder = build_session(&decoder_path, gpu_config)?;
    let vocab = load_vocab(&tokens_path)?;

    Ok(LoadedCohereModel {
        decoder,
        encoder,
        gpu_config,
        model_dir: model_dir.to_path_buf(),
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
fn find_tokens_path(model_dir: &Path) -> Result<PathBuf, TranscriptionError> {
    // Check model_dir itself first, then parent (for tokenizer.json at repo root).
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

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

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

/// Parse a HuggingFace `tokenizer.json` file.
/// The vocab lives at `model.vocab` as `{ token_string: id, ... }`.
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

/// Parse a tab-separated `tokens.txt` file (id\ttoken per line).
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

        // Skip special tokens.
        if id >= TOKEN_START_OF_CONTEXT as u32 {
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
    let mut result = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Check for <0xNN> byte token pattern.
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

// ---------------------------------------------------------------------------
// Autoregressive decode
// ---------------------------------------------------------------------------

type NamedInput<'v> = (Cow<'v, str>, SessionInputValue<'v>);

fn autoregressive_decode(
    decoder: &mut Session,
    encoder_hidden: &DynValue,
    vocab: &HashMap<u32, String>,
) -> Result<String, TranscriptionError> {
    let prompt = build_prompt_tokens();
    let mut generated_ids: Vec<i64> = Vec::new();
    let mut kv_cache: Option<Vec<DynValue>> = None;
    let mut offset: i64 = 0;

    let cache_names: Vec<String> = (0..NUM_DECODER_LAYERS)
        .flat_map(|layer| {
            ["key", "value"].into_iter().flat_map(move |cache_type| {
                ["self", "cross"].into_iter().map(move |attn_type| {
                    format!("past_{cache_type}_{attn_type}_attention.{layer}")
                })
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
        let offset_arr = ndarray::Array1::from_vec(vec![offset]);

        let input_ids_value = Value::from_array(input_ids_arr)
            .map_err(|e| TranscriptionError::transcription_failure("decoder input_ids", &e))?;
        let offset_value = Value::from_array(offset_arr)
            .map_err(|e| TranscriptionError::transcription_failure("decoder offset", &e))?;

        let mut inputs: Vec<NamedInput<'_>> = Vec::with_capacity(3 + cache_names.len());
        inputs.push(("input_ids".into(), (&input_ids_value).into()));
        inputs.push((
            "encoder_hidden_states".into(),
            SessionInputValue::from(encoder_hidden),
        ));
        inputs.push(("offset".into(), (&offset_value).into()));

        // KV cache inputs.
        if let Some(ref cache_values) = kv_cache {
            for (idx, name) in cache_names.iter().enumerate() {
                inputs.push((
                    Cow::Borrowed(name.as_str()),
                    SessionInputValue::from(&cache_values[idx]),
                ));
            }
        } else {
            for name in &cache_names {
                let cache = ndarray::Array4::<f32>::zeros((1, NUM_HEADS, 0, HEAD_DIM));
                let cache_value = Value::from_array(cache).map_err(|e| {
                    TranscriptionError::transcription_failure("initial KV cache", &e)
                })?;
                inputs.push((Cow::Borrowed(name.as_str()), cache_value.into()));
            }
        }

        let decoder_outputs = decoder
            .run(inputs)
            .map_err(|e| TranscriptionError::transcription_failure("decoder forward pass", &e))?;

        // Separate logits (first output) from KV cache (remaining outputs).
        let mut output_iter = decoder_outputs.into_iter();

        let (_, logits_value) = output_iter.next().ok_or_else(|| {
            TranscriptionError::transcription_failure("decoder", "produced no output")
        })?;

        let best_id = greedy_argmax(&logits_value)?;

        if best_id == TOKEN_END_OF_TRANSCRIPT {
            break;
        }

        generated_ids.push(best_id);
        offset += seq_len as i64;

        // Collect updated KV cache tensors from remaining decoder outputs.
        let new_cache: Vec<DynValue> = output_iter.map(|(_, v)| v).collect();
        if new_cache.len() == cache_names.len() {
            kv_cache = Some(new_cache);
        }
    }

    Ok(detokenize(&generated_ids, vocab))
}

/// Extract the token ID with the highest logit at the last sequence position.
/// Validates the expected `[batch, seq_len, vocab_size]` shape before indexing.
fn greedy_argmax(logits_value: &DynValue) -> Result<i64, TranscriptionError> {
    let (logits_shape, logits_data) = logits_value
        .try_extract_tensor::<f32>()
        .map_err(|e| TranscriptionError::transcription_failure("logits extraction", &e))?;

    let dims: &[i64] = logits_shape;
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
        TOKEN_START_OF_CONTEXT,
        TOKEN_START_OF_TRANSCRIPT,
        TOKEN_LANG_EN,
        TOKEN_PNC_ON,
        TOKEN_ITN_ON,
    ]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::transcription::TranscriptionBackend;

    #[test]
    fn probe_rejects_missing_encoder() {
        let result = CohereBackend::probe_model(Path::new("/tmp/nonexistent/encoder_model.onnx"));
        let error = result.expect_err("should fail");
        assert_eq!(error.code, "missing_model_file");
    }

    #[test]
    fn probe_rejects_missing_decoder() {
        let temp = temp_dir("probe-decoder");
        let encoder = temp.join("encoder_model_fp16.onnx");
        std::fs::write(&encoder, b"fake").unwrap();

        let error = CohereBackend::probe_model(&encoder).expect_err("should fail without decoder");
        assert!(error.details.unwrap().contains("decoder"));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_rejects_missing_tokens() {
        let temp = temp_dir("probe-tokens");
        std::fs::write(temp.join("encoder_model_fp16.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("decoder_model_merged_fp16.onnx"), b"fake").unwrap();

        let error = CohereBackend::probe_model(&temp.join("encoder_model_fp16.onnx"))
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

        assert!(CohereBackend::probe_model(&temp.join("encoder_model_fp16.onnx")).is_ok());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_succeeds_with_quantized_decoder() {
        let temp = temp_dir("probe-ok-quant");
        std::fs::write(temp.join("encoder_model_quantized.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("decoder_model_merged_quantized.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("tokens.txt"), b"0\thello").unwrap();

        assert!(CohereBackend::probe_model(&temp.join("encoder_model_quantized.onnx")).is_ok());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn probe_succeeds_with_tokenizer_json_in_parent() {
        // Simulates the HuggingFace layout: onnx/ subdir with models,
        // tokenizer.json at repo root (parent of onnx/).
        let temp = temp_dir("probe-ok-json");
        let onnx_dir = temp.join("onnx");
        std::fs::create_dir_all(&onnx_dir).unwrap();
        std::fs::write(onnx_dir.join("encoder_model_fp16.onnx"), b"fake").unwrap();
        std::fs::write(onnx_dir.join("decoder_model_merged_fp16.onnx"), b"fake").unwrap();
        std::fs::write(temp.join("tokenizer.json"), b"{}").unwrap();

        assert!(CohereBackend::probe_model(&onnx_dir.join("encoder_model_fp16.onnx")).is_ok());

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
        vocab.insert(0, "Hello".to_string());
        vocab.insert(1, " world".to_string());

        assert_eq!(detokenize(&[0, 1], &vocab), "Hello world");
    }

    #[test]
    fn detokenize_skips_special_tokens() {
        let mut vocab = HashMap::new();
        vocab.insert(0, "Hello".to_string());

        let result = detokenize(
            &[
                TOKEN_START_OF_CONTEXT,
                TOKEN_START_OF_TRANSCRIPT,
                0,
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
        std::fs::write(
            &path,
            r#"{"model":{"vocab":{"hello":0," world":1}}}"#,
        )
        .unwrap();

        let vocab = load_vocab(&path).expect("should parse");
        assert_eq!(vocab.get(&0), Some(&"hello".to_string()));
        assert_eq!(vocab.get(&1), Some(&" world".to_string()));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn build_prompt_tokens_includes_required_control_tokens() {
        let tokens = build_prompt_tokens();
        assert!(tokens.contains(&TOKEN_START_OF_CONTEXT));
        assert!(tokens.contains(&TOKEN_START_OF_TRANSCRIPT));
        assert!(tokens.contains(&TOKEN_LANG_EN));
        assert!(tokens.contains(&TOKEN_PNC_ON));
        assert!(tokens.contains(&TOKEN_ITN_ON));
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
