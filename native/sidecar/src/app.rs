use serde_json::json;

use crate::protocol::{PROTOCOL_VERSION, RequestEnvelope, RequestType, ResponseEnvelope};

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

pub fn handle_request(request: RequestEnvelope, sidecar_version: &str) -> HandledResponse {
    match request.request_type {
        RequestType::Health => HandledResponse {
            control_flow: ControlFlow::Continue,
            response: ResponseEnvelope::success(
                request.id,
                RequestType::Health,
                json!({
                    "status": "ready",
                    "protocolVersion": PROTOCOL_VERSION,
                    "sidecarVersion": sidecar_version,
                }),
            ),
        },
        RequestType::TranscribeMock => HandledResponse {
            control_flow: ControlFlow::Continue,
            response: ResponseEnvelope::success(
                request.id,
                RequestType::TranscribeMock,
                json!({
                    "text": "This is a bootstrap transcript from the local sidecar.\n",
                    "segments": [
                        {
                            "startMs": 0,
                            "endMs": 1500,
                            "text": "This is a bootstrap transcript",
                        },
                        {
                            "startMs": 1500,
                            "endMs": 2600,
                            "text": "from the local sidecar.",
                        }
                    ]
                }),
            ),
        },
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ControlFlow, handle_request};
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
        let handled = handle_request(request(RequestType::Health), SIDECAR_VERSION);

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
    fn transcribe_mock_returns_deterministic_text() {
        let handled = handle_request(request(RequestType::TranscribeMock), SIDECAR_VERSION);

        assert_eq!(handled.control_flow, ControlFlow::Continue);
        assert_eq!(
            handled.response.payload,
            Some(json!({
                "text": "This is a bootstrap transcript from the local sidecar.\n",
                "segments": [
                    {
                        "startMs": 0,
                        "endMs": 1500,
                        "text": "This is a bootstrap transcript",
                    },
                    {
                        "startMs": 1500,
                        "endMs": 2600,
                        "text": "from the local sidecar.",
                    }
                ]
            }))
        );
    }

    #[test]
    fn shutdown_returns_acknowledgement() {
        let handled = handle_request(request(RequestType::Shutdown), SIDECAR_VERSION);

        assert_eq!(handled.control_flow, ControlFlow::Shutdown);
        assert_eq!(
            handled.response.payload,
            Some(json!({
                "acknowledged": true,
            }))
        );
    }
}
