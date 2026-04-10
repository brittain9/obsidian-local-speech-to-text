use obsidian_local_stt_sidecar::app::{ControlFlow, handle_request};
use obsidian_local_stt_sidecar::protocol::{RequestEnvelope, RequestType};
use serde_json::json;

#[test]
fn transcribe_mock_smoke_test() {
    let handled = handle_request(
        RequestEnvelope {
            id: "req-42".to_string(),
            protocol_version: "v1".to_string(),
            request_type: RequestType::TranscribeMock,
            payload: json!({}),
        },
        "0.1.0",
    );

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
