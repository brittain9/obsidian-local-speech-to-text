use serde_json::json;

use crate::protocol::{
    PROTOCOL_VERSION, RequestEnvelope, RequestType, ResponseEnvelope, TranscribeFileRequestPayload,
};
use crate::transcription::{TranscriptionEngine, TranscriptionRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFlow {
    Continue,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandledResponse {
    pub control_flow: ControlFlow,
    pub response: ResponseEnvelope,
}

pub struct AppState {
    sidecar_version: String,
    transcription_engine: TranscriptionEngine,
}

impl AppState {
    pub fn new(sidecar_version: impl Into<String>) -> Self {
        Self {
            sidecar_version: sidecar_version.into(),
            transcription_engine: TranscriptionEngine::default(),
        }
    }

    pub fn handle_request(&mut self, request: RequestEnvelope) -> HandledResponse {
        match request.request_type {
            RequestType::Health => HandledResponse {
                control_flow: ControlFlow::Continue,
                response: ResponseEnvelope::success(
                    request.id,
                    RequestType::Health,
                    json!({
                        "status": "ready",
                        "protocolVersion": PROTOCOL_VERSION,
                        "sidecarVersion": self.sidecar_version,
                    }),
                ),
            },
            RequestType::TranscribeFile => self.handle_transcribe_file(request),
            RequestType::Shutdown => HandledResponse {
                control_flow: ControlFlow::Shutdown,
                response: ResponseEnvelope::success(
                    request.id,
                    RequestType::Shutdown,
                    json!({
                        "acknowledged": true,
                    }),
                ),
            },
        }
    }

    fn handle_transcribe_file(&mut self, request: RequestEnvelope) -> HandledResponse {
        let request_id = request.id.clone();
        let payload = match request.parse_payload::<TranscribeFileRequestPayload>() {
            Ok(payload) => payload,
            Err(error) => {
                return HandledResponse {
                    control_flow: ControlFlow::Continue,
                    response: ResponseEnvelope::failure(
                        request_id,
                        RequestType::TranscribeFile,
                        "invalid_request_payload",
                        "Transcription request payload is invalid.",
                        Some(error.to_string()),
                    ),
                };
            }
        };

        match self.transcription_engine.transcribe(&TranscriptionRequest {
            audio_file_path: payload.audio_file_path.into(),
            language: payload.language,
            model_file_path: payload.model_file_path.into(),
        }) {
            Ok(transcript) => HandledResponse {
                control_flow: ControlFlow::Continue,
                response: ResponseEnvelope::success(
                    request_id,
                    RequestType::TranscribeFile,
                    serde_json::to_value(transcript)
                        .expect("transcript payload must serialize cleanly"),
                ),
            },
            Err(error) => HandledResponse {
                control_flow: ControlFlow::Continue,
                response: ResponseEnvelope::failure(
                    request_id,
                    RequestType::TranscribeFile,
                    error.code,
                    error.message,
                    error.details,
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AppState, ControlFlow};
    use crate::protocol::{RequestEnvelope, RequestType};

    const SIDECAR_VERSION: &str = "0.1.0";

    fn request(request_type: RequestType) -> RequestEnvelope {
        RequestEnvelope {
            id: "req-1".to_string(),
            protocol_version: "v1".to_string(),
            request_type,
            payload: json!({}),
        }
    }

    #[test]
    fn health_returns_ready_payload() {
        let handled = AppState::new(SIDECAR_VERSION).handle_request(request(RequestType::Health));

        assert_eq!(handled.control_flow, ControlFlow::Continue);
        assert_eq!(
            handled.response.payload,
            Some(json!({
                "status": "ready",
                "protocolVersion": "v1",
                "sidecarVersion": SIDECAR_VERSION,
            }))
        );
    }

    #[test]
    fn transcribe_file_rejects_invalid_payload() {
        let handled = AppState::new(SIDECAR_VERSION).handle_request(RequestEnvelope {
            id: "req-1".to_string(),
            protocol_version: "v1".to_string(),
            request_type: RequestType::TranscribeFile,
            payload: json!({}),
        });

        assert_eq!(handled.control_flow, ControlFlow::Continue);
        assert!(!handled.response.ok);
        assert_eq!(
            handled
                .response
                .error
                .expect("response error should exist")
                .code,
            "invalid_request_payload"
        );
    }

    #[test]
    fn shutdown_returns_acknowledgement() {
        let handled = AppState::new(SIDECAR_VERSION).handle_request(request(RequestType::Shutdown));

        assert_eq!(handled.control_flow, ControlFlow::Shutdown);
        assert_eq!(
            handled.response.payload,
            Some(json!({
                "acknowledged": true,
            }))
        );
    }
}
