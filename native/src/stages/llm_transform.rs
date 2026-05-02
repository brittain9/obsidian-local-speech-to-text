use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::protocol::{StageId, TimestampGranularity, TimestampSource, TranscriptSegment};
use crate::stages::{StageContext, StageProcess, StageProcessor};
use crate::transcription::Transcript;

const OLLAMA_CHAT_URL: &str = "http://127.0.0.1:11434/api/chat";
const SYSTEM_PROMPT: &str =
    "Return only the transformed transcript text. No preamble or explanation.";

pub struct LlmTransformStage {
    client: reqwest::Client,
}

impl LlmTransformStage {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(60))
                .build()
                .expect("Ollama reqwest client should build"),
        }
    }
}

impl StageProcessor for LlmTransformStage {
    fn id(&self) -> StageId {
        StageId::LlmTransform
    }

    fn collapses_segment_boundaries(&self) -> bool {
        true
    }

    fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
        let Some(config) = ctx.llm_transform else {
            return StageProcess::Skipped {
                reason: "disabled".to_string(),
                payload: None,
            };
        };

        let input = transcript.joined_text();
        if input.trim().is_empty() {
            return StageProcess::Skipped {
                reason: "empty_input".to_string(),
                payload: None,
            };
        }

        if *ctx.cancel_rx.borrow() {
            return StageProcess::Skipped {
                reason: "cancelled".to_string(),
                payload: None,
            };
        }

        let result = ctx.tokio_runtime.block_on(send_chat(
            &self.client,
            config.model.clone(),
            config.prompt.clone(),
            input.clone(),
            ctx.cancel_rx.clone(),
        ));

        match result {
            Ok(response) => {
                let output = response.message.content.trim().to_string();
                let done_reason = response.done_reason.unwrap_or_else(|| "stop".to_string());
                let payload = llm_payload(
                    &config.model,
                    output.len() as u32,
                    false,
                    response.prompt_eval_count,
                    response.eval_count,
                    &done_reason,
                );

                if done_reason != "stop" {
                    return StageProcess::Failed {
                        error: format!("Ollama stopped with done_reason={done_reason}"),
                        payload: Some(llm_payload(
                            &config.model,
                            output.len() as u32,
                            done_reason == "length",
                            response.prompt_eval_count,
                            response.eval_count,
                            &done_reason,
                        )),
                    };
                }

                if output.is_empty() {
                    return StageProcess::Failed {
                        error: "Ollama returned empty output".to_string(),
                        payload: Some(payload),
                    };
                }

                if output.len() > input.len().saturating_mul(10).saturating_add(1_000) {
                    return StageProcess::Failed {
                        error: "Ollama output exceeded length guard".to_string(),
                        payload: Some(llm_payload(
                            &config.model,
                            output.len() as u32,
                            true,
                            response.prompt_eval_count,
                            response.eval_count,
                            &done_reason,
                        )),
                    };
                }

                let transcript_text = if config.developer_mode {
                    format!("Original:\n{}\n\nTransformed:\n{}", input.trim(), output)
                } else {
                    output
                };

                StageProcess::Ok {
                    segments: vec![TranscriptSegment {
                        end_ms: ctx.voice_activity.duration_ms(),
                        start_ms: 0,
                        text: transcript_text,
                        timestamp_granularity: TimestampGranularity::Utterance,
                        timestamp_source: TimestampSource::None,
                    }],
                    payload: Some(payload),
                }
            }
            Err(error) => StageProcess::Failed {
                error,
                payload: Some(llm_payload(&config.model, 0, false, None, None, "error")),
            },
        }
    }
}

async fn send_chat(
    client: &reqwest::Client,
    model: String,
    prompt: String,
    input: String,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<OllamaChatResponse, String> {
    let request = client.post(OLLAMA_CHAT_URL).json(&json!({
        "keep_alive": "30m",
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": format!("{prompt}\n\n{input}") }
        ],
        "model": model,
        "options": {
            "num_predict": 512,
            "seed": 0,
            "temperature": 0.2,
        },
        "stream": false,
        "think": false,
    }));

    let response = tokio::select! {
        _ = cancel_rx.changed() => {
            return Err("cancelled".to_string());
        }
        response = request.send() => response.map_err(|error| error.to_string())?,
    };

    if response.status() != StatusCode::OK {
        return Err(format!("Ollama returned HTTP {}", response.status()));
    }

    response
        .json::<OllamaChatResponse>()
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
    #[serde(default)]
    done_reason: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OllamaMessage {
    content: String,
}

fn llm_payload(
    model: &str,
    output_chars: u32,
    truncated: bool,
    prompt_eval_count: Option<u32>,
    eval_count: Option<u32>,
    done_reason: &str,
) -> serde_json::Value {
    json!({
        "doneReason": done_reason,
        "durationMs": 0,
        "evalCount": eval_count,
        "model": model,
        "outputChars": output_chars,
        "promptEvalCount": prompt_eval_count,
        "truncated": truncated,
    })
}
